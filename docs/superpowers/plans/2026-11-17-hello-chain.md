# Hello, Chain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a standalone, gasless, passkey-signed on-chain guestbook on Base Sepolia, with contracts built rules-first and verified, and a polished mobile-first page for non-crypto visitors.

**Architecture:** A non-upgradeable `Guestbook` contract (Foundry, OpenZeppelin 5.x) stores ≤140-byte messages keyed by a `bytes32 visitorId` and accepts three write paths: direct, EIP-712 wallet signature, and WebAuthn passkey. A Next.js app on Vercel serves the page and a `/api/relay` route that filters, rate-limits, simulates and submits signed entries from a funded relayer key. The page reads the feed with viem, applies the same abuse filter before display, and updates live from contract events.

**Tech Stack:** Foundry (forge/anvil/cast), Solidity 0.8.x (pinned), OpenZeppelin Contracts 5.x, Halmos, Slither, Aderyn · Next.js (App Router), TypeScript, Tailwind, viem, wagmi, Vitest, Playwright · pnpm · GitHub Actions · Vercel · Base Sepolia (84532).

**Spec:** `docs/superpowers/specs/2026-11-17-onchain-guestbook-design.md`

## Global Constraints

- Network: Base Sepolia, chain id `84532`; local dev on `anvil` (chain id `31337`).
- Solidity pinned to the latest stable 0.8.x at setup (exact version written into `foundry.toml`); contract is **not upgradeable**; owner via `Ownable2Step`.
- Message length **1–140 bytes** (UTF-8 bytes, not characters).
- Cooldown: constructor param, immutable, must be within **1 h – 24 h**; deployed value **24 h (86400 s)**.
- Max page size **50**.
- EIP-712 domain: name `"HelloChain"`, version `"1"`.
- Every revert uses a custom error. Every write emits an event.
- No visitor path requires funds, an extension install, or unlabelled crypto jargon ("gas", "nonce", "transaction hash").
- No third-party wallet-vendor branding in the visitor flow. No email sign-in.
- The count shown to visitors is labelled **"signatures"**.
- WebAuthn `rpId` comes from `NEXT_PUBLIC_RP_ID`; never hard-coded.
- Secrets only in env vars; `.env.example` documents every one; nothing secret committed.
- Book code lives only in `contracts/book-baseline/` with MIT attribution; all other code is original.
- Local commits only; **never push** or create remotes without the owner's explicit OK.

## Review Focus

1. **Emoji / non-Latin messages** — 140 is a *byte* limit; the UI counter must count UTF-8 bytes so a visitor never completes Face ID only to be rejected. → Task 8 test `validateMessage counts UTF-8 bytes`.
2. **Visitor lost local storage or switched device** — passkey public key unknown; app must fall back to "Create a passkey" cleanly, not crash or sign with a stale key. → Task 10 test `loadPasskey returns null when storage empty or corrupt`.
3. **Double-click / second tab submits again** — second submission must surface "You've already signed today — come back tomorrow", never a raw revert. → Task 11 test `maps CooldownActive to friendly message`.
4. **Relayer out of funds or RPC down** — visitor sees "The guestbook is busy right now — try again in a minute" and their typed message stays in the box. → Task 11 test `returns 503 busy on submit failure`; Task 13 test keeps textarea content on error.
5. **Visitor cancels the Face ID / fingerprint prompt** — return to idle silently with no error banner. → Task 10 test `signWithPasskey returns cancelled on NotAllowedError`; Task 13 handles `cancelled` as no-op.

---

## File Structure

