// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Guestbook} from "../src/Guestbook.sol";
import {IGuestbook} from "../src/IGuestbook.sol";

/// @dev Minimal Halmos cheatcode interface (avoids vendoring halmos-cheatcodes).
interface Hevm {
    function warp(uint256) external;
    function prank(address) external;
    function assume(bool) external;
}

interface SVM {
    function createBytes(uint256 byteSize, string calldata name) external returns (bytes memory);
}

/// @dev Symbolic checks (Halmos) scoped to the direct `sign()` path and the counting / cooldown /
///      length rules in `_record`. The WebAuthn / P-256 path is too heavy for symbolic execution and is
///      covered by unit, fuzz and invariant tests instead.
contract GuestbookHalmosTest {
    Hevm internal constant vm = Hevm(address(uint160(uint256(keccak256("hevm cheat code")))));
    SVM internal constant svm = SVM(0xF3993A62377BCd56AE39D773740A5390411E8BC9);

    Guestbook internal gb;

    address internal constant OWNER = address(0xBEEF);
    uint40 internal constant COOLDOWN = 1 hours;

    function setUp() public {
        vm.warp(1_700_000_000);
        gb = new Guestbook(OWNER, COOLDOWN);
    }

    /// @dev A successful sign() never decreases entryCount (it grows it by exactly one); a failed one
    ///      leaves it unchanged.
    function check_countNeverDecreases(address caller, uint256 later) public {
        vm.assume(later >= block.timestamp && later < 2 ** 40);
        bytes memory msg1 = svm.createBytes(8, "m1");
        bytes memory msg2 = svm.createBytes(8, "m2");

        uint256 before1 = gb.entryCount();
        vm.prank(caller);
        try gb.sign(string(msg1)) {
            assert(gb.entryCount() == before1 + 1);
        } catch {
            assert(gb.entryCount() == before1);
        }

        vm.warp(later);
        uint256 before2 = gb.entryCount();
        assert(before2 >= before1);
        vm.prank(caller);
        try gb.sign(string(msg2)) {
            assert(gb.entryCount() == before2 + 1);
        } catch {
            assert(gb.entryCount() == before2);
        }
        assert(gb.entryCount() >= before2);
    }

    /// @dev For any cooldown in [1 hour, 1 day] and any dt < cooldown, a second sign() by the same visitor
    ///      reverts with exactly CooldownActive(firstTimestamp + cooldown); the first sign() succeeds.
    function check_cooldownEnforced(uint40 cooldown, uint40 dt) public {
        vm.assume(cooldown >= 3600 && cooldown <= 86400);
        vm.assume(dt < cooldown);
        Guestbook g = new Guestbook(OWNER, cooldown);
        address caller = address(0xCAFE);
        bytes memory m = svm.createBytes(5, "m");

        // forge-lint: disable-next-line(environment-read-across-mutation)
        uint256 t0 = block.timestamp; // Halmos has no vm.getBlockTimestamp
        vm.prank(caller);
        g.sign(string(m)); // must succeed, otherwise this path is vacuous
        assert(g.entryCount() == 1);

        vm.warp(t0 + dt);
        vm.prank(caller);
        (bool ok, bytes memory ret) = address(g).call(abi.encodeCall(g.sign, (string(m))));
        assert(!ok);
        assert(
            keccak256(ret)
                == keccak256(abi.encodeWithSelector(IGuestbook.CooldownActive.selector, uint40(t0) + cooldown))
        );
        assert(g.entryCount() == 1);
    }

    /// @dev For every length in [0, 160] outside [1, MAX_MESSAGE_BYTES], sign() reverts with exactly
    ///      MessageEmpty() (len 0) or MessageTooLong(len) (141..160). The calldata is assembled by hand so the
    ///      ABI length word is symbolic while the buffer keeps a concrete 160-byte size (Halmos cannot copy a
    ///      symbolic number of bytes); lengths above 160 are not covered here (the ABI decoder rejects them
    ///      before `_record` runs, because the calldata is too short).
    function check_lengthRule(uint256 len) public {
        vm.assume(len <= 160);
        vm.assume(len == 0 || len > 140);
        bytes memory data = svm.createBytes(160, "m");
        bytes memory cd = abi.encodePacked(gb.sign.selector, uint256(0x20), len, data);
        vm.prank(address(0xCAFE));
        (bool ok, bytes memory ret) = address(gb).call(cd);
        assert(!ok);
        if (len == 0) {
            assert(keccak256(ret) == keccak256(abi.encodeWithSelector(IGuestbook.MessageEmpty.selector)));
        } else {
            assert(keccak256(ret) == keccak256(abi.encodeWithSelector(IGuestbook.MessageTooLong.selector, len)));
        }
        assert(gb.entryCount() == 0);
    }

    /// @dev Every length in [1, MAX_MESSAGE_BYTES] is accepted (fresh visitor, symbolic content).
    ///      Halmos cannot copy a symbolic number of bytes, so the accepting range is enumerated
    ///      (needs `--loop 141`, set in halmos.toml); together with `check_lengthRule` this proves
    ///      that sign() succeeds iff 1 <= len <= 140.
    function check_lengthAccepted() public {
        for (uint256 len = 1; len <= 140; ++len) {
            bytes memory data = svm.createBytes(len, "m");
            vm.prank(address(uint160(0x1000 + len)));
            (bool ok,) = address(gb).call(abi.encodeCall(gb.sign, (string(data))));
            assert(ok);
        }
        assert(gb.entryCount() == 140);
        assert(gb.uniqueVisitors() == 140);
    }
}
