// POST /api/relay — gasless guestbook entries. Thin: resolve the client IP, read the capped body,
// hand off to lib/relay (content-type → validate → filter → reserve limits → simulate → submit).
// Wire format: lib/relay/types.ts.
// Runs on the Node.js runtime (the default; segment config like `runtime`/`dynamic` is rejected under
// cacheComponents). POST handlers are never cached.
import { resolveClientIp } from "@/lib/relay/clientIp";
import { safeErrorText } from "@/lib/relay/errors";
import { busy, handleRelay, type RelayResult } from "@/lib/relay/handler";
import { getRelayDeps } from "@/lib/relay/env";
import { MAX_BODY_BYTES, readBodyCapped } from "@/lib/relay/validate";

async function relay(req: Request): Promise<RelayResult> {
  try {
    const ip = resolveClientIp(req.headers);
    if (ip === null) {
      console.error(
        "[relay] refusing request: no trusted client IP. Deploy on Vercel, or set TRUSTED_PROXY_HEADER to x-real-ip / x-forwarded-for (the header your proxy overwrites) and make sure the proxy sets it on every request.",
      );
      return busy;
    }
    const body = await readBodyCapped(req, MAX_BODY_BYTES);
    return await handleRelay({ body, ip, contentType: req.headers.get("content-type") }, getRelayDeps());
  } catch (err) {
    console.error(`[relay] route failure: ${safeErrorText(err)}`);
    return busy;
  }
}

export async function POST(req: Request): Promise<Response> {
  const result = await relay(req);
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store", ...result.headers },
  });
}
