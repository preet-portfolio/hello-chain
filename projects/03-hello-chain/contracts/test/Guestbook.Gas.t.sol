// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test, console} from "forge-std/Test.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {Guestbook} from "../src/Guestbook.sol";
import {WebAuthnHelper} from "./utils/WebAuthnHelper.sol";

/// @notice Measures each write path for the predicted-vs-measured table in notes/ch03-hello-world.md.
/// @dev Forge 1.9 runs tests in isolation mode by default (`isolate = true`): every top-level call is
///      executed as its own transaction, so `vm.lastFrameGas().gasTotalUsed` is the full transaction gas
///      (21,000 base + calldata + execution), identical to a receipt's gasUsed on anvil. This file
///      subtracts the intrinsic part it can compute exactly and asserts the EXECUTION gas is within
///      +-10 % of the first-principles prediction. Every call is a fresh visitor's first sign into an
///      empty guestbook, so every touched slot starts cold and zero.
contract GuestbookGasTest is Test {
    Guestbook internal gb;
    address internal relayer = makeAddr("relayer");
    uint256 internal constant PASSKEY = 0xA11CE;
    uint256 internal constant TOLERANCE = 0.1e18; // +-10 %

    // Predicted execution gas (excludes the 21,000 base and calldata); derivation in the notes.
    uint256 internal constant PRED_SIGN_SHORT = 138_000; // 5-byte message, stored inline in one slot
    uint256 internal constant PRED_SIGN_140 = 250_000; // 140-byte message: length slot + 5 data slots
    uint256 internal constant PRED_WALLET_SHORT = 167_500; // + nonce slot, cold EXTCODESIZE, ecrecover, EIP-712
    uint256 internal constant PRED_PASSKEY_PRECOMPILE = 174_000; // + nonce slot, WebAuthn checks, P256VERIFY

    function setUp() public {
        vm.warp(1_700_000_000);
        gb = new Guestbook(makeAddr("owner"), 1 days);
    }

    /// @dev EIP-2028 calldata cost: 16 per non-zero byte, 4 per zero byte. (The EIP-7623 floor of
    ///      Prague+ never binds here: execution dwarfs it.)
    function _intrinsic(bytes memory data) internal pure returns (uint256 gas) {
        gas = 21_000;
        for (uint256 i; i < data.length; ++i) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }

    function _report(string memory label, bytes memory data, uint256 predictedExec) internal view {
        uint256 total = vm.lastFrameGas().gasTotalUsed;
        uint256 intrinsic = _intrinsic(data);
        uint256 exec = total - intrinsic;
        console.log(label);
        console.log("  tx total", total);
        console.log("  intrinsic (21000 + calldata)", intrinsic);
        console.log("  execution", exec);
        console.log("  predicted execution", predictedExec);
        assertApproxEqRel(exec, predictedExec, TOLERANCE);
    }

    function _string(uint256 n) internal pure returns (string memory s) {
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = "a";
        }
        s = string(b);
    }

    function test_gas_sign_short() public {
        vm.prank(makeAddr("alice"));
        gb.sign("hello");
        _report("sign, 5-byte message", abi.encodeCall(Guestbook.sign, ("hello")), PRED_SIGN_SHORT);
    }

    function test_gas_sign_140() public {
        string memory m = _string(140);
        vm.prank(makeAddr("alice"));
        gb.sign(m);
        _report("sign, 140-byte message", abi.encodeCall(Guestbook.sign, (m)), PRED_SIGN_140);
    }

    function test_gas_signWithWallet_short() public {
        (address alice, uint256 key) = makeAddrAndKey("alice");
        uint256 dl = block.timestamp + 1 hours;
        bytes32 digest = gb.hashEntry(bytes32(uint256(uint160(alice))), "hello", 0, dl);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(relayer);
        gb.signWithWallet(alice, "hello", dl, sig);
        _report(
            "signWithWallet (EOA, ECDSA), 5-byte message",
            abi.encodeCall(Guestbook.signWithWallet, (alice, "hello", dl, sig)),
            PRED_WALLET_SHORT
        );
    }

    function _passkeyCall() internal returns (bytes memory data) {
        return _passkeyCall("hello");
    }

    function _passkeyCall(string memory message) internal returns (bytes memory data) {
        (bytes32 qx, bytes32 qy) = WebAuthnHelper.publicKey(PASSKEY);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory challenge = abi.encodePacked(gb.hashEntry(gb.passkeyVisitorId(qx, qy), message, 0, dl));
        WebAuthn.WebAuthnAuth memory auth = WebAuthnHelper.sign(PASSKEY, challenge);
        data = abi.encodeCall(Guestbook.signWithPasskey, (qx, qy, message, dl, auth));

        vm.prank(relayer);
        gb.signWithPasskey(qx, qy, message, dl, auth);
    }

    /// @dev Osaka rules include the P256VERIFY precompile at 0x100 (EIP-7951, 6,900 gas), the same
    ///      address RIP-7212 uses on rollups such as Base.
    function test_gas_signWithPasskey_precompile() public {
        vm.setEvmVersion("osaka");
        bytes memory data = _passkeyCall();
        _report("signWithPasskey, P256VERIFY precompile (osaka), 5-byte message", data, PRED_PASSKEY_PRECOMPILE);
    }

    /// @dev The project's evm_version is cancun, which has no precompile at 0x100, so OpenZeppelin's
    ///      P256 falls back to its pure-Solidity verifier. Measured only; the difference to the test
    ///      above is the price of verifying P-256 in EVM bytecode.
    function test_gas_signWithPasskey_solidityFallback() public {
        bytes memory data = _passkeyCall();
        uint256 total = vm.lastFrameGas().gasTotalUsed;
        console.log("signWithPasskey, Solidity P-256 fallback (cancun), 5-byte message");
        console.log("  tx total", total);
        console.log("  execution", total - _intrinsic(data));
        assertGt(total - _intrinsic(data), 2 * PRED_PASSKEY_PRECOMPILE);
    }

    /// @dev Worst case the relayer pays for: longest message, no precompile. web/src/lib/relay/submit.ts
    ///      caps relayed transactions at MAX_RELAY_GAS = 700,000; this keeps that ceiling honest if the
    ///      contract or OpenZeppelin's WebAuthn/P256 code changes.
    function test_gas_signWithPasskey_140_solidityFallback_underRelayCap() public {
        _passkeyCall(_string(140));
        uint256 total = vm.lastFrameGas().gasTotalUsed;
        console.log("signWithPasskey, Solidity P-256 fallback (cancun), 140-byte message: tx total", total);
        assertLt(total, 700_000);
    }
}
