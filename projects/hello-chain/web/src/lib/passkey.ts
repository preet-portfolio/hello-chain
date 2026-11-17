// Browser-side WebAuthn passkeys (P-256 / ES256) for Guestbook.signWithPasskey.
// React-free: registration, key storage, and assertions shaped like OpenZeppelin's WebAuthn.WebAuthnAuth.
import { bytesToHex, encodeAbiParameters, hexToBytes, keccak256, type Hex } from "viem";

export const PASSKEY_STORAGE_KEY = "hello-chain.passkey.v1";

/** secp256r1 group order. OpenZeppelin's WebAuthn.verify rejects s > n/2 (malleability). */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const HALF_N = P256_N / 2n;

const COSE_ALG_ES256 = -7;
const FLAG_UV = 0x04;

export type StoredPasskey = { credentialId: string; qx: Hex; qy: Hex; visitorId: Hex };

/** Mirrors `WebAuthn.WebAuthnAuth` in OpenZeppelin 5.x field-for-field (same order). */
export type WebAuthnAuthPayload = {
  r: Hex;
  s: Hex;
  challengeIndex: bigint;
  typeIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
};

export type PasskeySignResult = { status: "ok"; auth: WebAuthnAuthPayload } | { status: "cancelled" };

// ---------------------------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------------------------

function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const toBytes = (b: ArrayBuffer | ArrayBufferView): Uint8Array =>
  b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

