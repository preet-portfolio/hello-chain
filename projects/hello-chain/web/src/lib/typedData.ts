import type { TypedDataDefinition } from "viem";

/** EIP-712 types for Guestbook.hashEntry; must match ENTRY_TYPEHASH in Guestbook.sol. */
export const entryTypes = {
  Entry: [
    { name: "visitorId", type: "bytes32" },
    { name: "message", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export type EntryTypedData = TypedDataDefinition<typeof entryTypes, "Entry">;

/**
 * Typed data whose `hashTypedData` equals `Guestbook.hashEntry(visitorId, message, nonce, deadline)`
 * on the contract at `contract` on `chainId`.
 */
export function typedDataFor(
  chainId: number,
  contract: `0x${string}`,
  visitorId: `0x${string}`,
  message: string,
  nonce: bigint,
  deadline: bigint,
): EntryTypedData {
  return {
    domain: { name: "HelloChain", version: "1", chainId, verifyingContract: contract },
    types: entryTypes,
    primaryType: "Entry",
    message: { visitorId, message, nonce, deadline },
  };
}
