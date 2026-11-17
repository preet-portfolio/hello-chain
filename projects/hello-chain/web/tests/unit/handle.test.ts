import { describe, expect, it } from "vitest";
import { friendlyHandle } from "@/lib/handle";

describe("friendlyHandle", () => {
  const a = "0x1234567890abcdef1234567890abcdef12345678" as const;
  const b = "0x1234567890abcdef1234567890abcdef1234abcd" as const;
  it("is deterministic", () => {
    expect(friendlyHandle(a)).toBe(friendlyHandle(a));
  });
  it("has Adjective Animal #last4 format", () => {
    expect(friendlyHandle(a)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ #5678$/);
  });
  it("differs for different ids", () => {
    expect(friendlyHandle(a)).not.toBe(friendlyHandle(b));
  });
  it("is case-insensitive on hex", () => {
    expect(friendlyHandle(b.toUpperCase().replace("0X", "0x") as `0x${string}`)).toBe(friendlyHandle(b));
  });
  it("spreads zero-padded wallet-style ids across different word pairs", () => {
    const addrs = [
      "f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      "70997970c51812dc3a010c7d01b50e0d17dc79c8",
      "3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
      "90f79bf6eb2c4f870365e785982e1f101e93b906",
      "15d34aaf54267db7d7c367839aaf71a00a2c6a65",
    ];
    const pairs = addrs.map((x) =>
      friendlyHandle(`0x${"0".repeat(24)}${x}` as `0x${string}`).replace(/ #.*/, ""),
    );
    expect(new Set(pairs).size).toBeGreaterThanOrEqual(4);
  });
});