const toBytes32 = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}`;

const isBytes32 = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

/** Same as Guestbook.passkeyVisitorId: keccak256(abi.encode(qx, qy)). */
export function passkeyVisitorId(qx: Hex, qy: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [qx, qy]));
}

// ---------------------------------------------------------------------------------------------
// Minimal CBOR decoder: just enough for attestationObject and COSE_Key (RFC 8949 majors 0-5, 7).
// ---------------------------------------------------------------------------------------------

type CborValue = number | string | Uint8Array | CborValue[] | Map<CborValue, CborValue> | boolean | null;

function cborDecode(buf: Uint8Array, offset = 0): [CborValue, number] {
  if (offset >= buf.length) throw new Error("cbor: unexpected end");
  const ib = buf[offset++];
  const major = ib >> 5;
  const info = ib & 0x1f;
  let n: number;
  if (info < 24) n = info;
  else if (info >= 24 && info <= 27) {
    const len = 1 << (info - 24);
    if (offset + len > buf.length) throw new Error("cbor: unexpected end");
    n = 0;
    for (let i = 0; i < len; i++) n = n * 256 + buf[offset + i];
    if (!Number.isSafeInteger(n)) throw new Error("cbor: integer too large");
    offset += len;
  } else throw new Error("cbor: indefinite lengths not supported");

  switch (major) {
    case 0:
      return [n, offset];
    case 1:
      return [-1 - n, offset];
    case 2:
    case 3: {
      if (offset + n > buf.length) throw new Error("cbor: unexpected end");
      const slice = buf.slice(offset, offset + n);
      return [major === 2 ? slice : new TextDecoder("utf-8", { fatal: true }).decode(slice), offset + n];
    }
    case 4: {
      const arr: CborValue[] = [];
      for (let i = 0; i < n; i++) {
        let v: CborValue;
        [v, offset] = cborDecode(buf, offset);
        arr.push(v);
      }
      return [arr, offset];
    }
    case 5: {
      const map = new Map<CborValue, CborValue>();
      for (let i = 0; i < n; i++) {
        let k: CborValue;
        let v: CborValue;
        [k, offset] = cborDecode(buf, offset);
        [v, offset] = cborDecode(buf, offset);
        map.set(k, v);
      }
      return [map, offset];
    }
    case 7:
      if (info === 20) return [false, offset];
      if (info === 21) return [true, offset];
      if (info === 22) return [null, offset];
      throw new Error("cbor: unsupported simple value");
    default:
      throw new Error("cbor: unsupported major type (tags)");
  }
}

// ---------------------------------------------------------------------------------------------
// Public key extraction
// ---------------------------------------------------------------------------------------------

/** COSE_Key (EC2, ES256, P-256) → affine coordinates. */
export function parseCoseP256Key(cose: Uint8Array): { qx: Hex; qy: Hex } {
  const [key] = cborDecode(cose);
  if (!(key instanceof Map)) throw new Error("COSE key is not a map");
  const x = key.get(-2);
  const y = key.get(-3);
  if (key.get(1) !== 2) throw new Error("COSE key: kty must be EC2 (2)");
  if (key.get(3) !== COSE_ALG_ES256) throw new Error("COSE key: alg must be ES256 (-7)");
  if (key.get(-1) !== 1) throw new Error("COSE key: crv must be P-256 (1)");
  if (!(x instanceof Uint8Array) || x.length !== 32 || !(y instanceof Uint8Array) || y.length !== 32) {
    throw new Error("COSE key: x and y must be 32 bytes");
  }
  return { qx: bytesToHex(x), qy: bytesToHex(y) };
}

/** attestationObject (CBOR) → authData → attestedCredentialData → COSE public key. */
export function publicKeyFromAttestationObject(attestationObject: Uint8Array): { qx: Hex; qy: Hex } {
  const [att] = cborDecode(attestationObject);
  const authData = att instanceof Map ? att.get("authData") : undefined;
  if (!(authData instanceof Uint8Array)) throw new Error("attestationObject: missing authData");
  // rpIdHash(32) | flags(1) | signCount(4) | aaguid(16) | credIdLen(2) | credId | COSE key | extensions?
  if (!(authData[32] & 0x40)) throw new Error("authData: no attested credential data");
  const credIdLenAt = 32 + 1 + 4 + 16;
  if (authData.length < credIdLenAt + 2) throw new Error("authData: truncated");
  const credIdLen = (authData[credIdLenAt] << 8) | authData[credIdLenAt + 1];
  const keyStart = credIdLenAt + 2 + credIdLen;
  // The COSE key may be followed by extensions, so decode exactly one CBOR item.
  const [, keyEnd] = cborDecode(authData, keyStart);
  return parseCoseP256Key(authData.slice(keyStart, keyEnd));
}

// SubjectPublicKeyInfo header for id-ecPublicKey + prime256v1, followed by 0x04 || x || y.
const P256_SPKI_PREFIX = hexToBytes("0x3059301306072a8648ce3d020106082a8648ce3d03010703420004");

/** SPKI DER (from `AuthenticatorAttestationResponse.getPublicKey()`) → affine coordinates. */
export function publicKeyFromSpki(spki: Uint8Array): { qx: Hex; qy: Hex } {
  if (spki.length !== P256_SPKI_PREFIX.length + 64 || P256_SPKI_PREFIX.some((b, i) => spki[i] !== b)) {
    throw new Error("SPKI: not an uncompressed P-256 public key");
  }
  const off = P256_SPKI_PREFIX.length;
  return { qx: bytesToHex(spki.slice(off, off + 32)), qy: bytesToHex(spki.slice(off + 32)) };
}

// ---------------------------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------------------------

/** ASN.1 DER `SEQUENCE { INTEGER r, INTEGER s }` → (r, s). */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let p = 0;
  const fail = (): never => {
    throw new Error("Invalid DER ECDSA signature");
  };
  const readLen = (): number => {
    if (p >= der.length) fail();
    const l = der[p++];
    if (l < 0x80) return l;
    if (l === 0x81 && p < der.length) return der[p++];
    return fail();
  };
  const readInt = (): bigint => {
    if (der[p++] !== 0x02) fail();
    const len = readLen();
    if (len === 0 || len > 33 || p + len > der.length) fail();
    const v = BigInt(bytesToHex(der.slice(p, p + len)));
    p += len;
    return v;
  };
  if (der[p++] !== 0x30) fail();
  const seqLen = readLen();
  if (p + seqLen !== der.length) fail();
  const r = readInt();
  const s = readInt();
  if (p !== der.length || r === 0n || s === 0n || r >= P256_N || s >= P256_N) fail();
  return { r, s };
}

/** Maps s to the lower half of the curve order; (r, n - s) is the equivalent valid signature. */
export function normalizeS(s: bigint): bigint {
  return s > HALF_N ? P256_N - s : s;
}

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

function isStoredPasskey(v: unknown): v is StoredPasskey {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.credentialId === "string" &&
    /^[A-Za-z0-9_-]+$/.test(o.credentialId) &&
    isBytes32(o.qx) &&
    isBytes32(o.qy) &&
    isBytes32(o.visitorId) &&
    o.visitorId.toLowerCase() === passkeyVisitorId(o.qx, o.qy).toLowerCase()
  );
}

/** The stored passkey, or null if absent, unreadable, malformed, or inconsistent. */
export function loadPasskey(): StoredPasskey | null {
  try {
    const raw = globalThis.localStorage?.getItem(PASSKEY_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredPasskey(parsed)) return null;
    const { credentialId, qx, qy, visitorId } = parsed;
    return { credentialId, qx, qy, visitorId };
  } catch {
    return null;
  }
}

function savePasskey(pk: StoredPasskey): void {
  try {
    globalThis.localStorage?.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(pk));
  } catch {
    // Private mode / quota: the caller still gets the passkey for this session.
  }
}

// ---------------------------------------------------------------------------------------------
// WebAuthn ceremonies
// ---------------------------------------------------------------------------------------------

function rpId(): string {
  // Referenced statically so Next.js inlines it at build time.
  return process.env.NEXT_PUBLIC_RP_ID || window.location.hostname;
}

const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** Creates a new ES256 passkey (user verification required) and stores its public key. */
export async function registerPasskey(): Promise<StoredPasskey> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "Hello, Chain", id: rpId() },
      user: { id: randomBytes(16), name: "Guestbook visitor", displayName: "Guestbook visitor" },
      // Registration is not verified on-chain; the challenge only needs to be unpredictable.
      challenge: randomBytes(32),
      pubKeyCredParams: [{ type: "public-key", alg: COSE_ALG_ES256 }],
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      attestation: "none",
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Passkey creation returned no credential");

  const response = cred.response as AuthenticatorAttestationResponse;
  let key: { qx: Hex; qy: Hex } | undefined;
  if (typeof response.getPublicKey === "function") {
    const spki = response.getPublicKey();
    if (spki) key = publicKeyFromSpki(toBytes(spki));
  }
  key ??= publicKeyFromAttestationObject(toBytes(response.attestationObject));

  const pk: StoredPasskey = {
    credentialId: base64urlEncode(toBytes(cred.rawId)),
    qx: key.qx,
    qy: key.qy,
    visitorId: passkeyVisitorId(key.qx, key.qy),
  };
  savePasskey(pk);
  return pk;
}

/** Byte offset (as the contract sees it) of `needle` in `json`, or throws. */
function byteIndexOf(json: string, needle: string): bigint {
  const i = json.indexOf(needle);
  if (i < 0) throw new Error(`clientDataJSON is missing ${needle}`);
  return BigInt(new TextEncoder().encode(json.slice(0, i)).length);
}

/**
 * Asks the stored passkey to sign `digest` (the EIP-712 digest from Guestbook.hashEntry) and returns
 * a payload for Guestbook.signWithPasskey. Resolves `{ status: 'cancelled' }` if the user dismisses
 * the prompt or it times out; any other failure throws.
 */
export async function signWithPasskey(pk: StoredPasskey, digest: Hex): Promise<PasskeySignResult> {
  const challenge = new Uint8Array(hexToBytes(digest));
  if (challenge.length !== 32) throw new Error("digest must be 32 bytes");

  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: rpId(),
        allowCredentials: [{ type: "public-key", id: base64urlDecode(pk.credentialId) }],
        userVerification: "required",
        timeout: 120_000,
      },
    })) as PublicKeyCredential | null;
  } catch (err) {
    if (err instanceof Error && err.name === "NotAllowedError") return { status: "cancelled" };
    throw err;
  }
  if (!cred) return { status: "cancelled" };

  const response = cred.response as AuthenticatorAssertionResponse;
  const authenticatorData = toBytes(response.authenticatorData);
  if (authenticatorData.length < 37 || !(authenticatorData[32] & FLAG_UV)) {
    throw new Error("Authenticator did not perform user verification");
  }
  // Decode strictly: the contract hashes these exact bytes, so the string must round-trip.
  const clientDataJSON = new TextDecoder("utf-8", { fatal: true }).decode(toBytes(response.clientDataJSON));
  const typeIndex = byteIndexOf(clientDataJSON, '"type":"webauthn.get"');
  const challengeIndex = byteIndexOf(clientDataJSON, `"challenge":"${base64urlEncode(challenge)}"`);

  const { r, s } = parseDerSignature(toBytes(response.signature));
  return {
    status: "ok",
    auth: {
      r: toBytes32(r),
      s: toBytes32(normalizeS(s)),
      challengeIndex,
      typeIndex,
      authenticatorData: bytesToHex(authenticatorData),
      clientDataJSON,
    },
  };
}
