// Fixed-window rate limiters. `hit` atomically counts one event (allowed while count <= limit) and
// always counts, even when denied; `release` undoes exactly one count. The daily success limits use
// hit as a *reservation* before simulating and release it on any outcome but a successful send, so
// concurrent requests cannot all slip past a check-then-act gap. Because hit and release both commute,
// releasing every non-kept hit (denied ones included) restores the exact count in any interleaving.

export type RateLimitResult = { allowed: boolean; retryAfter: number };

export interface RateLimiter {
  hit(key: string, limit: number, windowSec: number): Promise<RateLimitResult>;
  release(key: string): Promise<void>;
}

/**
 * In-process limiter for local dev and tests. On serverless it is per instance (each cold start
 * gets a fresh map), so production should set the Upstash env vars.
 */
export function memoryRateLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();

  const current = (key: string) => {
    const w = windows.get(key);
    if (w && w.resetAt > now()) return w;
    if (w) windows.delete(key);
    return undefined;
  };

  // Opportunistic sweep so the map cannot grow without bound.
  let ops = 0;
  const sweep = () => {
    if (++ops % 1000 !== 0) return;
    const t = now();
    for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
  };

  return {
    // Synchronous body: no await between read and write, so it is atomic within the process.
    async hit(key, limit, windowSec) {
      sweep();
      let w = current(key);
      if (!w) {
        w = { count: 0, resetAt: now() + windowSec * 1000 };
        windows.set(key, w);
      }
      w.count++;
      if (w.count > limit) return { allowed: false, retryAfter: Math.max(0, Math.ceil((w.resetAt - now()) / 1000)) };
      return { allowed: true, retryAfter: 0 };
    },
    async release(key) {
      const w = current(key);
      if (w && w.count > 0) w.count--;
    },
  };
}

const PREFIX = "hello-chain:rl:";

// Decrement only an existing, positive counter: a bare DECR on an expired key would create a
// TTL-less -1 that never goes away.
const RELEASE_LUA =
  "local v = tonumber(redis.call('GET', KEYS[1])) if v and v > 0 then return redis.call('DECR', KEYS[1]) end return 0";

/**
 * Upstash Redis limiter over the plain REST API (one /pipeline round trip per call) — avoids two
 * dependencies for a handful of Redis commands. Throws on any HTTP/command error; the relay handler
 * turns that into 503 busy (fail closed: the relayer spends real gas).
 */
export function upstashRateLimiter(url: string, token: string, fetchFn: typeof fetch = fetch): RateLimiter {
  const endpoint = `${url.replace(/\/+$/, "")}/pipeline`;

  async function pipeline(commands: string[][]): Promise<unknown[]> {
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
    const out = (await res.json()) as { result?: unknown; error?: string }[];
    if (!Array.isArray(out) || out.length !== commands.length) throw new Error("Upstash: malformed response");
    for (const r of out) if (r?.error) throw new Error("Upstash command error");
    return out.map((r) => r.result);
  }

  // TTL is -1 (no expiry) or -2 (missing) in edge cases; fall back to the full window.
  const ttlOr = (ttl: unknown, windowSec: number) => (typeof ttl === "number" && ttl >= 0 ? ttl : windowSec);

  return {
    async hit(key, limit, windowSec) {
      const k = PREFIX + key;
      // SET NX EX starts the window only if absent; INCR (atomic) then counts this hit.
      const [, count, ttl] = await pipeline([
        ["SET", k, "0", "EX", String(windowSec), "NX"],
        ["INCR", k],
        ["TTL", k],
      ]);
      if (Number(count) > limit) return { allowed: false, retryAfter: ttlOr(ttl, windowSec) };
      return { allowed: true, retryAfter: 0 };
    },
    async release(key) {
      await pipeline([["EVAL", RELEASE_LUA, "1", PREFIX + key]]);
    },
  };
}
