import { expect, type BrowserContext, type Page } from "@playwright/test";

export const fixedNow = new Date("2026-10-16T00:00:00Z");

export async function authenticate(context: BrowserContext) {
  await context.addCookies([{ name: "desk_e2e_session", value: "1", url: "http://127.0.0.1:18045" }]);
}

export async function prepare(context: BrowserContext) {
  await authenticate(context);
  const response = await context.request.post("http://127.0.0.1:18045/api/desk/__e2e/reset");
  expect(response.ok()).toBeTruthy();
}

export async function openDesk(page: Page, path = "/") {
  await page.clock.setFixedTime(fixedNow);
  await page.goto(path);
  await expect(page.locator("main")).toBeVisible();
}

export async function api(page: Page, path: string, init?: Parameters<Page["request"]["fetch"]>[1]) {
  return page.request.fetch(`http://127.0.0.1:18045${path}`, init);
}
