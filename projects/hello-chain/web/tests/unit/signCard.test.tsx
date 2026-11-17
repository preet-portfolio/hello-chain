// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { utf8ByteLength } from "@/lib/message";

const readContract = vi.fn();
const getBlock = vi.fn();
const waitForTransactionReceipt = vi.fn();
vi.mock("@/lib/chain", async () => {
  const { anvil } = await import("viem/chains");
  return {
    activeChain: anvil,
    publicClient: {
      readContract: (...a: unknown[]) => readContract(...a),
      getBlock: (...a: unknown[]) => getBlock(...a),
      waitForTransactionReceipt: (...a: unknown[]) => waitForTransactionReceipt(...a),
    },
  };
});

const loadPasskey = vi.fn();
const registerPasskey = vi.fn();
const signWithPasskey = vi.fn();
vi.mock("@/lib/passkey", () => ({
  PASSKEY_STORAGE_KEY: "hello-chain.passkey.v1",
  loadPasskey: () => loadPasskey(),
  registerPasskey: () => registerPasskey(),
  signWithPasskey: (...a: unknown[]) => signWithPasskey(...a),
}));

const connect = vi.fn();
const getConnection = vi.fn();
const signTypedData = vi.fn();
const switchChain = vi.fn();
vi.mock("wagmi/actions", () => ({
  connect: (...a: unknown[]) => connect(...a),
  getConnection: (...a: unknown[]) => getConnection(...a),
  signTypedData: (...a: unknown[]) => signTypedData(...a),
  switchChain: (...a: unknown[]) => switchChain(...a),
}));

import { SignCard } from "@/components/SignCard";
import { Providers } from "@/app/providers";
import { friendlyError, waitPhrase } from "@/lib/relay/errors";

const PK = {
  credentialId: "abc",
  qx: `0x${"11".repeat(32)}`,
  qy: `0x${"22".repeat(32)}`,
  visitorId: `0x${"33".repeat(32)}`,
} as const;
const AUTH = {
  r: `0x${"44".repeat(32)}`,
  s: `0x${"55".repeat(32)}`,
  challengeIndex: 23n,
  typeIndex: 1n,
  authenticatorData: "0x0102",
  clientDataJSON: '{"type":"webauthn.get"}',
};
const TX = `0x${"aa".repeat(32)}`;
const NOW = 1_800_000_000;
const DAY = 86_400;
// Checksummed (mixed-case) address, as wallets return it.
const WALLET = "0x5B38Da6a701c568545dCfcB03FcB875f56beddC4";
const WALLET_VISITOR = `0x000000000000000000000000${WALLET.slice(2).toLowerCase()}`;

/** Chain state for the reads the card makes before prompting. */
function chainState({ lastSignedAt = 0 }: { lastSignedAt?: number } = {}) {
  readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "nonces") return 0n;
    if (functionName === "lastSignedAt") return lastSignedAt;
    if (functionName === "COOLDOWN") return DAY;
    throw new Error(`unexpected read ${functionName}`);
  });
  getBlock.mockResolvedValue({ timestamp: BigInt(NOW) });
}

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 Safari/605.1.15",
  android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
};

