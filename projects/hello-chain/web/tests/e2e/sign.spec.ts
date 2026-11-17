import { expect, test as base, type Page } from "@playwright/test";

// Each test gets a fresh context (empty localStorage) and its own virtual platform authenticator,
// so it is a brand-new visitor with a brand-new passkey. Tests share the chain but not visitors,
// and each one reads the state it depends on, so they pass in any order.
const test = base.extend<{ clientIp: string; page: Page }>({
  clientIp: ["203.0.113.7", { option: true }],
  page: async ({ page, clientIp }, provide) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    // Act as the trusted reverse proxy (TRUSTED_PROXY_HEADER=x-real-ip) for relay requests only.
    // Not extraHTTPHeaders: that would also add the header to the browser's RPC calls to anvil,
    // whose CORS preflight allows only content-type.
    await page.route("**/api/relay", (route) =>
      route.continue({ headers: { ...route.request().headers(), "x-real-ip": clientIp } }),
    );
    await provide(page);
  },
});

const MESSAGE = "Hello from Playwright 👋";

const signCard = (page: Page) => page.getByRole("region", { name: "Sign the guestbook" });

function signButton(page: Page) {
  return signCard(page).getByRole("button", { name: /^Sign with (your passkey|Face ID \/ fingerprint)$/ });
}

async function readCount(page: Page): Promise<number> {
  const count = page.getByTestId("signature-count");
  await expect(count).toHaveText(/\d[\d,]* signatures?/);
  return Number((await count.innerText()).replace(/[^\d]/g, ""));
}

/** First visit: one tap creates the passkey, a second (fresh) tap signs with it. */
async function signOnce(page: Page, message: string) {
  await signCard(page).getByLabel("Your hello").fill(message);
  await signButton(page).click();
  await expect(signCard(page).getByRole("status")).toHaveText("Passkey ready — tap to sign");
  await signCard(page).getByRole("button", { name: "Tap to sign" }).click();
  await expect(signCard(page).getByRole("status")).toContainText("Signed ✓", { timeout: 45_000 });
}

test.describe("first visit", () => {
  test.use({ clientIp: "203.0.113.7" });

  test("stranger signs with a passkey and sees it live", async ({ page }) => {
    await page.goto("/");
    const before = await readCount(page);

    await signOnce(page, MESSAGE);

    const feed = page.getByRole("region", { name: "Recent signatures" });
    await expect(feed.getByText(MESSAGE, { exact: true })).toHaveCount(1);
    await expect(page.getByTestId("signature-count")).toHaveText(
      `${(before + 1).toLocaleString("en-US")} ${before + 1 === 1 ? "signature" : "signatures"}`,
    );
  });
});

test.describe("second visit", () => {
  // A different client IP: the relay allows one entry per IP per day.
  test.use({ clientIp: "203.0.113.8" });

  test("signing again the same day says come back tomorrow", async ({ page }) => {
    await page.goto("/");
    await signOnce(page, "First hello, about to try again");

    await signCard(page).getByLabel("Your hello").fill("Second hello, same day");
    await signButton(page).click();
    await expect(signCard(page).getByRole("alert")).toContainText("come back tomorrow");
  });
});
