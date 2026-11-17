// Data layer for the live feed. No React in here so it stays unit-testable.
import { guestbookAbi, guestbookAddress } from "@/lib/contract";
import { activeChain, publicClient } from "@/lib/chain";
import { isAbusive } from "@/lib/filter";

export type FeedKind = "direct" | "wallet" | "passkey";

export type FeedEntry = {
  id: bigint;
  visitorId: `0x${string}`;
  timestamp: number;
  kind: FeedKind;
  message: string;
};

type EntryViewLike = {
  id: bigint;
  visitorId: `0x${string}`;
  timestamp: number | bigint;
  kind: number;
  hidden: boolean;
  message: string;
};

const KINDS: FeedKind[] = ["direct", "wallet", "passkey"];

export class GuestbookUnavailableError extends Error {
  constructor() {
    super("Guestbook address is not configured for the active chain");
    this.name = "GuestbookUnavailableError";
  }
}

function address(): `0x${string}` {
  const a = guestbookAddress[activeChain.id];
  if (!a) throw new GuestbookUnavailableError();
  return a;
}

// Every id a read has returned, including hidden/filtered ones. Signed events do not carry
// `hidden`, so a watched event for an id we already read must never resurface as a card.
const knownIds = new Set<string>();
const remember = (rows: readonly EntryViewLike[]) => rows.forEach((r) => knownIds.add(r.id.toString()));

function toFeedEntry(e: EntryViewLike): FeedEntry {
  return {
    id: e.id,
    visitorId: e.visitorId,
    timestamp: Number(e.timestamp),
    kind: KINDS[e.kind] ?? "direct",
    message: e.message,
  };
}

/** Drops hidden entries and anything the shared abuse filter rejects. */
export function visibleEntries(entries: readonly EntryViewLike[]): FeedEntry[] {
  return entries.filter((e) => !e.hidden && !isAbusive(e.message).abusive).map(toFeedEntry);
}

export async function fetchLatest(limit = 20): Promise<{ entries: FeedEntry[]; count: bigint; blockNumber: bigint }> {
  const addr = address();
  // Block read first so the live watcher can start from it and leave no gap.
  const blockNumber = await publicClient.getBlockNumber();
  const [count, latest] = await Promise.all([
    publicClient.readContract({ address: addr, abi: guestbookAbi, functionName: "entryCount", blockNumber }),
    publicClient.readContract({
      address: addr,
      abi: guestbookAbi,
      functionName: "latest",
      args: [BigInt(limit)],
      blockNumber,
    }),
  ]);
  remember(latest as readonly EntryViewLike[]);
  return { entries: visibleEntries(latest as readonly EntryViewLike[]), count: count as bigint, blockNumber };
}

/** Entries with id < beforeId, newest first. Pass `blockNumber` to read at the feed's pinned block. */
export async function fetchPage(beforeId: bigint, limit = 20, blockNumber?: bigint): Promise<FeedEntry[]> {
  if (beforeId <= 0n) return [];
  const start = beforeId > BigInt(limit) ? beforeId - BigInt(limit) : 0n;
  const rows = (await publicClient.readContract({
    address: address(),
    abi: guestbookAbi,
    functionName: "getEntries",
    args: [start, beforeId - start],
    blockNumber,
  })) as readonly EntryViewLike[];
  remember(rows);
  return visibleEntries([...rows].reverse());
}

/** A screen's worth of visible entries: keep paging past hidden/filtered ones until this many show. */
export const MIN_VISIBLE = 10;
/** Most pages one load (the first screen, or one "Load more") may read. */
export const PAGE_BUDGET = 5;

/**
 * Pages down from `beforeId` (newest first, every read at `blockNumber`) until `minVisible` visible
 * entries are collected, `maxPages` pages are read, or the start of the log is reached. Without this,
 * a run of junk posted straight to the contract (the relay never sees it) could empty the first screen.
 * @returns the visible entries and the new lowest loaded id (0n = nothing older left).
 */
export async function fetchOlder(
  beforeId: bigint,
  opts: { limit: number; blockNumber: bigint; minVisible?: number; maxPages?: number },
): Promise<{ entries: FeedEntry[]; oldest: bigint }> {
  const { limit, blockNumber, minVisible = MIN_VISIBLE, maxPages = PAGE_BUDGET } = opts;
  const entries: FeedEntry[] = [];
  let oldest = beforeId;
  for (let pages = 0; pages < maxPages && oldest > 0n && entries.length < minVisible; pages++) {
    entries.push(...(await fetchPage(oldest, limit, blockNumber)));
    oldest = oldest > BigInt(limit) ? oldest - BigInt(limit) : 0n;
  }
  return { entries, oldest };
}

/** Subscribe to new signatures. A freshly signed entry is never hidden. */
export function watchSigned(
  onEntry: (e: FeedEntry) => void,
  opts: { fromBlock?: bigint; // first block to replay: pass blockNumber + 1n
    onSigned?: (id: bigint) => void } = {},
): () => void {
  return publicClient.watchContractEvent({
    fromBlock: opts.fromBlock,
    address: address(),
    abi: guestbookAbi,
    eventName: "Signed",
    onLogs: (logs) => {
      for (const log of logs) {
        const a = log.args as {
          id?: bigint;
          visitorId?: `0x${string}`;
          kind?: number;
          message?: string;
          timestamp?: number | bigint;
        };
        if (a.id !== undefined) opts.onSigned?.(a.id);
        if (a.id === undefined || !a.visitorId || a.message === undefined) continue;
        if (knownIds.has(a.id.toString())) continue;
        const [entry] = visibleEntries([
          {
            id: a.id,
            visitorId: a.visitorId,
            kind: Number(a.kind ?? 0),
            message: a.message,
            timestamp: a.timestamp ?? 0,
            hidden: false,
          },
        ]);
        if (entry) onEntry(entry);
      }
    },
  });
}
