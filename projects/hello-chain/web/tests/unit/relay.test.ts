import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  pad,
  parseEther,
  type Hex,
} from "viem";
import { guestbookAbi } from "@/lib/contract";
import { passkeyVisitorId } from "@/lib/passkey";

// Spy on the real filter so tests can assert what text reaches it.
vi.mock("@/lib/filter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/filter")>();
  return { ...actual, isAbusive: vi.fn(actual.isAbusive) };
});
import { isAbusive } from "@/lib/filter";

import {
  DEFAULT_MIN_BALANCE_WEI,
  handleRelay as handleRelayRaw,
  isJsonContentType,
  LIMITS,
  type RelayDeps,
  type RelayInput,
} from "@/lib/relay/handler";
import { ipBucket, resolveClientIp } from "@/lib/relay/clientIp";
import { relayLimitsFromEnv, upstashRequired } from "@/lib/relay/env";
import { MAX_RELAY_GAS } from "@/lib/relay/submit";

/** Every test request is application/json unless it says otherwise. */
const handleRelay = (i: Omit<RelayInput, "contentType"> & { contentType?: string | null }, d: RelayDeps | null) =>
  handleRelayRaw({ contentType: "application/json", ...i }, d);
import { memoryRateLimiter, upstashRateLimiter, type RateLimiter } from "@/lib/relay/rateLimit";
import { friendlyError } from "@/lib/relay/errors";
import { MAX_BODY_BYTES, parseRelayBody, readBodyCapped } from "@/lib/relay/validate";
import { toWireAuth, type RelayRequest } from "@/lib/relay/types";

const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const TX = `0x${"ab".repeat(32)}` as Hex;
const RELAYER = "0x2546BcD3c84621e976D8185a91A922aE77ECEc30" as const;

const AUTHOR_A = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
const AUTHOR_B = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";

function walletBody(over: Partial<Extract<RelayRequest, { kind: "wallet" }>> = {}): string {
  return JSON.stringify({
    kind: "wallet",
    author: AUTHOR_A,
    message: "Hello from the test suite",
    deadline: "4102444800",
    signature: `0x${"11".repeat(65)}`,
    ...over,
  });
}

const QX = `0x${"01".repeat(32)}` as Hex;
const QY = `0x${"02".repeat(32)}` as Hex;
function passkeyBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "passkey",
    qx: QX,
    qy: QY,
    message: "Hi from a passkey",
    deadline: 4102444800,
    auth: {
      r: `0x${"03".repeat(32)}`,
      s: `0x${"04".repeat(32)}`,
      challengeIndex: "23",
      typeIndex: 1,
      authenticatorData: `0x${"05".repeat(37)}`,
      clientDataJSON: '{"type":"webauthn.get","challenge":"abc"}',
    },
    ...over,
  });
}

function revert(errorName: string, args: readonly unknown[] = [], functionName = "signWithWallet") {
  const data = encodeErrorResult({
    abi: guestbookAbi,
    errorName,
    args,
  } as Parameters<typeof encodeErrorResult>[0]);
  return new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: guestbookAbi, data, functionName }),
    { abi: guestbookAbi, functionName, args: [] },
  );
}

type Fakes = {
  simulateContract: ReturnType<typeof vi.fn>;
  writeContract: ReturnType<typeof vi.fn>;
  getBlock: ReturnType<typeof vi.fn>;
  getBalance: ReturnType<typeof vi.fn>;
  estimateContractGas: ReturnType<typeof vi.fn>;
  log: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
};

function makeDeps(limiter: RateLimiter = memoryRateLimiter()): { deps: RelayDeps; f: Fakes } {
  const f: Fakes = {
    simulateContract: vi.fn(async (args: Record<string, unknown>) => ({ request: { ...args } })),
    writeContract: vi.fn(async () => TX),
    getBlock: vi.fn(async () => ({ timestamp: 1_000n })),
    getBalance: vi.fn(async () => 10n ** 18n),
    estimateContractGas: vi.fn(async () => 200_000n),
    log: { warn: vi.fn(), error: vi.fn() },
  };
  const deps = {
    publicClient: {
      simulateContract: f.simulateContract,
      estimateContractGas: f.estimateContractGas,
      getBlock: f.getBlock,
      getBalance: f.getBalance,
    },
    walletClient: { writeContract: f.writeContract },
    account: { address: RELAYER },
    contract: CONTRACT,
    limiter,
    log: f.log,
  } as unknown as RelayDeps;
  return { deps, f };
}

const IP = "203.0.113.7";

beforeEach(() => {
  vi.mocked(isAbusive).mockClear();
});

