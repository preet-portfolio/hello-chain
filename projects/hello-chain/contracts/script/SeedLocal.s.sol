// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Script, console} from "forge-std/Script.sol";
import {Guestbook} from "../src/Guestbook.sol";

/// @notice Local-only: signs three sample entries, each from a different account (24h cooldown per visitor).
/// Reads deployments/<chainId>.json. Keys come from SEED_PK_1..3; the fallbacks are anvil's PUBLIC, well-known
/// dev keys #1..#3 (never hold value on any real network). Do not point this script at a live chain.
contract SeedLocal is Script {
    // anvil default accounts #1, #2, #3 (public dev keys, deterministic from the standard test mnemonic)
    uint256 internal constant ANVIL_PK_1 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant ANVIL_PK_2 = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 internal constant ANVIL_PK_3 = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;

    function run() external {
        require(block.chainid == 31337, "SeedLocal is for local anvil only");
        string memory json = vm.readFile(string.concat("./deployments/", vm.toString(block.chainid), ".json"));
        Guestbook gb = Guestbook(vm.parseJsonAddress(json, ".address"));

        _sign(gb, vm.envOr("SEED_PK_1", ANVIL_PK_1), unicode"Hello from the first visitor 👋");
        _sign(gb, vm.envOr("SEED_PK_2", ANVIL_PK_2), unicode"gm! Loving this little onchain guestbook ☀️");
        _sign(
            gb, vm.envOr("SEED_PK_3", ANVIL_PK_3), unicode"Just passing through. Thanks for the smart contracts lesson!"
        );

        console.log("entryCount", gb.entryCount());
    }

    function _sign(Guestbook gb, uint256 pk, string memory message) internal {
        vm.startBroadcast(pk);
        gb.sign(message);
        vm.stopBroadcast();
    }
}
