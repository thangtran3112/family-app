import type { Locator, Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { origin } from "../helpers";
import { expect, expectCleanScreen, openDesk, prepareDesk, test } from "./helpers";
import { DAY, ET_OFFSET, createThreadByApi, expectNoDayLanguage, saveFilter, send } from "./hub-helpers";

// The thread's Summary (5R, ADR-0025): one card of the thread (equity, the next step, the clock and its controls), the results by ET date and the stats,
// and the landing's row that is one stretched link.

const summaryUrl = (id: number) => `/practice/thread?id=${id}`;
const table = (page: Page) => page.getByRole("table", { name: PRACTICE_COPY.landingTableLabel });
const rows = (page: Page) => table(page).getByRole("row", { name: /^Freestyle · / });

/** True when a table is wider than the box that holds it (a clipped column) or the page scrolls sideways. */
async function clipped(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const grid of document.querySelectorAll<HTMLElement>("#main-content table")) {
      const wrap = grid.parentElement!;
      if (grid.scrollWidth > wrap.clientWidth + 1 || wrap.scrollWidth > wrap.clientWidth + 1) out.push(`${grid.getAttribute("aria-label") ?? "table"} ${Math.max(grid.scrollWidth, wrap.scrollWidth)}>${wrap.clientWidth}`);
    }
    if (document.scrollingElement!.scrollWidth > window.innerWidth) out.push("the page scrolls sideways");
    return out;
  });
}

