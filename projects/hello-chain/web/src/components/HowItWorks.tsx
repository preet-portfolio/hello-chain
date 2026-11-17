// The recruiter case study. Server component: static copy plus links read from env at build time.
// This is the one place on the page where technical words appear, each explained in plain language.
import { configuredLinks, type CaseStudyLink } from "@/lib/links";

/** Whole-test gas from contracts/.gas-snapshot (setup included, so these are upper bounds). */
const GAS = [
  { path: "Direct, visitor pays their own fee", test: "test_sign_storesEntryAndEmits", gas: 220_133 },
  { path: "Crypto wallet signature", test: "test_validSig_recordsAsAuthor_kindWallet", gas: 246_383 },
  { path: "Passkey (Face ID / fingerprint)", test: "test_validAssertion_kindPasskey", gas: 513_441 },
] as const;
const MAX_GAS = Math.max(...GAS.map((g) => g.gas));

type Step = { title: string; body: string; detail: React.ReactNode; icon: React.ReactNode };

const STEPS: Step[] = [
  {
    title: "Your passkey seals the message",
    body: "Face ID or your fingerprint unlocks a private key that never leaves your device. It signs your exact words — a seal only you can press.",
    detail: (
      <>
        A <Term>WebAuthn passkey</Term> signs with <Term>P-256</Term>, the standard curve behind passkeys. What it
        signs is an <Term>EIP-712</Term> message: a structured format that ties your words to this guestbook, this
        network, a one-time counter and a 15-minute expiry, so the seal can&apos;t be replayed anywhere else.
      </>
    ),
    icon: <FingerprintIcon />,
  },
  {
    title: "A relayer pays the fee",
    body: "Writing to a blockchain costs a small fee, called gas. A small server of mine — the relayer — checks your message is friendly, then pays that fee for you.",
    detail: (
      <>
        It rate-limits each device and <Term>simulates</Term> every entry first, so one that would be rejected costs
        nothing. It can&apos;t forge or alter your words: change one letter and the seal from step 1 no longer
        matches.
      </>
    ),
    icon: <RelayIcon />,
  },
  {
    title: "The contract checks the seal itself",
    body: "The guestbook is a small program — a smart contract — on Base, a public blockchain. It doesn't trust my server: it re-checks your seal, then stores your hello for good.",
    detail: (
      <>
        On Base the P-256 check uses the <Term>RIP-7212</Term> precompile, a built-in shortcut for exactly this maths,
        with OpenZeppelin&apos;s Solidity fallback elsewhere. One entry per visitor per day, enforced on-chain. There is
        no edit or delete; I can only hide an entry from this page, and the original stays public.
      </>
    ),
    icon: <BlockIcon />,
  },
  {
    title: "The feed hears it live",
    body: "When your hello is stored, the contract announces it. This page is listening, so it appears for everyone — no refresh.",
    detail: (
      <>
        The page subscribes to the contract&apos;s <Term>Signed</Term> event and reads history in fixed-size pages,
        so loading never slows down as the guestbook grows. The same friendliness filter runs again before anything
        is shown.
      </>
    ),
    icon: <FeedIcon />,
  },
];

