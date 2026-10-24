import { expect, type BrowserContext, type Page } from "@playwright/test";

export const fixedNow = new Date("2026-10-16T00:00:00Z");
/** The e2e proxy's origin: static export plus `/api`, with the reserved session cookie (`playwright.config.ts`). */
export const origin = `http://127.0.0.1:${process.env.DESK_E2E_PROXY_PORT ?? "18045"}`;

export async function authenticate(context: BrowserContext) {
  await context.addCookies([{ name: "desk_e2e_session", value: "1", url: origin }]);
}

/** Reset the disposable database. `seed` picks the world: `legacy` (the first specs) or a Technical one (`e2e/desk/`). */
export async function prepare(context: BrowserContext, seed = "legacy") {
  await authenticate(context);
  const response = await context.request.post(`${origin}/api/desk/__e2e/reset?seed=${seed}`);
  expect(response.ok()).toBeTruthy();
}

export async function openDesk(page: Page, path = "/") {
  await page.clock.setFixedTime(fixedNow);
  await page.goto(path);
  await expect(page.locator("main")).toBeVisible();
}

export async function api(page: Page, path: string, init?: Parameters<Page["request"]["fetch"]>[1]) {
  return page.request.fetch(`${origin}${path}`, init);
}
