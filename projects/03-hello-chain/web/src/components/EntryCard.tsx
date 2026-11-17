import { friendlyHandle } from "@/lib/handle";
import type { FeedEntry } from "@/lib/feed";

const HOW: Record<FeedEntry["kind"], string> = {
  passkey: "signed with a passkey",
  wallet: "signed with a wallet",
  direct: "signed directly",
};

export function relativeTime(unixSeconds: number, nowMs: number): string {
  const s = Math.max(0, Math.floor(nowMs / 1000 - unixSeconds));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(s / 3600);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(s / 86400);
  if (d < 30) return `${d} ${d === 1 ? "day" : "days"} ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function EntryCard({ entry, now }: { entry: FeedEntry; now: number | null }) {
  return (
    <li className={`rounded-2xl border border-line bg-surface p-4 sm:p-5 ${entry.id < 0n ? "entry-in border-dashed" : "entry-in"}`}>
      <p className="break-words text-base leading-relaxed [overflow-wrap:anywhere]">{entry.message}</p>
      <p className="mt-3 flex flex-wrap items-baseline gap-x-2 text-sm text-muted">
        <span className="font-medium text-ink">
          {friendlyHandle(entry.visitorId)}
        </span>
        <span aria-hidden>·</span>
        <time dateTime={new Date(entry.timestamp * 1000).toISOString()}>
          {now === null ? "" : relativeTime(entry.timestamp, now)}
        </time>
        <span aria-hidden>·</span>
        <span className="text-xs">{HOW[entry.kind]}</span>
      </p>
    </li>
  );
}
