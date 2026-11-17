# Chapter 1 — Blockchain Basics (reference notes)

> Our own summary of the book's ideas, updated to the 2026 picture. The book is a reference only; nothing here is meant to be copied into a project.

## 1. Distributed systems

| Idea | Core point | Book's story |
|---|---|---|
| Centralized vs P2P | Client–server puts a trusted middleman in the path (Web2). P2P makes every node a client and a server, removing the middleman but adding coordination problems. | Google search, WhatsApp ticks vs BitTorrent |
| Byzantine Generals | How do honest parties agree when some participants lie and messages pass through untrusted hands? | 6 army captains + 1 traitor must agree on an attack time |
| Winning strategy | (1) Every message costs real work to produce. (2) Every message embeds all earlier messages. Faking history costs more work than the time allowed. This is **proof of work + hash chaining** in disguise. | Traitor would need 30 min of work in a 10 min window |
| CAP theorem | Under a network partition you must choose **Consistency** or **Availability**; you can't keep all three of C, A, P. | HappySpouse.com: two notebooks, a missed sync, a couple's fight = partition |
| Eventual consistency | Write locally, sync in the background; briefly stale reads are the price. | The run-around clerk |
| Consensus | All nodes agree on one value that some node actually proposed. Families: Raft/Paxos (crash faults, majority vote), PBFT (Byzantine faults), PoW, PoS, DPoS. | — |

## 2. Cryptography (integrity, not secrecy)

- **Hash function**: one-way, fixed-size output, tiny input change → totally different output (avalanche), collision resistant.
- **Hash chain**: `h(h(x))` — each link commits to everything before it.
- **Merkle tree**: hash pairs upward to a single **root**. An **inclusion proof** is just the sibling hashes along the path (log₂ n of them). The verifier recomputes the root; a wrong leaf breaks the path immediately.
- Worked example in the book: 4 leaves D0–D3, proving D2 needs only its sibling, the other branch hash, and the known root.

## 3. Two ways to see a blockchain

- **Developer**: a chain of blocks, each committing to the previous block's hash and a Merkle root of its contents. Bitcoin's leaves are transactions; Ethereum's commitments cover **state** (accounts, storage, code results).
- **Trader**: a ledger acting as money — medium of exchange, store of value, unit of account — with distributed consensus standing in for a central authority.

## 4. Inside a Bitcoin block

| Field | Size | Purpose |
|---|---|---|
| Magic number `0xD9B4BEF9` | 4 B | Network identifier on the wire |
| Block size | 4 B | Length of what follows |
| **Header** | 80 B | version · prev block hash · Merkle root · timestamp · bits (target) · nonce |
| Tx counter | 1–9 B (varint) | Number of transactions |
| Transactions | rest | The payload |

Key insight: transactions are committed through the Merkle root, so hashing the header costs the same whether the block holds 1 tx or 10,000.

## 5. Mining and forking

- **Mining** = brute-force search for a nonce so `hash(header) < target`. Lower target = harder.
- **Retargeting** every 2016 blocks keeps the average at ~10 minutes.
- **Forks**: soft fork = backward compatible (old nodes still accept new blocks); hard fork = not compatible, the chain can split permanently. Either can be miner-activated or user-activated.
  - SegWit / BIP148 (2017) → user-activated soft fork.
  - ETH / ETC split after The DAO hack (2016) → hard fork.

## 6. Evolution and hype

- Melanie Swan: Blockchain 1.0 currency → 2.0 contracts/finance → 3.0 beyond finance (government, health, science, art).
- Generations: money → assets → contracts.
- Book's 2017 view: blockchain was in Gartner's "trough of disillusionment"; smart contracts were the hope for climbing out.

## What changed since the book (2026 view)

| Book says | Now |
|---|---|
| Block reward 12.5 BTC | **3.125 BTC** since the April 2024 halving (next ~2028) |
| 1 MB block limit | **4M weight units** since SegWit (~1.5–2 MB typical, up to ~4 MB) |
| Header version "= 2" | Version bits are used for **BIP9 soft-fork signalling** |
| Ethereum is proof of work | **Proof of stake** since The Merge (Sept 2022); 12 s slots, 32-epoch finality (~13 min) |
| Ethereum stores "every state" and might not scale | Scaling moved to **L2 rollups**; **EIP-4844 blobs** (Dencun, 2024) made L2 data cheap; Pectra (2025) added smart-account features for regular wallets (EIP-7702) |
| Hype trough (2017) | Stablecoins, tokenized real-world assets, Bitcoin/ETH ETFs (2024), restaking and on-chain payments are mainstream use |
| Merkle trees in blocks | Ethereum state uses Merkle-Patricia tries today, with a move toward **Verkle / binary trees** for stateless clients on the roadmap |

## Takeaways worth building on

1. Every core idea in this chapter has a story attached → a project can teach by **letting people play the story**.
2. Merkle proofs are the most directly useful thing for later chapters: allowlists, airdrops, claim contracts and rollups all verify them on-chain.
3. "Faking history costs more than the time allowed" is the single sentence that explains why blockchains are trustworthy — any project from this chapter should make users *feel* that.

## Candidate project directions (undecided)

| Direction | Who it serves | Value |
|---|---|---|
| Playable explainer ("tamper and watch it break") | Newcomers, students, non-technical stakeholders | Understand blockchains in minutes by doing |
| From-scratch mini chain | The developer (us) | Deep understanding of blocks, mining, forks |
| Merkle proof toolkit | Builders in later chapters | Reusable for allowlists/airdrops/claims |

Status: waiting on the user's answer to "who is this for and what should they walk away with?"
