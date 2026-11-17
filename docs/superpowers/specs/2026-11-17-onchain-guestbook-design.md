# Design — On-chain Guestbook ("Hello, Chain")

*Project 1 · inspired by Chapter 3 "Hello World of Smart Contracts" · 2026-11-17*
*Working name "Hello, Chain" is a placeholder (builder/owner may rename).*

## 1. Intent and why

The owner (a developer building a Web3 portfolio) wants a **real, interactive product** that strangers — recruiters, hiring managers, fellow devs — actually use, and that proves professional-grade smart-contract engineering.

The book's Chapter 3 teaches three toys in Solidity 0.4.11: a greeting (`HelloWorld`), a counter with increment/decrement (`ArithValue`), and a loop (`NumberLoop`), deployed on a hand-mined private PoW chain. We turn those three ideas into a product:

| Book concept | Becomes |
|---|---|
| Hello World greeting | A visitor's short "hello" message, stored on-chain forever |
| Counter (inc/dec) | Entry count + unique-visitor count, provably consistent and never underflowing |
| Loop | Paginated, gas-bounded reading of the feed |
| Private chain + mining | Local `anvil` devnet → Base Sepolia public testnet (mining no longer exists post-Merge) |

**The product:** a standalone web page where a visitor writes a hello (≤140 chars), confirms with Face ID / fingerprint (passkey), and watches it appear live in a feed alongside a running visitor count. No wallet install, no gas, no crypto jargon. A "How it works" section explains the engineering to recruiters in plain language.

The book's code is a concept source and a "before" baseline only. All code, naming and structure are original.

## 2. Goals

1. A stranger on a phone signs the guestbook in **under a minute** with no crypto knowledge or funds.
2. Contracts built to professional standard: rules written first as tests (unit + fuzz + invariant), key rules formally checked, static analysis clean, gas understood and measured.
3. Live feed updates without refresh.
4. Owner can hide abusive entries from display without altering the on-chain record.
5. Deployed and **source-verified** on Base Sepolia (Sourcify exact match).
6. CI on every push.
7. Reference notes `notes/ch03-hello-world.md` with under-the-hood findings.
8. A visible "book vs ours" comparison: the book's `ArithValue` fails our counter rules.

## 3. Non-goals

- Mainnet deployment or real money.
- Email sign-in (dropped: requires a third-party wallet vendor; passkeys cover non-crypto users).
- Editing/deleting entries, replies, likes, threads, profiles, avatars.
- Tokens, NFTs, rewards.
- Building the owner's wider portfolio site (this is standalone; an embed can come later).
- Multi-language content moderation beyond a reasonable filter.

## 4. Anti-goals (would be a failure even if it "works")

- Any visitor-facing step that requires holding crypto, installing an extension, or reading words like "gas", "nonce", "transaction hash" without a plain-language label.
- Abusive content displayed on the page with no way for the owner to hide it.
- Third-party wallet-vendor branding in the visitor flow.
- An upgradeable/admin-mutable message store — permanence is the point.
- Unbounded loops or reads whose gas grows with the guestbook's size.

## 5. Constraints

