import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, encodeAbiParameters, hashTypedData, http, keccak256 } from "viem";
import { guestbookAbi } from "@/lib/contract";
import { typedDataFor } from "@/lib/typedData";
import {
  PASSKEY_STORAGE_KEY,
  type StoredPasskey,
  loadPasskey,
  normalizeS,
  parseCoseP256Key,
  parseDerSignature,
  publicKeyFromAttestationObject,
  publicKeyFromSpki,
  registerPasskey,
  signWithPasskey,
} from "@/lib/passkey";
import {
  FLAG_UP,
  P256_N,
  attestationObject,
  b64url,
  coseKey,
  createSoftKey,
  credential,
  derSignature,
  fromHex,
  makeAssertion,
  memoryStorage,
  sha256,
  spki,
  toArrayBuffer,
  toHex,
  type AssertionOptions,
  type SoftKey,
} from "../support/softAuthenticator";

// P-256 generator point G: a fixed, publicly known key used as the COSE fixture.
const GX = "0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296" as const;
const GY = "0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5" as const;
const vidOf = (qx: `0x${string}`, qy: `0x${string}`) =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [qx, qy]));

const create = vi.fn();
const get = vi.fn();
let storage: Storage;

beforeEach(() => {
  storage = memoryStorage();
  create.mockReset();
  get.mockReset();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("navigator", { credentials: { create, get } });
  vi.stubGlobal("window", { location: { hostname: "localhost" } });
  vi.stubEnv("NEXT_PUBLIC_RP_ID", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const validStored = (): StoredPasskey => ({
  credentialId: "AQIDBA",
  qx: GX,
  qy: GY,
  visitorId: vidOf(GX, GY),
});

describe("COSE / SPKI key parsing", () => {
  it("parses COSE P-256 key into qx/qy", () => {
    expect(parseCoseP256Key(coseKey(fromHex(GX), fromHex(GY)))).toEqual({ qx: GX, qy: GY });
  });

  it("rejects COSE keys that are not ES256 on P-256", () => {
    expect(() => parseCoseP256Key(coseKey(fromHex(GX), fromHex(GY), { alg: -8 }))).toThrow();
    expect(() => parseCoseP256Key(coseKey(fromHex(GX), fromHex(GY), { crv: 2 }))).toThrow();
    expect(() => parseCoseP256Key(coseKey(fromHex(GX), fromHex(GY).slice(1)))).toThrow();
  });

  it("extracts the key from an attestationObject", () => {
    const att = attestationObject(Uint8Array.of(9, 8, 7, 6), coseKey(fromHex(GX), fromHex(GY)));
    expect(publicKeyFromAttestationObject(att)).toEqual({ qx: GX, qy: GY });
  });

  it("extracts the key from SPKI DER and rejects other curves", () => {
    expect(publicKeyFromSpki(spki(fromHex(GX), fromHex(GY)))).toEqual({ qx: GX, qy: GY });
    const bad = spki(fromHex(GX), fromHex(GY));
    bad[20] ^= 0xff; // corrupt the curve OID
    expect(() => publicKeyFromSpki(bad)).toThrow();
  });
});

describe("DER signatures and low-s", () => {
  it("parses DER with leading-zero integers into 32-byte values", () => {
    const r = 0x80n << 248n; // high bit set → DER adds a 0x00 pad
    const s = 5n; // short integer → must be left-padded
    expect(parseDerSignature(derSignature(r, s))).toEqual({ r, s });
  });

  it("normalises high-s to low-s", () => {
    const half = P256_N / 2n;
    expect(normalizeS(half)).toBe(half);
    expect(normalizeS(half + 1n)).toBe(P256_N - (half + 1n));
    expect(normalizeS(P256_N - 1n)).toBe(1n);
  });

  it("rejects malformed DER", () => {
    expect(() => parseDerSignature(Uint8Array.of(0x30, 0x02, 0x02, 0x00))).toThrow();
    expect(() => parseDerSignature(Uint8Array.of(0x31, 0x00))).toThrow();
  });
});

describe("loadPasskey", () => {
  it("returns null when storage empty or corrupt", () => {
    expect(loadPasskey()).toBeNull();
    storage.setItem(PASSKEY_STORAGE_KEY, "{not json");
    expect(loadPasskey()).toBeNull();
    storage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify({ ...validStored(), qx: "0x1234" }));
    expect(loadPasskey()).toBeNull();
    storage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify({ ...validStored(), credentialId: "" }));
    expect(loadPasskey()).toBeNull();
    storage.setItem(PASSKEY_STORAGE_KEY, "null");
    expect(loadPasskey()).toBeNull();
  });

  it("returns null when visitorId does not match the key", () => {
    storage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify({ ...validStored(), visitorId: `0x${"11".repeat(32)}` }));
    expect(loadPasskey()).toBeNull();
  });

  it("returns null when localStorage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(loadPasskey()).toBeNull();
  });

  it("returns a valid stored passkey", () => {
    storage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(validStored()));
    expect(loadPasskey()).toEqual(validStored());
  });
});