const fetchMock = vi.fn();
function relayReplies(status: number, body: unknown) {
  fetchMock.mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function setUA(ua: string) {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(ua);
}

async function typeMessage(text: string) {
  const user = userEvent.setup();
  const box = screen.getByRole("textbox");
  await user.click(box);
  await user.paste(text);
  return { user, box: box as HTMLTextAreaElement };
}

const signButton = () => screen.getByRole("button", { name: /^Sign with/ });

beforeEach(() => {
  readContract.mockReset();
  getBlock.mockReset();
  chainState();
  connect.mockReset().mockResolvedValue({ accounts: [WALLET], chainId: 31337 });
  getConnection.mockReset().mockReturnValue({ status: "disconnected", chainId: 31337 });
  signTypedData.mockReset().mockResolvedValue(`0x${"bb".repeat(65)}`);
  switchChain.mockReset();
  waitForTransactionReceipt.mockReset().mockResolvedValue({ status: "success" });
  loadPasskey.mockReset().mockReturnValue(PK);
  registerPasskey.mockReset().mockResolvedValue(PK);
  signWithPasskey.mockReset().mockResolvedValue({ status: "ok", auth: AUTH });
  fetchMock.mockReset();
  relayReplies(200, { txHash: TX });
  vi.stubGlobal("fetch", fetchMock);
  setUA(UA.windows);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SignCard: message input", () => {
  it("counter shows 140 minus the UTF-8 byte length", async () => {
    render(<SignCard />);
    expect(screen.getByTestId("byte-counter").textContent).toContain("140");
    const text = "héllo 👋";
    await typeMessage(text);
    expect(screen.getByTestId("byte-counter").textContent).toContain(String(140 - utf8ByteLength(text)));
    expect(140 - utf8ByteLength(text)).toBe(129);
  });

  it("disables the sign button when the message is empty, blank, or over 140 bytes", async () => {
    render(<SignCard />);
    expect(signButton()).toHaveProperty("disabled", true);
    const { box, user } = await typeMessage("   ");
    expect(signButton()).toHaveProperty("disabled", true);
    await user.clear(box);
    await user.paste("👋".repeat(36)); // 144 bytes, 36 characters
    expect(screen.getByTestId("byte-counter").textContent).toContain("-4");
    expect(signButton()).toHaveProperty("disabled", true);
    await user.clear(box);
    await user.paste("hello");
    expect(signButton()).toHaveProperty("disabled", false);
  });
});

describe("SignCard: button label", () => {
  it.each([
    ["iPhone", UA.iphone],
    ["Mac", UA.mac],
    ["Android", UA.android],
  ])("says Face ID / fingerprint on %s", (_name, ua) => {
    setUA(ua);
    render(<SignCard />);
    expect(signButton().textContent).toBe("Sign with Face ID / fingerprint");
  });

  it("falls back to a generic passkey label elsewhere", () => {
    render(<SignCard />);
    expect(signButton().textContent).toBe("Sign with your passkey");
  });
});

describe("SignCard: passkey flow", () => {
  it("relays the trimmed message and pushes an optimistic entry, then shows Signed", async () => {
    const onOptimistic = vi.fn();
    render(<SignCard onOptimistic={onOptimistic} />);
    const { user } = await typeMessage("  hello chain  ");
    await user.click(signButton());

    await screen.findByText(/Signed/);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "nonces", args: [PK.visitorId] }),
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/relay");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      kind: "passkey",
      qx: PK.qx,
      qy: PK.qy,
      message: "hello chain",
      auth: { r: AUTH.r, s: AUTH.s, challengeIndex: "23", typeIndex: "1" },
    });
    // 15 minutes after the latest block (chain time), not the device clock.
    expect(body.deadline).toBe(String(NOW + 15 * 60));
    expect(body.visitorId).toBeUndefined();

    expect(onOptimistic).toHaveBeenCalledTimes(1);
    expect(onOptimistic.mock.calls[0][0]).toMatchObject({
      visitorId: PK.visitorId,
      message: "hello chain",
      kind: "passkey",
    });
    expect(onOptimistic.mock.calls[0][0].id).toBeLessThan(0n);
    expect(waitForTransactionReceipt).toHaveBeenCalledWith(expect.objectContaining({ hash: TX }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("first visit takes two taps: create the passkey, then sign on a fresh tap", async () => {
    // loadPasskey keeps returning null (e.g. storage unavailable): the card remembers the new key.
    loadPasskey.mockReturnValue(null);
    render(<SignCard />);
    expect(screen.getByText(/First time\? Your device will create a passkey/)).toBeTruthy();
    const { user, box } = await typeMessage("hi");
    await user.click(signButton());

    // Tap 1 only creates the passkey: no sign prompt chained onto it (iOS needs a fresh gesture).
    const tap = await screen.findByRole("button", { name: "Tap to sign" });
    expect(screen.getByRole("status").textContent).toBe("Passkey ready — tap to sign");
    expect(registerPasskey).toHaveBeenCalledTimes(1);
    expect(signWithPasskey).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(box.value).toBe("hi");
    expect(screen.queryByRole("alert")).toBeNull();

    // Tap 2 signs with the passkey just created, without creating another.
    await user.click(tap);
    await screen.findByText(/Signed/);
    expect(registerPasskey).toHaveBeenCalledTimes(1);
    expect(signWithPasskey).toHaveBeenCalledTimes(1);
    expect(signWithPasskey).toHaveBeenCalledWith(PK, expect.stringMatching(/^0x[0-9a-f]{64}$/));
    expect(signButton().textContent).toBe("Sign with your passkey");
  });

  it("a returning visitor (stored passkey) still signs in one tap", async () => {
    render(<SignCard />);
    const { user } = await typeMessage("hi again");
    await user.click(signButton());
    await screen.findByText(/Signed/);
    expect(registerPasskey).not.toHaveBeenCalled();
    expect(signWithPasskey).toHaveBeenCalledTimes(1);
  });

  it("returns to idle with no error when the visitor cancels the prompt", async () => {
    signWithPasskey.mockResolvedValue({ status: "cancelled" });
    render(<SignCard />);
    expect(screen.queryByRole("button", { name: "Use a new passkey" })).toBeNull();
    const { user, box } = await typeMessage("hello");
    await user.click(signButton());
    await waitFor(() => expect(signButton()).toHaveProperty("disabled", false));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(box.value).toBe("hello");
  });

  it("offers 'Use a new passkey' after a stored passkey's prompt ends cancelled, and replaces it", async () => {
    signWithPasskey.mockResolvedValueOnce({ status: "cancelled" });
    const NEW_PK = { ...PK, credentialId: "fresh", visitorId: `0x${"77".repeat(32)}` } as const;
    registerPasskey.mockResolvedValue(NEW_PK);
    render(<SignCard />);
    const { user, box } = await typeMessage("hello");
    await user.click(signButton());
    const fresh = await screen.findByRole("button", { name: "Use a new passkey" });
    expect(screen.queryByRole("alert")).toBeNull();

    await user.click(fresh);
    // Creating the new passkey is its own tap; signing waits for the next one.
    const tap = await screen.findByRole("button", { name: "Tap to sign" });
    expect(registerPasskey).toHaveBeenCalledTimes(1);
    expect(signWithPasskey).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Use a new passkey" })).toBeNull();
    await user.click(tap);
    await screen.findByText(/Signed/);
    expect(signWithPasskey).toHaveBeenLastCalledWith(NEW_PK, expect.stringMatching(/^0x[0-9a-f]{64}$/));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).message).toBe("hello");
    expect(box.value).toBe("");
  });

  it("keeps the old passkey when creating the new one is cancelled", async () => {
    signWithPasskey.mockResolvedValueOnce({ status: "cancelled" });
    registerPasskey.mockRejectedValue(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    render(<SignCard />);
    const { user } = await typeMessage("hello");
    await user.click(signButton());
    await user.click(await screen.findByRole("button", { name: "Use a new passkey" }));
    await waitFor(() => expect(registerPasskey).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(signButton());
    await screen.findByText(/Signed/);
    expect(signWithPasskey).toHaveBeenLastCalledWith(PK, expect.anything());
  });

  it("a first-time visitor who cancels the sign prompt is not offered another new passkey", async () => {
    loadPasskey.mockReturnValue(null);
    signWithPasskey.mockResolvedValue({ status: "cancelled" });
    render(<SignCard />);
    const { user } = await typeMessage("hello");
    await user.click(signButton());
    await user.click(await screen.findByRole("button", { name: "Tap to sign" }));
    await waitFor(() => expect(signWithPasskey).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(signButton()).toHaveProperty("disabled", false));
    expect(screen.queryByRole("button", { name: "Use a new passkey" })).toBeNull();
  });

  it("returns to idle with no error when the visitor cancels passkey creation", async () => {
    loadPasskey.mockReturnValue(null);
    registerPasskey.mockRejectedValue(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    render(<SignCard />);
    const { user, box } = await typeMessage("hello");
    await user.click(signButton());
    await waitFor(() => expect(signButton()).toHaveProperty("disabled", false));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(box.value).toBe("hello");
  });

  it("keeps the typed message when the relay refuses (cooldown)", async () => {
    relayReplies(429, { error: "cooldown", retryAfter: 80_000 });
    const onOptimistic = vi.fn();
    render(<SignCard onOptimistic={onOptimistic} />);
    const { user, box } = await typeMessage("hello again");
    await user.click(signButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("You've already signed today — come back tomorrow");
    expect(box.value).toBe("hello again");
    expect(onOptimistic).not.toHaveBeenCalled();
    expect(signButton()).toHaveProperty("disabled", false);
  });

  it("formats the rate-limit wait from retryAfter", async () => {
    relayReplies(429, { error: "rateLimited", retryAfter: 3 * 3600 });
    render(<SignCard />);
    const { user, box } = await typeMessage("hello");
    await user.click(signButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Slow down a little — try again in about 3 hours");
    expect(box.value).toBe("hello");
  });

  it("shows the busy copy when the relay is unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<SignCard />);
    const { user, box } = await typeMessage("hello");
    await user.click(signButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The guestbook is busy right now — try again in a minute");
    expect(box.value).toBe("hello");
  });

  it("withdraws the optimistic entry and keeps the message if the entry is not recorded", async () => {
    waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    const undo = vi.fn();
    render(<SignCard onOptimistic={() => undo} />);
    const { user, box } = await typeMessage("hello");
    await user.click(signButton());
    await screen.findByRole("alert");
    expect(undo).toHaveBeenCalledTimes(1);
    expect(box.value).toBe("hello");
  });

  it("shows the cooldown copy when the entry reverts because another tab signed first", async () => {
    // Before prompting: not on cooldown. After the revert: the other tab's entry has landed.
    let reads = 0;
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "nonces") return 0n;
      if (functionName === "lastSignedAt") return reads++ === 0 ? 0 : NOW - 60;
      if (functionName === "COOLDOWN") return DAY;
      throw new Error(`unexpected read ${functionName}`);
    });
    waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    render(<SignCard />);
    const { user, box } = await typeMessage("hello");
    await user.click(signButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("You've already signed today — come back tomorrow");
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "lastSignedAt", args: [PK.visitorId] }),
    );
    expect(box.value).toBe("hello");
  });

  it("keeps the busy copy when the entry reverts and the visitor is not on cooldown", async () => {
    waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    render(<SignCard />);
    const { user } = await typeMessage("hello");
    await user.click(signButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The guestbook is busy right now — try again in a minute");
  });

  it("drops the first-time hint once a passkey has been created", async () => {
    loadPasskey.mockReturnValue(null);
    registerPasskey.mockImplementation(async () => {
      loadPasskey.mockReturnValue(PK); // registerPasskey stores the key
      return PK;
    });
    signWithPasskey.mockResolvedValue({ status: "cancelled" });
    render(<SignCard />);
    expect(screen.getByText(/First time\?/)).toBeTruthy();
    const { user } = await typeMessage("hello");
    await user.click(signButton());
    await screen.findByRole("button", { name: "Tap to sign" });
    expect(registerPasskey).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/First time\?/)).toBeNull();
  });

  it("drops the first-time hint when a passkey is created elsewhere (no local re-render)", () => {
    loadPasskey.mockReturnValue(null);
    render(<SignCard />);
    expect(screen.getByText(/First time\?/)).toBeTruthy();
    loadPasskey.mockReturnValue(PK);
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "hello-chain.passkey.v1" }));
    });
    expect(screen.queryByText(/First time\?/)).toBeNull();
  });
});

