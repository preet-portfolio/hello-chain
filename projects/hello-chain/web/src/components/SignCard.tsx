"use client";

import { useId, useRef, useState, useSyncExternalStore } from "react";
import type { Address, Hex } from "viem";
import { connect, getConnection, signTypedData, switchChain } from "wagmi/actions";
import { useConfig, useConnectors, type Connector } from "wagmi";
import { activeChain } from "@/lib/chain";
import type { FeedEntry } from "@/lib/feed";
import { isAbusive } from "@/lib/filter";
import { MAX_MESSAGE_BYTES, utf8ByteLength, validateMessage } from "@/lib/message";
import {
  loadPasskey,
  PASSKEY_STORAGE_KEY,
  registerPasskey,
  signWithPasskey,
  type StoredPasskey,
} from "@/lib/passkey";
import { friendlyError } from "@/lib/relay/errors";
import { toWireAuth, type RelayRequest } from "@/lib/relay/types";
import {
  cooldownMessage,
  entryDigest,
  entryRecorded,
  entryTypedData,
  isUserRejection,
  postRelay,
  proofUrl,
  signLabel,
  VisitorError,
} from "@/lib/signing";
import { walletVisitorId } from "@/lib/relay/validate";
import { useOptimisticSink } from "./GuestbookProvider";

type Via = "passkey" | "wallet";

type Phase =
  | { name: "idle"; offerNewPasskey?: boolean }
  // A passkey was just created; signing waits for a fresh tap (iOS may refuse a get() chained onto create()).
  | { name: "ready" }
  | { name: "confirming"; via: Via }
  | { name: "submitting" }
  | { name: "signed"; proof: string | null }
  | { name: "error"; message: string };

/** What a flow hands back once the visitor has signed: the relay body and who signed. */
type Prepared = { request: RelayRequest; visitorId: Hex };
const CANCELLED = "cancelled" as const;
/** A stored passkey's prompt ended cancelled: it may be gone from the device, so offer a new one. */
const STORED_CANCELLED = "storedCancelled" as const;
/** A passkey was created; the visitor taps again to sign. */
const PASSKEY_READY = "passkeyReady" as const;
type PrepareResult = Prepared | typeof CANCELLED | typeof STORED_CANCELLED | typeof PASSKEY_READY;
type Prepare = (message: string) => Promise<PrepareResult>;

const PASSKEY_UNAVAILABLE = "This device couldn't use a passkey here — try a crypto wallet instead";
const WALLET_UNAVAILABLE = "Your wallet couldn't connect to the guestbook — try the passkey button instead";
const WALLET_SIGN_FAILED = "Your wallet couldn't sign that — please try again";

let nextPlaceholderId = -1n;

const noSubscribe = () => () => {};

