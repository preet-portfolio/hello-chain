// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {Guestbook} from "../../src/Guestbook.sol";
import {IGuestbook} from "../../src/IGuestbook.sol";
import {MockERC1271Wallet} from "../mocks/MockERC1271Wallet.sol";
import {WebAuthnHelper} from "../utils/WebAuthnHelper.sol";

/// @dev Invariant-test handler: drives every write path with bounded random inputs and records
///      ghost state (message hashes, counts, nonces) that the invariants compare against the contract.
contract GuestbookHandler is Test {
    Guestbook public immutable GB;
    address public immutable OWNER;

    uint256 internal constant ACTORS = 4;

    address[ACTORS] public eoas;
    uint256[ACTORS] internal _eoaKeys;
    MockERC1271Wallet[ACTORS] public wallets;
    uint256[ACTORS] internal _passkeys;
    bytes32[ACTORS] internal _qx;
    bytes32[ACTORS] internal _qy;

    // ghost state
    bytes32[] public ghostHashes;
    mapping(bytes32 visitorId => bool) public seen;
    bytes32[] public visitors;
    mapping(bytes32 visitorId => uint256) public ghostNonce;
    uint256 public ghostUnique;
    uint256 public prevCount;
    uint256 public prevUnique;
    bool public countDecreased;
    bool public uniqueDecreased;
    bool public nonceDecreased;
    /// @dev A write succeeded although the visitor was still inside the cooldown.
    bool public cooldownBroken;
    /// @dev A well-formed write (valid length, signature, deadline, outside cooldown) was rejected.
    bool public unexpectedRevert;
    mapping(bytes32 visitorId => uint256) public ghostLastSigned;
    uint256 public successes;

    constructor(Guestbook gb, address owner_) {
        GB = gb;
        OWNER = owner_;
        for (uint256 i; i < ACTORS; ++i) {
            (eoas[i], _eoaKeys[i]) = makeAddrAndKey(string.concat("eoa", vm.toString(i)));
            wallets[i] = new MockERC1271Wallet(eoas[i]);
            _passkeys[i] = 0xA000 + i;
            (_qx[i], _qy[i]) = WebAuthnHelper.publicKey(_passkeys[i]);
        }
    }

    function ghostLength() external view returns (uint256) {
        return ghostHashes.length;
    }

    function visitorCount() external view returns (uint256) {
        return visitors.length;
    }

    function visitorAt(uint256 i) external view returns (bytes32) {
        return visitors[i];
    }

    // ---------------------------------------------------------------- actions

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 2 days));
        _check();
    }

    function sign(uint256 actorSeed, uint256 msgSeed) external {
        address a = eoas[actorSeed % ACTORS];
        string memory m = _message(msgSeed);
        bytes32 vid = bytes32(uint256(uint160(a)));
        bool expected = _outsideCooldown(vid);
        vm.prank(a);
        try GB.sign(m) {
            _onSuccess(vid, m, false, expected);
        } catch {
            if (expected) unexpectedRevert = true;
        }
        _check();
    }

    function signWithWallet(uint256 actorSeed, uint256 msgSeed, bool viaContractWallet) external {
        uint256 i = actorSeed % ACTORS;
        address author = viaContractWallet ? address(wallets[i]) : eoas[i];
        bytes32 vid = bytes32(uint256(uint160(author)));
        string memory m = _message(msgSeed);
        uint256 dl = block.timestamp + 1 hours;
        bytes32 digest = GB.hashEntry(vid, m, GB.nonces(vid), dl);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_eoaKeys[i], digest);
        bool expected = _outsideCooldown(vid);
        try GB.signWithWallet(author, m, dl, abi.encodePacked(r, s, v)) {
            _onSuccess(vid, m, true, expected);
        } catch {
            if (expected) unexpectedRevert = true;
        }
        _check();
    }

    function signWithPasskey(uint256 actorSeed, uint256 msgSeed) external {
        uint256 i = actorSeed % ACTORS;
        bytes32 vid = GB.passkeyVisitorId(_qx[i], _qy[i]);
        string memory m = _message(msgSeed);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory challenge = abi.encodePacked(GB.hashEntry(vid, m, GB.nonces(vid), dl));
        WebAuthn.WebAuthnAuth memory auth = WebAuthnHelper.sign(_passkeys[i], challenge);
        bool expected = _outsideCooldown(vid);
        try GB.signWithPasskey(_qx[i], _qy[i], m, dl, auth) {
            _onSuccess(vid, m, true, expected);
        } catch {
            if (expected) unexpectedRevert = true;
        }
        _check();
    }

    function setHidden(uint256 idSeed, bool hidden) external {
        uint256 n = ghostHashes.length;
        if (n == 0) return;
        vm.prank(OWNER);
        GB.setHidden(idSeed % n, hidden);
        _check();
    }

    // ---------------------------------------------------------------- internals

    /// @dev Whether a well-formed write by `vid` must succeed right now.
    function _outsideCooldown(bytes32 vid) internal view returns (bool) {
        uint256 last = ghostLastSigned[vid];
        return last == 0 || block.timestamp >= last + GB.COOLDOWN();
    }

    function _onSuccess(bytes32 vid, string memory m, bool nonceUsed, bool expected) internal {
        if (!expected) cooldownBroken = true;
        ghostLastSigned[vid] = block.timestamp;
        _recordGhost(vid, m, nonceUsed);
    }

    function _recordGhost(bytes32 vid, string memory m, bool nonceUsed) internal {
        ghostHashes.push(keccak256(bytes(m)));
        ++successes;
        if (!seen[vid]) {
            seen[vid] = true;
            visitors.push(vid);
            ++ghostUnique;
        }
        if (nonceUsed) ++ghostNonce[vid];
    }

    /// @dev Compares live contract state with the previous observation (monotonicity flags).
    function _check() internal {
        uint256 c = GB.entryCount();
        uint256 u = GB.uniqueVisitors();
        if (c < prevCount) countDecreased = true;
        if (u < prevUnique) uniqueDecreased = true;
        prevCount = c;
        prevUnique = u;
        uint256 n = visitors.length;
        for (uint256 i; i < n; ++i) {
            if (GB.nonces(visitors[i]) < ghostNonce[visitors[i]]) nonceDecreased = true;
        }
    }

    /// @dev Message of 1-140 bytes derived from a seed (a few over-length / empty cases are not
    ///      generated: those paths are covered by the unit and Halmos tests).
    function _message(uint256 seed) internal pure returns (string memory) {
        uint256 len = (seed % 140) + 1;
        bytes memory b = new bytes(len);
        bytes32 h = keccak256(abi.encode(seed));
        for (uint256 i; i < len; ++i) {
            b[i] = h[i % 32];
        }
        return string(b);
    }
}
