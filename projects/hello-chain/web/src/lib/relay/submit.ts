// Simulate → estimate (with a ceiling) → send for a validated entry. Gas is estimated, never hard-coded
// (signWithPasskey costs ~443k for a 5-byte message and ~558k for 140 bytes on the Solidity P-256
// fallback, ~204k with the P-256 precompile; see contracts/test/Guestbook.Gas.t.sol), but it is
// capped: an ERC-1271 author contract could otherwise make the relayer pay for arbitrarily
// expensive verification.
import { formatEther, parseEther, type Account, type Address, type Hex } from "viem";
import { guestbookAbi } from "@/lib/contract";
import type { WebAuthnAuthPayload } from "@/lib/passkey";
import { decodeRevert, INVALID_REVERTS, safeErrorText } from "./errors";
import type { RelayEntry } from "./validate";

export const LOW_BALANCE_WEI = parseEther("0.005");
/** Hard ceiling per relayed entry. Passkey on the Solidity P-256 fallback peaks around 558k (140 bytes). */
export const MAX_RELAY_GAS = 700_000n;

export type GuestbookCall =
  | { functionName: "signWithWallet"; args: readonly [Address, string, bigint, Hex] }
  | { functionName: "signWithPasskey"; args: readonly [Hex, Hex, string, bigint, WebAuthnAuthPayload] };

export type SimulateParams = GuestbookCall & { address: Address; abi: typeof guestbookAbi; account: Account };

/** The subset of a viem PublicClient the relayer uses (injectable for tests). */
export interface RelayPublicClient {
  simulateContract(params: SimulateParams): Promise<{ request: unknown }>;
  estimateContractGas(params: SimulateParams): Promise<bigint>;
  getBlock(): Promise<{ timestamp: bigint }>;
  getBalance(params: { address: Address }): Promise<bigint>;
}

/** The subset of a viem WalletClient the relayer uses. Receives simulateContract's `request` plus `gas`. */
export interface RelayWalletClient {
  writeContract(request: unknown): Promise<Hex>;
}

export interface RelayLogger {
  warn(msg: string): void;
  error(msg: string): void;
}

export type SubmitDeps = {
  publicClient: RelayPublicClient;
  walletClient: RelayWalletClient;
  account: Account;
  contract: Address;
  log: RelayLogger;
};

export type SubmitOutcome =
  | { ok: true; txHash: Hex }
  | { ok: false; error: "cooldown"; retryAfter: number }
  | { ok: false; error: "invalid" | "busy" };

export function callFor(entry: RelayEntry): GuestbookCall {
  return entry.kind === "passkey"
    ? { functionName: "signWithPasskey", args: [entry.qx, entry.qy, entry.message, entry.deadline, entry.auth] }
    : { functionName: "signWithWallet", args: [entry.author, entry.message, entry.deadline, entry.signature] };
}

async function classify(err: unknown, deps: SubmitDeps, stage: string): Promise<SubmitOutcome> {
  const revert = decodeRevert(err);
  if (revert?.errorName === "CooldownActive") {
    const until = BigInt(revert.args[0] as number | bigint);
    try {
      const { timestamp } = await deps.publicClient.getBlock();
      const left = until - timestamp;
      return { ok: false, error: "cooldown", retryAfter: left > 0n ? Number(left) : 0 };
    } catch {
      return { ok: false, error: "cooldown", retryAfter: 0 };
    }
  }
  if (revert && INVALID_REVERTS.has(revert.errorName)) return { ok: false, error: "invalid" };
  deps.log.error(`[relay] ${stage} failed: ${revert ? `revert ${revert.errorName}` : safeErrorText(err)}`);
  return { ok: false, error: "busy" };
}

async function warnIfLowBalance(deps: SubmitDeps): Promise<void> {
  try {
    const balance = await deps.publicClient.getBalance({ address: deps.account.address });
    if (balance < LOW_BALANCE_WEI) {
      deps.log.warn(
        `[relay] relayer balance low: ${formatEther(balance)} ETH at ${deps.account.address} (top up below 0.005 ETH)`,
      );
    }
  } catch (err) {
    deps.log.warn(`[relay] could not read relayer balance: ${safeErrorText(err)}`);
  }
}

/** Simulates the call (decoding Guestbook custom errors), enforces the gas ceiling, then submits. */
export async function submitEntry(entry: RelayEntry, deps: SubmitDeps): Promise<SubmitOutcome> {
  const params: SimulateParams = {
    ...callFor(entry),
    address: deps.contract,
    abi: guestbookAbi,
    account: deps.account,
  };

  let request: unknown;
  let estimate: bigint;
  try {
    ({ request } = await deps.publicClient.simulateContract(params));
    estimate = await deps.publicClient.estimateContractGas(params);
  } catch (err) {
    return classify(err, deps, "simulate");
  }
  if (estimate > MAX_RELAY_GAS) {
    deps.log.error(`[relay] gas ceiling exceeded: estimate ${estimate} > ${MAX_RELAY_GAS} (${params.functionName})`);
    return { ok: false, error: "busy" };
  }
  // 10% headroom for small state differences between estimate and inclusion, never above the ceiling.
  const withHeadroom = (estimate * 110n) / 100n;
  const gas = withHeadroom > MAX_RELAY_GAS ? MAX_RELAY_GAS : withHeadroom;

  let txHash: Hex;
  try {
    txHash = await deps.walletClient.writeContract({ ...(request as object), gas });
  } catch (err) {
    // A state change between simulate and send (e.g. a concurrent entry) can still revert here.
    return classify(err, deps, "submit");
  }
  await warnIfLowBalance(deps);
  return { ok: true, txHash };
}