export function HowItWorks({ links = configuredLinks() }: { links?: CaseStudyLink[] }) {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className="scroll-mt-8 border-t border-line pt-16 sm:pt-20">
      <p className="text-eyebrow font-semibold uppercase text-accent">For the curious</p>
      <h2 id="how-title" className="mt-3 font-display text-h2 tracking-tight">
        How it works
      </h2>
      <p className="mt-5 max-w-2xl text-lead text-muted">
        You just left a public record that nobody — not even me — can edit. Here&apos;s what happens in the few
        seconds between your fingerprint and your hello appearing, and why each part is there.
      </p>

      <ol className="flow mt-12" aria-label="From your device to the feed, in four steps">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flow-step">
            <span className="flow-icon" aria-hidden>
              {s.icon}
            </span>
            <p className="font-mono text-xs text-muted">Step {i + 1}</p>
            <h3 className="mt-1 text-h3 font-semibold">{s.title}</h3>
            <p className="mt-2 leading-relaxed text-muted">{s.body}</p>
            <p className="mt-3 border-l-2 border-accent-soft pl-3 text-sm leading-relaxed text-muted">{s.detail}</p>
          </li>
        ))}
      </ol>

      <Proven />
      <Costs />

      {links.length > 0 && (
        <ul className="mt-14 flex flex-wrap gap-3" aria-label="Proof and source">
          {links.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-surface px-5 py-2.5 text-sm font-medium transition-colors hover:border-accent hover:text-accent"
              >
                {l.label}
                <span aria-hidden>↗</span>
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Claims backed by contracts/test/Guestbook.Halmos.t.sol and contracts/test/Guestbook.Invariant.t.sol. */
function Proven() {
  return (
    <div className="mt-20">
      <h3 className="font-display text-[1.75rem] leading-tight tracking-tight">Proven, not promised</h3>
      <p className="mt-3 max-w-2xl leading-relaxed text-muted">
        &ldquo;Trust me&rdquo; isn&apos;t good enough for a public record, so the guestbook&apos;s two core rules are
        checked by machines, not just by a handful of examples I thought of.
      </p>
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <article className="rounded-2xl border border-line bg-surface p-6">
          <p className="text-eyebrow font-semibold uppercase text-accent">Rule 1</p>
          <p className="mt-4 leading-relaxed">
            <strong className="font-semibold">The entry count can never go down.</strong> There is no subtract and no
            setter — only a new hello adds to it, and hiding an entry leaves it alone.
          </p>
        </article>
        <article className="rounded-2xl border border-line bg-surface p-6">
          <p className="text-eyebrow font-semibold uppercase text-accent">Rule 2</p>
          <p className="mt-4 leading-relaxed">
            <strong className="font-semibold">One hello per visitor per day.</strong> A second try at any moment before
            the wait is over is refused.
          </p>
        </article>
      </div>
      <p className="mt-6 max-w-2xl text-sm leading-relaxed text-muted">
        Both are checked two ways. <Term>Halmos</Term>, a symbolic checker, proves them for every possible input on
        the direct signing path — not a sample, all of them. And <Term>invariant tests</Term> fire 256 random
        sequences of 100 calls each (signing by every method, waiting, hiding) and confirm the rules hold after
        every single step.
      </p>
      <p className="mt-4 text-xs leading-relaxed text-muted">
        Proofs: <code className="font-mono">check_countNeverDecreases</code> and{" "}
        <code className="font-mono">check_cooldownEnforced</code>; invariants:{" "}
        <code className="font-mono">invariant_countsMonotonic</code> and{" "}
        <code className="font-mono">invariant_cooldownRespected</code>.
      </p>
    </div>
  );
}

function Costs() {
  return (
    <div className="mt-20">
      <h3 className="font-display text-[1.75rem] leading-tight tracking-tight">What a hello costs</h3>
      <p className="mt-3 max-w-2xl leading-relaxed text-muted">
        <Term>Gas</Term> is how a blockchain measures computing work; the fee is gas × the network&apos;s current
        price. The relayer pays it, so you never see it. Measured in the contract&apos;s test suite (whole test, setup
        included):
      </p>
      <table className="mt-6 w-full border-collapse text-left text-sm">
        <caption className="sr-only">Measured gas per way of signing</caption>
        <thead>
          <tr className="border-b border-line text-muted">
            <th scope="col" className="py-2 pr-3 font-medium">
              Way of signing
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              Gas used
            </th>
          </tr>
        </thead>
        <tbody>
          {GAS.map((g) => (
            <tr key={g.test} className="border-b border-line align-top">
              <th scope="row" className="py-3 pr-3 font-normal">
                {g.path}
                <span
                  aria-hidden
                  className="mt-2 block h-1.5 rounded-full bg-accent"
                  style={{ width: `${Math.round((g.gas / MAX_GAS) * 100)}%`, opacity: g.gas === MAX_GAS ? 1 : 0.55 }}
                />
              </th>
              <td className="py-3 text-right font-mono tabular-nums">{g.gas.toLocaleString("en-US")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
        A passkey costs about twice as much because checking a P-256 signature is heavier maths than checking a
        wallet&apos;s. That&apos;s the trade I chose: the visitor gets Face ID instead of a wallet install, and the
        relayer absorbs the difference.
      </p>
    </div>
  );
}

function Term({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-ink">{children}</span>;
}

// ---- Icons: original line drawings, stroke = currentColor so they follow the theme. ----

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {children}
    </svg>
  );
}

function FingerprintIcon() {
  return (
    <Svg>
      <path d="M6.5 8.5A6.5 6.5 0 0 1 18.4 9" />
      <path d="M5.2 13a8 8 0 0 1 .3-2.4" />
      <path d="M9 19.5c.8-1.6 1.2-3.4 1.2-5.3a1.8 1.8 0 0 1 3.6 0c0 .9-.1 1.8-.2 2.6" />
      <path d="M7.4 17.2c.6-1 .9-2 .9-3.1a3.7 3.7 0 0 1 7.4 0c0 2.4-.5 4.6-1.4 6.6" />
      <path d="M18.6 12.4c.2.6.3 1.2.3 1.8 0 1.4-.2 2.8-.5 4.1" />
      <path d="M12 14.2c0 2.7-.7 5.1-2 7.3" />
    </Svg>
  );
}

function RelayIcon() {
  return (
    <Svg>
      <path d="M3.5 11.2 20 4l-5.6 16-3.1-6.6z" />
      <path d="m11.3 13.4 4-4" />
    </Svg>
  );
}

function BlockIcon() {
  return (
    <Svg>
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="m4 7.5 8 4.5 8-4.5" />
      <path d="M12 12v9" />
    </Svg>
  );
}

function FeedIcon() {
  return (
    <Svg>
      <rect x="4" y="4" width="16" height="5" rx="1.5" />
      <rect x="4" y="11" width="16" height="4" rx="1.5" />
      <path d="M4 19h10" />
    </Svg>
  );
}
