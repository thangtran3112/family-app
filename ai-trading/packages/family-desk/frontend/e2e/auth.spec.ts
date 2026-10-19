import { expect, test } from "@playwright/test";
import { fixedNow } from "./helpers";

test("missing cookie and forged identity are rejected; app redirects once to hub login", async ({ browser }) => {
  const context = await browser.newContext();
  const direct = await context.request.get("http://127.0.0.1:18045/api/desk/strategies");
  expect(direct.status()).toBe(401);
  const forged = await context.request.get("http://127.0.0.1:18045/api/desk/strategies", {
    headers: { "Cf-Access-Authenticated-User-Email": "forged@example.test", "X-Verified-Email": "forged@example.test" },
  });
  expect(forged.status()).toBe(401);

  const page = await context.newPage();
  await page.clock.setFixedTime(fixedNow);
  await page.route("https://trading-hub.tobytran.dev/**", (route) => route.fulfill({ status: 200, body: "login intercepted" }));
  await page.goto("http://127.0.0.1:18045/");
  await expect(page).toHaveURL(/trading-hub\.tobytran\.dev\/login\?returnTo=/);
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("http://127.0.0.1:18045/");
  await context.close();
});
