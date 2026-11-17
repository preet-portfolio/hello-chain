// Error copy for the UI and custom-error decoding for the relayer. Browser-safe.
import { BaseError, ContractFunctionRevertedError } from "viem";
import type { RelayErrorCode } from "./types";

const COPY: Record<RelayErrorCode, string> = {
  cooldown: "You've already signed today — come back tomorrow",
  busy: "The guestbook is busy right now — try again in a minute",
  filtered: "Let's keep it friendly — links, contact details and strong language aren't allowed here.",
  rateLimited: "Slow down a little — try again in a moment",
  network: "Someone on your network already signed today — try again tomorrow.",
  invalid: "Something went wrong with that signature — please try again",
};

/** A wait in plain words: "in a minute", "in 5 minutes", "in about 3 hours", "tomorrow". */
export function waitPhrase(seconds: number): string {
  if (seconds <= 60) return "in a minute";
  if (seconds < 3600) return `in ${Math.ceil(seconds / 60)} minutes`;
  const hours = Math.round(seconds / 3600);
  if (seconds < 12 * 3600) return hours === 1 ? "in about an hour" : `in about ${hours} hours`;
  return "tomorrow";
}

/**
 * Plain-language message for a relay error code. Pass `retryAfter` (seconds, from a 429) so the
 * copy says how long to wait instead of a vague "in a moment".
 */
export function friendlyError(code: RelayErrorCode, retryAfter?: number): string {
  if (retryAfter === undefined || !Number.isFinite(retryAfter)) return COPY[code];
  // A cooldown with no time left (block time already past `until`) still means "you signed today":
  // never say "in a minute" when we can't name a real wait.
  if (code === "cooldown" && retryAfter <= 0) return COPY.cooldown;
  const wait = waitPhrase(Math.max(0, retryAfter));
  if (code === "cooldown") return `You've already signed today — come back ${wait}`;
  if (code === "rateLimited") return `Slow down a little — try again ${wait}`;
  return COPY[code];
}

export type DecodedRevert = { errorName: string; args: readonly unknown[] };

/** The Guestbook custom error behind a viem simulate/write failure, or null if it was not a revert. */
export function decodeRevert(err: unknown): DecodedRevert | null {
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError) || !revert.data?.errorName) return null;
  return { errorName: revert.data.errorName, args: revert.data.args ?? [] };
}

/**
 * Loggable text for an error. viem errors give only `shortMessage`: their full `message` embeds
 * request details such as the RPC URL, which can carry an API key.
 */
export function safeErrorText(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage;
  if (err instanceof Error) return `${err.name}: ${err.message.slice(0, 200)}`;
  return "non-Error thrown";
}

/** Reverts that mean the request itself is bad (400), as opposed to cooldown (429) or infra (503). */
export const INVALID_REVERTS = new Set(["MessageEmpty", "MessageTooLong", "SignatureExpired", "InvalidSignature"]);