```
.gitignore                                  ignores Ethereum-Smart-Contract-Development/, node_modules, out, cache, .env*
.claude/launch.json                         dev-server config for the browser pane
.github/workflows/hello-chain.yml           CI, paths: projects/03-hello-chain/**
projects/03-hello-chain/
  README.md                                 run, deploy, moderate
  contracts/
    foundry.toml                            profiles: default, ci (fuzz 10k), book (solc 0.4.26, src=book-baseline)
    src/Guestbook.sol                       the contract
    src/IGuestbook.sol                      types, errors, events (shared by tests/scripts)
    test/Guestbook.Direct.t.sol             rules 1,2,3,6 via sign()
    test/Guestbook.Hidden.t.sol             rule 7
    test/Guestbook.Wallet.t.sol             EIP-712 + ERC-1271 path
    test/Guestbook.Passkey.t.sol            WebAuthn path
    test/Guestbook.Invariant.t.sol          + test/handlers/GuestbookHandler.sol
    test/Guestbook.Halmos.t.sol             formal checks
    test/BookBaseline.t.sol                 book ArithValue vs our counter rules
    book-baseline/ArithValue.sol            verbatim book file + attribution header
    script/Deploy.s.sol                     deploy + write deployments/<chainId>.json
    script/Hide.s.sol                       owner moderation
    script/SeedLocal.s.sol                  a few sample entries on anvil
    deployments/                            <chainId>.json {address, blockNumber}
  web/
    .env.example
    src/app/page.tsx                        the single page
    src/app/api/relay/route.ts              relayer endpoint
    src/components/{Hero,SignCard,Feed,EntryCard,HowItWorks}.tsx
    src/lib/contract.ts                     ABI + address per chain (generated)
    src/lib/chain.ts                        viem public client, chain selection
    src/lib/message.ts                      validateMessage, utf8ByteLength (shared)
    src/lib/filter.ts                       isAbusive (shared by relayer + page)
    src/lib/handle.ts                       friendlyHandle(visitorId)
    src/lib/passkey.ts                      register/load/sign with WebAuthn
    src/lib/typedData.ts                    EIP-712 domain/types builder (shared)
    src/lib/feed.ts                         fetchLatest, fetchPage, watchSigned
    src/lib/relay/{validate,rateLimit,submit,errors}.ts
    tests/unit/*.test.ts                    Vitest
    tests/e2e/sign.spec.ts                  Playwright + virtual authenticator
notes/ch03-hello-world.md
```

---

### Task 0: Repo, toolchain and live localhost

**Files:**
- Create: `.gitignore`, `.claude/launch.json`, `projects/03-hello-chain/web/` (Next.js scaffold), `projects/03-hello-chain/web/src/app/page.tsx`
- Test: none (scaffold) — verified by the browser pane.

**Interfaces:**
- Produces: dev server `web` on `http://localhost:3000`, launch config name `hello-chain-web`.

- [ ] **Step 1:** `git init` at the workspace root; write `.gitignore` (book repo, `node_modules`, `.next`, `out`, `cache`, `broadcast/*/31337`, `.env`, `.env.*` except `.env.example`).
- [ ] **Step 2:** Install Foundry (`curl -L https://foundry.paradigm.xyz | bash && foundryup`); `pip3 install halmos slither-analyzer`; `brew install cyfrin/tap/aderyn`. Verify: `forge --version`, `halmos --version`, `slither --version`, `aderyn --version` all print.
- [ ] **Step 3:** Scaffold `web` with `pnpm create next-app@latest web --ts --tailwind --app --src-dir --eslint --use-pnpm --no-import-alias` inside `projects/03-hello-chain/`; add `viem wagmi @tanstack/react-query`, dev deps `vitest @playwright/test`.
- [ ] **Step 4:** Replace `page.tsx` with a "Hello, Chain — being built" placeholder listing the plan's tasks, so the owner sees progress.
- [ ] **Step 5:** Write `.claude/launch.json` (`name: hello-chain-web`, `pnpm --dir projects/03-hello-chain/web dev`, port 3000); start it with `preview_start` and confirm the placeholder renders.
- [ ] **Step 6:** Commit `chore: scaffold hello-chain repo and web app`.

---

### Task 1: Guestbook core — direct path, counts, cooldown, pagination

**Files:**
- Create: `contracts/foundry.toml`, `contracts/src/IGuestbook.sol`, `contracts/src/Guestbook.sol`
- Test: `contracts/test/Guestbook.Direct.t.sol`

