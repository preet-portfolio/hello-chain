// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {Guestbook} from "../src/Guestbook.sol";
import {IGuestbook} from "../src/IGuestbook.sol";
import {MockERC1271Wallet} from "./mocks/MockERC1271Wallet.sol";

contract GuestbookWalletTest is Test {
    Guestbook internal gb;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    uint256 internal aliceKey;
    address internal alice;

    uint40 internal constant COOLDOWN = 1 days;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant ENTRY_TYPEHASH =
        keccak256("Entry(bytes32 visitorId,string message,uint256 nonce,uint256 deadline)");

    function setUp() public {
        vm.warp(1_700_000_000);
        gb = new Guestbook(owner, COOLDOWN);
        (alice, aliceKey) = makeAddrAndKey("alice");
    }

    function _vid(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    /// @dev Independent digest computation (does not call gb.hashEntry) for a given chain id.
    function _digest(uint256 chainId, address verifying, bytes32 vid, string memory message, uint256 nonce, uint256 dl)
        internal
        pure
        returns (bytes32)
    {
        bytes32 domainSep =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("HelloChain"), keccak256("1"), chainId, verifying));
        bytes32 structHash = keccak256(abi.encode(ENTRY_TYPEHASH, vid, keccak256(bytes(message)), nonce, dl));
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    function _sig(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signFor(uint256 key, address who, string memory message, uint256 nonce, uint256 dl)
        internal
        view
        returns (bytes memory)
    {
        return _sig(key, _digest(block.chainid, address(gb), _vid(who), message, nonce, dl));
    }

    function test_hashEntry_matchesIndependentDigest() public view {
        bytes32 expected = _digest(block.chainid, address(gb), _vid(alice), "hi", 0, 123);
        assertEq(gb.hashEntry(_vid(alice), "hi", 0, 123), expected);
    }

    function test_validSig_recordsAsAuthor_kindWallet() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _signFor(aliceKey, alice, "hello", 0, dl);

        vm.expectEmit(true, true, false, true, address(gb));
        emit IGuestbook.Signed(0, _vid(alice), IGuestbook.Kind.Wallet, "hello", uint40(block.timestamp));

        vm.prank(relayer);
        uint256 id = gb.signWithWallet(alice, "hello", dl, sig);

        assertEq(id, 0);
        IGuestbook.EntryView memory e = gb.getEntry(0);
        assertEq(e.visitorId, _vid(alice));
        assertTrue(e.visitorId != _vid(relayer));
        assertEq(uint8(e.kind), uint8(IGuestbook.Kind.Wallet));
        assertEq(gb.nonces(_vid(alice)), 1);
        assertEq(gb.nonces(_vid(relayer)), 0);
    }

    function test_walletAndDirectShareCooldown() public {
        vm.prank(alice);
        gb.sign("direct");

        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _signFor(aliceKey, alice, "wallet", 0, dl);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IGuestbook.CooldownActive.selector, uint40(block.timestamp) + COOLDOWN));
        gb.signWithWallet(alice, "wallet", dl, sig);
        // failed attempt must not burn the nonce
        assertEq(gb.nonces(_vid(alice)), 0);
    }

    function test_revert_replay() public {
        uint256 dl = vm.getBlockTimestamp() + 3 days;
        bytes memory sig = _signFor(aliceKey, alice, "hello", 0, dl);
        vm.prank(relayer);
        gb.signWithWallet(alice, "hello", dl, sig);

        // past the cooldown, the same signature is rejected because the nonce moved on
        vm.warp(vm.getBlockTimestamp() + COOLDOWN + 1);
        vm.prank(relayer);
        vm.expectRevert(IGuestbook.InvalidSignature.selector);
        gb.signWithWallet(alice, "hello", dl, sig);
        assertEq(gb.nonces(_vid(alice)), 1);
        assertEq(gb.entryCount(), 1);
    }

    function test_revert_expired() public {
        uint256 dl = block.timestamp - 1;
        bytes memory sig = _signFor(aliceKey, alice, "hello", 0, dl);
        vm.expectRevert(IGuestbook.SignatureExpired.selector);
        gb.signWithWallet(alice, "hello", dl, sig);
    }

    function test_deadlineEqualNow_ok() public {
        uint256 dl = block.timestamp;
        bytes memory sig = _signFor(aliceKey, alice, "hello", 0, dl);
        gb.signWithWallet(alice, "hello", dl, sig);
        assertEq(gb.entryCount(), 1);
    }

    function test_revert_wrongChain() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _sig(aliceKey, _digest(block.chainid + 1, address(gb), _vid(alice), "hello", 0, dl));
        vm.expectRevert(IGuestbook.InvalidSignature.selector);
        gb.signWithWallet(alice, "hello", dl, sig);
    }

    function test_revert_tamperedMessage() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _signFor(aliceKey, alice, "hello", 0, dl);
        vm.expectRevert(IGuestbook.InvalidSignature.selector);
        gb.signWithWallet(alice, "hellO", dl, sig);
    }

    function test_revert_wrongAuthor() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _signFor(aliceKey, alice, "hello", 0, dl);
        vm.expectRevert(IGuestbook.InvalidSignature.selector);
        gb.signWithWallet(relayer, "hello", dl, sig);
    }

    function test_erc1271Wallet() public {
        MockERC1271Wallet w = new MockERC1271Wallet(alice);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _signFor(aliceKey, address(w), "from 1271", 0, dl);

        vm.prank(relayer);
        uint256 id = gb.signWithWallet(address(w), "from 1271", dl, sig);

        assertEq(gb.getEntry(id).visitorId, _vid(address(w)));
        assertEq(gb.nonces(_vid(address(w))), 1);
    }

    function testFuzz_randomSigRejected(bytes calldata sig, string calldata message) public {
        vm.assume(bytes(message).length > 0 && bytes(message).length <= 140);
        vm.expectRevert(IGuestbook.InvalidSignature.selector);
        gb.signWithWallet(alice, message, block.timestamp + 1 hours, sig);
    }
}