describe("handleRelay", () => {
  it("rejects malformed body 400", async () => {
    const { deps, f } = makeDeps();
    for (const [i, body] of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ kind: "carrier-pigeon" }),
      walletBody({ author: "0x1234" as never }),
      walletBody({ signature: "0xzz" as never }),
      walletBody({ deadline: "-1" }),
      walletBody({ deadline: "1.5" }),
      walletBody({ message: 42 as never }),
      walletBody({ message: "" }),
      walletBody({ message: "x".repeat(141) }),
      passkeyBody({ qx: "0x01" }),
      passkeyBody({ auth: { r: "0x00" } }),
    ].entries()) {
      // Distinct IPs so the 10/60s burst limit is not what answers.
      const res = await handleRelay({ body, ip: `10.0.0.${i}` }, deps);
      expect(res, body).toEqual({ status: 400, body: { error: "invalid" } });
    }
    expect(f.simulateContract).not.toHaveBeenCalled();
    expect(f.writeContract).not.toHaveBeenCalled();
  });

  it("rejects a null (oversize/unreadable) body and an oversize string body with 400", async () => {
    const { deps } = makeDeps();
    expect(await handleRelay({ body: null, ip: IP }, deps)).toEqual({ status: 400, body: { error: "invalid" } });
    const huge = walletBody({ message: "a".repeat(MAX_BODY_BYTES) });
    expect(await handleRelay({ body: huge, ip: IP }, deps)).toEqual({ status: 400, body: { error: "invalid" } });
  });

  it("rejects untrimmed text the signature covers (would be altered) with 400", async () => {
    const { deps, f } = makeDeps();
    const res = await handleRelay({ body: walletBody({ message: "  hello  " }), ip: IP }, deps);
    expect(res).toEqual({ status: 400, body: { error: "invalid" } });
    expect(f.simulateContract).not.toHaveBeenCalled();
  });

  it("never passes over-long text to the abuse filter", async () => {
    const { deps } = makeDeps();
    await handleRelay({ body: walletBody({ message: "a.".repeat(3000) }), ip: IP }, deps);
    expect(isAbusive).not.toHaveBeenCalled();
  });

  it("filtered message 422 with reason", async () => {
    const { deps, f } = makeDeps();
    const res = await handleRelay({ body: walletBody({ message: "visit www.spam.example" }), ip: IP }, deps);
    expect(res).toEqual({ status: 422, body: { error: "filtered", reason: "link" } });
    expect(isAbusive).toHaveBeenCalledWith("visit www.spam.example");
    expect(f.simulateContract).not.toHaveBeenCalled();
  });

  it("maps CooldownActive to friendly message", async () => {
    const { deps, f } = makeDeps();
    f.simulateContract.mockRejectedValueOnce(revert("CooldownActive", [1_600]));
    const res = await handleRelay({ body: walletBody(), ip: IP }, deps);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: "cooldown", retryAfter: 600 });
    expect(res.headers?.["Retry-After"]).toBe("600");
    expect(friendlyError("cooldown")).toBe("You've already signed today — come back tomorrow");
    expect(f.writeContract).not.toHaveBeenCalled();
  });

  it("clamps cooldown retryAfter at 0 when the block time has already passed `until`", async () => {
    const { deps, f } = makeDeps();
    f.simulateContract.mockRejectedValueOnce(revert("CooldownActive", [900]));
    const res = await handleRelay({ body: walletBody(), ip: IP }, deps);
    expect(res.body).toEqual({ error: "cooldown", retryAfter: 0 });
  });

  it("maps InvalidSignature / SignatureExpired / MessageTooLong reverts to 400 invalid", async () => {
    for (const [name, args] of [
      ["InvalidSignature", []],
      ["SignatureExpired", []],
      ["MessageTooLong", [200n]],
    ] as const) {
      const { deps, f } = makeDeps();
      f.simulateContract.mockRejectedValueOnce(revert(name, args));
      const res = await handleRelay({ body: walletBody(), ip: IP }, deps);
      expect(res, name).toEqual({ status: 400, body: { error: "invalid" } });
    }
  });

  it("does not submit when simulation fails", async () => {
    const { deps, f } = makeDeps();
    f.simulateContract.mockRejectedValueOnce(revert("InvalidSignature"));
    await handleRelay({ body: walletBody(), ip: IP }, deps);
    f.simulateContract.mockRejectedValueOnce(new Error("socket hang up"));
    const res = await handleRelay({ body: walletBody({ author: AUTHOR_B }), ip: "198.51.100.1" }, deps);
    expect(res).toEqual({ status: 503, body: { error: "busy" } });
    expect(f.writeContract).not.toHaveBeenCalled();
  });

  it("returns 503 busy on submit failure (RPC throws)", async () => {
    const { deps, f } = makeDeps();
    f.writeContract.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await handleRelay({ body: walletBody(), ip: IP }, deps);
    expect(res).toEqual({ status: 503, body: { error: "busy" } });
    expect(f.log.error).toHaveBeenCalled();
  });

  it("returns 503 busy when the relayer is not configured", async () => {
    const res = await handleRelay({ body: walletBody(), ip: IP }, null);
    expect(res).toEqual({ status: 503, body: { error: "busy" } });
  });

  it("returns txHash on success (wallet), submitting the exact simulated request", async () => {
    const { deps, f } = makeDeps();
    const res = await handleRelay({ body: walletBody(), ip: IP }, deps);
    expect(res).toEqual({ status: 200, body: { txHash: TX } });
    const sim = f.simulateContract.mock.calls[0][0];
    expect(sim).toMatchObject({
      address: CONTRACT,
      functionName: "signWithWallet",
      args: [AUTHOR_A, "Hello from the test suite", 4102444800n, `0x${"11".repeat(65)}`],
      account: { address: RELAYER },
    });
    expect(sim.gas).toBeUndefined(); // gas is estimated, never hard-coded
    // Explicit gas = estimate + 10% headroom.
    expect(f.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "signWithWallet", gas: 220_000n }),
    );
  });

  it("returns txHash on success (passkey), converting wire indices to bigint", async () => {
    const { deps, f } = makeDeps();
    const res = await handleRelay({ body: passkeyBody(), ip: IP }, deps);
    expect(res).toEqual({ status: 200, body: { txHash: TX } });
    const sim = f.simulateContract.mock.calls[0][0];
    expect(sim.functionName).toBe("signWithPasskey");
    expect(sim.args).toEqual([
      QX,
      QY,
      "Hi from a passkey",
      4102444800n,
      {
        r: `0x${"03".repeat(32)}`,
        s: `0x${"04".repeat(32)}`,
        challengeIndex: 23n,
        typeIndex: 1n,
        authenticatorData: `0x${"05".repeat(37)}`,
        clientDataJSON: '{"type":"webauthn.get","challenge":"abc"}',
      },
    ]);
  });

  it("second success from same IP within a day → 429", async () => {
    const { deps, f } = makeDeps();
    expect((await handleRelay({ body: walletBody(), ip: IP }, deps)).status).toBe(200);
    const res = await handleRelay({ body: walletBody({ author: AUTHOR_B }), ip: IP }, deps);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "network" });
    expect((res.body as { retryAfter: number }).retryAfter).toBeGreaterThan(86_000);
    expect(f.writeContract).toHaveBeenCalledTimes(1);
  });

  it("second success from the same visitor (different IP) within a day → 429 cooldown", async () => {
    const { deps, f } = makeDeps();
    expect((await handleRelay({ body: walletBody(), ip: IP }, deps)).status).toBe(200);
    const res = await handleRelay({ body: walletBody(), ip: "198.51.100.1" }, deps);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "cooldown" });
    expect(f.writeContract).toHaveBeenCalledTimes(1);
  });

  it("does not burn the daily slot on filtered, invalid or failed requests", async () => {
    const { deps, f } = makeDeps();
    await handleRelay({ body: walletBody({ message: "call me +1 555 123 4567" }), ip: IP }, deps);
    f.simulateContract.mockRejectedValueOnce(revert("InvalidSignature"));
    await handleRelay({ body: walletBody(), ip: IP }, deps);
    f.writeContract.mockRejectedValueOnce(new Error("nonce too low"));
    await handleRelay({ body: walletBody(), ip: IP }, deps);
    const res = await handleRelay({ body: walletBody(), ip: IP }, deps);
    expect(res).toEqual({ status: 200, body: { txHash: TX } });
  });

  it("applies 10/60s per IP to every request, including invalid ones", async () => {
    const { deps } = makeDeps();
    for (let i = 0; i < 10; i++) {
      expect((await handleRelay({ body: "junk", ip: IP }, deps)).status).toBe(400);
    }
    const res = await handleRelay({ body: walletBody(), ip: IP }, deps);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "rateLimited" });
    // A different IP is unaffected.
    expect((await handleRelay({ body: walletBody(), ip: "198.51.100.1" }, deps)).status).toBe(200);
  });

  it("derives visitorId server-side (passkey: keccak(abi.encode(qx,qy)); wallet: padded address)", async () => {
    const calls: string[] = [];
    const inner = memoryRateLimiter();
    const spy: RateLimiter = {
      hit: (k, l, w) => (calls.push(`hit ${k}`), inner.hit(k, l, w)),
      release: (k) => (calls.push(`release ${k}`), inner.release(k)),
    };
    const { deps } = makeDeps(spy);
    await handleRelay({ body: passkeyBody({ visitorId: `0x${"ff".repeat(32)}` }), ip: IP }, deps);
    await handleRelay({ body: walletBody(), ip: "198.51.100.1" }, deps);
    const pkId = passkeyVisitorId(QX, QY);
    const walletId = pad(AUTHOR_A.toLowerCase() as Hex, { size: 32 });
    expect(calls).toContain(`hit visitor-day:${pkId}`);
    expect(calls).toContain(`hit visitor-day:${walletId}`);
    expect(calls.some((c) => c.includes("ff".repeat(32)))).toBe(false);
  });

  it("logs a warning (but still succeeds) when relayer balance < 0.005 ETH", async () => {
    const { deps, f } = makeDeps();
    f.getBalance.mockResolvedValue(4_000_000_000_000_000n);
    const res = await handleRelay({ body: walletBody(), ip: IP }, deps);
    expect(res.status).toBe(200);
    expect(f.log.warn).toHaveBeenCalledWith(expect.stringMatching(/balance/i));
  });

  it("maps a limiter outage to 503 busy", async () => {
    const broken: RateLimiter = {
      hit: async () => {
        throw new Error("redis down");
      },
      release: async () => {
        throw new Error("redis down");
      },
    };
    const { deps, f } = makeDeps(broken);
    expect(await handleRelay({ body: walletBody(), ip: IP }, deps)).toEqual({ status: 503, body: { error: "busy" } });
    expect(f.writeContract).not.toHaveBeenCalled();
  });
});

