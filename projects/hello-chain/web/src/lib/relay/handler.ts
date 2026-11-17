// The relay flow, framework-free so it can be unit-tested with injected clients and limiter:
// burst limit → content-type → validate (bounded) → filter → reserve daily slots (visitor, IP, global) →
// balance floor → simulate/estimate → send. Daily reservations are released on every outcome except a
// successful send. IPs are keyed by ipBucket (IPv6 per /64).
import { formatEther, parseEther } from "viem";
import { isAbusive } from "@/lib/filter";
import { ipBucket } from "./clientIp";
import { safeErrorText } from "./errors";
import type { RateLimiter } from "./rateLimit";
import { submitEntry, type SubmitDeps } from "./submit";
import type { RelayResponse } from "./types";
import { parseRelayBody } from "./validate";

export const LIMITS = {
  /** Every request, valid or not. Never released. */
  ipBurst: { limit: 10, windowSec: 60 },
  /** Successful entries only: reserved before simulating, released unless the send succeeds. */
  ipDaily: { limit: 1, windowSec: 86_400 },
  visitorDaily: { limit: 1, windowSec: 86_400 },
  /** All relayed entries together, a hard ceiling on daily spend. Reserved/released like the above. */
  globalDaily: { limit: 200, windowSec: 86_400 },
} as const;

/** Below this relayer balance the relay refuses (503) instead of sending. */
export const DEFAULT_MIN_BALANCE_WEI = parseEther("0.002");

export type RelayDeps = SubmitDeps & {
  limiter: RateLimiter;
  /** Overrides LIMITS.globalDaily.limit (RELAY_GLOBAL_DAILY_LIMIT). */
  globalDailyLimit?: number;
  /** Overrides DEFAULT_MIN_BALANCE_WEI (RELAY_MIN_BALANCE_WEI). */
  minBalanceWei?: bigint;
};

export type RelayResult = { status: number; body: RelayResponse; headers?: Record<string, string> };

export type RelayInput = {
  /** Raw request body, or null if it was unreadable or over the size cap. */
  body: string | null;
  /** Client IP as resolved by resolveClientIp. */
  ip: string;
  /** The Content-Type header. Only application/json is accepted (blocks CORS simple requests). */
  contentType: string | null;
};

const invalid: RelayResult = { status: 400, body: { error: "invalid" } };
const unsupportedType: RelayResult = { status: 415, body: { error: "invalid" } };
export const busy: RelayResult = { status: 503, body: { error: "busy" } };

function tooMany(error: "cooldown" | "rateLimited" | "network", retryAfter: number): RelayResult {
  const s = Math.max(0, Math.ceil(retryAfter));
  return { status: 429, body: { error, retryAfter: s }, headers: { "Retry-After": String(s) } };
}

export function isJsonContentType(ct: string | null): boolean {
  return ct?.split(";")[0].trim().toLowerCase() === "application/json";
}

/** @param deps Clients/limiter, or null when the relayer is not configured (→ 503). */
export async function handleRelay(input: RelayInput, deps: RelayDeps | null): Promise<RelayResult> {
  if (!deps) return busy;
  const { limiter, log } = deps;
  const ipKey = ipBucket(input.ip);
  // Every successful hit here is a reservation to release unless the entry is sent.
  const reserved: string[] = [];
  let keep = false;

  try {
    const burst = await limiter.hit(`ip-min:${ipKey}`, LIMITS.ipBurst.limit, LIMITS.ipBurst.windowSec);
    if (!burst.allowed) return tooMany("rateLimited", burst.retryAfter);

    if (!isJsonContentType(input.contentType)) return unsupportedType;
    // Shape + canonical message (1-140 bytes, already trimmed) BEFORE the regex-heavy filter.
    if (input.body === null) return invalid;
    const parsed = parseRelayBody(input.body);
    if (!parsed.ok) return invalid;
    const entry = parsed.value;

    const abuse = isAbusive(entry.message);
    if (abuse.abusive) return { status: 422, body: { error: "filtered", reason: abuse.reason ?? "spam" } };

    // Atomic reservations (INCR). hit always counts, so record the key before inspecting the result.
    const visitorKey = `visitor-day:${entry.visitorId}`;
    const ipDayKey = `ip-day:${ipKey}`;
    const globalKey = "global-day";
    reserved.push(visitorKey);
    const visitor = await limiter.hit(visitorKey, LIMITS.visitorDaily.limit, LIMITS.visitorDaily.windowSec);
    reserved.push(ipDayKey);
    const ip = await limiter.hit(ipDayKey, LIMITS.ipDaily.limit, LIMITS.ipDaily.windowSec);
    if (!visitor.allowed) return tooMany("cooldown", visitor.retryAfter);
    // This visitor has not signed today, but someone else behind the same IP (or IPv6 /64) has.
    if (!ip.allowed) return tooMany("network", ip.retryAfter);
    reserved.push(globalKey);
    const globalLimit = deps.globalDailyLimit ?? LIMITS.globalDaily.limit;
    const global = await limiter.hit(globalKey, globalLimit, LIMITS.globalDaily.windowSec);
    if (!global.allowed) {
      log.error(`[relay] global daily cap of ${globalLimit} entries reached; refusing until the window resets`);
      return busy;
    }

    // Balance floor: refuse rather than send from an almost-empty relayer (getBalance errors → busy).
    const floor = deps.minBalanceWei ?? DEFAULT_MIN_BALANCE_WEI;
    const balance = await deps.publicClient.getBalance({ address: deps.account.address });
    if (balance < floor) {
      log.error(
        `[relay] relayer balance ${formatEther(balance)} ETH is below the floor of ${formatEther(floor)} ETH at ${deps.account.address}; refusing until topped up`,
      );
      return busy;
    }

    const outcome = await submitEntry(entry, deps);
    if (!outcome.ok) {
      if (outcome.error === "cooldown") return tooMany("cooldown", outcome.retryAfter);
      return outcome.error === "invalid" ? invalid : busy;
    }
    keep = true;
    return { status: 200, body: { txHash: outcome.txHash } };
  } catch (err) {
    log.error(`[relay] unexpected failure: ${safeErrorText(err)}`);
    return busy;
  } finally {
    if (!keep && reserved.length > 0) {
      await Promise.all(
        reserved.map((k) =>
          limiter.release(k).catch((err) => log.error(`[relay] failed to release ${k}: ${safeErrorText(err)}`)),
        ),
      );
    }
  }
}
