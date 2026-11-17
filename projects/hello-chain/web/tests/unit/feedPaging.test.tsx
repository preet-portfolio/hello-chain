// @vitest-environment jsdom
// The provider with the real feed module over a fake chain: a first screen of junk must not hide
// older, visible entries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";

const PINNED = 42n;
let log: { id: bigint; visitorId: `0x${string}`; timestamp: number; kind: number; hidden: boolean; message: string }[] = [];
const readContract = vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly bigint[] }) => {
  if (functionName === "entryCount") return BigInt(log.length);
  if (functionName === "latest") return [...log].reverse().slice(0, Number(args![0]));
  if (functionName === "getEntries") {
    const [start, n] = args!.map(Number);
    return log.slice(start, start + n);
  }
  throw new Error(`unexpected read ${functionName}`);
});
vi.mock("@/lib/chain", () => ({
  activeChain: { id: 31337 },
  publicClient: {
    getBlockNumber: async () => PINNED,
    readContract: (a: { functionName: string; args?: readonly bigint[] }) => readContract(a),
    watchContractEvent: () => () => {},
  },
}));

import { GuestbookProvider, useGuestbook } from "@/components/GuestbookProvider";

function makeLog(n: number, junk: (id: number) => "spam" | "hidden" | null) {
  log = Array.from({ length: n }, (_, id) => ({
    id: BigInt(id),
    visitorId: `0x${id.toString(16).padStart(64, "0")}` as `0x${string}`,
    timestamp: 1_700_000_000 + id,
    kind: 0,
    hidden: junk(id) === "hidden",
    message: junk(id) === "spam" ? `visit evil${id}.com` : `hello ${id}`,
  }));
}

const probe = {} as { current: ReturnType<typeof useGuestbook> };
function Probe() {
  const v = useGuestbook();
  useEffect(() => {
    probe.current = v;
  });
  return null;
}

async function mount() {
  render(
    <GuestbookProvider>
      <Probe />
    </GuestbookProvider>,
  );
  await waitFor(() => expect(probe.current.status).toBe("ready"));
}

const pageReads = () => readContract.mock.calls.filter(([a]) => a.functionName !== "entryCount");

beforeEach(() => {
  readContract.mockClear();
});
afterEach(cleanup);

describe("GuestbookProvider paging past filtered entries", () => {
  it("keeps fetching when the first page is all junk (posted directly to the contract)", async () => {
    makeLog(100, (id) => (id >= 80 ? (id % 2 ? "spam" : "hidden") : null));
    await mount();
    const ids = probe.current.entries.map((e) => Number(e.id));
    expect(ids.length).toBeGreaterThanOrEqual(10);
    expect(ids[0]).toBe(79);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(probe.current.hasMore).toBe(true);
    expect(probe.current.count).toBe(100n);
    // Two pages (latest + one older page), every read pinned to the same block.
    expect(pageReads()).toHaveLength(2);
    for (const [a] of readContract.mock.calls) expect(a).toMatchObject({ blockNumber: PINNED });
  });

  it("stops after a budget of 5 pages, then Load more continues with the same budget", async () => {
    makeLog(240, () => "spam");
    await mount();
    expect(probe.current.entries).toEqual([]);
    expect(pageReads()).toHaveLength(5);
    expect(probe.current.hasMore).toBe(true);

    makeLog(240, (id) => (id < 5 ? null : "spam"));
    readContract.mockClear();
    await act(() => probe.current.loadMore());
    // 5 more pages cover ids 40..139; nothing visible yet.
    expect(pageReads()).toHaveLength(5);
    expect(probe.current.entries).toEqual([]);
    expect(probe.current.hasMore).toBe(true);

    readContract.mockClear();
    await act(() => probe.current.loadMore());
    // Ids 0..39 remain: two pages, then the start of the log.
    expect(pageReads()).toHaveLength(2);
    expect(probe.current.entries.map((e) => Number(e.id))).toEqual([4, 3, 2, 1, 0]);
    expect(probe.current.hasMore).toBe(false);
    for (const [a] of readContract.mock.calls) expect(a).toMatchObject({ blockNumber: PINNED });
  });

  it("reads only one page when it already has enough visible entries", async () => {
    makeLog(50, () => null);
    await mount();
    expect(probe.current.entries).toHaveLength(20);
    expect(pageReads()).toHaveLength(1);
    readContract.mockClear();
    await act(() => probe.current.loadMore());
    expect(pageReads()).toHaveLength(1);
    expect(probe.current.entries).toHaveLength(40);
  });
});
