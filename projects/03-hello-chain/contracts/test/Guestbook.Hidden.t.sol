// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Guestbook} from "../src/Guestbook.sol";
import {IGuestbook} from "../src/IGuestbook.sol";

contract GuestbookHiddenTest is Test {
    Guestbook internal gb;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal newOwner = makeAddr("newOwner");

    function setUp() public {
        vm.warp(1_700_000_000);
        gb = new Guestbook(owner, 1 days);
        vm.prank(alice);
        gb.sign("hello");
    }

    function test_ownerHides_emits() public {
        IGuestbook.EntryView memory before_ = gb.getEntry(0);

        vm.expectEmit(true, false, false, true, address(gb));
        emit IGuestbook.HiddenSet(0, true);
        vm.prank(owner);
        gb.setHidden(0, true);

        assertTrue(gb.isHidden(0));
        IGuestbook.EntryView memory after_ = gb.getEntry(0);
        assertTrue(after_.hidden);
        assertEq(after_.message, "hello");
        assertEq(after_.message, before_.message);
        assertEq(after_.timestamp, before_.timestamp);
        assertEq(after_.visitorId, before_.visitorId);
        assertTrue(gb.getEntries(0, 10)[0].hidden);
        assertTrue(gb.latest(10)[0].hidden);
    }

    function test_unhide() public {
        vm.startPrank(owner);
        gb.setHidden(0, true);
        vm.expectEmit(true, false, false, true, address(gb));
        emit IGuestbook.HiddenSet(0, false);
        gb.setHidden(0, false);
        vm.stopPrank();

        assertFalse(gb.isHidden(0));
        assertFalse(gb.getEntry(0).hidden);
        assertEq(gb.getEntry(0).message, "hello");
    }

    /// @notice Hiding is the owner's only form of moderation, and it must never lower the counters.
    /// @dev The invariant suite (`invariant_countsMonotonic`) checks this across random call sequences;
    ///      this is the direct, readable version of the same claim.
    function test_countNeverDecreasesWhenHiding() public {
        vm.prank(bob);
        gb.sign("hi from bob");
        assertEq(gb.entryCount(), 2);
        assertEq(gb.uniqueVisitors(), 2);

        vm.prank(owner);
        gb.setHidden(0, true);
        assertEq(gb.entryCount(), 2);
        assertEq(gb.uniqueVisitors(), 2);
    }

    function test_revert_nonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        gb.setHidden(0, true);
    }

    function test_revert_missingId() public {
        vm.expectRevert(abi.encodeWithSelector(IGuestbook.EntryNotFound.selector, 1));
        vm.prank(owner);
        gb.setHidden(1, true);

        vm.expectRevert(abi.encodeWithSelector(IGuestbook.EntryNotFound.selector, 7));
        gb.isHidden(7);
    }

    function test_ownershipTwoStep() public {
        vm.prank(owner);
        gb.transferOwnership(newOwner);
        assertEq(gb.owner(), owner);
        assertEq(gb.pendingOwner(), newOwner);

        // old owner still in charge until acceptance
        vm.prank(newOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, newOwner));
        gb.setHidden(0, true);

        vm.prank(newOwner);
        gb.acceptOwnership();
        assertEq(gb.owner(), newOwner);

        vm.prank(newOwner);
        gb.setHidden(0, true);
        assertTrue(gb.isHidden(0));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        gb.setHidden(0, false);
    }

    function test_revert_renounceOwnership() public {
        vm.expectRevert(IGuestbook.RenounceDisabled.selector);
        vm.prank(owner);
        gb.renounceOwnership();
        assertEq(gb.owner(), owner);

        vm.expectRevert(IGuestbook.RenounceDisabled.selector);
        vm.prank(alice);
        gb.renounceOwnership();
    }
}