describe("friendlyError", () => {
  it("has plain-language copy for every code", () => {
    expect(friendlyError("busy")).toBe("The guestbook is busy right now — try again in a minute");
    expect(friendlyError("rateLimited")).toBe("Slow down a little — try again in a moment");
    expect(friendlyError("invalid")).toBe("Something went wrong with that signature — please try again");
    expect(friendlyError("filtered")).toBe(
      "Let's keep it friendly — links, contact details and strong language aren't allowed here.",
    );
  });
});

describe("parseRelayBody", () => {
  it("accepts indices/deadline as decimal strings or safe integers, rejects unsafe numbers", () => {
    expect(parseRelayBody(passkeyBody()).ok).toBe(true);
    expect(parseRelayBody(walletBody({ deadline: 2 ** 60 as never })).ok).toBe(false);
    expect(parseRelayBody(walletBody({ deadline: "1".repeat(79) })).ok).toBe(false);
  });

  it("toWireAuth round-trips a WebAuthnAuthPayload", () => {
    const wire = toWireAuth({
      r: QX,
      s: QY,
      challengeIndex: 23n,
      typeIndex: 1n,
      authenticatorData: "0x05",
      clientDataJSON: "{}",
    });
    expect(wire).toEqual({ r: QX, s: QY, challengeIndex: "23", typeIndex: "1", authenticatorData: "0x05", clientDataJSON: "{}" });
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
  });
});