**Interfaces:**
- Produces (in `IGuestbook.sol`):
  - `enum Kind { Direct, Wallet, Passkey }`
  - `struct EntryView { uint256 id; bytes32 visitorId; uint40 timestamp; Kind kind; bool hidden; string message; }`
  - errors: `MessageEmpty()`, `MessageTooLong(uint256 length)`, `CooldownActive(uint40 until)`, `SignatureExpired()`, `InvalidSignature()`, `PageTooLarge(uint256 limit)`, `EntryNotFound(uint256 id)`, `CooldownOutOfRange(uint40 cooldown)`
  - events: `Signed(uint256 indexed id, bytes32 indexed visitorId, Kind kind, string message, uint40 timestamp)`, `HiddenSet(uint256 indexed id, bool hidden)`
- Produces (in `Guestbook.sol`):
  - `constructor(address initialOwner, uint40 cooldown)`
  - `uint256 public constant MAX_MESSAGE_BYTES = 140; uint256 public constant MAX_PAGE = 50; uint40 public immutable COOLDOWN;`
  - `function sign(string calldata message) external returns (uint256 id)` — visitorId = `bytes32(uint256(uint160(msg.sender)))`
  - `function entryCount() external view returns (uint256)`, `function uniqueVisitors() external view returns (uint256)`
  - `function getEntry(uint256 id) external view returns (EntryView memory)`
  - `function getEntries(uint256 start, uint256 limit) external view returns (EntryView[] memory)` — clamps to end; reverts `PageTooLarge` if `limit > 50`
  - `function latest(uint256 limit) external view returns (EntryView[] memory)` — newest first
  - `function lastSignedAt(bytes32 visitorId) external view returns (uint40)`
  - internal `_record(bytes32 visitorId, Kind kind, string calldata message) returns (uint256 id)` used by all write paths

- [ ] **Step 1:** `forge init contracts --no-git`; `forge install OpenZeppelin/openzeppelin-contracts@v5.<latest>`; pin solc in `foundry.toml`; add `[profile.ci] fuzz.runs = 10000`.
- [ ] **Step 2: Write failing tests** in `Guestbook.Direct.t.sol`:
  - `test_sign_storesEntryAndEmits` — `sign("hi")` returns id 0, emits `Signed(0, vid(alice), Kind.Direct, "hi", now)`, `entryCount()==1`, `uniqueVisitors()==1`.
  - `test_revert_emptyMessage` → `MessageEmpty()`.
  - `test_revert_141Bytes` → `MessageTooLong(141)`; `test_accepts_140Bytes`.
  - `testFuzz_lengthRule(bytes)` — length 1–140 succeeds, else reverts with the matching error.
  - `test_revert_withinCooldown` — second sign at `+86399` → `CooldownActive(t0+86400)`; `test_allows_afterCooldown` at `+86400`, and `uniqueVisitors()` stays 1 while `entryCount()` is 2.
  - `test_constructor_rejectsCooldown` for `3599` and `86401` → `CooldownOutOfRange`.
  - `test_getEntries_clampsAndCaps` — 3 entries: `getEntries(1,50)` returns ids [1,2]; `getEntries(5,10)` returns []; `getEntries(0,51)` → `PageTooLarge(51)`.
  - `test_latest_newestFirst` — ids [2,1,0] for `latest(3)`.
  - `test_getEntry_missing` → `EntryNotFound(0)`.
- [ ] **Step 3:** Run `forge test --match-path test/Guestbook.Direct.t.sol` — expect FAIL (no contract).
- [ ] **Step 4:** Implement `Guestbook` per Interfaces. Storage per spec §7.2; pack `visitorId|timestamp|kind` sensibly.
- [ ] **Step 5:** Re-run — expect PASS.
- [ ] **Step 6:** Commit `feat(contracts): guestbook core with direct signing`.

---

### Task 2: Owner hidden flag

**Files:** Modify `contracts/src/Guestbook.sol`; Test `contracts/test/Guestbook.Hidden.t.sol`

**Interfaces:**
- Produces: `function setHidden(uint256 id, bool hidden) external onlyOwner`, `function isHidden(uint256 id) external view returns (bool)`; `EntryView.hidden` reflects it. Owner via `Ownable2Step`.