describe("registerPasskey", () => {
  const credId = Uint8Array.of(1, 2, 3, 4, 5, 250);

  it("requests an ES256, UV-required, no-attestation credential and stores the key (SPKI path)", async () => {
    create.mockResolvedValue(
      credential(credId, {
        attestationObject: toArrayBuffer(attestationObject(credId, coseKey(new Uint8Array(32), new Uint8Array(32)))),
        clientDataJSON: new ArrayBuffer(0),
        getPublicKey: () => toArrayBuffer(spki(fromHex(GX), fromHex(GY))),
        getPublicKeyAlgorithm: () => -7,
      }),
    );
    const pk = await registerPasskey();
    expect(pk).toEqual({ credentialId: b64url(credId), qx: GX, qy: GY, visitorId: vidOf(GX, GY) });
    expect(loadPasskey()).toEqual(pk);

    const { publicKey } = create.mock.calls[0][0] as { publicKey: PublicKeyCredentialCreationOptions };
    expect(publicKey.rp).toEqual({ name: "Hello, Chain", id: "localhost" });
    expect(publicKey.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }]);
    expect(publicKey.authenticatorSelection).toEqual({ userVerification: "required", residentKey: "preferred" });
    expect(publicKey.attestation).toBe("none");
    expect(publicKey.user.name).toBe("Guestbook visitor");
    expect((publicKey.user.id as Uint8Array).length).toBeGreaterThanOrEqual(16);
    expect((publicKey.challenge as Uint8Array).length).toBe(32);
  });

  it("falls back to the COSE key in attestationObject when getPublicKey is unavailable", async () => {
    create.mockResolvedValue(
      credential(credId, {
        attestationObject: toArrayBuffer(attestationObject(credId, coseKey(fromHex(GX), fromHex(GY)))),
        clientDataJSON: new ArrayBuffer(0),
      }),
    );
    expect(await registerPasskey()).toMatchObject({ qx: GX, qy: GY });
  });

  it("uses NEXT_PUBLIC_RP_ID when set", async () => {
    vi.stubEnv("NEXT_PUBLIC_RP_ID", "hello-chain.example");
    create.mockResolvedValue(
      credential(credId, {
        attestationObject: toArrayBuffer(attestationObject(credId, coseKey(fromHex(GX), fromHex(GY)))),
        clientDataJSON: new ArrayBuffer(0),
      }),
    );
    await registerPasskey();
    expect(create.mock.calls[0][0].publicKey.rp.id).toBe("hello-chain.example");
  });

  it("still returns the passkey when storage is unavailable", async () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    create.mockResolvedValue(
      credential(credId, {
        attestationObject: toArrayBuffer(attestationObject(credId, coseKey(fromHex(GX), fromHex(GY)))),
        clientDataJSON: new ArrayBuffer(0),
      }),
    );
    expect(await registerPasskey()).toMatchObject({ qx: GX, qy: GY });
  });
});