describe("readBodyCapped", () => {
  it("returns the text when within the cap and null beyond it", async () => {
    expect(await readBodyCapped(new Request("http://x", { method: "POST", body: "hi" }), 8)).toBe("hi");
    expect(await readBodyCapped(new Request("http://x", { method: "POST", body: "x".repeat(9) }), 8)).toBeNull();
    const declared = new Request("http://x", { method: "POST", body: "hi", headers: { "content-length": "99999" } });
    expect(await readBodyCapped(declared, 8)).toBeNull();
  });
});

describe("memoryRateLimiter", () => {
  it("allows `limit` hits per window, reports retryAfter, and resets after the window", async () => {
    let now = 0;
    const rl = memoryRateLimiter(() => now);
    expect(await rl.hit("k", 2, 60)).toEqual({ allowed: true, retryAfter: 0 });
    expect(await rl.hit("k", 2, 60)).toEqual({ allowed: true, retryAfter: 0 });
    expect(await rl.hit("k", 2, 60)).toEqual({ allowed: false, retryAfter: 60 });
    now = 45_000;
    expect(await rl.hit("k", 2, 60)).toEqual({ allowed: false, retryAfter: 15 });
    now = 60_000;
    expect(await rl.hit("k", 2, 60)).toEqual({ allowed: true, retryAfter: 0 });
  });

  it("release undoes one count (denied hits count too), never below zero", async () => {
    const rl = memoryRateLimiter(() => 0);
    expect((await rl.hit("r", 1, 60)).allowed).toBe(true); // 1
    expect((await rl.hit("r", 1, 60)).allowed).toBe(false); // 2
    await rl.release("r"); // 1
    expect((await rl.hit("r", 1, 60)).allowed).toBe(false); // 2
    await rl.release("r");
    await rl.release("r"); // 0
    await rl.release("r"); // stays 0
    expect((await rl.hit("r", 1, 60)).allowed).toBe(true);
    await rl.release("missing"); // no-op
  });
});

