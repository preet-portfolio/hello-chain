// Which client IP the per-IP limits key on. Forwarding headers are client-controlled unless the
// deployment's own proxy rewrites them, so exactly one header is trusted, and only when we know the
// proxy overwrites it. There is never a fallback from a rewritten header to one that may be passed
// through from the client.

export type IpEnv = { VERCEL?: string; TRUSTED_PROXY_HEADER?: string; NODE_ENV?: string };

const clean = (s: string | null | undefined) => {
  const v = s?.trim();
  return v ? v.slice(0, 64) : undefined;
};

/**
 * - Vercel (VERCEL=1): its edge overwrites x-forwarded-for, so the first hop is the client.
 * - TRUSTED_PROXY_HEADER=x-real-ip: our proxy overwrites x-real-ip with the peer address; read only it.
 * - TRUSTED_PROXY_HEADER=x-forwarded-for: our proxy appends the peer; read only its LAST hop.
 *   With either value, a missing/blank header returns null (fail closed; never one shared bucket).
 * - Anything else: production → null (caller answers 503); development → "dev-local".
 */
export function resolveClientIp(headers: Headers, env: IpEnv = process.env): string | null {
  if (env.VERCEL === "1") {
    return clean(headers.get("x-forwarded-for")?.split(",")[0]) ?? clean(headers.get("x-real-ip")) ?? "unknown";
  }
  if (env.TRUSTED_PROXY_HEADER === "x-real-ip") {
    return clean(headers.get("x-real-ip")) ?? null;
  }
  if (env.TRUSTED_PROXY_HEADER === "x-forwarded-for") {
    return clean(headers.get("x-forwarded-for")?.split(",").at(-1)) ?? null;
  }
  return env.NODE_ENV === "production" ? null : "dev-local";
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Eight 16-bit groups of an IPv6 address (a trailing dotted IPv4 counts as two), or null if malformed. */
function ipv6Groups(addr: string): number[] | null {
  let s = addr.toLowerCase();
  const v4 = s.match(/:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const o = v4[1].split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    s = `${s.slice(0, -v4[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (h: string) => (h === "" ? [] : h.split(":"));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * The rate-limit bucket for a client address. One subscriber is routinely handed a whole IPv6 /64,
 * so IPv6 addresses are keyed by their /64 prefix (normalised: lowercase, `::` expanded, no zone or
 * brackets); otherwise anyone with a /64 would have ~2^64 "different" IPs. IPv4 addresses, including
 * IPv4-mapped IPv6 (::ffff:a.b.c.d), are keyed per address. Anything else ("dev-local") is unchanged.
 */
export function ipBucket(ip: string): string {
  const s = ip.trim().replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "");
  if (IPV4.test(s)) return s;
  if (!s.includes(":")) return ip;
  const g = ipv6Groups(s);
  if (!g) return ip;
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join(".");
  }
  return `${g
    .slice(0, 4)
    .map((n) => n.toString(16))
    .join(":")}::/64`;
}