// "Does this browser hold a passkey?" as an external store: re-read when this tab registers one
// and when another tab changes it (storage event), so the first-time hint never goes stale.
const passkeyListeners = new Set<() => void>();
const notifyPasskeyChanged = () => passkeyListeners.forEach((l) => l());
function subscribePasskey(onChange: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === PASSKEY_STORAGE_KEY) onChange();
  };
  passkeyListeners.add(onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    passkeyListeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Creates a passkey (and stores it). Null if the visitor dismissed the prompt. */
async function createPasskey(): Promise<StoredPasskey | null> {
  try {
    const pk = await registerPasskey();
    notifyPasskeyChanged();
    return pk;
  } catch (err) {
    // registerPasskey surfaces a dismissed creation prompt as NotAllowedError.
    if ((err as { name?: string } | null)?.name === "NotAllowedError") return null;
    throw new VisitorError(PASSKEY_UNAVAILABLE);
  }
}

/**
 * Passkey flow. A first-time visitor's tap only creates the passkey (→ PASSKEY_READY); the next tap
 * signs. Chaining navigator.credentials.get() straight onto create() without a fresh user gesture can
 * be refused silently on iOS Safari. `created` holds a passkey made in this session, so signing works
 * even when storage is unavailable.
 */
async function preparePasskey(
  message: string,
  created: { current: StoredPasskey | null },
): Promise<PrepareResult> {
  const stored = created.current ? null : loadPasskey();
  const pk = created.current ?? stored;
  if (!pk) {
    const fresh = await createPasskey();
    if (!fresh) return CANCELLED;
    created.current = fresh;
    return PASSKEY_READY;
  }
  const td = await entryTypedData(pk.visitorId, message);
  let result: Awaited<ReturnType<typeof signWithPasskey>>;
  try {
    result = await signWithPasskey(pk, entryDigest(td));
  } catch {
    throw new VisitorError(PASSKEY_UNAVAILABLE);
  }
  if (result.status === "cancelled") return stored ? STORED_CANCELLED : CANCELLED;
  return {
    visitorId: pk.visitorId,
    request: {
      kind: "passkey",
      qx: pk.qx,
      qy: pk.qy,
      message,
      deadline: td.message.deadline.toString(),
      auth: toWireAuth(result.auth),
    },
  };
}

export function SignCard({ onOptimistic }: { onOptimistic?: (entry: FeedEntry) => (() => void) | void }) {
  const sink = useOptimisticSink();
  const push = onOptimistic ?? sink;
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const label = useSyncExternalStore(noSubscribe, () => signLabel(navigator.userAgent), () => "Sign with your passkey");
  const hasPasskey = useSyncExternalStore(subscribePasskey, () => loadPasskey() !== null, () => true);
  const inputId = useId();
  // A passkey created in this session (first visit or "Use a new passkey"); preferred over storage.
  const created = useRef<StoredPasskey | null>(null);

  const remaining = MAX_MESSAGE_BYTES - utf8ByteLength(text);
  const valid = validateMessage(text).ok;
  const busy = phase.name === "confirming" || phase.name === "submitting";

  async function run(via: Via, prepare: Prepare) {
    const v = validateMessage(text);
    if (!v.ok || busy) return;
    const message = v.value;
    // Same filter as the relay, before any prompt or chain read: never ask for Face ID to then refuse.
    if (isAbusive(message).abusive) {
      setPhase({ name: "error", message: friendlyError("filtered") });
      return;
    }
    setPhase({ name: "confirming", via });

    let prepared: PrepareResult;
    try {
      prepared = await prepare(message);
    } catch (err) {
      setPhase({ name: "error", message: err instanceof VisitorError ? err.message : friendlyError("busy") });
      return;
    }
    if (prepared === CANCELLED || prepared === STORED_CANCELLED) {
      setPhase({ name: "idle", offerNewPasskey: prepared === STORED_CANCELLED });
      return;
    }
    if (prepared === PASSKEY_READY) {
      setPhase({ name: "ready" });
      return;
    }

    setPhase({ name: "submitting" });
    const relayed = await postRelay(prepared.request);
    if (!relayed.ok) {
      setPhase({ name: "error", message: relayed.message });
      return;
    }
    const undo = push?.({
      id: nextPlaceholderId--,
      visitorId: prepared.visitorId,
      timestamp: Math.floor(Date.now() / 1000),
      kind: via,
      message,
    });
    if (!(await entryRecorded(relayed.txHash))) {
      undo?.();
      // Most likely a race the relay's simulation couldn't see (e.g. another tab signed first and
      // this one hit CooldownActive): say so plainly when the chain now shows a cooldown.
      const cooldown = await cooldownMessage(prepared.visitorId).catch(() => null);
      setPhase({ name: "error", message: cooldown ?? friendlyError("busy") });
      return;
    }
    setText("");
    setPhase({ name: "signed", proof: proofUrl(relayed.txHash) });
  }

  // The stored passkey's prompt was dismissed or failed (often: it no longer exists on this device).
  async function replacePasskey() {
    if (busy) return;
    setPhase({ name: "confirming", via: "passkey" });
    try {
      const fresh = await createPasskey(); // stores it, replacing the old one
      if (!fresh) {
        setPhase({ name: "idle", offerNewPasskey: true });
        return;
      }
      created.current = fresh;
      setPhase({ name: "ready" });
    } catch (err) {
      setPhase({ name: "error", message: err instanceof VisitorError ? err.message : friendlyError("busy") });
    }
  }

  return (
    <section
      aria-label="Sign the guestbook"
      className="rise rise-3 mb-16 rounded-3xl border border-line bg-surface p-5 shadow-card sm:p-7"
    >
      <label htmlFor={inputId} className="block text-sm font-semibold">
        Your hello
      </label>
      <textarea
        id={inputId}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (phase.name === "error" || phase.name === "signed") setPhase({ name: "idle" });
        }}
        disabled={busy}
        rows={3}
        placeholder="Say hi to everyone who comes after you…"
        className="mt-2 w-full resize-none rounded-xl border border-line-strong bg-paper p-3.5 text-base leading-relaxed placeholder:text-muted focus:border-accent disabled:opacity-60"
      />
      <div className="mt-1 flex justify-end">
        <span
          data-testid="byte-counter"
          aria-live="polite"
          aria-label={`${remaining} left`}
          className={`text-xs tabular-nums ${remaining < 0 ? "text-danger" : "text-muted"}`}
        >
          {remaining}
        </span>
      </div>

      <button
        type="button"
        onClick={() => run("passkey", (message) => preparePasskey(message, created))}
        disabled={!valid || busy}
        className="mt-3 w-full rounded-full bg-accent px-5 py-3.5 text-base font-semibold text-accent-ink transition-[filter,transform] hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100"
      >
        {phase.name === "ready" ? "Tap to sign" : label}
      </button>
      {!hasPasskey && phase.name === "idle" && (
        <p className="mt-2 text-center text-xs text-muted">
          First time? Your device will create a passkey — nothing to install, nothing to pay.
        </p>
      )}

      {phase.name === "idle" && phase.offerNewPasskey && (
        <p className="mt-2 text-center">
          <button
            type="button"
            onClick={replacePasskey}
            className="text-xs text-muted underline decoration-line-strong underline-offset-4 hover:text-ink"
          >
            Use a new passkey
          </button>
        </p>
      )}

      <Status phase={phase} />

      <WalletOption disabled={!valid || busy} onSign={(prepare) => run("wallet", prepare)} />
    </section>
  );
}

