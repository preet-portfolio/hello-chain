// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {Guestbook} from "../src/Guestbook.sol";
import {GuestbookHandler} from "./handlers/GuestbookHandler.sol";

contract GuestbookInvariantTest is Test {
    Guestbook internal gb;
    GuestbookHandler internal handler;

    address internal owner = makeAddr("owner");

    function setUp() public {
        vm.warp(1_700_000_000);
        gb = new Guestbook(owner, 1 hours);
        handler = new GuestbookHandler(gb, owner);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = GuestbookHandler.warp.selector;
        selectors[1] = GuestbookHandler.sign.selector;
        selectors[2] = GuestbookHandler.signWithWallet.selector;
        selectors[3] = GuestbookHandler.signWithPasskey.selector;
        selectors[4] = GuestbookHandler.setHidden.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_countMatchesEntries() public view {
        assertEq(gb.entryCount(), handler.ghostLength());
    }

    function invariant_uniqueLeqEntries() public view {
        assertLe(gb.uniqueVisitors(), gb.entryCount());
        assertEq(gb.uniqueVisitors(), handler.ghostUnique());
    }

    function invariant_countsMonotonic() public view {
        assertFalse(handler.countDecreased());
        assertFalse(handler.uniqueDecreased());
    }

    function invariant_messagesImmutable() public view {
        uint256 n = handler.ghostLength();
        for (uint256 i; i < n; ++i) {
            assertEq(keccak256(bytes(gb.getEntry(i).message)), handler.ghostHashes(i));
        }
    }

    function invariant_nonceMonotonic() public view {
        assertFalse(handler.nonceDecreased());
        uint256 n = handler.visitorCount();
        for (uint256 i; i < n; ++i) {
            bytes32 vid = handler.visitorAt(i);
            assertEq(gb.nonces(vid), handler.ghostNonce(vid));
        }
    }

    /// @dev No visitor ever lands two entries less than COOLDOWN apart, and no well-formed write
    ///      outside the cooldown is rejected (the handler predicts every outcome).
    function invariant_cooldownRespected() public view {
        assertFalse(handler.cooldownBroken());
        assertFalse(handler.unexpectedRevert());
    }

    function afterInvariant() public {
        emit log_named_uint("successful writes (last run)", handler.successes());
    }
}
