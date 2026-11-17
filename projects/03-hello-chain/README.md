# Hello, Chain — an on-chain guestbook

A visitor writes a short hello (up to 140 bytes), confirms with Face ID, a fingerprint or a PIN (a **passkey**), and watches it appear in a live feed. No wallet, no crypto, no gas: a small relayer pays the fee, and the contract itself checks the passkey signature. Crypto-native visitors can sign with their wallet or call the contract directly.

Engineering notes (concepts, measurements, design decisions): [notes/ch03-hello-world.md](../../notes/ch03-hello-world.md).

| Path | What's there |
|---|---|
| `contracts/` | Foundry project: `Guestbook.sol` (Solidity 0.8.38, OpenZeppelin 5.7.0), tests, Halmos proofs, scripts |
| `web/` | Next.js 16 app: page, passkey + wallet signing, relayer route `POST /api/relay` |
| `../../.github/workflows/hello-chain.yml` | CI: format, build, tests, gas snapshot, Halmos, Slither, web lint/types/unit/build/E2E |

## Rules the contract enforces

- Message is 1–140 **bytes**; one entry per visitor per cooldown (24 h by default, fixed at deploy, 1 h–24 h allowed).
- Entry count and unique-visitor count only ever grow (fuzzed, invariant-tested and proved with Halmos).
- Entries are never edited or deleted. The owner can only set a public `hidden` flag, which the page respects.
- Signed entries are bound to chain, contract, visitor, message, a per-visitor nonce and a deadline (EIP-712), so they cannot be replayed.
- Reads are paginated (max 50 per call); nothing loops over the whole guestbook.

## Prerequisites