describe("upstashRateLimiter", () => {
  it("uses one REST pipeline per call with bearer auth and maps the count/TTL", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify([{ result: "OK" }, { result: 3 }, { result: 42 }])),
    );
    const rl = upstashRateLimiter("https://eu.upstash.io/", "tok", fetchFn);
    expect(await rl.hit("ip-min:1.2.3.4", 2, 60)).toEqual({ allowed: false, retryAfter: 42 });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://eu.upstash.io/pipeline");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init?.body as string)).toEqual([
      ["SET", "hello-chain:rl:ip-min:1.2.3.4", "0", "EX", "60", "NX"],
      ["INCR", "hello-chain:rl:ip-min:1.2.3.4"],
      ["TTL", "hello-chain:rl:ip-min:1.2.3.4"],
    ]);

    fetchFn.mockResolvedValueOnce(new Response(JSON.stringify([{ result: 0 }])));
    await rl.release("visitor-day:0xab");
    const [cmd] = JSON.parse(fetchFn.mock.calls[1][1]?.body as string);
    // Guarded decrement via Lua: never creates a TTL-less negative key.
    expect(cmd.slice(0, 1)).toEqual(["EVAL"]);
    expect(cmd.slice(2)).toEqual(["1", "hello-chain:rl:visitor-day:0xab"]);
    expect(cmd[1]).toMatch(/GET.*> 0.*DECR/);
  });

  it("throws on HTTP or command errors (the handler turns that into 503)", async () => {
    const rl = upstashRateLimiter("https://x", "t", (async () => new Response("no", { status: 401 })) as typeof fetch);
    await expect(rl.hit("k", 1, 1)).rejects.toThrow();
    const rl2 = upstashRateLimiter(
      "https://x",
      "t",
      (async () => new Response(JSON.stringify([{ error: "ERR" }, { result: 1 }, { result: 1 }]))) as typeof fetch,
    );
    await expect(rl2.hit("k", 1, 1)).rejects.toThrow();
  });
});

