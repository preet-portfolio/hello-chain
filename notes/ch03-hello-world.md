# Chapter 3 — Hello World of Smart Contracts (reference notes)

> Our own summary of the book's ideas, updated to the 2026 picture, followed by what we measured while building [Hello, Chain](../projects/hello-chain/README.md), an on-chain guestbook. The book is a reference only; nothing here is copied into the project.

## 1. What the chapter teaches

| Idea | Core point | Book's example |
|---|---|---|
| A contract is a program with storage | State variables live in the contract's storage and survive between calls. Functions read or change them. A constructor runs once at deploy time to set initial values. | A counter that starts at 100 |
| Reading vs writing | Reading state is free when done locally through a node. Changing state needs a transaction, which costs gas and waits for a block. | "fetch" vs "set / increment / decrement" functions |
| Return values | A function can compute and return a value without touching storage at all. | A function that returns a fixed greeting string |
| Loops cost gas | Every loop iteration runs opcodes, and every storage write in the loop is expensive. | A loop that adds 1..9 to a stored number |
| A private chain to play on | Make your own network: write a genesis file (chain id, low difficulty, gas limit), start a node, mine blocks yourself to get test ether, then deploy and call the contract there. | A custom genesis with a tiny difficulty and a node mining locally |
| Toolchain of the time | Write in a browser IDE, compile with solc 0.4, deploy through a node console or wallet. | Solidity `^0.4.11` |

The counter (`ArithValue`) is the heart of the chapter. In 2026 eyes it has three real bugs, and our project keeps it next to our own contract as a "before" baseline ([BookBaseline.t.sol](../projects/hello-chain/contracts/test/BookBaseline.t.sol), which compiles the original with solc 0.4.26):

1. **Anyone can reset it.** `setNumber` has no access control (`test_book_anyoneCanReset`).
2. **It wraps below zero.** Solidity 0.4 arithmetic is unchecked, so decrementing 0 gives 2²⁵⁶−1 (`test_book_decrementWrapsBelowZero`).
3. **Nothing proves it is consistent.** Our replacement counters (entry count, unique visitors) can only grow, which a unit test, an invariant suite and a Halmos proof all check (`test_ours_countCannotDecrease`, `invariant_*`, `check_countNeverDecreases`).

## 2. What changed since the book (2026 view)

| Book says (2018) | Now |
|---|---|
| Solidity `^0.4.11` | **0.8.38**. Checked arithmetic by default since 0.8.0 (the counter bug above is now a revert), `constructor` keyword, `view`/`pure` instead of `constant`, custom errors (0.8.4), explicit visibility. |
| Run a private proof-of-work chain and mine your own ether | Gone: see section 6. Local work uses **anvil** (Foundry); shared testing uses public testnets (Sepolia, Hoodi) or **L2 testnets** such as Base Sepolia. |
| Browser IDE + node console | **Foundry** (`forge` build/test/fuzz/invariant/scripts, `anvil` dev node, `cast` CLI). Tests are written in Solidity next to the code. |
| Testnets Ropsten / Rinkeby / Kovan | All retired. Sepolia (apps), Hoodi (staking), plus each L2's own testnet. |
| Flat gas prices for storage | **EIP-2929** (Berlin, 2021) made the *first* touch of a slot or account in a transaction expensive ("cold") and later touches cheap ("warm"). **EIP-1559** (London, 2021) split fees into a burned base fee and a tip. **EIP-3529** cut refunds. |
| Calldata is cheap | **EIP-7623** (Pectra, May 2025) adds a calldata price floor for data-heavy transactions; rollups post data as **blobs** (EIP-4844, Dencun 2024). |
| Users need a wallet with ether | **Passkeys** can sign for you (P-256 / WebAuthn). Rollups added a P-256 precompile (**RIP-7212**; Base since the Fjord upgrade, July 2024) and L1 added the same address in **Fusaka** (Dec 2025, **EIP-7951**). A relayer can pay gas for the user. |
| An address is either a person (EOA) or a contract | **EIP-7702** (Pectra) lets an EOA delegate to contract code, so "has code" no longer means "is a contract wallet" (see section 5.4). |
| Verify by pasting source into an explorer | Reproducible verification from build metadata via **Sourcify** (`forge verify-contract --verifier sourcify`), which explorers read. |
| Hope the code is right | Fuzzing, invariant testing, symbolic proofs (Halmos) and static analysis (Slither) are routine in CI. |

