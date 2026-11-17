// Test-only software WebAuthn authenticator: a real P-256 key (WebCrypto) that produces
// registration and assertion responses byte-compatible with what a browser hands back.
import { createHash } from "node:crypto";

export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_AT = 0x40;

const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
export const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
export const toHex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}` as `0x${string}`;
export const fromHex = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

// ---- minimal CBOR encoder (only what attestationObject / COSE keys need) ----
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
function head(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 0x100) return Uint8Array.of((major << 5) | 24, n);
  if (n < 0x10000) return Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff);
  throw new Error("cbor: length too large for test encoder");
}
export function cbor(v: Cbor): Uint8Array {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = new TextEncoder().encode(v);
    return concat(head(3, b.length), b);
  }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  const parts: Uint8Array[] = [head(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return concat(...parts);
}

/** COSE_Key for an EC2 P-256 ES256 key: {1: 2, 3: -7, -1: 1, -2: x, -3: y}. */
export function coseKey(x: Uint8Array, y: Uint8Array, over: { alg?: number; crv?: number } = {}): Uint8Array {
  return cbor(
    new Map<Cbor, Cbor>([
      [1, 2],
      [3, over.alg ?? -7],
      [-1, over.crv ?? 1],
      [-2, x],
      [-3, y],
    ]),
  );
}

export function attestationObject(credentialId: Uint8Array, cose: Uint8Array, rpId = "localhost"): Uint8Array {
  const authData = concat(
    sha256(new TextEncoder().encode(rpId)),
    Uint8Array.of(FLAG_UP | FLAG_UV | FLAG_AT),
    Uint8Array.of(0, 0, 0, 0),
    new Uint8Array(16), // aaguid (zero for "none" attestation)
    Uint8Array.of(credentialId.length >> 8, credentialId.length & 0xff),
    credentialId,
    cose,
  );
  return cbor(
    new Map<Cbor, Cbor>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]),
  );
}

/** SPKI DER for an uncompressed P-256 point (what `getPublicKey()` returns). */
export function spki(x: Uint8Array, y: Uint8Array): Uint8Array {
  return concat(fromHex("3059301306072a8648ce3d020106082a8648ce3d030107034200"), Uint8Array.of(4), x, y);
}

function derInt(v: bigint): Uint8Array {
  let b = fromHex(v.toString(16).padStart(64, "0"));
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  b = b.slice(i);
  if (b[0] & 0x80) b = concat(Uint8Array.of(0), b);
  return concat(Uint8Array.of(0x02, b.length), b);
}
export function derSignature(r: bigint, s: bigint): Uint8Array {
  const body = concat(derInt(r), derInt(s));
  return concat(Uint8Array.of(0x30, body.length), body);
}

export type SoftKey = { privateKey: CryptoKey; publicKey: CryptoKey; x: Uint8Array; y: Uint8Array };

export async function createSoftKey(): Promise<SoftKey> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, x: raw.slice(1, 33), y: raw.slice(33, 65) };
}

export type AssertionOptions = {
  flags?: number;
  origin?: string;
  rpId?: string;
  /** Put "challenge" before "type" to prove indices are computed, not hard-coded. */
  challengeFirst?: boolean;
  /** Force the DER signature to carry the high-s form (n - s). */
  highS?: boolean;
};

export async function makeAssertion(key: SoftKey, challenge: Uint8Array, o: AssertionOptions = {}) {
  const origin = o.origin ?? "http://localhost:3000";
  const authenticatorData = concat(
    sha256(new TextEncoder().encode(o.rpId ?? "localhost")),
    Uint8Array.of(o.flags ?? FLAG_UP | FLAG_UV),
    Uint8Array.of(0, 0, 0, 7),
  );
  const ch = `"challenge":"${b64url(challenge)}"`;
  const ty = `"type":"webauthn.get"`;
  const json = o.challengeFirst
    ? `{${ch},${ty},"origin":"${origin}","crossOrigin":false}`
    : `{${ty},${ch},"origin":"${origin}","crossOrigin":false}`;
  const clientDataJSON = new TextEncoder().encode(json);
  const signed = concat(authenticatorData, sha256(clientDataJSON));
  // WebCrypto hashes the input with SHA-256 and returns raw r || s (IEEE P1363).
  const rawSig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, ab(signed)),
  );
  const r = BigInt(toHex(rawSig.slice(0, 32)));
  let s = BigInt(toHex(rawSig.slice(32)));
  const half = P256_N / 2n;
  if (o.highS && s <= half) s = P256_N - s;
  if (o.highS === false && s > half) s = P256_N - s;
  return {
    response: {
      authenticatorData: ab(authenticatorData),
      clientDataJSON: ab(clientDataJSON),
      signature: ab(derSignature(r, s)),
      userHandle: null,
    },
    json,
    r,
    s,
  };
}

/** Wraps a response in a PublicKeyCredential-like object. */
export function credential<T>(id: Uint8Array, response: T) {
  return { id: b64url(id), rawId: ab(id), type: "public-key", response, getClientExtensionResults: () => ({}) };
}

/** In-memory Storage stand-in. */
export function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  };
}

export { ab as toArrayBuffer, sha256 };
