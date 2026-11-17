// Request parsing for the relayer. Bounded work only: everything here runs before the abuse filter,
// whose DOMAIN regex is super-linear on long input, so the message is length-checked first.
import { getAddress, isAddress, maxUint256, pad, type Address, type Hex } from "viem";
import { validateMessage } from "@/lib/message";
import { passkeyVisitorId, type WebAuthnAuthPayload } from "@/lib/passkey";

export const MAX_BODY_BYTES = 8 * 1024;

export type RelayEntry =
  | {
      kind: "passkey";
      visitorId: Hex;
      qx: Hex;
      qy: Hex;
      message: string;
      deadline: bigint;
      auth: WebAuthnAuthPayload;
    }
  | {
      kind: "wallet";
      visitorId: Hex;
      author: Address;
      message: string;
      deadline: bigint;
      signature: Hex;
    };

export type ParseResult = { ok: true; value: RelayEntry } | { ok: false };

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})+$/;
const DECIMAL = /^(?:0|[1-9]\d{0,77})$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const bytes32 = (v: unknown): Hex | null => (typeof v === "string" && BYTES32.test(v) ? (v as Hex) : null);
const hexBytes = (v: unknown): Hex | null => (typeof v === "string" && HEX_BYTES.test(v) ? (v as Hex) : null);

/** Decimal string or non-negative safe integer → uint256 bigint. */
function uint(v: unknown): bigint | null {
  let n: bigint;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) return null;
    n = BigInt(v);
  } else if (typeof v === "string" && DECIMAL.test(v)) {
    n = BigInt(v);
  } else return null;
  return n <= maxUint256 ? n : null;
}

/** Wallet visitor id: the address left-padded to bytes32 (matches Guestbook._visitorId). */
export function walletVisitorId(author: Address): Hex {
  return pad(author.toLowerCase() as Hex, { size: 32 });
}

/** The message must already be canonical: the signature covers these exact bytes. */
function canonicalMessage(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = validateMessage(v);
  return m.ok && m.value === v ? v : null;
}

function parseAuth(v: unknown): WebAuthnAuthPayload | null {
  if (!isObject(v)) return null;
  const r = bytes32(v.r);
  const s = bytes32(v.s);
  const challengeIndex = uint(v.challengeIndex);
  const typeIndex = uint(v.typeIndex);
  const authenticatorData = hexBytes(v.authenticatorData);
  const clientDataJSON = typeof v.clientDataJSON === "string" ? v.clientDataJSON : null;
  if (!r || !s || challengeIndex === null || typeIndex === null || !authenticatorData || clientDataJSON === null) {
    return null;
  }
  return { r, s, challengeIndex, typeIndex, authenticatorData, clientDataJSON };
}

/** Parses and validates a raw JSON body. Computes visitorId server-side (ignores any sent). */
export function parseRelayBody(raw: string): ParseResult {
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return { ok: false };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!isObject(body)) return { ok: false };

  const message = canonicalMessage(body.message);
  const deadline = uint(body.deadline);
  if (message === null || deadline === null) return { ok: false };

  if (body.kind === "passkey") {
    const qx = bytes32(body.qx);
    const qy = bytes32(body.qy);
    const auth = parseAuth(body.auth);
    if (!qx || !qy || !auth) return { ok: false };
    return { ok: true, value: { kind: "passkey", visitorId: passkeyVisitorId(qx, qy), qx, qy, message, deadline, auth } };
  }
  if (body.kind === "wallet") {
    const signature = hexBytes(body.signature);
    if (typeof body.author !== "string" || !isAddress(body.author, { strict: false }) || !signature) {
      return { ok: false };
    }
    const author = getAddress(body.author);
    return { ok: true, value: { kind: "wallet", visitorId: walletVisitorId(author), author, message, deadline, signature } };
  }
  return { ok: false };
}

/**
 * Reads a request body as UTF-8, giving up (null) as soon as it exceeds `maxBytes` — whether
 * declared by Content-Length or actually streamed — so an oversize body is never buffered whole.
 */
export async function readBodyCapped(req: Request, maxBytes = MAX_BODY_BYTES): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}
