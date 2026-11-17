// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Minimal smart-contract wallet: a signature is valid when its ECDSA signer is `signer`.
contract MockERC1271Wallet is IERC1271 {
    address public immutable SIGNER;

    constructor(address signer) {
        SIGNER = signer;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == SIGNER) return IERC1271.isValidSignature.selector;
        return 0xffffffff;
    }
}