- [ ] **Step 1: Failing tests:** `test_ownerHides_emits` (`HiddenSet(0,true)`, `isHidden(0)`, message bytes unchanged); `test_unhide`; `test_revert_nonOwner` (`OwnableUnauthorizedAccount`); `test_revert_missingId` (`EntryNotFound`); `test_ownershipTwoStep`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(contracts): owner hidden flag`.

---

### Task 3: Wallet path (EIP-712, EOA + ERC-1271)

**Files:** Modify `Guestbook.sol`; Test `contracts/test/Guestbook.Wallet.t.sol`

**Interfaces:**
- Produces:
  - Typed struct: `Entry(bytes32 visitorId,string message,uint256 nonce,uint256 deadline)`; domain `("HelloChain","1", chainId, address(this))` via OZ `EIP712`.
  - `function signWithWallet(address author, string calldata message, uint256 deadline, bytes calldata signature) external returns (uint256 id)` — visitorId from `author`; verify with `SignatureChecker.isValidSignatureNow`; consumes `nonces[visitorId]`.
  - `function nonces(bytes32 visitorId) external view returns (uint256)`
  - `function hashEntry(bytes32 visitorId, string calldata message, uint256 nonce, uint256 deadline) public view returns (bytes32 digest)` — the EIP-712 digest (reused by Task 4 and the web app's tests).

- [ ] **Step 1: Failing tests:** `test_validSig_recordsAsAuthor_kindWallet` (relayer address ≠ author; entry's visitorId is author's); `test_walletAndDirectShareCooldown` (same address via `sign()` then `signWithWallet` within 24 h → `CooldownActive`); `test_revert_replay` (same sig twice → `InvalidSignature`, nonce incremented once); `test_revert_expired` (`deadline < block.timestamp` → `SignatureExpired`); `test_revert_wrongChain` (sig made for another chainid → `InvalidSignature`); `test_revert_tamperedMessage`; `test_erc1271Wallet` (mock 1271 account validates); `testFuzz_randomSigRejected`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement (nonce read → digest → verify → increment → `_record`). **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(contracts): gasless wallet signatures (EIP-712/1271)`.

---

### Task 4: Passkey path (WebAuthn P-256)

**Files:** Modify `Guestbook.sol`; Test `contracts/test/Guestbook.Passkey.t.sol`

**Interfaces:**
- Consumes: `hashEntry` (Task 3).
- Produces:
  - `function passkeyVisitorId(bytes32 qx, bytes32 qy) public pure returns (bytes32)` = `keccak256(abi.encode(qx, qy))`
  - `function signWithPasskey(bytes32 qx, bytes32 qy, string calldata message, uint256 deadline, WebAuthn.WebAuthnAuth calldata auth) external returns (uint256 id)` — challenge = `abi.encodePacked(hashEntry(vid, message, nonce, deadline))`; user verification required.
- Library: OpenZeppelin `WebAuthn` (if present in the pinned 5.x) else Solady `WebAuthn`; both use the RIP-7212 precompile with a Solidity fallback so anvil works. Record the choice in `notes/ch03-hello-world.md`.

