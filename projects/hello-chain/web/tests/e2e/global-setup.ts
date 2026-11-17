// E2E global setup: a private anvil on :8546, the Guestbook deployed to it, and a production build of
// the app served by `next start` on :3100. It never touches the developer's own anvil (:8545) or
// `next dev` (:3000). Returns the teardown, which stops both processes it started.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { E2E_ENV, E2E_RPC_PORT, E2E_WEB_PORT } from "./env";

const web = resolve(__dirname, "../..");
const contracts = resolve(web, "../contracts");
const foundryBin = join(homedir(), ".foundry/bin");
const PATH = `${foundryBin}:${process.env.PATH ?? ""}`;

// Anvil's well-known dev key #0: a fresh chain + this key at nonce 0 reproduces the committed
// deployment address. Public test key; it only ever holds value on a local anvil.
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const DEPLOYER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// Deploy.s.sol reads OWNER and COOLDOWN (forge also loads contracts/.env, but never overrides a variable
// that is already set). Pin both so an ambient shell or .env cannot change the deployment under test.
const DEPLOY_ENV: NodeJS.ProcessEnv = { ...process.env, OWNER: DEPLOYER_ADDRESS, COOLDOWN: "86400" };

// Files the deploy + sync steps rewrite. They must come out byte-identical to what is committed.
const TRACKED = [join(contracts, "deployments/31337.json"), join(web, "src/lib/contract.ts")];

function assertPortFree(port: number): Promise<void> {
  return new Promise((ok, fail) => {
    const srv = createServer()
      .once("error", () => fail(new Error(`[e2e] port ${port} is already in use; refusing to reuse it`)))
      .once("listening", () => srv.close(() => ok()))
      .listen(port, "127.0.0.1");
  });
}

async function waitFor(what: string, probe: () => Promise<boolean>, timeoutMs: number, child: ChildProcess) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`[e2e] ${what} exited early with code ${child.exitCode}`);
    if (await probe().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`[e2e] timed out waiting for ${what}`);
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(cmd, args, { cwd, env: { ...env, PATH }, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`[e2e] \`${cmd} ${args.join(" ")}\` failed (exit ${r.status})`);
}

function kill(child: ChildProcess | undefined) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM"); // whole process group (next start may fork)
  } catch {
    child.kill("SIGTERM");
  }
}

export default async function globalSetup() {
  await assertPortFree(E2E_RPC_PORT);
  await assertPortFree(E2E_WEB_PORT);

  const originals = TRACKED.map((f) => readFileSync(f));
  let anvil: ChildProcess | undefined;
  let app: ChildProcess | undefined;

  try {
    anvil = spawn("anvil", ["--port", String(E2E_RPC_PORT), "--silent"], {
      env: { ...process.env, PATH },
      stdio: "ignore",
      detached: true,
    });
    await waitFor(
      "anvil",
      async () => {
        const res = await fetch(E2E_ENV.RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        });
        return res.ok;
      },
      15_000,
      anvil,
    );

    run(
      "forge",
      ["script", "script/Deploy.s.sol", "--rpc-url", E2E_ENV.RPC_URL, "--broadcast", "--private-key", DEPLOYER_KEY],
      contracts,
      DEPLOY_ENV,
    );
    run("node", ["scripts/sync-contract.mjs"], web);

    // Same chain id, deployer and nonce → same address and block. If anything drifted, put the
    // committed files back and stop: an altered deployment must never be left behind.
    const drifted = TRACKED.filter((f, i) => !readFileSync(f).equals(originals[i]));
    if (drifted.length) {
      TRACKED.forEach((f, i) => writeFileSync(f, originals[i]));
      throw new Error(`[e2e] deploy/sync changed tracked files (restored): ${drifted.join(", ")}`);
    }

    // Explicit env wins over .env.local (Next never overrides variables already set).
    const appEnv = { ...process.env, ...E2E_ENV };
    run("node", ["node_modules/next/dist/bin/next", "build"], web, appEnv);

    app = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", String(E2E_WEB_PORT)], {
      cwd: web,
      env: appEnv,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    });
    await waitFor("next start", async () => (await fetch(`http://localhost:${E2E_WEB_PORT}/`)).ok, 60_000, app);
  } catch (err) {
    kill(app);
    kill(anvil);
    TRACKED.forEach((f, i) => {
      if (!readFileSync(f).equals(originals[i])) writeFileSync(f, originals[i]);
    });
    throw err;
  }

  return async () => {
    kill(app);
    kill(anvil);
  };
}