test.describe("Practice thread Summary", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("a thread row is one stretched link: Tab, Enter, middle click and cmd-click open the Summary, the Screen link and Delete stay their own", async ({ page, context }) => {
    const id = await createThreadByApi(context, { balance: 30_000 });
    await openDesk(page, "/practice");
    const row = rows(page).first();
    const name = row.getByRole("link", { name: /^Freestyle · / });
    await expect(row.getByRole("link"), "the name and the Screen").toHaveCount(2);
    await expect(row.locator("xpath=self::tr[@role]")).toHaveCount(0); // a plain row: no role=link on <tr>

    // Hit areas: the whole row is the name's link; the header and the Screen link and Delete are not.
    const hit = (target: Locator, dx: number, dy: number) =>
      target.evaluate(
        (node, [x, y]) => {
          const box = node.getBoundingClientRect();
          const el = document.elementFromPoint(box.left + x!, box.top + y!);
          return el ? { link: el.closest("a") !== null, button: el.closest("button") !== null } : null;
        },
        [dx, dy],
      );
    const box = (await row.boundingBox())!;
    expect(await hit(row, 6, 6), "top left of the row").toEqual({ link: true, button: false });
    expect(await hit(row, box.width / 2, box.height - 4), "bottom middle of the row").toEqual({ link: true, button: false });
    expect(await hit(table(page).getByRole("columnheader").first(), 6, 6), "the header is not a link").toEqual({ link: false, button: false });
    const screen = row.getByRole("link", { name: PRACTICE_COPY.landingOpenScreen });
    const deleteButton = row.getByRole("button", { name: /^Delete/ });
    for (const control of [screen, deleteButton]) {
      const rect = (await control.boundingBox())!;
      const top = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest("a, button")?.textContent ?? null, [rect.x + rect.width / 2, rect.y + rect.height / 2]);
      expect(top, "the control is above the stretched link").toBe(await control.innerText());
    }

    // Hover shades the row (the raised token), the overlay does not swallow it.
    await row.hover();
    const shades = await row.evaluate((node) => {
      const probe = document.createElement("div");
      probe.style.background = "var(--color-raised)";
      document.body.append(probe);
      const raised = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return [getComputedStyle(node).backgroundColor, raised];
    });
    expect(shades[0]).toBe(shades[1]);

    // Keyboard: Tab reaches the name link, then Open Screen, then Delete; the ring is drawn round the row; Enter opens the Summary.
    await page.getByRole("heading", { name: "Practice", level: 1 }).evaluate((node) => (node.setAttribute("tabindex", "-1"), node.focus()));
    const order: string[] = [];
    for (let step = 0; step < 12 && order.length < 3; step++) {
      await page.keyboard.press("Tab");
      const here = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        const inRow = el?.closest("tr[data-status]") !== null && el?.closest("tr[data-status]") !== undefined;
        return inRow ? { tag: el!.tagName, text: el!.innerText || el!.getAttribute("aria-label") || "" } : null;
      });
      if (here) order.push(`${here.tag} ${here.text}`.trim());
    }
    expect(order).toEqual([expect.stringMatching(/^A Freestyle · .+$/), `A ${PRACTICE_COPY.landingOpenScreen}`, expect.stringMatching(/^BUTTON Delete/)]);
    await name.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(name).toBeFocused();
    expect(await name.evaluate((node) => getComputedStyle(node, "::after").outlineStyle), "a visible ring on the row").toBe("solid");
    await page.keyboard.press("Enter");
    await page.waitForURL(summaryUrl(id));

    // Middle click and cmd-click are a link's own: a new tab, this page stays.
    await openDesk(page, "/practice");
    for (const open of [{ button: "middle" as const }, { modifiers: ["ControlOrMeta" as const] }]) {
      const opened = context.waitForEvent("page");
      await row.click({ position: { x: 8, y: 8 }, ...open });
      const tab = await opened;
      await tab.waitForURL(new RegExp(`${summaryUrl(id).replace("?", "\\?")}$`));
      await tab.close();
      await expect(page).toHaveURL(/\/practice$/);
    }
  });

  test("a new thread's Summary: the equity, the next step, the clock with its controls, the results by date and the stats, with nothing about a day", async ({ page, context }) => {
    const id = await createThreadByApi(context, { balance: 30_000 });
    await openDesk(page, summaryUrl(id));
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Freestyle · ");
    // The big figure is a heading: Balance until the clock is read, then Equity.
    await expect(page.getByRole("heading", { level: 2, name: /^(Balance|Equity)$/ })).toBeVisible();
    await expect(page.getByTestId("thread-balance")).toHaveText("$30,000.00");

    // The next step: the Screen, and Delete thread beside it. No Resume, no Start day, no plan to replace.
    const step = page.getByRole("region", { name: PRACTICE_COPY.overviewStepTitle });
    await expect(step.getByRole("link", { name: PRACTICE_COPY.overviewOpenScreen })).toHaveAttribute("href", `/practice/screen?thread=${id}`);
    await expect(step.getByRole("button", { name: PRACTICE_COPY.threadDeleteConfirm, exact: true })).toBeVisible();
    await expect(step).toContainText(PRACTICE_COPY.overviewStepLine);
    for (const gone of [/^Resume$/, /^Start Trading$/, /^Start day/i, /^Replace/, /^Skip day/i, /^End day/i]) {
      await expect(page.getByRole("button", { name: gone }).or(page.getByRole("link", { name: gone }))).toHaveCount(0);
    }

    // The clock: paused at the start, Play, the four speeds, Next open and Jump. Next open names the open it goes to; there is no Step and no Skip day.
    const clock = page.getByTestId("thread-clock");
    await expect(clock.getByTestId("thread-clock-time")).toHaveText("Fri 2026-09-25 · 9:30:00 AM ET");
    for (const name of ["Play", "1x", "2x", "5x", "10x"]) await expect(clock.getByRole("button", { name, exact: true })).toBeEnabled();
    const nextOpen = clock.getByTestId("thread-clock-next-open");
    await expect(nextOpen).toBeEnabled();
    await expect(nextOpen).toHaveText("Next open · Mon 2026-09-28 · 9:30 AM ET");
    await expect(clock.getByRole("button", { name: PRACTICE_COPY.clockJumpGo, exact: true }), "Jump waits for a date and a time").toBeDisabled();
    await expect(clock.getByTestId("thread-clock-stays"), "nothing is open, so nothing stays").toHaveCount(0);
    for (const gone of ["Step", "Skip day", "End day"]) await expect(clock.getByRole("button", { name: gone, exact: true })).toHaveCount(0);

    // The results by ET date start empty, and the stats count trades, not days.
    const results = page.getByRole("region", { name: PRACTICE_COPY.overviewResultsTitle });
    await expect(results).toContainText(PRACTICE_COPY.overviewResultsNone);
    const stats = page.getByRole("region", { name: "Thread stats" });
    await expect(stats).toContainText(PRACTICE_COPY.overviewStatOpen);
    for (const gone of ["Days practiced", "Days passed", "Adherence"]) await expect(stats).not.toContainText(gone);
    const journal = page.getByRole("link", { name: PRACTICE_COPY.threadJournal });
    expect((await journal.boundingBox())!.height).toBeGreaterThanOrEqual(32);
    await expect(journal).toHaveCSS("color", "rgb(255, 176, 32)");

    expect(await clipped(page), "no table is cut and the page does not scroll sideways").toEqual([]);
    await expectNoDayLanguage(page);
    await expectCleanScreen(page);
  });

  test("a closed thread's card finishes its sentence and offers the journal and a new thread, and its clock is gone (D-121)", async ({ page, context }) => {
    const id = await createThreadByApi(context);
    expect((await context.request.post(`${origin}/api/desk/replay/threads/${id}/close`)).ok()).toBeTruthy();
    await openDesk(page, summaryUrl(id));
    const card = page.getByRole("region", { name: PRACTICE_COPY.overviewStepTitle });
    await expect(card).toContainText(PRACTICE_COPY.overviewStepClosed);
    await expect(card.getByRole("link", { name: PRACTICE_COPY.threadOpenJournal })).toHaveAttribute("href", `/practice/journal?thread=${id}`);
    await expect(card.getByRole("link", { name: PRACTICE_COPY.threadStartNew })).toHaveAttribute("href", "/practice");
    await expect(page.getByTestId("thread-clock"), "a closed thread's clock has stopped: no board").toHaveCount(0);
    await expect(page.getByText(PRACTICE_COPY.threadClosedBadge, { exact: true }).first()).toBeVisible();
    await expectNoDayLanguage(page);
  });

  test("a thread made without a setup has no clock: the row, the Summary and the Screen say so, and saving a setup starts the clock paused at its start", async ({ page, context }) => {
    test.setTimeout(120_000);
    const filter = await saveFilter(context);
    const made = await send(context, "POST", "/threads", { schemaVersion: 1, mode: "day", startingBalance: 50_000, plan: { stopNoteOnEntry: "no", tradeOnlyOnSignal: "no" } });
    const id: number = made.thread.id;
    await openDesk(page, "/practice");
    const row = rows(page).first();
    await expect(row.getByTestId("thread-time")).toHaveText(PRACTICE_COPY.landingNoClock);
    await expect(row.getByRole("link", { name: PRACTICE_COPY.landingOpenScreen }), "no clock, no Screen to open").toHaveCount(0);

    await openDesk(page, summaryUrl(id));
    await expect(page.getByTestId("thread-clock")).toContainText(PRACTICE_COPY.clockNotStarted);
    await expect(page.getByRole("region", { name: PRACTICE_COPY.overviewStepTitle })).toContainText(PRACTICE_COPY.overviewStepNoClock);
    await openDesk(page, `/practice/screen?thread=${id}`);
    await expect(page.getByText(PRACTICE_COPY.screenNoSetup)).toBeVisible();
    await expect(page.getByRole("link", { name: PRACTICE_COPY.screenToSummary })).toHaveAttribute("href", summaryUrl(id));

    // The first setup starts the clock paused at `startAt`; time does not move until she moves it.
    await send(context, "PUT", `/threads/${id}/setup`, {
      schemaVersion: 2,
      startAt: `${DAY}T09:30:00${ET_OFFSET}`,
      screen: { filters: [{ id: filter }], maxList: 30 },
      setup: { interval: "1m", session: "regular", armed: [] },
    });
    await openDesk(page, summaryUrl(id));
    await expect(page.getByTestId("thread-clock-time")).toHaveText("Fri 2026-09-25 · 9:30:00 AM ET");
    await expect(page.getByTestId("thread-clock-state")).toHaveText(PRACTICE_COPY.clockStatePaused);
  });
});