## 3. What we built and why it maps to the chapter

| Book concept | Hello, Chain |
|---|---|
| Greeting string | A visitor's 1–140 byte message, stored forever |
| Counter | `entryCount` and `uniqueVisitors`, which can only grow (proved) |
| Loop | Paginated reads with a hard page cap of 50; no function walks the whole log |
| Private chain + mining | anvil locally, Base Sepolia publicly |

Three ways to sign, all funnelled through one internal `_record` that enforces the rules: `sign` (caller pays gas), `signWithWallet` (EIP-712 signature from an EOA or ERC-1271 wallet, relayer pays gas) and `signWithPasskey` (WebAuthn assertion, relayer pays gas).

Ownership moves only through `Ownable2Step` (transfer, then accept). `renounceOwnership()` is overridden to revert with `RenounceDisabled()`: an ownerless guestbook could never hide abuse again.

**Relayer spend guards (final review).** The relayer pays for every gasless entry, so its daily spend is capped by reservations taken atomically before simulating and released on every outcome except a successful send: one entry per visitor per day, one per client IP per day (IPv6 bucketed by /64, because one subscriber usually holds a whole /64; IPv4-mapped IPv6 counts as the IPv4 address), and a global `global-day` cap (200, `RELAY_GLOBAL_DAILY_LIMIT`). Below a balance floor (0.002 ETH, `RELAY_MIN_BALANCE_WEI`) it refuses with 503 instead of sending. On Vercel production it refuses outright without Upstash, since per-instance memory limits reset on every cold start. A new visitor blocked only by the per-IP limit sees "Someone on your network already signed today".

**First visit is two taps.** Creating a passkey and then immediately asking it to sign, without a fresh tap in between, can be refused silently by iOS Safari. So the first tap only creates the passkey ("Passkey ready — tap to sign") and the second tap signs. If a stored passkey's prompt ends cancelled (often: the passkey is gone from the device), the card offers "Use a new passkey". The friendliness filter now runs in the card before any prompt, and the signature deadline is the latest block's timestamp + 15 minutes rather than the device clock.

## 4. Under the hood: storage

`forge inspect Guestbook storageLayout`:

| Slot | Variable | Type | From |
|---|---|---|---|
| 0 | `_owner` | `address` | `Ownable` |
| 1 | `_pendingOwner` | `address` | `Ownable2Step` |
| 2 | `_nameFallback` | `string` | `EIP712` (only used if the name were ≥ 32 bytes) |
| 3 | `_versionFallback` | `string` | `EIP712` (same) |
| 4 | `_entries` | `Entry[]` | ours: slot holds the length |
| 5 | `_uniqueVisitors` | `uint256` | ours |
| 6 | `_lastSignedAt` | `mapping(bytes32 => uint40)` | ours: value at `keccak256(visitorId . 6)` |
| 7 | `_nonces` | `mapping(bytes32 => uint256)` | ours: value at `keccak256(visitorId . 7)` |

`COOLDOWN` is `immutable`, so it lives in the bytecode and costs no storage read. The EIP-712 domain separator is cached as immutables too.

Each `Entry` takes **3 slots** starting at `keccak256(4) + 3·id`:

| Offset | Content |
|---|---|
| +0 | `visitorId` (bytes32) |
| +1 | `timestamp` (uint40, 5 bytes) · `kind` (enum, 1 byte) · `hidden` (bool, 1 byte), packed |
| +2 | `message` (string) |

How a `string` is stored decides much of the gas:

