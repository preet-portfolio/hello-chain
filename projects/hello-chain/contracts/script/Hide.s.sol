// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Script, console} from "forge-std/Script.sol";
import {Guestbook} from "../src/Guestbook.sol";

/// @notice Owner moderation. Env: ENTRY_ID, HIDDEN (default true). Broadcast as the owner (--private-key/--account).
contract Hide is Script {
    function run() external {
        string memory json = vm.readFile(string.concat("./deployments/", vm.toString(block.chainid), ".json"));
        Guestbook gb = Guestbook(vm.parseJsonAddress(json, ".address"));
        uint256 id = vm.envUint("ENTRY_ID");
        bool hidden = vm.envOr("HIDDEN", true);

        vm.startBroadcast();
        gb.setHidden(id, hidden);
        vm.stopBroadcast();

        console.log("setHidden", id, hidden);
    }
}
