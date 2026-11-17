// Browser-side helpers shared by the passkey and wallet sign flows. No React in here.
import { hashTypedData, type Address, type Hex } from "viem";
import { activeChain, publicClient } from "@/lib/chain";
import { guestbookAbi, guestbookAddress } from "@/lib/contract";
import { typedDataFor, type EntryTypedData } from "@/lib/typedData";
import { friendlyError } from "@/lib/relay/errors";
import type { RelayErrorCode, RelayRequest, RelayResponse } from "@/lib/relay/types";

/** How long a signature stays valid for the relayer. */
export const SIGN_WINDOW_SECONDS = 15 * 60;

/** Deadline for a signature made now, measured on chain time (a device clock can be hours off). */
export function deadlineFrom(blockTimestamp: bigint): bigint {
  return blockTimestamp + BigInt(SIGN_WINDOW_SECONDS);
}

/** An error whose message is already visitor-facing copy. */
export class VisitorError extends Error {}

function contractAddress(): Address {
  const a = guestbookAddress[activeChain.id];
  if (!a) throw new Error("Guestbook address is not configured for the active chain");
  return a;
}

/**
 * EIP-712 typed data for this visitor's next entry, with a deadline SIGN_WINDOW_SECONDS after the
 * latest block (the same block the cooldown check reads). Throws a VisitorError
 * with the cooldown copy if this visitor signed too recently, so callers check it BEFORE prompting
 * for Face ID / fingerprint or a wallet signature.
 */
export async function entryTypedData(visitorId: Hex, message: string): Promise<EntryTypedData> {
  const contract = contractAddress();
  const [nonce, cooldown] = await Promise.all([
    publicClient.readContract({ address: contract, abi: guestbookAbi, functionName: "nonces", args: [visitorId] }),
    cooldownState(visitorId),
  ]);
  if (cooldown.copy) throw new VisitorError(cooldown.copy);
  return typedDataFor(activeChain.id, contract, visitorId, message, nonce, deadlineFrom(cooldown.blockTimestamp));
}

/** The cooldown copy if this visitor signed within the contract's cooldown (as of the latest block), else null. */
export async function cooldownMessage(visitorId: Hex): Promise<string | null> {
  return (await cooldownState(visitorId)).copy;
}

async function cooldownState(visitorId: Hex): Promise<{ copy: string | null; blockTimestamp: bigint }> {
  const gb = { address: contractAddress(), abi: guestbookAbi } as const;
  const [lastSignedAt, cooldown, block] = await Promise.all([
    publicClient.readContract({ ...gb, functionName: "lastSignedAt", args: [visitorId] }),
    publicClient.readContract({ ...gb, functionName: "COOLDOWN" }),
    publicClient.getBlock(),
  ]);
  const last = BigInt(lastSignedAt);
  const left = last + BigInt(cooldown) - block.timestamp;
  const copy = last !== 0n && left > 0n ? friendlyError("cooldown", Number(left)) : null;
  return { copy, blockTimestamp: block.timestamp };
}

export const entryDigest = (td: EntryTypedData): Hex => hashTypedData(td);

export type RelayOutcome = { ok: true; txHash: Hex } | { ok: false; message: string };

const ERROR_CODES = new Set<RelayErrorCode>(["invalid", "filtered", "cooldown", "rateLimited", "network", "busy"]);

/** POSTs to /api/relay and turns any failure into visitor-facing copy. */
export async function postRelay(req: RelayRequest): Promise<RelayOutcome> {
  let body: RelayResponse;
  try {
    const res = await fetch("/api/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    body = (await res.json()) as RelayResponse;
  } catch {
    return { ok: false, message: friendlyError("busy") };
  }
  if ("txHash" in body && typeof body.txHash === "string") return { ok: true, txHash: body.txHash };
  const code = "error" in body && ERROR_CODES.has(body.error) ? body.error : "busy";
  const retryAfter = "retryAfter" in body && typeof body.retryAfter === "number" ? body.retryAfter : undefined;
  return { ok: false, message: friendlyError(code, retryAfter) };
}

/**
 * Waits for the relayed entry to land. False only if it was definitely not recorded (reverted);
 * if the receipt can't be fetched the relayer still accepted it, and the live feed reconciles.
 */
export async function entryRecorded(txHash: Hex): Promise<boolean> {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    return receipt.status === "success";
  } catch {
    return true;
  }
}

/** Explorer page for the entry, or null on chains without one (local anvil). */
export function proofUrl(txHash: Hex): string | null {
  const base = activeChain.blockExplorers?.default.url;
  return base ? `${base}/tx/${txHash}` : null;
}

/** True when the visitor dismissed a wallet prompt (EIP-1193 4001 anywhere in the cause chain). */
export function isUserRejection(err: unknown): boolean {
  for (let e = err as { name?: string; code?: number; cause?: unknown } | undefined, i = 0; e && i < 10; i++) {
    if (e.code === 4001 || e.name === "UserRejectedRequestError") return true;
    e = e.cause as typeof e;
  }
  return false;
}

/** "Face ID / fingerprint" where the platform authenticator is one of those, else a generic label. */
export function signLabel(userAgent: string): string {
  return /iPhone|iPad|iPod|Macintosh|Mac OS X|Android/.test(userAgent)
    ? "Sign with Face ID / fingerprint"
    : "Sign with your passkey";
}