- **Short (≤ 31 bytes):** data and `length·2` share the one slot. "hello" costs a single slot write.
- **Long (≥ 32 bytes):** the slot holds `length·2 + 1`, and the data goes in `ceil(length/32)` slots starting at `keccak256(slot)`. A 140-byte message is 1 + 5 = 6 slots.

## 5. Under the hood: gas

### 5.1 What "gas" means in each number

| Number | Includes |
|---|---|
| Receipt `gasUsed` | 21,000 base + calldata (16 per non-zero byte, 4 per zero byte) + execution. This is what a visitor or the relayer pays for. |
| `forge test` per-test gas (and `.gas-snapshot`) | The whole test function: setup calls, the call under test, view calls and assertions. A regression signal, not a price. |
| `vm.lastFrameGas()` in forge 1.9 | Forge 1.9 runs tests in **isolation mode by default** (`isolate = true`), so every top-level call is its own transaction and this returns the **full transaction gas**, base and calldata included. We confirmed it on anvil: the receipt of the same `sign("hello")` reported exactly the same 159,735. |

Lesson learned: our first comparison put predicted *execution* gas next to forge's measured *transaction* gas, and every row looked about 15 % too low. The gap was exactly 21,000 + calldata. [Guestbook.Gas.t.sol](../projects/hello-chain/contracts/test/Guestbook.Gas.t.sol) now subtracts the intrinsic part it can compute exactly and asserts that execution is within ±10 % of the prediction.

### 5.2 Predicted vs measured

Setup for every row: a fresh visitor's first entry into an empty guestbook, so every touched slot starts **cold and zero**. Rules used (EIP-2929 / EIP-2200):

| Operation | Gas |
|---|---|
| SLOAD, cold / warm | 2,100 / 100 |
| SSTORE zero → non-zero, slot cold | 22,100 (20,000 + 2,100 cold surcharge) |
| SSTORE zero → non-zero, slot already warm | 20,000 |
| SSTORE to a slot already written in this tx | 100 |
| LOGn | 375 + 375·topics + 8·data bytes |
| KECCAK256 | 30 + 6·words |
| EXTCODESIZE, cold account | 2,600 |
| ecrecover precompile | 3,000 |

**`sign("hello")` execution prediction**

| Item | Gas |
|---|---|
| `_lastSignedAt[v]`: cold read 2,100, then write 0 → t (warm) 20,000, plus a warm re-read for the packed uint40 100 | 22,200 |
| `_uniqueVisitors`: cold read 2,100 + write 0 → 1 20,000 | 22,100 |
| `_entries.length`: cold read 2,100 + warm re-read 100 + write 0 → 1 20,000 | 22,200 |
| Entry slot +0 (`visitorId`): cold write 22,100 | 22,100 |
| Entry slot +1 (packed): cold read 2,100 + write 20,000 + two read-modify-writes of the same slot (100 + 100 + 100) | 22,400 |
| Entry slot +2 (message, short): cold read of the old length 2,100 + write 20,000 | 22,100 |
| `Signed` event: LOG3 (topic0 + 2 indexed) = 1,500, data = kind, offset, timestamp, length, 1 data word = 160 bytes × 8 = 1,280 | 2,780 |
| Three KECCAK256 (mapping key, array base) | ~120 |
| ~650 cheap opcodes (dispatch, ABI decode, checks, memory) at ~3 gas | ~2,000 |
| **Predicted execution** | **~138,000** |

For a **140-byte** message add five data slots (5 × 22,100 = 110,500), 128 more log bytes (1,024), one more KECCAK256 and a little ABI work: **~250,000**.

For **`signWithWallet`** add the nonce (cold read 2,100 + write 0 → 1 20,000), `author.code.length` on a cold account (2,600), ecrecover (3,000 + 100 call), EIP-712 hashing (~150) and more ABI decoding (~1,500): **~167,500**.