- [ ] **Step 1: Failing tests** using `vm.signP256` and a test helper that builds `authenticatorData` (rpIdHash ‖ flags UP|UV ‖ signCount) and `clientDataJSON` (`{"type":"webauthn.get","challenge":"<base64url digest>","origin":"http://localhost:3000"}`):
  - `test_validAssertion_kindPasskey` (visitorId = `passkeyVisitorId(qx,qy)`).
  - `test_revert_wrongKey`, `test_revert_replay`, `test_revert_expired`, `test_revert_challengeMismatch` (message changed after signing), `test_revert_noUserVerification` (UV flag cleared), `test_revert_highS` (malleable s).
  - `test_samePasskeyCooldown` — second assertion from the same key within 24 h → `CooldownActive`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(contracts): passkey signing via WebAuthn`.

---

### Task 5: Invariants, formal checks, analyzers, gas baseline

**Files:** Create `test/handlers/GuestbookHandler.sol`, `test/Guestbook.Invariant.t.sol`, `test/Guestbook.Halmos.t.sol`, `contracts/.gas-snapshot`, `contracts/aderyn.toml` (if needed), `contracts/slither.config.json`

**Interfaces:**
- Consumes: full `Guestbook` API.

- [ ] **Step 1: Invariant tests** (handler drives sign/signWithWallet/signWithPasskey/setHidden/warp with ghost vars):
  - `invariant_countMatchesEntries` — `entryCount()` == ghost entries.
  - `invariant_uniqueLeqEntries`.
  - `invariant_countsMonotonic` — never decrease between calls.
  - `invariant_messagesImmutable` — keccak of every stored message equals ghost hash.
  - `invariant_nonceMonotonic`.
- [ ] **Step 2:** Run `forge test --match-path test/Guestbook.Invariant.t.sol` — PASS (contracts exist; if FAIL, fix the contract, not the invariant).
- [ ] **Step 3: Halmos** `check_countNeverDecreases`, `check_cooldownEnforced(uint40 dt)` (symbolic `dt < COOLDOWN` ⇒ revert), `check_lengthRule(uint256 len)`. Run `halmos --contract GuestbookHalmosTest` — all `[PASS]`.
- [ ] **Step 4:** `slither .` and `aderyn .` — zero high/medium; each remaining low/informational either fixed or justified in `notes/ch03-hello-world.md`.
- [ ] **Step 5:** `forge snapshot` → commit `.gas-snapshot`.
- [ ] **Step 6:** Commit `test(contracts): invariants, halmos proofs, analyzers, gas baseline`.

---

### Task 6: Book baseline comparison

**Files:** Create `contracts/book-baseline/ArithValue.sol` (verbatim from `Ethereum-Smart-Contract-Development/Chapter03/ArithValue.sol` with header `// Source: Packt "Ethereum Smart Contract Development" (MIT, © 2018 Packt) — kept unmodified as a comparison baseline`), `contracts/test/BookBaseline.t.sol`; Modify `foundry.toml` (`[profile.book] src="book-baseline"`, `solc="0.4.26"`, `out="out-book"`).

**Interfaces:**
- Produces: `interface IArithValue { function fetchNumber() external view returns (uint); function setNumber(uint) external; function incrementNumber() external; function decrementNumber() external; }` in the test.

