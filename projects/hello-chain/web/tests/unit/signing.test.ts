import { afterEach, describe, expect, it, vi } from "vitest";

const readContract = vi.fn();
const getBlock = vi.fn();
vi.mock("@/lib/chain", async () => {
  const { anvil } = await import("viem/chains");
  return {
    activeChain: anvil,
    publicClient: {
      readContract: (...a: unknown[]) => readContract(...a),
      getBlock: (...a: unknown[]) => getBlock(...a),
    },
  };
});

import { entryTypedData, SIGN_WINDOW_SECONDS, VisitorError } from "@/lib/signing";

const VISITOR = `0x${"33".repeat(32)}` as const;
const BLOCK_TS = 1_800_000_000;

function chain(lastSignedAt = 0) {
  readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "nonces") return 4n;
    if (functionName === "lastSignedAt") return lastSignedAt;
    if (functionName === "COOLDOWN") return 86_400;
    throw new Error(`unexpected read ${functionName}`);
  });
  getBlock.mockResolvedValue({ timestamp: BigInt(BLOCK_TS) });
}

afterEach(() => {
  vi.restoreAllMocks();
  readContract.mockReset();
  getBlock.mockReset();
});

describe("entryTypedData", () => {
  it("takes the deadline from the latest block (the cooldown read), not the device clock", async () => {
    chain();
    // A device clock two hours fast (or slow) must not shift the deadline.
    for (const skew of [2 * 3600, -2 * 3600]) {
      vi.spyOn(Date, "now").mockReturnValue((BLOCK_TS + skew) * 1000);
      const td = await entryTypedData(VISITOR, "hi");
      expect(td.message.deadline).toBe(BigInt(BLOCK_TS + SIGN_WINDOW_SECONDS));
      expect(td.message.nonce).toBe(4n);
    }
    expect(SIGN_WINDOW_SECONDS).toBe(900);
    // One block read per call, shared by the cooldown check and the deadline.
    expect(getBlock).toHaveBeenCalledTimes(2);
  });

  it("still throws the cooldown copy before building typed data", async () => {
    chain(BLOCK_TS - 60);
    await expect(entryTypedData(VISITOR, "hi")).rejects.toBeInstanceOf(VisitorError);
  });
});