describe("signWithPasskey", () => {
  const digest = `0x${"ab".repeat(32)}` as const;
  let key: SoftKey;
  let pk: StoredPasskey;
  const credId = Uint8Array.of(7, 7, 7);

  beforeEach(async () => {
    key = await createSoftKey();
    const qx = toHex(key.x);
    const qy = toHex(key.y);
    pk = { credentialId: b64url(credId), qx, qy, visitorId: vidOf(qx, qy) };
  });

  const respondWith = (o: AssertionOptions = {}) => {
    let made: Awaited<ReturnType<typeof makeAssertion>> | undefined;
    get.mockImplementation(async (opts: { publicKey: PublicKeyCredentialRequestOptions }) => {
      made = await makeAssertion(key, new Uint8Array(opts.publicKey.challenge as Uint8Array), o);
      return credential(credId, made.response);
    });
    return () => made!;
  };

  it("returns cancelled on NotAllowedError", async () => {
    get.mockRejectedValue(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"));
    expect(await signWithPasskey(pk, digest)).toEqual({ status: "cancelled" });
  });

  it("propagates other errors", async () => {
    get.mockRejectedValue(new DOMException("bad rp id", "SecurityError"));
    await expect(signWithPasskey(pk, digest)).rejects.toThrow("bad rp id");
  });

  it("requests the digest as challenge for the stored credential with UV required", async () => {
    respondWith();
    await signWithPasskey(pk, digest);
    const { publicKey } = get.mock.calls[0][0] as { publicKey: PublicKeyCredentialRequestOptions };
    expect(toHex(new Uint8Array(publicKey.challenge as Uint8Array))).toBe(digest);
    expect(publicKey.userVerification).toBe("required");
    expect(publicKey.rpId).toBe("localhost");
    expect(publicKey.allowCredentials).toHaveLength(1);
    expect(toHex(new Uint8Array(publicKey.allowCredentials![0].id as Uint8Array))).toBe(toHex(credId));
  });

  it("builds a payload that mirrors WebAuthn.WebAuthnAuth and verifies over sha256(authData || sha256(clientData))", async () => {
    const made = respondWith();
    const res = await signWithPasskey(pk, digest);
    if (res.status !== "ok") throw new Error("expected ok");
    const { auth } = res;
    expect(Object.keys(auth)).toEqual(["r", "s", "challengeIndex", "typeIndex", "authenticatorData", "clientDataJSON"]);
    expect(auth.clientDataJSON).toBe(made().json);
    expect(auth.typeIndex).toBe(1n);
    expect(auth.challengeIndex).toBe(23n);
    expect(auth.r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(auth.s).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(auth.s) <= P256_N / 2n).toBe(true);

    const signed = new Uint8Array([
      ...fromHex(auth.authenticatorData),
      ...sha256(new TextEncoder().encode(auth.clientDataJSON)),
    ]);
    const raw = new Uint8Array([...fromHex(auth.r), ...fromHex(auth.s)]);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key.publicKey,
        toArrayBuffer(raw),
        toArrayBuffer(signed),
      ),
    ).toBe(true);
  });

  it("computes indices from the real clientDataJSON instead of hard-coding them", async () => {
    respondWith({ challengeFirst: true });
    const res = await signWithPasskey(pk, digest);
    if (res.status !== "ok") throw new Error("expected ok");
    const json = res.auth.clientDataJSON;
    expect(res.auth.challengeIndex).toBe(1n);
    expect(json.slice(Number(res.auth.typeIndex)).startsWith('"type":"webauthn.get"')).toBe(true);
    expect(json.slice(Number(res.auth.challengeIndex)).startsWith(`"challenge":"${b64url(fromHex(digest))}"`)).toBe(
      true,
    );
  });

  it("normalises a high-s browser signature to low-s", async () => {
    const made = respondWith({ highS: true });
    const res = await signWithPasskey(pk, digest);
    if (res.status !== "ok") throw new Error("expected ok");
    expect(made().s > P256_N / 2n).toBe(true);
    expect(BigInt(res.auth.s)).toBe(P256_N - made().s);
  });

  it("rejects an assertion without the UV flag", async () => {
    respondWith({ flags: FLAG_UP });
    await expect(signWithPasskey(pk, digest)).rejects.toThrow(/user verification/i);
  });
});

