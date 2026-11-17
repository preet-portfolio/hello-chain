import { beforeEach, describe, expect, it, vi } from "vitest";

const readContract = vi.fn();
const watchContractEvent = vi.fn();
const getBlockNumber = vi.fn();
vi.mock("@/lib/chain", () => ({
  activeChain: { id: 31337 },
  publicClient: {
    getBlockNumber: () => getBlockNumber(),
    readContract: (...a: unknown[]) => readContract(...a),
    watchContractEvent: (...a: unknown[]) => watchContractEvent(...a),
  },
}));

import { fetchLatest, fetchPage, visibleEntries, watchSigned } from "@/lib/feed";

const vid = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as const;
const view = (id: number, over: Record<string, unknown> = {}) => ({
  id: BigInt(id),
  visitorId: vid,
  timestamp: 1_700_000_000 + id,
  kind: 0,
  hidden: false,
  message: `hello ${id}`,
  ...over,
});

beforeEach(() => {
  readContract.mockReset();
  watchContractEvent.mockReset();
  getBlockNumber.mockReset();
  getBlockNumber.mockResolvedValue(42n);
});

describe("visibleEntries", () => {
  it("drops hidden", () => {
    const out = visibleEntries([view(0), view(1, { hidden: true })]);
    expect(out.map((e) => e.id)).toEqual([0n]);
  });
  it("drops abusive even if not hidden", () => {
    const out = visibleEntries([view(0, { message: "email me a@b.com" }), view(1)]);
    expect(out.map((e) => e.id)).toEqual([1n]);
  });
  it("maps kind numbers to words", () => {
    const out = visibleEntries([view(0, { kind: 0 }), view(1, { kind: 1 }), view(2, { kind: 2 })]);
    expect(out.map((e) => e.kind)).toEqual(["direct", "wallet", "passkey"]);
  });
});

describe("fetchPage", () => {
  it("computes start = beforeId - limit and returns newest-first", async () => {
    readContract.mockResolvedValue([view(5), view(6), view(7)]);
    const out = await fetchPage(8n, 3);
    expect(readContract.mock.calls[0][0]).toMatchObject({
      functionName: "getEntries",
      args: [5n, 3n],
    });
    expect(out.map((e) => e.id)).toEqual([7n, 6n, 5n]);
  });
  it("clamps start at 0", async () => {
    readContract.mockResolvedValue([view(0), view(1)]);
    await fetchPage(2n, 20);
    expect(readContract.mock.calls[0][0]).toMatchObject({ args: [0n, 2n] });
  });
  it("returns nothing for beforeId 0 without calling the chain", async () => {
    expect(await fetchPage(0n, 20)).toEqual([]);
    expect(readContract).not.toHaveBeenCalled();
  });
});

describe("fetchLatest", () => {
  it("returns visible entries and count", async () => {
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === "entryCount" ? 2n : [view(1), view(0, { hidden: true })],
    );
    const out = await fetchLatest(20);
    expect(out.count).toBe(2n);
    expect(out.blockNumber).toBe(42n);
    expect(out.entries.map((e) => e.id)).toEqual([1n]);
  });
  it("pins both reads to the same block", async () => {
    readContract.mockResolvedValue([]);
    await fetchLatest(20);
    for (const c of readContract.mock.calls) expect(c[0].blockNumber).toBe(42n);
    expect(readContract).toHaveBeenCalledTimes(2);
  });
  it("does not resurface an entry it read as hidden when the event is replayed", async () => {
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === "entryCount" ? 91n : [view(90, { hidden: true })],
    );
    const { entries } = await fetchLatest(20);
    expect(entries).toEqual([]);
    watchContractEvent.mockReturnValue(vi.fn());
    const got: bigint[] = [];
    watchSigned((e) => got.push(e.id), { fromBlock: 43n });
    const { onLogs } = watchContractEvent.mock.calls[0][0];
    onLogs([
      { args: { id: 90n, visitorId: vid, kind: 0, message: "was hidden", timestamp: 1 } },
      { args: { id: 91n, visitorId: vid, kind: 0, message: "new one", timestamp: 2 } },
    ]);
    expect(got).toEqual([91n]);
  });
});

describe("watchSigned", () => {
  it("filters abusive events and returns an unwatch fn", () => {
    const unwatch = vi.fn();
    watchContractEvent.mockReturnValue(unwatch);
    const got: bigint[] = [];
    const counted: bigint[] = [];
    const stop = watchSigned((e) => got.push(e.id), { fromBlock: 42n, onSigned: (id) => counted.push(id) });
    expect(watchContractEvent.mock.calls[0][0].fromBlock).toBe(42n);
    const { onLogs } = watchContractEvent.mock.calls[0][0];
    onLogs([
      { args: { id: 3n, visitorId: vid, kind: 1, message: "hi", timestamp: 1_700_000_003 } },
      { args: { id: 4n, visitorId: vid, kind: 1, message: "mail a@b.com", timestamp: 1_700_000_004 } },
    ]);
    expect(got).toEqual([3n]);
    expect(counted).toEqual([3n, 4n]);
    stop();
    expect(unwatch).toHaveBeenCalled();
  });
});
