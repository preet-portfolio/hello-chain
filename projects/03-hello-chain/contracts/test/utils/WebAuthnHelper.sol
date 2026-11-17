// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

/// @dev Builds WebAuthn assertions the way a browser + platform authenticator does, signed with
///      Foundry's P-256 cheatcode. Used only by tests.
library WebAuthnHelper {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev secp256r1 group order.
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    bytes1 internal constant FLAG_UP = 0x01;
    bytes1 internal constant FLAG_UV = 0x04;

    string internal constant ORIGIN = "http://localhost:3000";
    string internal constant RP_ID = "localhost";

    /// @dev Index of `"type":"webauthn.get"` in the clientDataJSON produced by `clientDataJSON`.
    uint256 internal constant TYPE_INDEX = 1;
    /// @dev Index of `"challenge":"..."` (after `{"type":"webauthn.get",`).
    uint256 internal constant CHALLENGE_INDEX = 23;

    function publicKey(uint256 privateKey) internal pure returns (bytes32 qx, bytes32 qy) {
        (uint256 x, uint256 y) = vm.publicKeyP256(privateKey);
        return (bytes32(x), bytes32(y));
    }

    /// @dev rpIdHash (32) || flags (1) || signCount (4, big-endian).
    function authenticatorData(bytes1 flags) internal pure returns (bytes memory) {
        return abi.encodePacked(sha256(bytes(RP_ID)), flags, uint32(0));
    }

    /// @dev `{"type":"webauthn.get","challenge":"<base64url(challenge)>","origin":"http://localhost:3000"}`
    function clientDataJSON(bytes memory challenge) internal pure returns (string memory) {
        return string.concat(
            '{"type":"webauthn.get","challenge":"', Base64.encodeURL(challenge), '","origin":"', ORIGIN, '"}'
        );
    }

    /// @dev Assertion with UP|UV set, low-s normalised.
    function sign(uint256 privateKey, bytes memory challenge) internal pure returns (WebAuthn.WebAuthnAuth memory) {
        return sign(privateKey, challenge, FLAG_UP | FLAG_UV);
    }

    function sign(uint256 privateKey, bytes memory challenge, bytes1 flags)
        internal
        pure
        returns (WebAuthn.WebAuthnAuth memory auth)
    {
        auth.authenticatorData = authenticatorData(flags);
        auth.clientDataJSON = clientDataJSON(challenge);
        auth.typeIndex = TYPE_INDEX;
        auth.challengeIndex = CHALLENGE_INDEX;
        bytes32 h = sha256(abi.encodePacked(auth.authenticatorData, sha256(bytes(auth.clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(privateKey, h);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
        auth.r = r;
        auth.s = s;
    }
}
