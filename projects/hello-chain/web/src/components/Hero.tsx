"use client";

import { useGuestbook } from "./GuestbookProvider";

export function Hero() {
  const { status, count } = useGuestbook();
  const n = Number(count);
  return (
    <header className="pt-14 pb-10 sm:pt-24 sm:pb-14">
      <p className="rise text-eyebrow font-semibold uppercase text-accent">A public guestbook</p>
      <h1 className="rise rise-2 mt-4 font-display text-display tracking-tight">
        Hello, <span className="italic text-accent">Chain</span>
      </h1>
      <p className="rise rise-3 mt-6 max-w-xl text-lead text-muted">
        A guestbook anyone can sign, and no one can quietly edit. Leave a hello — it takes a fingerprint, not a
        wallet.
      </p>
      <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
        <p
          className="inline-flex min-h-8 items-center gap-2 font-medium text-muted"
          aria-live="polite"
          data-testid="signature-count"
        >
          {status === "ready" ? (
            <>
              <span className="size-2 rounded-full bg-accent" aria-hidden />
              <span>
                <span className="font-mono tabular-nums text-ink">{n.toLocaleString()}</span>{" "}
                {n === 1 ? "signature" : "signatures"}
              </span>
            </>
          ) : (
            " "
          )}
        </p>
        <a href="#how-it-works" className="text-muted underline decoration-line-strong underline-offset-4 hover:text-ink">
          How it works ↓
        </a>
      </div>
    </header>
  );
}
