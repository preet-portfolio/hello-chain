// Shared (server + browser) message rules. Pure: no Node-only or DOM APIs.

export const MAX_MESSAGE_BYTES = 140;

const encoder = new TextEncoder();

export function utf8ByteLength(s: string): number {
  return encoder.encode(s).length;
}

export type MessageValidation =
  | { ok: true; value: string }
  | { ok: false; reason: "empty" | "tooLong" };

/** Trims, then checks 1..140 UTF-8 bytes. Callers must submit `value`. */
export function validateMessage(s: string): MessageValidation {
  const value = s.trim();
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (utf8ByteLength(value) > MAX_MESSAGE_BYTES) return { ok: false, reason: "tooLong" };
  return { ok: true, value };
}