- [Foundry](https://getfoundry.sh) **1.9.0** (`forge`, `anvil`, `cast`). Forge 1.9 runs tests in isolation mode, which the gas snapshot depends on.
- Node **24** and pnpm **10** (`corepack enable`).
- Optional: `halmos` 0.3.3 and `slither-analyzer` 0.11.6 (`pip install halmos==0.3.3 slither-analyzer==0.11.6`).
- Clone with submodules: `git clone --recurse-submodules …` (or `git submodule update --init --recursive`).

## Run locally

```bash
# 1. A local chain (terminal 1). Keep it on :8545.
anvil

# 2. Deploy and add three sample entries (terminal 2).
cd projects/03-hello-chain/contracts
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key <anvil account #0 private key, printed by anvil at startup>
forge script script/SeedLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast

# 3. The web app.
cd ../web
pnpm install
cp .env.example .env.local   # then set NEXT_PUBLIC_CHAIN_ID=31337, NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545
                             # and RELAYER_PRIVATE_KEY to another anvil account's key (e.g. #9)
pnpm dev                     # http://localhost:3000
```

A fresh anvil plus account #0 at nonce 0 always deploys to the address already committed in `contracts/deployments/31337.json`, so nothing else needs regenerating. If you change the contract's ABI or deploy somewhere new, run `forge build` and then `pnpm sync:contract` in `web/` to regenerate `src/lib/contract.ts`.

Passkeys work on `localhost` in Chrome, Safari and Firefox. In Chrome DevTools you can add a virtual authenticator (More tools → WebAuthn) instead of using a real one.

## Test

What CI runs, from `contracts/`:

```bash
forge fmt --check
forge build --sizes
FOUNDRY_PROFILE=ci forge test         # 10,000 fuzz runs; plain `forge test` uses 256
forge snapshot --check --no-match-path 'test/Guestbook.Invariant.t.sol' --no-match-test 'testFuzz_|invariant_|check_'
halmos --contract GuestbookHalmosTest # ~35 s
slither . --fail-medium               # note: runs `forge clean`; rebuild afterwards
```

And from `web/`:

```bash
pnpm lint && pnpm exec tsc --noEmit && pnpm test   # ESLint, types, Vitest
pnpm build && pnpm check:css                       # production build; built CSS contains the design tokens
pnpm exec playwright install --with-deps chromium  # once
pnpm test:e2e                                      # its own anvil on :8546 and app on :3100
```

The E2E setup starts a private anvil on **:8546**, deploys with pinned `OWNER`/`COOLDOWN`, builds the app and serves it on **:3100**, so it never touches a dev stack on :8545 / :3000. It refuses to run if either port is busy.

After you changed gas on purpose, refresh the snapshot with the same filters (`forge snapshot --no-match-path … --no-match-test …`) and commit it.

## Environment variables

Each folder has a commented `.env.example`; copy it and fill it in. Real values never go in git.

**`contracts/.env`** (forge loads it automatically; leave optional values commented out, because a variable that is set but empty breaks `vm.envOr`)

| Variable | Used by | Meaning |
|---|---|---|
| `OWNER` | `Deploy.s.sol` | Contract owner (can hide entries). Default: the deploying account |
| `COOLDOWN` | `Deploy.s.sol` | Seconds between entries per visitor, 3600–86400. Default 86400 |
| `ENTRY_ID`, `HIDDEN` | `Hide.s.sol` | Entry to moderate; `true` hides (default), `false` unhides |
| `SEED_PK_1..3` | `SeedLocal.s.sol` | Local only. Default: anvil's public dev keys |
| `BASE_SEPOLIA_RPC_URL` | your shell | RPC endpoint for deploys (`set -a; source .env; set +a`) |

**`web/.env.local`** locally, or the host's environment settings in production

| Variable | Exposed to browser | Meaning |
|---|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | yes | `31337` (anvil) or `84532` (Base Sepolia) |
| `NEXT_PUBLIC_RPC_URL` | yes | Read RPC; empty = the chain's public default |
| `NEXT_PUBLIC_RP_ID` | yes | Passkey domain (host name, no scheme or port). Changing it orphans existing passkeys |
| `RELAYER_PRIVATE_KEY` | **no** | Funded key that pays gas for relayed entries |
| `RPC_URL` | no | Server-side RPC for the relayer (may contain an API key) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | no | Shared rate limits. **Required on Vercel production**: without them the relay refuses with 503 |
| `RELAY_GLOBAL_DAILY_LIMIT` | no | Most relayed entries per day across all visitors (spend ceiling). Default 200; over it the relay answers 503 |
| `RELAY_MIN_BALANCE_WEI` | no | Relay refuses (503, logged) while the relayer holds less than this. Default `2000000000000000` (0.002 ETH) |
| `TRUSTED_PROXY_HEADER` | no | Only off Vercel: the client-IP header your proxy overwrites (see below) |
| `NEXT_PUBLIC_CONTRACT_EXPLORER_URL`, `NEXT_PUBLIC_SOURCE_URL` | yes | "How it works" links; each link is hidden while empty |
| `NEXT_PUBLIC_SITE_URL` | yes | Optional canonical URL for social previews |

## Deploy (Base Sepolia + Vercel)

These steps need the owner's keys and are done by hand. Use throwaway testnet keys only.

**1. Deployer key.** Prefer an encrypted Foundry keystore over a raw key in a file:

```bash
cast wallet import deployer --interactive      # paste the testnet deployer key once
cast wallet address --account deployer         # note the address; fund it from a Base Sepolia faucet
```

**2. Deploy and verify** (from `contracts/`, with `BASE_SEPOLIA_RPC_URL` in your shell):

```bash
forge script script/Deploy.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --account deployer --sender <deployer address> --broadcast
# writes deployments/84532.json

forge verify-contract <guestbook address> src/Guestbook.sol:Guestbook \
  --chain base-sepolia --verifier sourcify \
  --constructor-args "$(cast abi-encode 'constructor(address,uint40)' <owner address> 86400)"
# expect an "exact match" (full match) on Sourcify
```

Set `OWNER=<address>` in front of the deploy command if the owner should differ from the deployer (`COOLDOWN` likewise).

**3. Point the app at it** (from `web/`): `pnpm sync:contract`, then commit `contracts/deployments/84532.json` and `web/src/lib/contract.ts`.

**4. Vercel.** Import the repository with **Root Directory** `projects/03-hello-chain/web` (framework Next.js, install `pnpm install`). Set, for Production:

- `NEXT_PUBLIC_CHAIN_ID=84532`, `NEXT_PUBLIC_RP_ID=<your-project>.vercel.app`
- `NEXT_PUBLIC_RPC_URL`: a **keyed** Base Sepolia endpoint from an RPC provider, locked to your domain with the provider's allowlist (the key is visible in the browser, so the allowlist is what protects it). Every visitor's browser reads through it and polls for new entries; the public `sepolia.base.org` endpoint is rate-limited and a busy page will hit that limit.
- `RELAYER_PRIVATE_KEY` (a **separate** funded testnet key, not the deployer), `RPC_URL`
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (Upstash via the Vercel Marketplace). **Required**: a Vercel production deployment without them refuses relay requests (503) rather than fall back to per-instance limits.
- Optional spend guards: `RELAY_GLOBAL_DAILY_LIMIT` (default 200 entries/day) and `RELAY_MIN_BALANCE_WEI` (default 0.002 ETH)
- `NEXT_PUBLIC_CONTRACT_EXPLORER_URL=https://sepolia.basescan.org/address/<guestbook address>#code`, `NEXT_PUBLIC_SOURCE_URL=<repository URL>`

`TRUSTED_PROXY_HEADER` is not needed on Vercel. Redeploy after changing any `NEXT_PUBLIC_*` value: they are baked in at build time.

**5. Fund the relayer** with Base Sepolia ETH. The relayer logs a warning below 0.005 ETH and refuses (503 "busy") below `RELAY_MIN_BALANCE_WEI` (0.002 ETH by default).

**6. Real-device check (mandatory).** In a fresh browser profile with no passkey for the site, do a first visit end to end on **a real iPhone (Safari)** and **a real Android phone (Chrome)**: type a message, tap the sign button (creates the passkey), tap **Tap to sign** (Face ID / fingerprint), and confirm the entry appears. Simulators and desktop virtual authenticators do not reproduce iOS's user-gesture rules for passkey prompts.

## Moderate

Hiding never changes the entry on-chain; it sets a public flag the page respects. Run as the owner, from `contracts/`:

```bash
# hide entry 3 on Base Sepolia
ENTRY_ID=3 HIDDEN=true forge script script/Hide.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --account owner --sender <owner address> --broadcast

# unhide it
ENTRY_ID=3 HIDDEN=false forge script script/Hide.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --account owner --sender <owner address> --broadcast
```

The script reads the contract address from `deployments/<chainId>.json`. Locally, use `--rpc-url http://127.0.0.1:8545 --private-key <anvil account #0 key>`.

## Operating notes

- **Spend is bounded three ways:** one relayed entry per visitor and per IP per day (IPv6 counts per /64, since one subscriber usually gets a whole /64), a global daily cap (`RELAY_GLOBAL_DAILY_LIMIT`, default 200), and a balance floor (`RELAY_MIN_BALANCE_WEI`). Over the cap or under the floor the relay answers 503 "busy" and logs why.
- **Rate limits need Upstash in production.** On Vercel production the relay refuses (503) without the Upstash variables. Elsewhere, without them, the relayer uses an in-memory limiter, and the relayer's nonce manager is also per process. On serverless every instance has its own copy, so limits are weaker and concurrent instances can race on the relayer's nonce. With Upstash the limits are shared; keep relayer traffic modest or use one relayer key per instance if you scale out.
- **Hosting somewhere other than Vercel:** set `TRUSTED_PROXY_HEADER` to a header your reverse proxy **overwrites** on every request (`x-real-ip`, or `x-forwarded-for` where the proxy appends the peer). Without it, production refuses every relay request with **503**, by design: a header the client can set would let anyone dodge the rate limits.
- **Relayer gas ceiling.** Each relayed entry is capped at 700,000 gas (`web/src/lib/relay/submit.ts`). The worst case today is a 140-byte passkey entry on a chain without the P-256 precompile: ~558k. On Base, with the precompile, a passkey entry is ~204k. `contracts/test/Guestbook.Gas.t.sol` fails if the worst case reaches the cap; re-check after changing the contract, the message limit or OpenZeppelin's WebAuthn code.
- **`.next` after running E2E:** `pnpm test:e2e` runs `next build` with the E2E settings, so `web/.next` then points at anvil :8546. Run `pnpm build` again before a manual `pnpm start`.
- **Stale styles in `pnpm dev`:** stop the dev server, delete `web/.next/dev`, start again. Details in [web/README.md](web/README.md#troubleshooting-dev-server-shows-old-styles).
