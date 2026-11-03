import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { expect, openDesk, prepareDesk, test } from "./helpers";
import { createThreadByApi } from "./hub-helpers";

// D-213: a supplied id that names nothing is "not found" whether or not a thread is open; only the bare route is "not chosen". The address is never rewritten.

test.beforeEach(async ({ context }) => {
  await prepareDesk(context);
});

test("a bad id says not found and keeps the address; the bare route says not chosen (D-213)", async ({ page, context }) => {
  await createThreadByApi(context);
  for (const [path, param] of [["/practice/thread", "id"], ["/practice/screen", "thread"], ["/practice/journal", "thread"]] as const) {
    for (const bad of ["abc", "0", "", "99999"]) {
      const url = `${path}?${param}=${bad}`;
      await openDesk(page, url);
      await expect(page.getByText(PRACTICE_COPY.threadPageNotFound), url).toBeVisible();
      await expect(page.getByText(PRACTICE_COPY.threadPickTitle), `${url} is not "not chosen"`).toHaveCount(0);
      // Past the open-thread read: the address is still the one she gave.
      await page.waitForTimeout(1000);
      expect(page.url().endsWith(url), `${url} stays`).toBe(true);
    }
    // The journal's bare route goes to the Practice landing by design (JournalRoute); the other two show the picker.
    if (path === "/practice/journal") continue;
    await openDesk(page, path);
    await expect(page.getByText(PRACTICE_COPY.threadPickTitle), `${path} bare`).toBeVisible();
  }
});
