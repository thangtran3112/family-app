import { expect, test } from "@playwright/test";
import { fixedNow, origin } from "./helpers";

test("missing cookie and forged identity are rejected; app redirects once to hub login", async ({ browser }) => {
  const context = await browser.newContext();
  const direct = await context.request.get(`${origin}/api/desk/strategies`);
  expect(direct.status()).toBe(401);
  const forged = await context.request.get(`${origin}/api/desk/strategies`, {
    headers: { "Cf-Access-Authenticated-User-Email": "forged-principal", "X-Verified-Email": "forged-principal" },
  });
  expect(forged.status()).toBe(401);

  const page = await context.newPage();
  await page.clock.setFixedTime(fixedNow);
  await page.route("https://trading-hub.tobytran.dev/**", (route) => route.fulfill({ status: 200, body: "login intercepted" }));
  await page.goto(`${origin}/`);
  await expect(page).toHaveURL(/trading-hub\.tobytran\.dev\/login\?returnTo=/);
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(`${origin}/`);
  await context.close();
});

// Production sign-in for the dedicated Clerk test user (email + password), alongside Google. Not part of the local
// suite: it hits the real hub and Desk, so it only runs through `pnpm test:e2e:prod` (`playwright.prod.config.ts`).
// FAMILY_DESK_TEST_USERNAME and FAMILY_DESK_TEST_PASSWORD come from ai-trading/temp/.env; export them without printing
// them and never hardcode them. The prod config turns traces off (they record typed values) and marks the run, so the
// default config, which keeps traces on failure, never runs this spec.
const deskOrigin = "https://trading.tobytran.dev";
const hubOrigin = "https://trading-hub.tobytran.dev";
const testUsername = process.env.FAMILY_DESK_TEST_USERNAME;
const testPassword = process.env.FAMILY_DESK_TEST_PASSWORD;

test.describe("production test user", () => {
  test.skip(!testUsername || !testPassword, "FAMILY_DESK_TEST_USERNAME / FAMILY_DESK_TEST_PASSWORD are not set");
  test.beforeEach(({}, testInfo) => {
    test.skip(!testInfo.config.metadata.production, "run it through `pnpm test:e2e:prod`");
  });

  test("password sign-in reaches the Desk API, Google stays offered, sign-out is unauthenticated", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const watchlists = () => context.request.get(`${deskOrigin}/api/desk/watchlists`);

    await page.goto(`${deskOrigin}/`);
    await expect(page).toHaveURL(/trading-hub\.tobytran\.dev\/login\?returnTo=/, { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    expect((await watchlists()).status()).toBe(401);

    await page.getByLabel("Email address").fill(testUsername!);
    await page.locator("input[name=password]").fill(testPassword!);
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    // Clerk can stop a password sign-in on an extra step; name the dashboard setting instead of timing out.
    const blocked = page.getByText(/Check your email|Setup your organization/).first();
    await Promise.race([
      page.waitForURL(`${deskOrigin}/**`, { timeout: 45_000 }).catch(() => undefined),
      blocked.waitFor({ timeout: 45_000 }).catch(() => undefined),
    ]);
    await expect(
      blocked,
      '"Check your email" = Clerk Client Trust (new-device verification) is on; "Setup your organization" = the instance requires organization membership',
    ).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`^${deskOrigin}/`));
    expect((await watchlists()).status()).toBe(200);

    await page.goto(`${hubOrigin}/`);
    await page.getByRole("button", { name: "Account" }).first().click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible({ timeout: 30_000 });
    expect((await watchlists()).status()).toBe(401);
    await context.close();
  });
});
