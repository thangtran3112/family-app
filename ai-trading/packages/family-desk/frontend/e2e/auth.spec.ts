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
