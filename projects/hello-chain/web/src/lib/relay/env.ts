// Server-only wiring of the relayer from environment variables. Built once per server instance.
import { createPublicClient, createWalletClient, http, isHex, nonceManager } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activeChain } from "@/lib/chain";
import { guestbookAddress } from "@/lib/contract";
import { DEFAULT_MIN_BALANCE_WEI, LIMITS, type RelayDeps } from "./handler";
import { memoryRateLimiter, upstashRateLimiter } from "./rateLimit";

let cached: RelayDeps | null | undefined;

type LimitEnv = { RELAY_GLOBAL_DAILY_LIMIT?: string; RELAY_MIN_BALANCE_WEI?: string; [key: string]: string | undefined };

/** Spend guards from env: positive integers only, otherwise the defaults (200 entries/day, 0.002 ETH). */
export function relayLimitsFromEnv(env: LimitEnv = process.env): { globalDailyLimit: number; minBalanceWei: bigint } {
  const cap = env.RELAY_GLOBAL_DAILY_LIMIT?.trim();
  const floor = env.RELAY_MIN_BALANCE_WEI?.trim();
  return {
    globalDailyLimit: cap && /^\d+$/.test(cap) && Number(cap) > 0 ? Number(cap) : LIMITS.globalDaily.limit,
    minBalanceWei: floor && /^\d+$/.test(floor) ? BigInt(floor) : DEFAULT_MIN_BALANCE_WEI,
  };
}

/**
 * A Vercel production deployment must share its rate limits through Upstash: the in-memory limiter is
 * per serverless instance, so every cold start would hand out fresh daily slots.
 */
export function upstashRequired(env: { VERCEL?: string; NODE_ENV?: string } = process.env): boolean {
  return env.VERCEL === "1" && env.NODE_ENV === "production";
}

function build(): RelayDeps | null {
  const log = console;
  const contract = guestbookAddress[activeChain.id];
  if (!contract) {
    log.error(`[relay] no Guestbook address for chain ${activeChain.id}; run \`pnpm sync:contract\` after deploying`);
    return null;
  }

  const key = process.env.RELAYER_PRIVATE_KEY?.trim();
  if (!key) {
    log.error("[relay] RELAYER_PRIVATE_KEY is not set; the relayer is disabled");
    return null;
  }
  let account;
  try {
    const hexKey = (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
    if (!isHex(hexKey) || hexKey.length !== 66) throw new Error("bad length");
    account = privateKeyToAccount(hexKey, { nonceManager });
  } catch {
    // Never echo the key (or the underlying error, which may contain it).
    log.error("[relay] RELAYER_PRIVATE_KEY is malformed (expected 32-byte hex); the relayer is disabled");
    return null;
  }

  const rpcUrl = process.env.RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || undefined;
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: activeChain, transport });
  const walletClient = createWalletClient({ account, chain: activeChain, transport });

  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!(upstashUrl && upstashToken) && upstashRequired()) {
    log.error(
      "[relay] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set on a Vercel production deployment; the relayer is disabled (per-instance memory limits would not hold)",
    );
    return null;
  }
  const limiter =
    upstashUrl && upstashToken ? upstashRateLimiter(upstashUrl, upstashToken) : memoryRateLimiter();
  if (!(upstashUrl && upstashToken) && process.env.NODE_ENV === "production") {
    log.warn("[relay] Upstash not configured: using the per-instance memory rate limiter");
  }

  return {
    // Thin adapters: the handler only needs these calls, and tests inject fakes of the same shape.
    publicClient: {
      // Narrow the union so viem can type-check each call's args against the ABI.
      simulateContract: (p) =>
        p.functionName === "signWithPasskey" ? publicClient.simulateContract(p) : publicClient.simulateContract(p),
      estimateContractGas: (p) =>
        p.functionName === "signWithPasskey"
          ? publicClient.estimateContractGas(p)
          : publicClient.estimateContractGas(p),
      getBlock: () => publicClient.getBlock(),
      getBalance: (p) => publicClient.getBalance(p),
    },
    walletClient: {
      writeContract: (request) =>
        walletClient.writeContract(request as Parameters<typeof walletClient.writeContract>[0]),
    },
    account,
    contract,
    limiter,
    log,
    ...relayLimitsFromEnv(),
  };
}

/** Relay dependencies, or null (→ 503 busy) when the key or contract address is missing. */
export function getRelayDeps(): RelayDeps | null {
  if (cached === undefined) cached = build();
  return cached;
}