test.describe("Practice · no Watchlists rail", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("the landing and the Summary have no Watchlists rail and no left column, the Screen and the journal carry no Watchlists either; Technical keeps its rail", async ({ page, context }) => {
    const id = await createThreadByApi(context);
    for (const path of ["/practice", summaryUrl(id), `/practice/screen?thread=${id}`, `/practice/journal?thread=${id}`]) {
      await openDesk(page, path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("complementary", { name: /^Watchlists/ }), path).toHaveCount(0);
      await expect(page.getByRole("tab", { name: "Watchlists", exact: true }), path).toHaveCount(0);
      await expect(page.getByText("Add symbols to start watching"), path).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Open Watchlists" }), path).toHaveCount(0);
      if (path === "/practice" || path === summaryUrl(id)) {
        const [left, center] = [await page.locator(".dk-left").boundingBox(), await page.locator("#main-content").boundingBox()];
        expect(Math.round(left!.width), `${path}: no left column`).toBe(0);
        expect(Math.round(center!.x), `${path}: the page starts at the window's left edge`).toBe(0);
      }
      await expectCleanScreen(page);
    }
    // The other modes are untouched.
    await openDesk(page, "/screener");
    await expect(page.getByRole("complementary", { name: "Watchlists and filters" })).toBeVisible();
  });
});
