// Wire format for POST /api/relay. Shared by the server route and the browser client (Task 12).
// Pure types + one tiny helper; no Node-only or DOM APIs.
import type { Address, Hex } from "viem";
import type { AbuseReason } from "@/lib/filter";
import type { WebAuthnAuthPayload } from "@/lib/passkey";

/**
 * A uint256 on the wire. JSON cannot carry bigint, so send a decimal string ("4102444800")
 * or a non-negative *safe* integer number. Strings are preferred; numbers above 2^53-1 are rejected.
 */
export type WireUint = string | number;

/** `WebAuthnAuthPayload` with its bigint indices as WireUint. Build it with `toWireAuth`. */
export type WireWebAuthnAuth = {
  r: Hex; // 0x + 64 hex chars
  s: Hex; // 0x + 64 hex chars (low-s; passkey.ts normalises it)
  challengeIndex: WireUint;
  typeIndex: WireUint;
  authenticatorData: Hex; // 0x + even-length hex, non-empty
  clientDataJSON: string; // the exact string the authenticator returned
};

/**
 * Request body. `message` must be exactly the string that was signed AND already trimmed
 * (i.e. `validateMessage(message).value === message`), 1-140 UTF-8 bytes; otherwise 400.
 * Send with `Content-Type: application/json`. The whole JSON body must be <= 8 KB. Never send a visitorId: the server derives it.
 */
export type RelayRequest =
  | {
      kind: "passkey";
      qx: Hex; // bytes32
      qy: Hex; // bytes32
      message: string;
      deadline: WireUint; // unix seconds, inclusive
      auth: WireWebAuthnAuth;
    }
  | {
      kind: "wallet";
      author: Address;
      message: string;
      deadline: WireUint; // unix seconds, inclusive
      signature: Hex; // EIP-712 signature (65-byte ECDSA, or ERC-1271 bytes for smart wallets)
    };

export type RelayErrorCode = "invalid" | "filtered" | "cooldown" | "rateLimited" | "network" | "busy";

/**
 * Responses:
 * 200 { txHash } · 400 { error: 'invalid' } · 415 { error: 'invalid' } (Content-Type not application/json)
 * 422 { error: 'filtered', reason }
 * 429 { error: 'cooldown' | 'rateLimited' | 'network', retryAfter } (seconds, >= 0; also sent as Retry-After)
 *     cooldown: this visitor signed today · network: someone else on this IP (/64) did · rateLimited: burst
 * 503 { error: 'busy' }
 */
export type RelayResponse =
  | { txHash: Hex }
  | { error: "invalid" }
  | { error: "filtered"; reason: AbuseReason }
  | { error: "cooldown" | "rateLimited" | "network"; retryAfter: number }
  | { error: "busy" };

export function toWireAuth(auth: WebAuthnAuthPayload): WireWebAuthnAuth {
  return {
    r: auth.r,
    s: auth.s,
    challengeIndex: auth.challengeIndex.toString(),
    typeIndex: auth.typeIndex.toString(),
    authenticatorData: auth.authenticatorData,
    clientDataJSON: auth.clientDataJSON,
  };
}