For **`signWithPasskey` with the precompile** add the nonce (22,100), P256VERIFY (6,900 under Osaka rules), two SHA-256 precompile calls (~400), base64url-encoding the challenge and matching it inside `clientDataJSON`, the public-key on-curve check and decoding the nested `WebAuthnAuth` struct (~6,500 together): **~174,000**.

**Measured** (`forge test --mc GuestbookGasTest -vv`, forge 1.9.0, solc 0.8.38, optimizer 200 runs):

| Call | Tx total | 21,000 + calldata | Execution | Predicted execution | Δ |
|---|---|---|---|---|---|
| `sign`, 5 bytes | 159,735 | 21,532 | 138,203 | 138,000 | +0.1 % |
| `sign`, 140 bytes | 273,882 | 23,664 | 250,218 | 250,000 | +0.1 % |
| `signWithWallet` (EOA), 5 bytes | 191,724 | 23,520 | 168,204 | 167,500 | +0.4 % |
| `signWithPasskey`, P256VERIFY precompile, 5 bytes | 203,940 | 27,280 | 176,660 | 174,000 | +1.5 % |
| `signWithPasskey`, Solidity P-256 fallback, 5 bytes | 442,626 | 27,280 | 415,346 | measured only | — |
| `signWithPasskey`, Solidity fallback, 140 bytes | 558,227 | — | — | must stay < 700,000 | — |

All predicted rows are inside the ±10 % tolerance, and the tests fail if that stops being true. The storage part is exact: an anvil trace of `sign("hello")` sums SSTORE = 122,300 and SLOAD = 10,800, i.e. the 133,100 in the table. The soft part of every prediction is the "cheap opcodes" line; the passkey row carries the most of it (WebAuthn parsing), which is why it is the furthest off.

Whole-test numbers in `.gas-snapshot` are different on purpose: `test_sign_storesEntryAndEmits` = 220,133, `test_validSig_recordsAsAuthor_kindWallet` = 246,383, `test_validAssertion_kindPasskey` = 513,441 include assertions and extra view calls. The 513k figure is what an earlier relayer comment called "peak passkey gas"; the real worst case is the 140-byte row above (558k), still under the relayer's 700k ceiling (`MAX_RELAY_GAS`).

**Re-check the 700k ceiling** if the contract, the message limit or OpenZeppelin's WebAuthn/P256 code changes: `test_gas_signWithPasskey_140_solidityFallback_underRelayCap` fails first.

### 5.3 P-256: precompile vs Solidity fallback

OpenZeppelin's `P256.verify` first calls address `0x100`. If a precompile answers, it uses the result; if not, it runs the curve maths in Solidity. The contract is compiled for `cancun` and does not need to know which chain it is on: the check happens at runtime.

| Path | Execution gas (5-byte message) |
|---|---|
| Precompile (forge with Osaka rules, EIP-7951 price 6,900) | 176,660 |
| Solidity fallback (Cancun rules, no precompile) | 415,346 |
| **Difference** | **238,686** |

So the P-256 maths alone costs about **245,600** gas in Solidity (238,686 + 6,900) vs **6,900** for the precompile, roughly 35×. Method: the same test body run twice, once with `vm.setEvmVersion("osaka")` (precompile present) and once on the project's `cancun` setting (absent). Base priced RIP-7212 at 3,450 when it launched; check the chain's current price, since L1 now charges 6,900 and OP-Stack chains follow L1 pricing in later upgrades. Either way, on Base a passkey entry is about the price of a wallet entry plus a few thousand gas.

### 5.4 Signature paths and EIP-7702

`SignatureChecker.isValidSignatureNowCalldata(author, digest, sig)` in OZ 5.7.0 branches on `author.code.length`:

- **No code** → ECDSA `tryRecover`, valid if the recovered address equals `author`.
- **Has code** → ERC-1271 `isValidSignature(digest, sig)` staticcall, valid if it returns the magic value.