function Status({ phase }: { phase: Phase }) {
  if (phase.name === "ready") {
    return (
      <p role="status" className="mt-3 text-center text-sm text-muted">
        Passkey ready — tap to sign
      </p>
    );
  }
  if (phase.name === "confirming") {
    return (
      <p role="status" className="mt-3 text-center text-sm text-muted">
        {phase.via === "passkey" ? "Confirm on your device…" : "Confirm in your wallet…"}
      </p>
    );
  }
  if (phase.name === "submitting") {
    return (
      <p role="status" className="mt-3 text-center text-sm text-muted">
        Writing it to the blockchain…
      </p>
    );
  }
  if (phase.name === "signed") {
    return (
      <p role="status" className="mt-3 text-center text-sm font-medium text-ok">
        Signed ✓ Your hello is in the guestbook for good.
        {phase.proof && (
          <>
            {" "}
            <a href={phase.proof} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              View proof
            </a>
          </>
        )}
      </p>
    );
  }
  if (phase.name === "error") {
    return (
      <p role="alert" className="mt-3 text-center text-sm text-danger">
        {phase.message}
      </p>
    );
  }
  return null;
}

function WalletOption({ disabled, onSign }: { disabled: boolean; onSign: (prepare: Prepare) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4 text-center">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="text-sm text-muted underline decoration-line-strong underline-offset-4 hover:text-ink"
      >
        Use a crypto wallet instead
      </button>
      {open && <WalletChoices disabled={disabled} onSign={onSign} />}
    </div>
  );
}

// Rendered only once opened, so wagmi is touched only by visitors who ask for a wallet.
function WalletChoices({ disabled, onSign }: { disabled: boolean; onSign: (prepare: Prepare) => void }) {
  const config = useConfig();
  const connectors = useConnectors();
  const hasInjected = useSyncExternalStore(
    noSubscribe,
    () => Boolean((window as { ethereum?: unknown }).ethereum),
    () => false,
  );
  // Wallets announced via EIP-6963 take precedence; the generic connector covers the rest.
  const announced = connectors.filter((c) => c.id !== "injected");
  const choices = announced.length > 0 ? announced : hasInjected ? connectors.filter((c) => c.id === "injected") : [];

  if (choices.length === 0) {
    return (
      <p className="mt-3 text-sm text-muted">
        No browser wallet found on this device — the button above works without one.
      </p>
    );
  }

  const prepareWith =
    (connector: Connector): Prepare =>
    async (message) => {
      let author: Address;
      try {
        const conn = getConnection(config);
        if (conn.status === "connected" && conn.connector?.uid === connector.uid && conn.address) {
          author = conn.address;
        } else {
          author = (await connect(config, { connector })).accounts[0];
        }
        if (getConnection(config).chainId !== activeChain.id) {
          await switchChain(config, { chainId: activeChain.id });
        }
      } catch (err) {
        if (isUserRejection(err)) return CANCELLED;
        throw new VisitorError(WALLET_UNAVAILABLE);
      }
      const visitorId = walletVisitorId(author);
      const td = await entryTypedData(visitorId, message);
      let signature: Hex;
      try {
        signature = await signTypedData(config, { ...td, account: author, connector });
      } catch (err) {
        if (isUserRejection(err)) return CANCELLED;
        throw new VisitorError(WALLET_SIGN_FAILED);
      }
      return {
        visitorId,
        request: { kind: "wallet", author, message, deadline: td.message.deadline.toString(), signature },
      };
    };

  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs text-muted">
        Your wallet will ask you to sign a message. It&apos;s free — nothing leaves your wallet.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {choices.map((c, i) => (
          <button
            key={c.uid}
            type="button"
            disabled={disabled}
            onClick={() => onSign(prepareWith(c))}
            className="rounded-full border border-line-strong px-4 py-2 text-sm font-medium hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {/* Neutral labels only: no wallet-vendor names in the visitor flow. */}
            {choices.length === 1 ? "Use my browser wallet" : `Use browser wallet ${i + 1}`}
          </button>
        ))}
      </div>
    </div>
  );
}