describe("SignCard: abuse filter before prompting", () => {
  const FILTERED = "Let's keep it friendly — links, contact details and strong language aren't allowed here.";

  it("rejects a filtered message before any passkey prompt or chain read, keeping the text", async () => {
    loadPasskey.mockReturnValue(null);
    render(<SignCard />);
    const { user, box } = await typeMessage("  visit evil.com  ");
    await user.click(signButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(FILTERED);
    expect(alert.textContent).toBe(friendlyError("filtered"));
    expect(registerPasskey).not.toHaveBeenCalled();
    expect(signWithPasskey).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
    expect(getBlock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(box.value).toBe("  visit evil.com  ");
  });

  it("rejects a filtered message before a stored passkey signs", async () => {
    render(<SignCard />);
    const { user } = await typeMessage("call me 555-123-4567");
    await user.click(signButton());
    expect((await screen.findByRole("alert")).textContent).toBe(FILTERED);
    expect(signWithPasskey).not.toHaveBeenCalled();
  });
});

describe("SignCard: cooldown before prompting", () => {
  it("does not open the passkey prompt when the visitor already signed today", async () => {
    chainState({ lastSignedAt: NOW - 2 * 3600 }); // 22 hours left
    render(<SignCard />);
    const { user, box } = await typeMessage("hello again");
    await user.click(signButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("You've already signed today — come back tomorrow");
    expect(signWithPasskey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(box.value).toBe("hello again");
  });

  it("lets the visitor sign once the cooldown has passed", async () => {
    chainState({ lastSignedAt: NOW - DAY - 1 });
    render(<SignCard />);
    const { user } = await typeMessage("hello again");
    await user.click(signButton());
    await screen.findByText(/Signed/);
    expect(signWithPasskey).toHaveBeenCalledTimes(1);
  });
});

describe("SignCard: wallet option", () => {
  const provider = { request: vi.fn().mockResolvedValue([]), on: vi.fn(), removeListener: vi.fn() };
  beforeEach(() => {
    (window as { ethereum?: unknown }).ethereum = provider;
  });
  afterEach(() => {
    delete (window as { ethereum?: unknown }).ethereum;
  });

  async function openWallet(onOptimistic?: (e: unknown) => void) {
    render(
      <Providers>
        <SignCard onOptimistic={onOptimistic} />
      </Providers>,
    );
    const { user, box } = await typeMessage("hello from a wallet");
    await user.click(screen.getByRole("button", { name: "Use a crypto wallet instead" }));
    const choice = await screen.findByRole("button", { name: "Use my browser wallet" });
    return { user, box, choice };
  }

  it("signs typed data, relays it, and pushes a lowercase visitorId", async () => {
    const onOptimistic = vi.fn();
    const { user, choice } = await openWallet(onOptimistic);
    await user.click(choice);
    await screen.findByText(/Signed/);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ kind: "wallet", author: WALLET, message: "hello from a wallet" });
    expect(onOptimistic.mock.calls[0][0]).toMatchObject({ visitorId: WALLET_VISITOR, kind: "wallet" });
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "nonces", args: [WALLET_VISITOR] }),
    );
  });

  it("checks the cooldown after connecting and before asking for a signature", async () => {
    chainState({ lastSignedAt: NOW - 23 * 3600 - 40 * 60 }); // 20 minutes left
    const { user, box, choice } = await openWallet();
    await user.click(choice);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("You've already signed today — come back in 20 minutes");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(signTypedData).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(box.value).toBe("hello from a wallet");
  });


  it("rejects a filtered message before connecting or asking the wallet to sign", async () => {
    render(
      <Providers>
        <SignCard />
      </Providers>,
    );
    const { user, box } = await typeMessage("ｅｘａｍｐｌｅ．ｃｏｍ");
    await user.click(screen.getByRole("button", { name: "Use a crypto wallet instead" }));
    await user.click(await screen.findByRole("button", { name: "Use my browser wallet" }));
    expect((await screen.findByRole("alert")).textContent).toBe(friendlyError("filtered"));
    expect(connect).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(box.value).toBe("ｅｘａｍｐｌｅ．ｃｏｍ");
  });

  it('reads "Use a crypto wallet instead" and never mentions gas or nonce', async () => {
    delete (window as { ethereum?: unknown }).ethereum;
    const { container } = render(
      <Providers>
        <SignCard />
      </Providers>,
    );
    const link = screen.getByRole("button", { name: "Use a crypto wallet instead" });
    const user = userEvent.setup();
    await user.click(link);
    // jsdom has no injected wallet: a plain sentence, not an error.
    expect(await screen.findByText(/No browser wallet found/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.textContent).not.toMatch(/\bgas\b|nonce|transaction hash/i);
  });

  // Last in this block: the announced wallet stays registered in the shared wagmi config.
  it("never names a wallet vendor, even when one announces itself (EIP-6963)", async () => {
    const { container } = render(
      <Providers>
        <SignCard />
      </Providers>,
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: Object.freeze({
            info: { uuid: "1f0c0e1a-0000-4000-8000-000000000001", name: "Acme Wallet", icon: "data:image/svg+xml,<svg/>", rdns: "com.acme" },
            provider,
          }),
        }),
      );
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Use a crypto wallet instead" }));
    expect(await screen.findByRole("button", { name: "Use my browser wallet" })).toBeTruthy();
    expect(container.textContent).not.toMatch(/Acme/);
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("friendlyError with retryAfter", () => {
  it("phrases waits in plain language", () => {
    expect(waitPhrase(30)).toBe("in a minute");
    expect(waitPhrase(60)).toBe("in a minute");
    expect(waitPhrase(5 * 60)).toBe("in 5 minutes");
    expect(waitPhrase(3600)).toBe("in about an hour");
    expect(waitPhrase(3 * 3600 + 100)).toBe("in about 3 hours");
  });
  it("keeps cooldown copy for long waits and shortens it for short ones", () => {
    expect(friendlyError("cooldown", 20 * 3600)).toBe("You've already signed today — come back tomorrow");
    expect(friendlyError("cooldown", 20 * 60)).toBe("You've already signed today — come back in 20 minutes");
    expect(friendlyError("rateLimited", 45)).toBe("Slow down a little — try again in a minute");
  });
  it("never tells a visitor on cooldown to come back in a minute when the wait is unknown or over", () => {
    const tomorrow = "You've already signed today — come back tomorrow";
    expect(friendlyError("cooldown", 0)).toBe(tomorrow);
    expect(friendlyError("cooldown", -5)).toBe(tomorrow);
    expect(friendlyError("cooldown", undefined)).toBe(tomorrow);
    expect(friendlyError("cooldown", Number.NaN)).toBe(tomorrow);
  });
});
