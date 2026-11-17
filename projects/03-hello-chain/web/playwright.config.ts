import { defineConfig, devices } from "@playwright/test";
import { E2E_WEB_PORT } from "./tests/e2e/env";

// The stack (anvil :8546 + `next build` / `next start` :3100) is started in global setup, which
// also deploys the contract; see tests/e2e/global-setup.ts.
export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  // One relayer key and one chain: keep transactions sequential.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    // localhost (not 127.0.0.1) so the page origin matches NEXT_PUBLIC_RP_ID.
    baseURL: `http://localhost:${E2E_WEB_PORT}`,
    trace: "retain-on-failure",
  },
  // The virtual authenticator is driven over CDP, so chromium only.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
