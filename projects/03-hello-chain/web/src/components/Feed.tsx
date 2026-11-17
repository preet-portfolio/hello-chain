"use client";

import { useEffect, useState } from "react";
import { useGuestbook } from "./GuestbookProvider";
import { EntryCard } from "./EntryCard";

export function Feed() {
  const { status, entries, hasMore, loadingMore, loadMoreFailed, loadMore, retry } = useGuestbook();
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // Clock starts after mount so nothing time-dependent is read during prerender.
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);

  if (status === "loading") {
    return <p className="py-10 text-muted">Loading the guestbook…</p>;
  }

  if (status === "error") {
    return (
      <div className="rounded-2xl border border-line bg-surface p-6 text-center">
        <p>
          The guestbook is taking a nap — try again in a moment.
        </p>
        <button
          type="button"
          onClick={retry}
          className="mt-4 rounded-full border border-line-strong px-4 py-2 text-sm font-medium hover:border-accent hover:text-accent"
        >
          Try again
        </button>
      </div>
    );
  }

  if (entries.length === 0 && !hasMore) {
    return <p className="py-10 text-muted">No signatures yet. Be the first.</p>;
  }

  return (
    <section aria-label="Recent signatures">
      <ul className="space-y-3">
        {entries.map((e) => (
          <EntryCard key={e.id.toString()} entry={e} now={now} />
        ))}
      </ul>
      {hasMore && (
        <div className="mt-6 text-center">
          {loadMoreFailed && (
            <p role="status" className="mb-3 text-sm text-muted">
              Couldn&apos;t load older messages — try again.
            </p>
          )}
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-full border border-line-strong px-5 py-2 text-sm font-medium hover:border-accent hover:text-accent disabled:opacity-60"
          >
            {loadingMore ? "Loading…" : loadMoreFailed ? "Try again" : "Load more"}
          </button>
        </div>
      )}
    </section>
  );
}
