import { expect, test } from "@playwright/test";
import { api, openDesk, prepare } from "./helpers";

test.beforeEach(async ({ context }) => prepare(context));

test("settings PUT persists, preserves unknown keys, and saves single-flight", async ({ page }) => {
  let putCount = 0;
  let releaseFirstPut!: () => void;
  const firstPutBlocked = new Promise<void>((resolve) => { releaseFirstPut = resolve; });
  await page.route("**/api/desk/settings", async (route, request) => {
    if (request.method() === "PUT") {
      putCount += 1;
      await firstPutBlocked;
      await route.continue();
    } else await route.continue();
  });
  await openDesk(page, "/settings");
  await page.getByLabel("Start").fill("21:30");
  await expect.poll(() => putCount).toBe(1);
  await expect(page.getByRole("checkbox", { name: "Slack" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "Slack" }).click({ force: true });
  expect(putCount).toBe(1);
  releaseFirstPut();
  await expect(page.getByText("Saved")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Start")).toHaveValue("21:30");
  const saved = await (await api(page, "/api/desk/settings")).json();
  expect(saved.settings.e2e_unknown).toEqual({ keep: true });
  expect(putCount).toBe(1);
});