// ---- End-to-end against the local Guestbook on anvil (skipped when anvil is not running) ----
const RPC = "http://127.0.0.1:8545";
const GUESTBOOK = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const client = createPublicClient({ transport: http(RPC, { retryCount: 0, timeout: 2_000 }) });
async function anvilHasGuestbook(): Promise<boolean> {
  try {
    if ((await client.getChainId()) !== 31337) return false;
    const code = await client.getCode({ address: GUESTBOOK });
    return !!code && code !== "0x";
  } catch {
    return false;
  }
}
const anvilUp = await anvilHasGuestbook();

describe.skipIf(!anvilUp)("signWithPasskey against the local Guestbook (eth_call, no tx)", () => {
  async function prepare(message: string) {
    const key = await createSoftKey();
    const qx = toHex(key.x);
    const qy = toHex(key.y);
    const visitorId = vidOf(qx, qy);
    expect(await client.readContract({ address: GUESTBOOK, abi: guestbookAbi, functionName: "passkeyVisitorId", args: [qx, qy] })).toBe(visitorId);
    const nonce = await client.readContract({ address: GUESTBOOK, abi: guestbookAbi, functionName: "nonces", args: [visitorId] });
    const { timestamp } = await client.getBlock();
    const deadline = timestamp + 3600n;
    const digest = hashTypedData(typedDataFor(31337, GUESTBOOK, visitorId, message, nonce, deadline));
    const pk: StoredPasskey = { credentialId: b64url(Uint8Array.of(1)), qx, qy, visitorId };
    return { key, pk, deadline, digest };
  }

  for (const variant of [{ name: "browser field order, high-s", challengeFirst: false }, { name: "reordered clientDataJSON", challengeFirst: true }]) {
    it(`contract accepts the assertion (${variant.name})`, async () => {
      const message = "gm from a passkey 🔑";
      const { key, pk, deadline, digest } = await prepare(message);
      get.mockImplementation(async (opts: { publicKey: PublicKeyCredentialRequestOptions }) => {
        const made = await makeAssertion(key, new Uint8Array(opts.publicKey.challenge as Uint8Array), {
          challengeFirst: variant.challengeFirst,
          highS: true,
        });
        return credential(Uint8Array.of(1), made.response);
      });
      const res = await signWithPasskey(pk, digest);
      if (res.status !== "ok") throw new Error("expected ok");
      const sim = await client.simulateContract({
        address: GUESTBOOK,
        abi: guestbookAbi,
        functionName: "signWithPasskey",
        args: [pk.qx, pk.qy, message, deadline, res.auth],
      });
      expect(typeof sim.result).toBe("bigint");
    });
  }

  it("contract rejects a tampered assertion", async () => {
    const message = "gm from a passkey 🔑";
    const { key, pk, deadline, digest } = await prepare(message);
    get.mockImplementation(async (opts: { publicKey: PublicKeyCredentialRequestOptions }) => {
      const made = await makeAssertion(key, new Uint8Array(opts.publicKey.challenge as Uint8Array));
      return credential(Uint8Array.of(1), made.response);
    });
    const res = await signWithPasskey(pk, digest);
    if (res.status !== "ok") throw new Error("expected ok");
    await expect(
      client.simulateContract({
        address: GUESTBOOK,
        abi: guestbookAbi,
        functionName: "signWithPasskey",
        args: [pk.qx, pk.qy, message + "!", deadline, res.auth],
      }),
    ).rejects.toThrow(/InvalidSignature/);
  });
});
