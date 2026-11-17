import { describe, expect, it } from "vitest";
import { utf8ByteLength, validateMessage } from "@/lib/message";

describe("validateMessage", () => {
  it("counts UTF-8 bytes", () => {
    expect(utf8ByteLength("😀")).toBe(4);
    expect(validateMessage("😀".repeat(35))).toEqual({ ok: true, value: "😀".repeat(35) });
    expect(validateMessage("😀".repeat(36))).toEqual({ ok: false, reason: "tooLong" });
    expect(validateMessage("a".repeat(140)).ok).toBe(true);
    expect(validateMessage("a".repeat(141))).toEqual({ ok: false, reason: "tooLong" });
    expect(validateMessage("é".repeat(70)).ok).toBe(true);
    expect(validateMessage("é".repeat(71)).ok).toBe(false);
  });
  it("rejects empty / whitespace", () => {
    expect(validateMessage("   ")).toEqual({ ok: false, reason: "empty" });
    expect(validateMessage("")).toEqual({ ok: false, reason: "empty" });
  });
  it("trims and byte-counts the trimmed value", () => {
    expect(validateMessage("  hi  ")).toEqual({ ok: true, value: "hi" });
    expect(validateMessage(" " + "a".repeat(140) + " ").ok).toBe(true);
  });
});