- Network: **Base Sepolia** (chain id 84532). Local dev on `anvil`.
- Contracts: **Foundry**, Solidity **0.8.x pinned** to the latest stable at setup; OpenZeppelin Contracts **5.x** for EIP-712, signature checking, P-256 / WebAuthn verification, and `Ownable2Step`.
- Passkey verification uses the P-256 verifier: Base's RIP-7212 precompile when present, with a Solidity fallback so it also works on `anvil` (OpenZeppelin's `P256` already does precompile-then-fallback; builder confirms the exact library/version, including whether OZ's WebAuthn helper is used or a vetted equivalent such as Solady's).
- Frontend: **Next.js (App Router) + TypeScript + Tailwind**, **viem/wagmi**. Mobile-first, light + dark.
- Hosting: **Vercel** (owner's account is connected). Relayer runs as a Next.js route handler there.
- Secrets (relayer private key, RPC URL, deployer key) are supplied by the owner; never committed. `.env.example` documents them.
- **Repo layout (Claude's call):** one git repo at the workspace root (`Development_ETH_Smart_Contract/`) holding all book projects. CI workflows live at the repo root in `.github/workflows/`, scoped per project with `paths:` filters. The book repo `Ethereum-Smart-Contract-Development/` is git-ignored (it keeps its own `.git`; reference only). Vercel's root directory = `projects/03-hello-chain/web`. A GitHub remote is created by the owner (or with explicit approval).
- **Domain (owner's call):** the Vercel production URL (`*.vercel.app`) for now. The WebAuthn `rpId` comes from an env var (`NEXT_PUBLIC_RP_ID`), never hard-coded, so a later move is a config change. Accepted consequence: when the site moves to a custom domain, existing passkeys stop working there and those visitors start fresh. Passkey sign-in works on `localhost` and the production URL; Vercel preview deployments show the page but passkey signing there is not required to work.
- A local dev server must be running and opened in the browser pane **from the first build step**, so the owner can watch progress.

## 6. Approaches considered

### Moderation
| Option | Verdict |
|---|---|
| **Relayer filter + owner "hidden" flag on-chain** | **Chosen.** Record stays permanent and honest; page stays clean; hiding is a separate public flag, so "never edited" holds. |
| Fully immutable, UI-only blocklist | Rejected: blocklist lives off-chain; explorers show everything with no signal. |
| Approve-before-publish | Rejected: kills the "appears live" moment. |

### Gasless sign-in
| Option | Verdict |
|---|---|
| **Passkey (WebAuthn P-256) + own relayer** | **Chosen.** No vendor, no install; contract verifies the passkey signature itself; the abuse filter lives naturally in the relayer; showcases the most original engineering. |
| Coinbase Smart Wallet + CDP paymaster (ERC-4337) | Rejected: vendor account/API key, Coinbase popup branding, filter needs a separate gate. |
| Privy embedded wallet (email) | Rejected: vendor lock-in and branding; mostly integration work. |

### Embedding
Owner has no portfolio yet → **standalone page** on Vercel. Embed later.

## 7. Decided design

### 7.1 Identity
- Every author is a `bytes32 visitorId`:
  - Passkey visitor: `keccak256(abi.encode(qx, qy))` of their P-256 public key.
  - Wallet visitor: the address left-padded to `bytes32` (so the two spaces cannot collide in practice; builder adds a domain tag if needed).
- The browser stores the passkey's credential id + public key (qx, qy) in `localStorage` after registration. If lost, the visitor simply creates a new passkey (= new visitor). Public-key recovery from a signature is out of scope.

### 7.2 Contract `Guestbook`
Not upgradeable. Owner = `Ownable2Step`.

**Rules (written as tests before code):**
1. Message length is 1–140 **bytes**; empty or longer reverts with a custom error.
2. One entry per `visitorId` per **cooldown** (default 24 h, fixed at deploy, immutable).
3. `entryCount() == entries.length` always; `uniqueVisitors() <= entryCount()`; counts only ever increase (no underflow is possible — and the formal check proves it).
4. Entries are never modified or deleted; the only mutable per-entry state is the owner's `hidden` flag.
5. Signatures are bound to: chain id, contract address (EIP-712 domain), visitorId, message, a per-visitor **nonce**, and a **deadline**. Replays, expired or cross-chain signatures revert.
6. Reads are paginated with a hard maximum page size (e.g. 50); no function iterates over all entries.
7. Only the owner can toggle `hidden`; toggling emits an event.

**Write paths** (anyone may submit — the signature decides authorship):
- `signWithPasskey(pubKey qx/qy, message, deadline, webAuthnAuth)` — verifies a WebAuthn assertion whose challenge is the EIP-712 digest.
- `signWithWallet(address author, message, deadline, signature)` — EIP-712 typed signature; supports EOAs and ERC-1271 smart accounts via `SignatureChecker`.
- `sign(message)` — direct call by `msg.sender` who pays their own gas (for crypto-native visitors who prefer it; also the simplest path for tests).

**Read paths:** `entryCount()`, `uniqueVisitors()`, `getEntry(id)`, `getEntries(start, limit)` (capped), `latest(limit)` (capped, newest first), `nonces(visitorId)`, `isHidden(id)`.

**Storage (builder may pack differently):** `Entry { bytes32 visitorId; uint40 timestamp; uint8 kind /*passkey|wallet|direct*/; string message; }`, `Entry[] entries`, `mapping(bytes32 => uint40) lastSignedAt`, `mapping(bytes32 => uint256) nonces`, `mapping(uint256 => bool) hidden`.

**Events:** `Signed(uint256 indexed id, bytes32 indexed visitorId, uint8 kind, string message, uint40 timestamp)`, `HiddenSet(uint256 indexed id, bool hidden)`.

**Errors:** custom errors for every revert (`MessageEmpty`, `MessageTooLong`, `CooldownActive(uint40 until)`, `SignatureExpired`, `InvalidSignature`, `PageTooLarge`, …).

### 7.3 Relayer (`POST /api/relay`)
1. Validate shape and length.
2. **Abuse filter**: profanity/slur list, URL and contact-info blocking, repeated-character spam. Rejections return a friendly message.
3. **Rate limit** per IP and per visitorId, **plus a per-device/IP daily limit of one entry** (owner's call), because passkeys are free to create and the on-chain cooldown only applies per passkey. Store choice left to builder (e.g. Upstash Redis via Vercel Marketplace).
4. **Simulate** the call (`eth_call`) — reject before spending gas if it would revert (bad signature, cooldown).
5. Submit from the relayer key; manage nonces safely for concurrent requests.
6. Return the transaction hash; log low relayer balance.
The relayer can be bypassed (the contract is permissionless). Two backstops: (a) **the same abuse filter runs on every entry before display** (owner's call), so bypassing entries never appear even briefly — the filter is one shared TypeScript module used by both the relayer and the page; (b) the owner's on-chain `hidden` flag for anything the filter misses.

**Wallet path (Claude's call):** "Use a crypto wallet instead" is **gasless** — the visitor signs EIP-712 typed data and the relayer submits `signWithWallet`. `sign()` stays in the contract for direct callers and tests but has no button, so no visitor path ever needs funds.

### 7.4 Web page (single route, mobile-first)
1. **Hero** — one line on what this is; live count, labelled honestly as **signatures** (a count of passkeys/wallets, not verified people).
2. **Sign card** — textarea with 140-char counter → primary button "Sign with Face ID / fingerprint" (wording adapts to platform); secondary "Use a crypto wallet instead". States: idle → confirming → "Writing it to the blockchain…" (optimistic entry in feed) → "Signed ✓" with a plain-language "View proof" link to the explorer.
3. **Live feed** — newest first, paginated "Load more"; hidden entries omitted; relative timestamps; passkey visitors shown as a short friendly handle derived from visitorId.
4. **How it works** (case study for recruiters) — plain language, small diagram: passkey → relayer → contract → feed; the "book vs ours" comparison; links to the verified contract and GitHub.
5. **Owner moderation** — no admin UI required; owner hides entries via a small `cast` script. (A minimal owner page is optional, builder's call.)
Errors always in plain language (e.g. "You've already signed today — come back tomorrow").

### 7.5 Quality and proof
- `forge test`: unit, **fuzz** (message lengths, cooldown boundaries, signature tampering), **invariant** (counts consistency, no edits, monotonic counts). Passkey signatures tested with Foundry's P-256 signing cheatcode / known WebAuthn vectors.
- **Formal**: Halmos (preferred) or SMTChecker proving rule 3 and the cooldown rule.
- **Static analysis**: Slither + Aderyn — clean or each finding explained in the notes.
- **Gas**: `forge snapshot` baseline; notes predict costs of `sign` (cold SSTOREs, string storage per 32-byte word, event log costs) from evm.codes / EIP-2929 and compare to measured.
- **Book comparison**: compile the book's `ArithValue` with a 0.4.x solc profile and run the counter-rule tests against it; show `decrementNumber()` wrapping from 0 to 2²⁵⁶−1.
- **Frontend**: typecheck, lint, unit tests for the filter and formatting; one Playwright end-to-end test against `anvil` using Chrome's virtual WebAuthn authenticator.
- **CI (GitHub Actions)**: all of the above on every push.
- **Deploy**: Foundry script to Base Sepolia, Sourcify verification.

### 7.6 Layout
```
.github/workflows/hello-chain.yml   CI, path-filtered to projects/03-hello-chain/**
.gitignore                          ignores Ethereum-Smart-Contract-Development/
projects/03-hello-chain/
  contracts/      Foundry project (src, test, script, book-baseline)
  web/            Next.js app (page + /api/relay + shared filter module)
  README.md       how to run, deploy, moderate
notes/ch03-hello-world.md
```

## 8. Success criteria
- CI green; fuzz + invariant tests and the formal check pass.
- Measured gas within a stated tolerance of predictions (differences explained).
- Sourcify exact match on Base Sepolia.
- A stranger signs from a phone in under a minute with no crypto.
- The book's `ArithValue` visibly fails the counter tests ours passes.
- README progress table updated.

## 9. Left to the builder
Exact names, cooldown value within 1–24 h, page size, visual design and colours, filter library, rate-limit store, handle-generation scheme, whether to add a minimal owner page, test-vector sources, and contract storage packing.
