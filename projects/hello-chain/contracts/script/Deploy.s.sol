// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Guestbook} from "../src/Guestbook.sol";

/// @notice Deploys Guestbook and records {address, blockNumber} in deployments/<chainId>.json.
/// Env: OWNER (default: the broadcaster), COOLDOWN seconds (default 86400).
contract Deploy is Script {
    function run() external returns (Guestbook gb) {
        // Use the broadcaster (the account passed via --private-key/--account/--sender) unless OWNER is set.
        (, address broadcaster,) = vm.readCallers();
        address owner = vm.envOr("OWNER", broadcaster);
        uint40 cooldown = uint40(vm.envOr("COOLDOWN", uint256(86400)));

        vm.startBroadcast();
        gb = new Guestbook(owner, cooldown);
        vm.stopBroadcast();

        // Dry runs (no --broadcast) simulate the deploy; only a real broadcast may record an address.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            _record(address(gb));
        }

        console.log("Guestbook deployed at", address(gb));
        console.log("owner", owner);
        console.log("cooldown", cooldown);
    }

    function _record(address gb) private {
        string memory key = "deployment";
        vm.serializeAddress(key, "address", gb);
        string memory json = vm.serializeUint(key, "blockNumber", block.number);
        string memory path = string.concat("./deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        vm.writeLine(path, ""); // trailing newline
    }
}