describe("fix round 1: reservations, gas ceiling, content-type", () => {
  it("N concurrent requests from one IP with distinct passkeys: exactly one reaches writeContract", async () => {
    const { deps, f } = makeDeps();
    // Slow simulation so all requests overlap between reservation and send.
    f.simulateContract.mockImplementation(async (args: Record<string, unknown>) => {
      await new Promise((r) => setTimeout(r, 10));
      return { request: { ...args } };
    });
    const bodies = Array.from({ length: 8 }, (_, i) =>
      passkeyBody({ qx: `0x${(i + 1).toString(16).padStart(2, "0").repeat(32)}` }),
    );
    const results = await Promise.all(bodies.map((body) => handleRelay({ body, ip: IP }, deps)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
    expect(f.writeContract).toHaveBeenCalledTimes(1);
  });

  it("a reverted simulation releases both reservations for the next request", async () => {
    const { deps, f } = makeDeps();
    f.simulateContract.mockRejectedValueOnce(revert("InvalidSignature"));
    expect((await handleRelay({ body: walletBody(), ip: IP }, deps)).status).toBe(400);
    f.simulateContract.mockRejectedValueOnce(revert("CooldownActive", [1_600]));
    expect((await handleRelay({ body: walletBody(), ip: IP }, deps)).status).toBe(429);
    expect(await handleRelay({ body: walletBody(), ip: IP }, deps)).toEqual({ status: 200, body: { txHash: TX } });
  });

  it("a request denied by the daily limit does not leave the counter inflated", async () => {
    const { deps, f } = makeDeps();
    // A holds the IP slot while B is denied; A then fails, so the slot must be free again.
    let failA!: () => void;
    f.simulateContract.mockImplementationOnce(
      () => new Promise((_, reject) => (failA = () => reject(revert("InvalidSignature")))),
    );
    const a = handleRelay({ body: walletBody(), ip: IP }, deps);
    await new Promise((r) => setTimeout(r, 0));
    const b = await handleRelay({ body: walletBody({ author: AUTHOR_B }), ip: IP }, deps);
    expect(b.status).toBe(429);
    failA();
    expect((await a).status).toBe(400);
    expect((await handleRelay({ body: walletBody({ author: AUTHOR_B }), ip: IP }, deps)).status).toBe(200);
  });

  it("an estimate above MAX_RELAY_GAS never calls writeContract (503 busy, logged) and frees the slot", async () => {
    const { deps, f } = makeDeps();
    f.estimateContractGas.mockResolvedValueOnce(MAX_RELAY_GAS + 1n);
    expect(await handleRelay({ body: walletBody(), ip: IP }, deps)).toEqual({ status: 503, body: { error: "busy" } });
    expect(f.writeContract).not.toHaveBeenCalled();
    expect(f.log.error).toHaveBeenCalledWith(expect.stringMatching(/gas ceiling exceeded/));
    expect((await handleRelay({ body: walletBody(), ip: IP }, deps)).status).toBe(200);
  });

  it("headroom is capped at the ceiling", async () => {
    const { deps, f } = makeDeps();
    f.estimateContractGas.mockResolvedValueOnce(MAX_RELAY_GAS - 1n);
    await handleRelay({ body: walletBody(), ip: IP }, deps);
    expect(f.writeContract).toHaveBeenCalledWith(expect.objectContaining({ gas: MAX_RELAY_GAS }));
  });

  it("rejects non-JSON content types with 415 invalid (blocks CORS simple requests)", async () => {
    const { deps, f } = makeDeps();
    for (const [i, ct] of [null, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data"].entries()) {
      const res = await handleRelay({ body: walletBody(), ip: `10.1.0.${i}`, contentType: ct }, deps);
      expect(res, String(ct)).toEqual({ status: 415, body: { error: "invalid" } });
    }
    expect(f.simulateContract).not.toHaveBeenCalled();
    expect(isJsonContentType("Application/JSON; charset=utf-8")).toBe(true);
  });

  it("logs viem errors by shortMessage only (never the full message with the RPC URL)", async () => {
    const { deps, f } = makeDeps();
    const { HttpRequestError } = await import("viem");
    f.writeContract.mockRejectedValueOnce(
      new HttpRequestError({ url: "https://rpc.example/v2/SECRET_API_KEY", body: {}, details: "boom" }),
    );
    await handleRelay({ body: walletBody(), ip: IP }, deps);
    const logged = f.log.error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/HTTP request failed/);
    expect(logged).not.toMatch(/SECRET_API_KEY/);
  });
});

describe("resolveClientIp", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  const both = { "x-forwarded-for": "198.51.100.9, 10.0.0.1", "x-real-ip": "203.0.113.5" };

  it("on Vercel uses the first x-forwarded-for hop, then x-real-ip, then 'unknown'", () => {
    const env = { VERCEL: "1", NODE_ENV: "production" };
    expect(resolveClientIp(h(both), env)).toBe("198.51.100.9");
    expect(resolveClientIp(h({ "x-real-ip": "203.0.113.5" }), env)).toBe("203.0.113.5");
    expect(resolveClientIp(h({}), env)).toBe("unknown");
  });

  it("TRUSTED_PROXY_HEADER=x-real-ip reads only x-real-ip and ignores x-forwarded-for", () => {
    const env = { TRUSTED_PROXY_HEADER: "x-real-ip", NODE_ENV: "production" };
    expect(resolveClientIp(h(both), env)).toBe("203.0.113.5");
    // No fallback to XFF when the selected header is missing: fail closed.
    expect(resolveClientIp(h({ "x-forwarded-for": "198.51.100.9" }), env)).toBeNull();
  });

  it("TRUSTED_PROXY_HEADER=x-forwarded-for takes the last hop and ignores a spoofed x-real-ip", () => {
    const env = { TRUSTED_PROXY_HEADER: "x-forwarded-for", NODE_ENV: "production" };
    const spoofed = { "x-forwarded-for": "6.6.6.6, 198.51.100.9", "x-real-ip": "6.6.6.6" };
    expect(resolveClientIp(h(spoofed), env)).toBe("198.51.100.9");
    expect(resolveClientIp(h({ "x-real-ip": "6.6.6.6" }), env)).toBeNull();
    expect(resolveClientIp(h({ "x-forwarded-for": " , " }), env)).toBeNull();
  });

  it("an invalid TRUSTED_PROXY_HEADER value is untrusted", () => {
    for (const v of ["", "X-Real-IP ", "forwarded", "x-client-ip", "1"]) {
      expect(resolveClientIp(h(both), { TRUSTED_PROXY_HEADER: v, NODE_ENV: "production" }), v).toBeNull();
      expect(resolveClientIp(h(both), { TRUSTED_PROXY_HEADER: v, NODE_ENV: "development" }), v).toBe("dev-local");
    }
  });

  it("the old TRUSTED_PROXY=1 no longer trusts anything", () => {
    const legacy = { TRUSTED_PROXY: "1" } as Record<string, string>;
    expect(resolveClientIp(h(both), { ...legacy, NODE_ENV: "production" })).toBeNull();
    expect(resolveClientIp(h(both), { ...legacy, NODE_ENV: "development" })).toBe("dev-local");
  });

  it("untrusted: production fails closed (null), development uses 'dev-local' and ignores headers", () => {
    expect(resolveClientIp(h(both), { NODE_ENV: "production" })).toBeNull();
    expect(resolveClientIp(h(both), { NODE_ENV: "development" })).toBe("dev-local");
    expect(resolveClientIp(h(both), { VERCEL: "0", NODE_ENV: "test" })).toBe("dev-local");
  });
});

describe("final review: IPv6 buckets, global cap, balance floor, network copy", () => {
  it("ipBucket: IPv6 addresses bucket by /64, IPv4 and mapped IPv4 stay per address", () => {
    expect(ipBucket("2001:db8:1:2::1")).toBe(ipBucket("2001:DB8:1:2:ffff:ffff:ffff:ffff"));
    expect(ipBucket("2001:db8:1:2::1")).toBe(ipBucket("2001:0db8:0001:0002:0:0:0:0abc"));
    expect(ipBucket("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:db8:1:3::1")).not.toBe(ipBucket("2001:db8:1:2::1"));
    expect(ipBucket("::1")).toBe("0:0:0:0::/64");
    expect(ipBucket("[2001:db8:1:2::9]")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket("::FFFF:cb00:7107")).toBe("203.0.113.7");
    expect(ipBucket("0:0:0:0:0:ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket("::ffff:203.0.113.8")).not.toBe(ipBucket("::ffff:203.0.113.7"));
    // Non-addresses (dev bucket, Vercel fallback) are left alone.
    expect(ipBucket("dev-local")).toBe("dev-local");
    expect(ipBucket("unknown")).toBe("unknown");
  });

  it("two IPv6 addresses in one /64 share the daily IP slot; another /64 does not", async () => {
    const { deps, f } = makeDeps();
    expect((await handleRelay({ body: walletBody(), ip: "2001:db8:1:2::1" }, deps)).status).toBe(200);
    const same = await handleRelay({ body: walletBody({ author: AUTHOR_B }), ip: "2001:db8:1:2::beef" }, deps);
    expect(same.status).toBe(429);
    const other = await handleRelay({ body: walletBody({ author: AUTHOR_B }), ip: "2001:db8:1:3::1" }, deps);
    expect(other.status).toBe(200);
    expect(f.writeContract).toHaveBeenCalledTimes(2);
  });

  it("an IPv4-mapped IPv6 address shares the IPv4 address's slot", async () => {
    const { deps } = makeDeps();
    expect((await handleRelay({ body: walletBody(), ip: IP }, deps)).status).toBe(200);
    const res = await handleRelay({ body: walletBody({ author: AUTHOR_B }), ip: `::ffff:${IP}` }, deps);
    expect(res.status).toBe(429);
  });

  it("the global daily cap answers 503 busy without simulating, and frees its slot when a send fails", async () => {
    const { deps, f } = makeDeps();
    deps.globalDailyLimit = 2;
    const ip = (i: number) => `198.51.100.${i}`;
    const author = (i: number) => `0x${String(i).padStart(40, "0")}` as const;
    // Slot 1 is taken, then slot 2 is held by a failing simulation and given back.
    expect((await handleRelay({ body: walletBody({ author: author(1) }), ip: ip(1) }, deps)).status).toBe(200);
    f.simulateContract.mockRejectedValueOnce(revert("InvalidSignature"));
    expect((await handleRelay({ body: walletBody({ author: author(2) }), ip: ip(2) }, deps)).status).toBe(400);
    expect((await handleRelay({ body: walletBody({ author: author(3) }), ip: ip(3) }, deps)).status).toBe(200);
    f.simulateContract.mockClear();
    const over = await handleRelay({ body: walletBody({ author: author(4) }), ip: ip(4) }, deps);
    expect(over).toEqual({ status: 503, body: { error: "busy" } });
    expect(f.simulateContract).not.toHaveBeenCalled();
    expect(f.log.error).toHaveBeenCalledWith(expect.stringMatching(/global daily cap/i));
    // The denied request released its per-visitor/per-IP slots too.
    deps.globalDailyLimit = 3;
    expect((await handleRelay({ body: walletBody({ author: author(4) }), ip: ip(4) }, deps)).status).toBe(200);
  });

  it("defaults the global daily cap to 200 under the key global-day", async () => {
    const calls: string[] = [];
    const inner = memoryRateLimiter();
    const spy: RateLimiter = {
      hit: (k, l, w) => (calls.push(`${k} ${l} ${w}`), inner.hit(k, l, w)),
      release: (k) => inner.release(k),
    };
    const { deps } = makeDeps(spy);
    await handleRelay({ body: walletBody(), ip: IP }, deps);
    expect(calls).toContain("global-day 200 86400");
    expect(LIMITS.globalDaily.limit).toBe(200);
  });

  it("refuses (503 busy, logged) below the balance floor without simulating, and frees the slots", async () => {
    const { deps, f } = makeDeps();
    f.getBalance.mockResolvedValueOnce(parseEther("0.0019"));
    expect(await handleRelay({ body: walletBody(), ip: IP }, deps)).toEqual({ status: 503, body: { error: "busy" } });
    expect(f.simulateContract).not.toHaveBeenCalled();
    expect(f.log.error).toHaveBeenCalledWith(expect.stringMatching(/balance .* below the floor/i));
    expect((await handleRelay({ body: walletBody(), ip: IP }, deps)).status).toBe(200);
    expect(DEFAULT_MIN_BALANCE_WEI).toBe(parseEther("0.002"));
    // A configured floor overrides the default.
    deps.minBalanceWei = 2n * 10n ** 18n;
    const res = await handleRelay({ body: walletBody({ author: AUTHOR_B }), ip: "198.51.100.1" }, deps);
    expect(res.status).toBe(503);
  });

  it("a new visitor blocked only by the per-IP daily limit gets the 'someone on your network' code", async () => {
    const { deps } = makeDeps();
    expect((await handleRelay({ body: walletBody(), ip: IP }, deps)).status).toBe(200);
    const res = await handleRelay({ body: walletBody({ author: AUTHOR_B }), ip: IP }, deps);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "network" });
    expect(friendlyError("network")).toBe("Someone on your network already signed today — try again tomorrow.");
    expect(friendlyError("network", 3600)).toBe(friendlyError("network"));
    // The burst limit keeps its own code.
    expect(friendlyError("rateLimited")).toMatch(/Slow down/);
  });
});

describe("relayLimitsFromEnv", () => {
  it("reads RELAY_GLOBAL_DAILY_LIMIT and RELAY_MIN_BALANCE_WEI, falling back to defaults on bad values", () => {
    expect(relayLimitsFromEnv({})).toEqual({ globalDailyLimit: 200, minBalanceWei: parseEther("0.002") });
    expect(relayLimitsFromEnv({ RELAY_GLOBAL_DAILY_LIMIT: "50", RELAY_MIN_BALANCE_WEI: "1000" })).toEqual({
      globalDailyLimit: 50,
      minBalanceWei: 1000n,
    });
    expect(relayLimitsFromEnv({ RELAY_GLOBAL_DAILY_LIMIT: "-3", RELAY_MIN_BALANCE_WEI: "0.5" })).toEqual({
      globalDailyLimit: 200,
      minBalanceWei: parseEther("0.002"),
    });
  });
});

describe("upstashRequired", () => {
  it("is true only for a Vercel production deployment", () => {
    expect(upstashRequired({ VERCEL: "1", NODE_ENV: "production" })).toBe(true);
    expect(upstashRequired({ VERCEL: "1", NODE_ENV: "development" })).toBe(false);
    expect(upstashRequired({ NODE_ENV: "production" })).toBe(false);
    expect(upstashRequired({})).toBe(false);
  });
});

describe("getRelayDeps fails closed without Upstash on Vercel production", () => {
  const load = async (env: Record<string, string>) => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "31337");
    vi.stubEnv("RELAYER_PRIVATE_KEY", `0x${"59".repeat(32)}`);
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("VERCEL", "");
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getRelayDeps } = await import("@/lib/relay/env");
    const deps = getRelayDeps();
    const logged = error.mock.calls.map((c) => String(c[0])).join("\n");
    error.mockRestore();
    warn.mockRestore();
    vi.unstubAllEnvs();
    return { deps, logged };
  };

  it("VERCEL=1 + production + no Upstash → null (503 busy) with a server log", async () => {
    const { deps, logged } = await load({ VERCEL: "1", NODE_ENV: "production" });
    expect(deps).toBeNull();
    expect(logged).toMatch(/UPSTASH_REDIS_REST_URL/);
    const res = await handleRelay({ body: walletBody(), ip: IP }, deps);
    expect(res).toEqual({ status: 503, body: { error: "busy" } });
  });

  it("elsewhere keeps the memory limiter (production off Vercel, Vercel preview/dev)", async () => {
    expect((await load({ NODE_ENV: "production" })).deps).not.toBeNull();
    expect((await load({ VERCEL: "1", NODE_ENV: "development" })).deps).not.toBeNull();
  });

  it("with Upstash configured on Vercel production the relayer is enabled, with env spend guards", async () => {
    const { deps } = await load({
      VERCEL: "1",
      NODE_ENV: "production",
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "t",
      RELAY_GLOBAL_DAILY_LIMIT: "25",
    });
    expect(deps).not.toBeNull();
    expect(deps?.globalDailyLimit).toBe(25);
  });
});
