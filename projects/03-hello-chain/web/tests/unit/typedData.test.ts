import { describe, expect, it } from "vitest";
import { hashTypedData } from "viem";
import fixture from "../fixtures/hashEntry.json";
import { typedDataFor } from "@/lib/typedData";

describe("typedDataFor", () => {
  it("hashes to the same digest as Guestbook.hashEntry", () => {
    const td = typedDataFor(
      fixture.chainId,
      fixture.verifyingContract as `0x${string}`,
      fixture.visitorId as `0x${string}`,
      fixture.message,
      BigInt(fixture.nonce),
      BigInt(fixture.deadline),
    );
    expect(hashTypedData(td)).toBe(fixture.digest);
  });

  it("uses the HelloChain v1 domain and Entry primary type", () => {
    const td = typedDataFor(1, "0x0000000000000000000000000000000000000001", `0x${"00".repeat(32)}`, "hi", 0n, 0n);
    expect(td.domain).toEqual({
      name: "HelloChain",
      version: "1",
      chainId: 1,
      verifyingContract: "0x0000000000000000000000000000000000000001",
    });
    expect(td.primaryType).toBe("Entry");
    expect(td.types.Entry).toEqual([
      { name: "visitorId", type: "bytes32" },
      { name: "message", type: "string" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ]);
  });

  it("changes the digest when any field changes", () => {
    const base = [fixture.chainId, fixture.verifyingContract, fixture.visitorId, fixture.message] as const;
    const a = hashTypedData(
      typedDataFor(base[0], base[1] as `0x${string}`, base[2] as `0x${string}`, base[3], 3n, 1893456000n),
    );
    const b = hashTypedData(
      typedDataFor(base[0], base[1] as `0x${string}`, base[2] as `0x${string}`, base[3], 4n, 1893456000n),
    );
    expect(a).not.toBe(b);
  });
});