- [ ] **Step 1:** Test `test_book_decrementWrapsBelowZero` — deploy artifact via `deployCode("out-book/ArithValue.sol/ArithValue.json")`, `setNumber(0)`, `decrementNumber()`, assert `fetchNumber() == type(uint256).max` (documents the bug), plus `test_book_anyoneCanReset` (non-deployer `setNumber` succeeds — no access control). Contrast test `test_ours_countCannotDecrease` reusing the invariant result.
- [ ] **Step 2:** `FOUNDRY_PROFILE=book forge build` then `forge test --match-path test/BookBaseline.t.sol` — PASS (the tests assert the book's broken behaviour).
- [ ] **Step 3:** Commit `test(contracts): book ArithValue baseline shows underflow`.

---

### Task 7: Deploy scripts + local chain wired into the web app

**Files:** Create `script/Deploy.s.sol`, `script/SeedLocal.s.sol`, `script/Hide.s.sol`, `deployments/31337.json`, `web/scripts/sync-contract.mjs`, `web/src/lib/contract.ts`, `web/src/lib/chain.ts`; Modify `.claude/launch.json` (add `anvil` config, port 8545) and `web/package.json` (`"sync:contract"`).

**Interfaces:**
- Produces:
  - `Deploy.s.sol`: reads `OWNER`, `COOLDOWN` (default 86400); writes `deployments/<chainId>.json` `{ "address": "0x…", "blockNumber": n }`.
  - `Hide.s.sol`: env `ENTRY_ID`, `HIDDEN` → `setHidden`.
  - `web/src/lib/contract.ts`: `export const guestbookAbi` (as const) and `export const guestbookAddress: Record<number, \`0x${string}\`>`; generated by `pnpm sync:contract` from `contracts/out` + `deployments/`.
  - `web/src/lib/chain.ts`: `export const activeChain` (anvil when `NEXT_PUBLIC_CHAIN_ID=31337`, else baseSepolia), `export const publicClient`.

- [ ] **Step 1:** Test: `forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast` against a running anvil → `deployments/31337.json` exists; `cast call <addr> "COOLDOWN()(uint40)"` returns `86400`.
- [ ] **Step 2:** `SeedLocal.s.sol` writes 3 sample entries; `cast call <addr> "entryCount()(uint256)"` → `3`.
- [ ] **Step 3:** `pnpm sync:contract` generates `contract.ts`; `pnpm tsc --noEmit` passes.
- [ ] **Step 4:** Commit `feat: deploy scripts and local contract wiring`.

---

### Task 8: Shared message rules and abuse filter

**Files:** Create `web/src/lib/message.ts`, `web/src/lib/filter.ts`, `web/src/lib/handle.ts`; Tests `web/tests/unit/{message,filter,handle}.test.ts`

**Interfaces:**
- Produces:
  - `utf8ByteLength(s: string): number`
  - `validateMessage(s: string): { ok: true; value: string } | { ok: false; reason: 'empty' | 'tooLong' }` — trims; limit 140 bytes.
  - `isAbusive(s: string): { abusive: boolean; reason?: 'profanity' | 'link' | 'contact' | 'spam' }` — profanity/slur list (library is builder's choice, with leetspeak normalisation), URLs/domains, emails/phone numbers, ≥8 repeated chars.
  - `friendlyHandle(visitorId: \`0x${string}\`): string` — deterministic `Adjective Animal #abcd`.

- [ ] **Step 1: Failing tests:** `validateMessage counts UTF-8 bytes` (35 × "😀" = 140 bytes → ok; 36 → tooLong; 140 × "a" ok; 141 → tooLong; "   " → empty); `blocks links` (`"visit evil.com"`, `"http://x"`); `blocks contact` (email, `+1 555 123 4567`); `blocks profanity incl. leetspeak`; `allows normal greetings` ("Hi from Pune! 👋", "Great work on the passkeys"); `blocks repeated spam` ("aaaaaaaaa"); `friendlyHandle is deterministic and differs for different ids`.
- [ ] **Step 2:** `pnpm vitest run tests/unit` — FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(web): shared message validation and abuse filter`.

---

### Task 9: Live feed and count on the page

**Files:** Create `web/src/lib/feed.ts`, `web/src/components/{Hero,Feed,EntryCard}.tsx`; Modify `web/src/app/page.tsx`; Tests `web/tests/unit/feed.test.ts`

**Interfaces:**
- Consumes: `guestbookAbi`, `guestbookAddress`, `publicClient`, `isAbusive`, `friendlyHandle`.
- Produces:
  - `type FeedEntry = { id: bigint; visitorId: \`0x${string}\`; timestamp: number; kind: 'direct'|'wallet'|'passkey'; message: string }`
  - `fetchLatest(limit = 20): Promise<{ entries: FeedEntry[]; count: bigint }>`
  - `fetchPage(beforeId: bigint, limit = 20): Promise<FeedEntry[]>` (uses `getEntries`)
  - `visibleEntries(entries: EntryView-like[]): FeedEntry[]` — drops `hidden` and `isAbusive` entries
  - `watchSigned(onEntry: (e: FeedEntry) => void): () => void` — `watchContractEvent` on `Signed`, applies the same display filter.

- [ ] **Step 1: Failing tests:** `visibleEntries drops hidden`; `visibleEntries drops abusive even if not hidden`; `fetchPage computes start = beforeId - limit, clamped at 0` (mock client).
- [ ] **Step 2:** FAIL → **Step 3:** implement lib + components (Hero shows "N signatures"; Feed newest-first with "Load more"; relative times) → **Step 4:** PASS.
- [ ] **Step 5:** Verify in the browser pane against seeded anvil: 3 entries render; running `cast send … "sign(string)" "live test"` appears without refresh.
- [ ] **Step 6:** Commit `feat(web): live feed and signature count`.

---

### Task 10: Passkey client

**Files:** Create `web/src/lib/passkey.ts`, `web/src/lib/typedData.ts`; Tests `web/tests/unit/{passkey,typedData}.test.ts`

**Interfaces:**
- Consumes: `hashEntry` semantics (Task 3), `NEXT_PUBLIC_RP_ID`.
- Produces:
  - `typedDataFor(chainId: number, contract: \`0x${string}\`, visitorId: \`0x${string}\`, message: string, nonce: bigint, deadline: bigint)` → viem `TypedDataDefinition` (domain `HelloChain`/`1`, type `Entry`).
  - `type StoredPasskey = { credentialId: string; qx: \`0x${string}\`; qy: \`0x${string}\`; visitorId: \`0x${string}\` }`
  - `registerPasskey(): Promise<StoredPasskey>` (userVerification `required`, `residentKey` `preferred`, ES256 only; extract qx/qy from the COSE key)
  - `loadPasskey(): StoredPasskey | null` (localStorage key `hello-chain.passkey.v1`; validates shape)
  - `signWithPasskey(pk: StoredPasskey, digest: \`0x${string}\`): Promise<{ status: 'ok'; auth: WebAuthnAuthPayload } | { status: 'cancelled' }>` — normalises signature to low-s; `WebAuthnAuthPayload` mirrors the Solidity struct field-for-field.

- [ ] **Step 1: Failing tests:** `typedDataFor hashes to the same digest as Guestbook.hashEntry` (fixture digest produced by a `forge script`/`cast` call and checked in); `loadPasskey returns null when storage empty or corrupt`; `signWithPasskey returns cancelled on NotAllowedError` (mocked `navigator.credentials.get`); `normalises high-s to low-s`; `parses COSE P-256 key into qx/qy` (fixture).
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(web): passkey registration and signing`.

---

### Task 11: Relayer endpoint

**Files:** Create `web/src/app/api/relay/route.ts`, `web/src/lib/relay/{validate,rateLimit,submit,errors}.ts`, `web/.env.example`; Tests `web/tests/unit/relay.test.ts`

**Interfaces:**
- Consumes: `validateMessage`, `isAbusive`, `guestbookAbi`, `guestbookAddress`, `activeChain`.
- Produces:
  - `POST /api/relay` body: `{ kind: 'passkey', qx, qy, message, deadline, auth } | { kind: 'wallet', author, message, deadline, signature }`
  - Responses: `200 { txHash }` · `400 { error: 'invalid' }` · `422 { error: 'filtered', reason }` · `429 { error: 'cooldown' | 'rateLimited', retryAfter }` · `503 { error: 'busy' }`
  - `interface RateLimiter { hit(key: string, limit: number, windowSec: number): Promise<{ allowed: boolean; retryAfter: number }> }` with `memoryRateLimiter` (local/tests) and `upstashRateLimiter` (when `UPSTASH_REDIS_REST_URL` set).
  - Limits: per IP 10 / 60 s; **per IP 1 / 86400 s for successful entries**; per visitorId 1 / 86400 s.
  - `friendlyError(code): string` — the plain-language copy used by the UI.
  - Env: `RELAYER_PRIVATE_KEY`, `RPC_URL`, `NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_RP_ID`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
- Flow: validate → filter → rate limit → `simulateContract` (decode custom errors) → `writeContract` with viem `nonceManager` → return hash; log warning when relayer balance < 0.005 ETH.

- [ ] **Step 1: Failing tests:** `rejects malformed body 400`; `filtered message 422 with reason`; `maps CooldownActive to friendly message` (simulate revert → 429 `cooldown`, friendlyError → "You've already signed today — come back tomorrow"); `second success from same IP within a day → 429`; `returns 503 busy on submit failure` (RPC throws); `does not submit when simulation fails` (write spy not called); `returns txHash on success`.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(web): gasless relayer with filter and rate limits`.

---

### Task 12: Sign card — passkey + wallet flows

**Files:** Create `web/src/components/SignCard.tsx`, `web/src/app/providers.tsx` (wagmi config: `injected()` via EIP-6963 discovery only); Modify `page.tsx`; Tests `web/tests/unit/signCard.test.tsx` (Vitest + Testing Library + jsdom)

**Interfaces:**
- Consumes: `validateMessage`, `utf8ByteLength`, `loadPasskey`, `registerPasskey`, `signWithPasskey`, `typedDataFor`, `friendlyError`, `/api/relay`, `nonces()` read, `watchSigned` (to confirm).
- Produces: UI state machine `idle → confirming → submitting → signed | error`, optimistic entry pushed to Feed via a callback `onOptimistic(entry: FeedEntry)`.
- Deadline = now + 15 min.

- [ ] **Step 1: Failing tests:** byte counter shows `140 - utf8ByteLength`; button disabled when invalid; `cancelled` returns to idle with no error; error keeps textarea content; button label "Sign with Face ID / fingerprint" (generic "Sign with your passkey" on non-Apple/Android UA); wallet link reads "Use a crypto wallet instead" and never shows the words gas/nonce.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS.
- [ ] **Step 5:** Manual check in the browser pane on anvil: sign with a passkey (Chrome DevTools virtual authenticator) and see the entry appear.
- [ ] **Step 6:** Commit `feat(web): sign card with passkey and wallet flows`.

---

### Task 13: Page polish and the recruiter case study

**Files:** Create `web/src/components/HowItWorks.tsx`; Modify `page.tsx`, `globals.css`, `layout.tsx` (metadata, OG image, favicon)

- [ ] **Step 1:** HowItWorks: plain-language 4-step diagram (passkey → relayer → contract → feed), "book vs ours" panel (the underflow story with numbers from Task 6), links to verified contract and source (filled after Task 15).
- [ ] **Step 2:** Light/dark via `prefers-color-scheme`; mobile layout at 375 px with no horizontal scroll; keyboard focus states; `aria-live` on status.
- [ ] **Step 3:** Verify in browser pane at mobile (375×812) and desktop, light and dark; run `pnpm lint && pnpm tsc --noEmit`.
- [ ] **Step 4:** Commit `feat(web): polished page and how-it-works case study`.

---

### Task 14: End-to-end test

**Files:** Create `web/playwright.config.ts`, `web/tests/e2e/sign.spec.ts`

- [ ] **Step 1:** Test `stranger signs with a passkey and sees it live`: global setup starts anvil, deploys, syncs contract, starts the app with a funded anvil relayer key; test enables a CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator`, `ctap2`, `internal`, `hasUserVerification: true`, `isUserVerified: true`), types "Hello from Playwright 👋", clicks sign, expects the entry in the feed and the count to increase by 1. Second test: signing again shows "come back tomorrow".
- [ ] **Step 2:** `pnpm playwright test` — PASS.
- [ ] **Step 3:** Commit `test(web): passkey end-to-end`.

---

### Task 15: CI, notes, README, deploy

**Files:** Create `.github/workflows/hello-chain.yml`, `projects/03-hello-chain/README.md`, `notes/ch03-hello-world.md`; Modify root `README.md` progress table

- [ ] **Step 1:** CI jobs (all `paths: projects/03-hello-chain/**`): `contracts` (foundry-toolchain, `forge fmt --check`, `forge build`, `FOUNDRY_PROFILE=ci forge test`, `forge snapshot --check`, book profile test), `formal` (halmos), `analyze` (slither-action, aderyn), `web` (pnpm install, lint, tsc, vitest, playwright with anvil). Validate locally with `act` if available, else YAML lint.
- [ ] **Step 2:** `notes/ch03-hello-world.md`: storage layout (`forge inspect Guestbook storageLayout`), key opcodes of `sign`, predicted vs measured gas table for `sign`/`signWithWallet`/`signWithPasskey` (cold SSTOREs per EIP-2929, string slot writes, LOG costs) with tolerance ±10 % and explained gaps, precompile vs fallback cost for P-256, why private-chain mining is gone post-Merge, analyzer findings.
- [ ] **Step 3:** Project README: run locally, env vars, deploy, moderate (`forge script script/Hide.s.sol`).
- [ ] **Step 4 (owner-gated):** with the owner's keys: deploy to Base Sepolia, verify on Sourcify (`forge verify-contract --verifier sourcify`) → "exact match"; set Vercel env vars; deploy `web` to Vercel; fund relayer; sign once from a phone.
- [ ] **Step 5:** Fill contract/explorer/GitHub links in HowItWorks; update root README progress row for Chapter 3.
- [ ] **Step 6:** Commit `docs: chapter 3 notes, CI, deploy`.
