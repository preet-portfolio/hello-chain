"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { fetchLatest, fetchOlder, MIN_VISIBLE, PAGE_BUDGET, watchSigned, type FeedEntry } from "@/lib/feed";

const PAGE_SIZE = 20;

type Status = "loading" | "ready" | "error";

type GuestbookState = {
  status: Status;
  entries: FeedEntry[];
  count: bigint;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreFailed: boolean;
  loadMore: () => Promise<void>;
  retry: () => void;
  /** Shows a just-relayed entry (negative placeholder id) until its Signed event arrives; returns an undo. */
  addOptimistic: (entry: FeedEntry) => () => void;
};

const Ctx = createContext<GuestbookState | null>(null);

export function useGuestbook(): GuestbookState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useGuestbook must be used inside <GuestbookProvider>");
  return v;
}

/** The provider's optimistic-entry sink, or undefined outside a provider. */
export function useOptimisticSink(): GuestbookState["addOptimistic"] | undefined {
  return useContext(Ctx)?.addOptimistic;
}

// One visitor has at most one entry in flight (the contract's cooldown), so the real event
// replaces any placeholder from the same visitorId.
// visitorIds are compared case-insensitively: hex from an event and from a client may differ in case.
const sameVisitor = (a: FeedEntry, b: FeedEntry) => a.visitorId.toLowerCase() === b.visitorId.toLowerCase();
const isPlaceholderFor = (p: FeedEntry, e: FeedEntry) => p.id < 0n && sameVisitor(p, e);

export function GuestbookProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [count, setCount] = useState<bigint>(0n);
  // Lowest entry id we have paged down to (every id below it is not yet loaded).
  const [oldestLoaded, setOldestLoaded] = useState<bigint>(0n);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const busy = useRef(false);
  // Block every read of this feed is pinned to (from fetchLatest); the watcher replays from block + 1.
  const pinnedBlock = useRef<bigint>(0n);

  useEffect(() => {
    let cancelled = false;
    let unwatch: (() => void) | undefined;
    (async () => {
      try {
        const { entries: first, count: n, blockNumber } = await fetchLatest(PAGE_SIZE);
        let oldest = n > BigInt(PAGE_SIZE) ? n - BigInt(PAGE_SIZE) : 0n;
        let initial = first;
        // A first page of hidden/filtered entries must not leave the first screen empty: page further
        // (same pinned block), within one load's budget counting the page already read.
        if (first.length < MIN_VISIBLE && oldest > 0n) {
          const more = await fetchOlder(oldest, {
            limit: PAGE_SIZE,
            blockNumber,
            minVisible: MIN_VISIBLE - first.length,
            maxPages: PAGE_BUDGET - 1,
          });
          initial = [...first, ...more.entries];
          oldest = more.oldest;
        }
        if (cancelled) return;
        pinnedBlock.current = blockNumber;
        setEntries(initial);
        setCount(n);
        setOldestLoaded(oldest);
        setStatus("ready");
        unwatch = watchSigned(
          (e) =>
            setEntries((prev) =>
              prev.some((p) => p.id === e.id) ? prev : [e, ...prev.filter((p) => !isPlaceholderFor(p, e))],
            ),
          {
            fromBlock: blockNumber + 1n, // reads were pinned to blockNumber, so no overlap
            // Count every recorded signature, even ones the display filter hides.
            onSigned: (id) => setCount((c) => (id + 1n > c ? id + 1n : c)),
          },
        );
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      unwatch?.();
    };
  }, [attempt]);

  const loadMore = useCallback(async () => {
    if (busy.current || oldestLoaded === 0n) return;
    busy.current = true;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      const older = await fetchOlder(oldestLoaded, { limit: PAGE_SIZE, blockNumber: pinnedBlock.current });
      setEntries((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...older.entries.filter((o) => !seen.has(o.id))];
      });
      setOldestLoaded(older.oldest);
    } catch {
      setLoadMoreFailed(true);
    } finally {
      busy.current = false;
      setLoadingMore(false);
    }
  }, [oldestLoaded]);

  const retry = useCallback(() => {
    setStatus("loading");
    setAttempt((a) => a + 1);
  }, []);

  const addOptimistic = useCallback((entry: FeedEntry) => {
    setEntries((prev) =>
      // The real event can win the race; then there is nothing to add.
      prev.some(
        (p) =>
          p.id >= 0n &&
          sameVisitor(p, entry) &&
          p.message === entry.message &&
          p.timestamp >= entry.timestamp - 15 * 60,
      )
        ? prev
        : [entry, ...prev.filter((p) => !isPlaceholderFor(p, entry))],
    );
    return () => setEntries((prev) => prev.filter((p) => p.id !== entry.id));
  }, []);

  const value = useMemo<GuestbookState>(
    () => ({
      status,
      entries,
      count,
      hasMore: oldestLoaded > 0n,
      loadingMore,
      loadMoreFailed,
      loadMore,
      retry,
      addOptimistic,
    }),
    [status, entries, count, oldestLoaded, loadingMore, loadMoreFailed, loadMore, retry, addOptimistic],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
