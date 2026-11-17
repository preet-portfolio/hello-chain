import { createPublicClient, http } from "viem";
import { anvil, baseSepolia } from "viem/chains";

const isLocal = process.env.NEXT_PUBLIC_CHAIN_ID === "31337";

export const activeChain = isLocal ? anvil : baseSepolia;

export const publicClient = createPublicClient({
  chain: activeChain,
  transport: http(process.env.NEXT_PUBLIC_RPC_URL || undefined),
});
