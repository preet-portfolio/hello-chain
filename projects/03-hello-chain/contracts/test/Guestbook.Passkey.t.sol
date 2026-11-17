// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {Guestbook} from "../src/Guestbook.sol";
import {IGuestbook} from "../src/IGuestbook.sol";
import {WebAuthnHelper} from "./utils/WebAuthnHelper.sol";

contract GuestbookPasskeyTest is Test {
    Guestbook internal gb;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");

    uint256 internal constant KEY = 0xA11CE;
    uint256 internal constant OTHER_KEY = 0xB0B;
    uint40 internal constant COOLDOWN = 1 days;

    bytes32 internal qx;
    bytes32 internal qy;

    function setUp() public {
        vm.warp(1_700_000_000);
        gb = new Guestbook(owner, COOLDOWN);
        (qx, qy) = WebAuthnHelper.publicKey(KEY);
    }

    function _challenge(string memory message, uint256 nonce, uint256 dl) internal view returns (bytes memory) {
        return abi.encodePacked(gb.hashEntry(gb.passkeyVisitorId(qx, qy), message, nonce, dl));
    }

    function _auth(uint256 key, string memory message, uint256 nonce, uint256 dl)
        internal
        view
        returns (WebAuthn.WebAuthnAuth memory)
    {
        return WebAuthnHelper.sign(key, _challenge(message, nonce, dl));
    }

    function test_passkeyVisitorId() public view {
        assertEq(gb.passkeyVisitorId(qx, qy), keccak256(abi.encode(qx, qy)));
    }

    function test_validAssertion_kindPasskey() public {
        uint256 dl = block.timestamp + 1 hours;
        WebAuthn.WebAuthnAuth memory auth = _auth(KEY, "hello", 0, dl);
        bytes32 vid = keccak256(abi.encode(qx, qy));

        vm.expectEmit(true, true, false, true, address(gb));
        emit IGuestbook.Signed(0, vid, IGuestbook.Kind.Passkey, "hello", uint40(block.timestamp));

        vm.prank(relayer);
        uint256 id = gb.signWithPasskey(qx, qy, "hello", dl, auth);

        assertEq(id, 0);
        IGuestbook.EntryView memory e = gb.getEntry(0);
        assertEq(e.visitorId, vid);
        assertEq(uint8(e.kind), uint8(IGuestbook.Kind.Passkey));
        assertEq(e.message, "hello");
        assertEq(gb.nonces(vid), 1);
        assertEq(gb.uniqueVisitors(), 1);
    }

    function test_deadlineEqualNow_ok() public {
        uint256 dl = block.timestamp;
        gb.signWithPasskey(qx, qy, "hello", dl, _auth(KEY, "hello", 0, dl));
        assertEq(gb.entryCount(), 1);
    }

    function test_revert_wrongKey() public {
        uint256 dl = block.timestamp + 1 hours;
        WebAuthn.WebAuthnAuth memory auth = _auth(OTHER_KEY, "hello", 0, dl);
        vm.expectRevert(IGuestbook.InvalidSignature.selector);
        gb.signWithPasskey(qx, qy, "hello", dl, auth);
    }

    function test_revert_replay() public {
        uint256 dl = vm.getBlockTimestamp() + 3 days;
        WebAuthn.WebAuthnAuth memory auth = _auth(KEY, "hello", 0, dl);
        gb.signWithPasskey(qx, qy, "hello", dl, auth);

        vm.warp(vm.getBlockTimestamp() + COOLDOWN + 1);
        vm.expectRevert(IGuestbook.InvalidSignature.selector);
        gb.signWithPasskey(qx, qy, "hello", dl, auth);
    }

    function test_revert_expired() public {
        uint256 dl = vm.getBlockTimestamp() + 1 hours;
        WebAuthn.WebAuthnAuth memory auth = _auth(KEY, "hello", 0, dl);
        vm.warp(dl + 1);
        vm.expectRevert(IGuestbook.SignatureExpired.selector);
        gb.signWithPasskey(qx, qy, "hello", dl, auth);
    }

    function test_revert_challengeMismatch() public {
        uint256 dl = block.timestamp + 1 hours;
        WebAuthn.WebAuthnAuth memory auth = _auth(KEY, "hello", 0, dl);
        vm.expectRevert(IGuestbook.InvalidSignature.selector);
        gb.signWithPasskey(qx, qy, "hellO", dl, auth);
    }

    function test_revert_noUserVerification() public {
        uint256 dl = block.timestamp + 1 hours;
        // validly signed by the right key, but the authenticator only reports user presence
        WebAuthn.WebAuthnAuth memory auth = WebAuthnHelper.sign(KEY, _challenge("hello", 0, dl), WebAuthnHelper.FLAG_UP);
        vm.expectRevert(IGuestbook.InvalidSignature.selector);
        gb.signWithPasskey(qx, qy, "hello", dl, auth);
    }

    function test_revert_highS() public {
        uint256 dl = block.timestamp + 1 hours;
        WebAuthn.WebAuthnAuth memory auth = _auth(KEY, "hello", 0, dl);
        // (r, n - s) is the malleable twin of a valid signature
        auth.s = bytes32(WebAuthnHelper.P256_N - uint256(auth.s));
        vm.expectRevert(IGuestbook.InvalidSignature.selector);
        gb.signWithPasskey(qx, qy, "hello", dl, auth);
    }

    function test_samePasskeyCooldown() public {
        uint256 dl = vm.getBlockTimestamp() + 1 hours;
        gb.signWithPasskey(qx, qy, "first", dl, _auth(KEY, "first", 0, dl));

        vm.warp(vm.getBlockTimestamp() + COOLDOWN - 1);
        uint256 dl2 = vm.getBlockTimestamp() + 1 hours;
        WebAuthn.WebAuthnAuth memory auth = _auth(KEY, "second", 1, dl2);
        vm.expectRevert(abi.encodeWithSelector(IGuestbook.CooldownActive.selector, uint40(1_700_000_000) + COOLDOWN));
        gb.signWithPasskey(qx, qy, "second", dl2, auth);
    }
}