Since EIP-7702, an EOA can set a delegation (its code becomes `0xef0100 ‖ delegate`, 23 bytes). Such an account **has code**, so it takes the ERC-1271 branch even though the person still holds the private key. That works when the delegate contract implements ERC-1271 (most smart-account delegates do, often by accepting the EOA key's own signature), and fails if it does not: a plain ECDSA signature from a delegated EOA is then rejected. For the guestbook the failure is safe (no entry, no fund loss, the visitor can still use `sign` or a passkey); it is a usability edge, not a security hole. The ERC-1271 call is bounded by the relayer's 700k gas cap.

### 5.5 Passkey verification and the threat model

`signWithPasskey` calls OZ 5.7.0 `WebAuthn.verify(challenge, auth, qx, qy, true)`. It checks: the `type` is `webauthn.get`, the `challenge` in `clientDataJSON` is base64url of our EIP-712 digest, the authenticator flags have **UP** (user present) and, because the last argument is `true`, **UV** (user verified: Face ID, fingerprint or PIN), and the P-256 signature over `authenticatorData ‖ sha256(clientDataJSON)` (with low-s).

It does **not** check the `origin` in `clientDataJSON` or the `rpIdHash` in `authenticatorData`. That is acceptable here because **the key is the identity**: `visitorId = keccak256(qx, qy)`. A browser only lets a site use passkeys registered for that site's rpId, so another site cannot produce an assertion from our visitors' keys; it could only use keys registered to itself, which map to *different* visitor ids. The worst a hostile site can do is sign the guestbook as its own visitors, which anyone can already do. Replay is blocked by the per-visitor nonce and deadline inside the challenge, and the EIP-712 domain binds chain id and contract address. If a future version gave a passkey power over something shared (funds, an existing account), it would need to pin `rpIdHash` and origin.

### 5.6 Key opcodes of `sign("hello")`

From an anvil `debug_traceTransaction` of a first sign into an empty guestbook (slot names from the storage layout):

| # | Op | Slot | Gas | Why |
|---|---|---|---|---|
| 1 | KECCAK256 | — | 42 | `keccak256(visitorId . 6)`, the `_lastSignedAt` key |
| 2 | SLOAD | `_lastSignedAt[v]` | 2,100 | cold read: 0 means "never signed" |
| 3 | SLOAD | 5 `_uniqueVisitors` | 2,100 | cold |
| 4 | SSTORE | 5 | 20,000 | 0 → 1 (already warm) |
| 5 | KECCAK256, SLOAD, SSTORE | `_lastSignedAt[v]` | 42 + 100 + 20,000 | key hashed again, then a read-modify-write of the packed uint40 |
| 6 | SLOAD ×2 | 4 `_entries.length` | 2,100 + 100 | read id, then push reads it again |
| 7 | SSTORE | 4 | 20,000 | length 0 → 1 |
| 8 | KECCAK256 | — | 36 | `keccak256(4)`, start of the array data |
| 9 | SSTORE | entry +0 | 22,100 | `visitorId`, cold |
| 10 | SLOAD, SSTORE, SSTORE, SLOAD, SSTORE | entry +1 | 2,100 + 20,000 + 100 + 100 + 100 | timestamp, kind, hidden packed into one slot: one field at a time |
| 11 | SLOAD + SSTORE | entry +2 | 2,100 + 20,000 | old string length read (to clear old data), then the short string |
| 12 | LOG3 | — | 2,780 | `Signed(id, visitorId, kind, message, timestamp)` |

There is no CALL and no SSTORE to `_nonces` on this path. For a 140-byte message, step 11 becomes a KECCAK256 plus five cold 22,100 writes for the data and one for the length, and the LOG3 costs 3,804.

## 6. Why private-chain mining is gone

The book had readers write a genesis file with a tiny difficulty, start a node with mining on, and mine their own ether. That relied on Ethereum being **proof of work**.

On **15 September 2022 (The Merge)**, Ethereum switched to **proof of stake**. Since then:

- Blocks are proposed by validators chosen by a **consensus client** (beacon chain) and executed by an **execution client** (geth, Reth, Nethermind, …) through the Engine API. An execution client alone no longer produces blocks.
- Mining support was removed from geth. There is nothing to mine and no mining reward; ether on a test network comes from the genesis allocation or a faucet.
- Running a realistic private PoS network means running both clients plus validators: possible (Kurtosis and similar tools do it), but heavy for a "hello world".

What replaces it:

| Need | 2026 tool |
|---|---|
| Fast local loop | **anvil**: instant blocks, 10 funded accounts, time travel (`evm_increaseTime`), impersonation, forking a live chain |
| Tests | **forge test**: each test runs in an in-process EVM, no node at all |
| Shared, realistic testing | Public testnets (Sepolia) or **L2 testnets** (Base Sepolia, chain id 84532) with faucets |

## 7. Analyzer and verification findings

**Halmos 0.3.3** (`halmos --contract GuestbookHalmosTest`, `halmos.toml` sets `loop = 141`; `foundry.toml` sets `dynamic_test_linking = false` because Halmos cannot run the `vm.deployCode` that forge's dynamic linking injects): 4 / 4 proofs pass.

| Proof | Property | Paths, time |
|---|---|---|
| `check_countNeverDecreases` | entry count never goes down, whoever calls | 3, 0.09 s |
| `check_cooldownEnforced` | a second sign within any cooldown in [1 h, 1 d] reverts with the exact unlock time | 3, 0.08 s |
| `check_lengthRule` | symbolic length 0 or 141..160 reverts with the exact error | 2, 0.02 s |
| `check_lengthAccepted` | every length 1..140 is accepted (enumerated; Halmos cannot copy symbolic-size calldata) | 1, 32.4 s |

**Invariant suite** (256 runs × depth 100, `fail_on_revert = false`): entry count matches a ghost log, unique visitors ≤ entries, both counts never decrease, stored messages never change, nonces never decrease, no visitor ever signs inside their cooldown.

**Slither 0.11.6** (`slither .`, config filters `lib/`, `test/`, `script/`): 0 high, 0 medium, 8 low/informational. CI fails on medium or above.

| Finding | Where | Verdict | Action |
|---|---|---|---|
| `timestamp`: `block.timestamp > deadline` | `signWithWallet`, `signWithPasskey` | True detection, intended use. Deadlines are minutes to hours; a sequencer or proposer can skew time by seconds at most. | None (documented in code) |
| `timestamp`: `last == 0`, `nowTs < last + COOLDOWN` | `_record` | Same: the per-visitor cooldown *is* a time rule; minimum cooldown is 1 hour. | None |
| `timestamp`: id / length comparisons | `isHidden`, `getEntry`, `getEntries`, `latest` | False positive: these compare ids and lengths, not time; Slither's data-flow reaches them through `_entries`, whose entries carry timestamps. | None |
| `naming-convention`: `COOLDOWN` not mixedCase | `Guestbook` | False positive for our style: immutables are UPPER_CASE like constants (Solidity style guide, forge-lint agrees). | None |
| `incorrect-equality` (medium): `last == 0` | `_record` | False positive: 0 is an exact sentinel for "never signed" (block timestamps are never 0). | Suppressed inline with a reason (Task 5) |

**Aderyn** was planned but dropped project-wide: it could not be installed in this environment, and CI runs Slither only.

## Takeaways worth building on

1. **Predict, then measure.** Gas is not magic: count cold slots × 22,100 and you are within a few percent. When a prediction misses, the gap usually points at a misunderstanding (here: what forge's number includes).
2. **Strings are the expensive part.** Five extra data slots for a long message cost more than an ECDSA check and a nonce together.
3. **Precompiles change the design space.** Passkeys went from "too expensive" (~440k) to "about the price of a wallet signature" (~200k) because a chain added one precompile.
4. **"Has code" no longer means "is a contract."** Anything branching on `code.length` needs a second look after EIP-7702.
5. **The book's private chain was really a test harness.** anvil and in-process tests are the same idea, minus the mining.
