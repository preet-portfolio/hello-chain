# Ethereum Smart Contract Projects (2026 edition)

Original, purpose-driven projects inspired by the ideas in *Ethereum Smart Contract Development* (Packt). The book's code lives in `Ethereum-Smart-Contract-Development/` as **reference only**.

## Ground rules

1. **No plagiarism.** We read the book for concepts, then design our own product, naming, structure and code.
2. **Every project has a purpose.** It solves a real problem for a named user, not just a demo of a concept.
3. **Built for the user's ease.** Clear UI, plain-language errors, sensible defaults, works on mobile.
4. **2026 tooling.** Current Solidity, Foundry/Hardhat 3, viem/wagmi, L2 deployment, account abstraction where it helps, real tests.
5. **One chapter at a time.** The user provides chapter context → we note it → agree on a project → design → plan → build.

## Layout

| Path | What's there |
|---|---|
| `notes/` | Our chapter reference notes (concepts + what changed since the book) |
| `projects/` | One folder per project (created once a design is approved) |
| `Ethereum-Smart-Contract-Development/` | The original book repo (read-only reference) |

## Progress

| # | Chapter | Notes | Project | Status |
|---|---|---|---|---|
| 1 | Blockchain Basics | [notes](notes/ch01-blockchain-basics.md) | — | Concepts captured; project direction not chosen yet |
| 2 | Grokking Ethereum | — | — | Next |
| 3 | Hello World of Smart Contracts | [notes](notes/ch03-hello-world.md) | [Hello, Chain](projects/03-hello-chain/README.md): on-chain guestbook with passkey signing | Built & tested locally (CI added); Base Sepolia deploy pending |
