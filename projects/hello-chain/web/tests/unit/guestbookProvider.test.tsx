// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { FeedEntry } from "@/lib/feed";

let emit: (e: FeedEntry) => void = () => {};
vi.mock("@/lib/feed", () => ({
  fetchLatest: async () => ({ entries: [], count: 0n, blockNumber: 1n }),
  fetchOlder: async () => ({ entries: [], oldest: 0n }),
  MIN_VISIBLE: 10,
  PAGE_BUDGET: 5,
  watchSigned: (onEntry: (e: FeedEntry) => void) => {
    emit = onEntry;
    return () => {};
  },
}));

import { GuestbookProvider, useGuestbook } from "@/components/GuestbookProvider";

// Checksummed wallet address left-padded to bytes32 (mixed case), vs. the event's lowercase hex.
const MIXED = "0x0000000000000000000000005B38Da6a701c568545dCfcB03FcB875f56beddC4" as const;
const LOWER = MIXED.toLowerCase() as `0x${string}`;
const NOW = 1_800_000_000;

const placeholder: FeedEntry = { id: -1n, visitorId: MIXED, timestamp: NOW, kind: "wallet", message: "hi" };
const real: FeedEntry = { id: 7n, visitorId: LOWER, timestamp: NOW + 2, kind: "wallet", message: "hi" };

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

beforeEach(() => {
  emit = () => {};
});
afterEach(cleanup);

describe("GuestbookProvider optimistic entries", () => {
  it("replaces a checksummed-wallet placeholder with the real event: one card", async () => {
    await mount();
    act(() => void probe.current.addOptimistic(placeholder));
    expect(probe.current.entries.map((e) => e.id)).toEqual([-1n]);
    act(() => emit(real));
    expect(probe.current.entries.map((e) => e.id)).toEqual([7n]);
  });

  it("skips the placeholder when the real event arrived first: one card", async () => {
    await mount();
    act(() => emit(real));
    act(() => void probe.current.addOptimistic(placeholder));
    expect(probe.current.entries.map((e) => e.id)).toEqual([7n]);
  });

  it("undo removes only the placeholder", async () => {
    await mount();
    let undo = () => {};
    act(() => {
      undo = probe.current.addOptimistic(placeholder);
    });
    act(() => undo());
    expect(probe.current.entries).toEqual([]);
  });
});
