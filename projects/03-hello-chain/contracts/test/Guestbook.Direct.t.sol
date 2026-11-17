// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {Guestbook} from "../src/Guestbook.sol";
import {IGuestbook} from "../src/IGuestbook.sol";

contract GuestbookDirectTest is Test {
    Guestbook internal gb;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint40 internal constant COOLDOWN = 1 days;

    function setUp() public {
        vm.warp(1_700_000_000);
        gb = new Guestbook(owner, COOLDOWN);
    }

    function _vid(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _bytesOfLength(uint256 n) internal pure returns (string memory) {
        return string(new bytes(n));
    }

    function test_sign_storesEntryAndEmits() public {
        vm.expectEmit(true, true, false, true, address(gb));
        emit IGuestbook.Signed(0, _vid(alice), IGuestbook.Kind.Direct, "hi", uint40(vm.getBlockTimestamp()));

        vm.prank(alice);
        uint256 id = gb.sign("hi");

        assertEq(id, 0);
        assertEq(gb.entryCount(), 1);
        assertEq(gb.uniqueVisitors(), 1);
        assertEq(gb.lastSignedAt(_vid(alice)), uint40(vm.getBlockTimestamp()));

        IGuestbook.EntryView memory e = gb.getEntry(0);
        assertEq(e.id, 0);
        assertEq(e.visitorId, _vid(alice));
        assertEq(e.timestamp, uint40(vm.getBlockTimestamp()));
        assertEq(uint8(e.kind), uint8(IGuestbook.Kind.Direct));
        assertFalse(e.hidden);
        assertEq(e.message, "hi");
    }

    function test_revert_emptyMessage() public {
        vm.prank(alice);
        vm.expectRevert(IGuestbook.MessageEmpty.selector);
        gb.sign("");
    }

    function test_revert_141Bytes() public {
        string memory m = _bytesOfLength(141);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGuestbook.MessageTooLong.selector, 141));
        gb.sign(m);
    }

    function test_accepts_140Bytes() public {
        string memory m = _bytesOfLength(140);
        vm.prank(alice);
        uint256 id = gb.sign(m);
        assertEq(id, 0);
        assertEq(bytes(gb.getEntry(0).message).length, 140);
    }

    function testFuzz_lengthRule(bytes calldata raw) public {
        string memory m = string(raw);
        vm.prank(alice);
        if (raw.length == 0) {
            vm.expectRevert(IGuestbook.MessageEmpty.selector);
        } else if (raw.length > 140) {
            vm.expectRevert(abi.encodeWithSelector(IGuestbook.MessageTooLong.selector, raw.length));
        }
        gb.sign(m);
        if (raw.length >= 1 && raw.length <= 140) {
            assertEq(gb.entryCount(), 1);
        } else {
            assertEq(gb.entryCount(), 0);
        }
    }

    function test_revert_withinCooldown() public {
        uint40 t0 = uint40(vm.getBlockTimestamp());
        vm.prank(alice);
        gb.sign("one");

        vm.warp(t0 + COOLDOWN - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGuestbook.CooldownActive.selector, t0 + COOLDOWN));
        gb.sign("two");
    }

    function test_allows_afterCooldown() public {
        uint40 t0 = uint40(vm.getBlockTimestamp());
        vm.prank(alice);
        gb.sign("one");

        vm.warp(t0 + COOLDOWN);
        vm.prank(alice);
        uint256 id = gb.sign("two");

        assertEq(id, 1);
        assertEq(gb.uniqueVisitors(), 1);
        assertEq(gb.entryCount(), 2);
        assertEq(gb.lastSignedAt(_vid(alice)), t0 + COOLDOWN);
    }

    function test_cooldownIsPerVisitor() public {
        vm.prank(alice);
        gb.sign("a");
        vm.prank(bob);
        gb.sign("b");
        assertEq(gb.uniqueVisitors(), 2);
        assertEq(gb.entryCount(), 2);
    }

    function test_constructor_rejectsCooldown() public {
        vm.expectRevert(abi.encodeWithSelector(IGuestbook.CooldownOutOfRange.selector, uint40(3599)));
        new Guestbook(owner, 3599);

        vm.expectRevert(abi.encodeWithSelector(IGuestbook.CooldownOutOfRange.selector, uint40(86401)));
        new Guestbook(owner, 86401);
    }

    function test_constructor_acceptsBounds() public {
        assertEq(new Guestbook(owner, 3600).COOLDOWN(), 3600);
        assertEq(new Guestbook(owner, 86400).COOLDOWN(), 86400);
        assertEq(gb.owner(), owner);
    }

    function _fill(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            address a = address(uint160(0x1000 + i));
            vm.prank(a);
            gb.sign("x");
        }
    }

    function test_getEntries_clampsAndCaps() public {
        _fill(3);

        IGuestbook.EntryView[] memory page = gb.getEntries(1, 50);
        assertEq(page.length, 2);
        assertEq(page[0].id, 1);
        assertEq(page[1].id, 2);

        assertEq(gb.getEntries(5, 10).length, 0);
        assertEq(gb.getEntries(3, 10).length, 0);

        vm.expectRevert(abi.encodeWithSelector(IGuestbook.PageTooLarge.selector, 51));
        gb.getEntries(0, 51);
    }

    function test_latest_newestFirst() public {
        _fill(3);

        IGuestbook.EntryView[] memory page = gb.latest(3);
        assertEq(page.length, 3);
        assertEq(page[0].id, 2);
        assertEq(page[1].id, 1);
        assertEq(page[2].id, 0);

        assertEq(gb.latest(2).length, 2);
        assertEq(gb.latest(10).length, 3);
        assertEq(gb.latest(0).length, 0);

        vm.expectRevert(abi.encodeWithSelector(IGuestbook.PageTooLarge.selector, 51));
        gb.latest(51);
    }

    function test_latest_empty() public view {
        assertEq(gb.latest(5).length, 0);
    }

    function test_getEntry_missing() public {
        vm.expectRevert(abi.encodeWithSelector(IGuestbook.EntryNotFound.selector, 0));
        gb.getEntry(0);
    }
}
