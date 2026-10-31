import type { Locator, Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { HUB_SWING_COPY } from "../../lib/replay/hubSwing.ts";
import { formatBalance } from "../../lib/replay/threadView.ts";
import { expect, expectCleanScreen, openDesk, prepareDesk, test } from "./helpers";
import { origin } from "../helpers";
import { THREAD_URL, createThreadByApi, startThread, threadIdOf } from "./hub-helpers";
import { DAY_ISO, createSwingThread, enterByApi, expectNoDates, markByApi, openNextDay, send, swingRow } from "./swing-helpers";

// The thread overview (5R): a dashboard per thread, the Progress column and the row that is one stretched link.

const overviewUrl = (id: number) => `/practice/thread?id=${id}`;
const practiceDay = (page: Page) => page.getByRole("region", { name: "Practice day" });
const rows = (table: Locator) => table.getByRole("row").filter({ has: table.page().getByRole("cell") });

/** True when a table is wider than the box that holds it (a clipped column) or the page scrolls sideways. */
async function clipped(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const table of document.querySelectorAll<HTMLElement>("#main-content table")) {
      const wrap = table.parentElement!;
      if (table.scrollWidth > wrap.clientWidth + 1 || wrap.scrollWidth > wrap.clientWidth + 1) out.push(`${table.getAttribute("aria-label") ?? "table"} ${Math.max(table.scrollWidth, wrap.scrollWidth)}>${wrap.clientWidth}`);
    }
    if (document.scrollingElement!.scrollWidth > window.innerWidth) out.push("the page scrolls sideways");
    return out;
  });
}

/** A swing thread whose Week 1 has ended: Day 1 held S01 and S04 open, Days 2 to 5 ended. The next day is gated behind the Week 1 review. */
async function gatedSwingThread(context: Parameters<typeof createSwingThread>[0]): Promise<number> {
  const threadId = await createSwingThread(context, { maxOpenHolds: 5 });
  const dayOne = await openNextDay(context, threadId);
  await enterByApi(context, dayOne, { symbol: "S01", watch: ["S01", "S04"], day: DAY_ISO[0]!, stopPrice: 95 });
  await markByApi(context, dayOne, "S04", { kind: "long_entry", shares: 100 });
  await send(context, "POST", `/day-lists/${dayOne}/end`);
  for (let day = 2; day <= 5; day++) await send(context, "POST", `/day-lists/${await openNextDay(context, threadId)}/end`);
  return threadId;
}

test.describe("Practice thread overview", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("a swing thread owing its Week 1 review: the review is the one primary step, the week list, days, holds and curve are on the page, and the row has no review button", async ({ page, context }) => {
    test.setTimeout(180_000);
    const threadId = await gatedSwingThread(context);

    // The landing: one Progress column, the owed review as a chip (not a link or a button), and no Continue.
    await openDesk(page, "/practice");
    const row = swingRow(page);
    await expect(row).toContainText("Day 6 of 15");
    await expect(row).toContainText(/\d+ practiced · \d+ passed/);
    await expect(row).toContainText("Week 1 review due");
    await expect(row.getByRole("link", { name: /review/i })).toHaveCount(0);
    await expect(row.getByRole("button", { name: /^Continue Day/ })).toHaveCount(0);
    await expect(row.getByRole("link")).toHaveCount(1); // the thread's own name, stretched over the row
    await row.click({ position: { x: 8, y: 8 } });
    await page.waitForURL(overviewUrl(threadId));

    // The place strip and the next step: Week 1 review first, Day 6 behind it.
    const place = page.getByRole("region", { name: "Thread balance" });
    await expect(place).toContainText("Week 2 of 3 · Day 6 of 15");
    await expect(place).toContainText(PRACTICE_COPY.threadSimulated);
    await expect(place).toContainText("Equity $");
    await expect(place).toContainText("Free cash $");
    const next = practiceDay(page);
    await expect(next.getByRole("heading", { name: PRACTICE_COPY.overviewNext })).toBeVisible();
    await expect(next.getByRole("link", { name: "Week 1 review", exact: true })).toHaveAttribute("href", `/practice/week?thread=${threadId}&week=1`);
    await expect(next).toContainText("Week 1 is done. Review it to unlock Day 6.");
    await expect(next.getByRole("status")).toHaveCount(0); // D-085: the notice is not printed a second time under the button
    await expect(page.getByRole("button", { name: /^Continue Day|^Start Day/ })).toHaveCount(0);

    // Weeks: Week 1 owes its review (a link to it), Weeks 2 and 3 are still to come.
    const weeks = page.getByRole("table", { name: PRACTICE_COPY.overviewWeeksCaption });
    await expect(rows(weeks)).toHaveCount(3);
    await expect(rows(weeks).nth(0)).toContainText(PRACTICE_COPY.overviewWeekReview);
    await expect(rows(weeks).nth(0).getByRole("link", { name: "Week 1", exact: true })).toHaveAttribute("href", `/practice/week?thread=${threadId}&week=1`);
    await expect(rows(weeks).nth(1)).toContainText(PRACTICE_COPY.overviewWeekUpcoming);
    await expect(rows(weeks).nth(1).getByRole("link")).toHaveCount(0);
    await expect(rows(weeks).nth(2)).toContainText(PRACTICE_COPY.overviewWeekUpcoming);

    // Days: one row per ended day, the newest first, by number and weekday.
    const days = page.getByRole("table", { name: PRACTICE_COPY.overviewDaysCaption });
    await expect(rows(days)).toHaveCount(5);
    await expect(rows(days).first()).toContainText("Day 5 · Fri");
    await expect(rows(days).last()).toContainText("Day 1 · Mon");
    await expect(rows(days).first().getByRole("link", { name: "Day 5 · Fri" })).toHaveAttribute("href", /\/practice\/day\?id=\d+$/);
    await expect(rows(days).last()).toContainText(PRACTICE_COPY.overviewDayPracticed);
    await expect(rows(days).first()).toContainText(PRACTICE_COPY.overviewDaySkipped);

    // Holds: the two holds carried out of Day 1 (S01 and S04), with their count; and the curve, the plan and the stats.
    const holds = page.getByRole("table", { name: PRACTICE_COPY.overviewHoldsCaption });
    await expect(rows(holds)).toHaveCount(2);
    await expect(rows(holds).filter({ hasText: "S04" })).toContainText("Long");
    await expect(rows(holds).filter({ hasText: "S01" })).toContainText("100");
    await expect(page.getByRole("region", { name: HUB_SWING_COPY.holdsTitle })).toContainText("2 open");
    await expect(page.getByRole("link", { name: PRACTICE_COPY.overviewHoldsLink })).toHaveAttribute("href", `/practice/journal?thread=${threadId}`);
    await expect(page.getByRole("img", { name: /^Balance and equity at the close of each day/ })).toBeVisible();
    const plan = page.getByRole("region", { name: PRACTICE_COPY.overviewPlanCaption });
    await expect(plan).toContainText("Swing · 12 names");
    await expect(plan).toContainText(PRACTICE_COPY.threadSharesPerEntry);
    const stats = page.getByRole("region", { name: "Thread stats" });
    await expect(stats.getByText(PRACTICE_COPY.threadAdherence, { exact: true })).toBeVisible();
    await expect(stats).toContainText(PRACTICE_COPY.threadAdherenceMeaning);
    await expect(stats.getByRole("link", { name: PRACTICE_COPY.threadJournal })).toHaveAttribute("href", `/practice/journal?thread=${threadId}`);
    await expectNoDates(page);
    await expectCleanScreen(page);

    // The review is the way on: it opens, Start Week 2 opens Day 6, and the overview then offers Continue with Week 1 done.
    await next.getByRole("link", { name: "Week 1 review", exact: true }).click();
    await page.waitForURL(new RegExp(`/practice/week\\?thread=${threadId}&week=1`));
    await page.getByRole("button", { name: "Start Week 2" }).click();
    await page.waitForURL(/\/practice\/day\?id=\d+/);
    await openDesk(page, overviewUrl(threadId));
    await expect(practiceDay(page).getByRole("button", { name: "Continue Day 6" })).toBeVisible();
    await expect(practiceDay(page).getByRole("link", { name: /review/i })).toHaveCount(0);
    await expect(practiceDay(page)).not.toContainText("unlocks after");
    await expect(rows(weeks).nth(0)).toContainText(PRACTICE_COPY.overviewWeekDone);
    await expect(rows(weeks).nth(1)).toContainText(PRACTICE_COPY.overviewWeekCurrent);
    await expectNoDates(page);
  });

  test("a fresh swing thread: Start Day 1 is the step, every week is still ahead, and the empty sections say so", async ({ page, context }) => {
    test.setTimeout(120_000);
    const threadId = await createSwingThread(context);
    await openDesk(page, overviewUrl(threadId));
    await expect(practiceDay(page).getByRole("button", { name: "Start Day 1" })).toBeVisible();
    await expect(practiceDay(page)).not.toContainText("unlocks after");
    const weeks = page.getByRole("table", { name: PRACTICE_COPY.overviewWeeksCaption });
    await expect(rows(weeks)).toHaveCount(3);
    await expect(rows(weeks).nth(0)).toContainText(PRACTICE_COPY.overviewWeekCurrent);
    await expect(rows(weeks).nth(0).getByRole("link")).toHaveCount(0); // no day has ended, so no review to open
    await expect(page.getByText(PRACTICE_COPY.overviewDaysNone)).toBeVisible();
    await expect(page.getByRole("region", { name: HUB_SWING_COPY.holdsTitle }).getByText(PRACTICE_COPY.swingNoHoldsOpen)).toBeVisible();
    await expect(page.getByText(HUB_SWING_COPY.noDaysYet)).toBeVisible();
    await expect(page.getByRole("region", { name: "Thread balance" })).toContainText("Week 1 of 3 · Day 1 of 15");
    await expectNoDates(page);
    await expectCleanScreen(page);
  });

  test("a day thread: Resume or Start with the plan beside it above the fold, the days section and the stats", async ({ page, context }) => {
    test.setTimeout(180_000);
    await startThread(page, context, { balance: "25000" });
    const id = threadIdOf(page);
    await expect(page).toHaveURL(THREAD_URL);
    const plan = page.getByRole("region", { name: "Daily list plan" });
    await expect(plan).toContainText("Day 1 of 5", { timeout: 60_000 });
    const next = practiceDay(page);
    await expect(page.getByRole("region", { name: "Thread balance" })).toContainText(formatBalance(25_000));
    await expect(page.getByRole("region", { name: "Thread balance" })).toContainText(PRACTICE_COPY.landingProgressNone);
    // Item 8: the plan sits in view, on the same row as the step, at both widths.
    const [nextBox, planBox] = [await next.boundingBox(), await plan.boundingBox()];
    const viewport = page.viewportSize()!;
    expect(planBox!.y + planBox!.height, "the plan is above the fold").toBeLessThan(viewport.height);
    expect(Math.abs(planBox!.y - nextBox!.y), "beside the step, not under it").toBeLessThan(4);
    expect(planBox!.x).toBeGreaterThan(nextBox!.x + nextBox!.width - 4);
    // Item 9: the days section is there (no day ended yet), and the stats explain adherence.
    await expect(page.getByRole("region", { name: PRACTICE_COPY.overviewDaysTitle })).toContainText(PRACTICE_COPY.overviewDaysNone);
    await expect(page.getByRole("region", { name: "Thread stats" })).toContainText(PRACTICE_COPY.threadAdherenceNone);
    await expect(page.getByRole("link", { name: PRACTICE_COPY.threadJournal })).toHaveAttribute("href", `/practice/journal?thread=${id}`);
    await expectNoDates(page);
    await expectCleanScreen(page);
  });

  test("the grid: two columns with a 320 px side at 1440 and one column at 1180, the page using its whole region, nothing clipped", async ({ page, context }) => {
    test.setTimeout(180_000);
    const threadId = await gatedSwingThread(context);
    await openDesk(page, overviewUrl(threadId));
    await expect(page.getByRole("table", { name: PRACTICE_COPY.overviewDaysCaption })).toBeVisible();
    await expect(page.getByRole("table", { name: PRACTICE_COPY.overviewHoldsCaption })).toBeVisible();
    const wide = page.viewportSize()!.width >= 1440;
    const place = (await page.getByRole("region", { name: "Thread balance" }).boundingBox())!;
    const stats = (await page.getByRole("region", { name: "Thread stats" }).boundingBox())!;
    const planBox = (await page.getByRole("region", { name: PRACTICE_COPY.overviewPlanCaption }).boundingBox())!;
    if (wide) {
      expect(Math.round(stats.width), "the side column is 320 px").toBe(320);
      expect(stats.x).toBeGreaterThan(place.x + place.width - 4);
      expect(Math.abs(planBox.y - place.y), "the side starts level with the main column").toBeLessThan(4);
      expect(stats.x + stats.width - place.x, "the page fills its region (the old page body stopped at 860 px)").toBeGreaterThan(1000);
    } else {
      expect(Math.abs(stats.x - place.x), "one column: the side stacks under the main column").toBeLessThan(2);
      expect(stats.y).toBeGreaterThan(place.y + place.height);
      expect(planBox.y, "in the same order: the plan before the stats").toBeLessThan(stats.y);
    }
    expect(await clipped(page)).toEqual([]);
  });

  test("a thread row is one stretched link: Tab, Enter, middle click and cmd-click open the overview, the action and Delete stay their own", async ({ page, context }) => {
    const id = await createThreadByApi(context, { balance: 30_000 });
    await openDesk(page, "/practice");
    const table = page.getByRole("table", { name: PRACTICE_COPY.landingTableLabel });
    const row = table.getByRole("row", { name: /Day trading/ });
    const link = row.getByRole("link");
    await expect(link).toHaveCount(1);
    await expect(row.locator("xpath=self::tr[@role]")).toHaveCount(0); // a plain row: no role=link on <tr>

    // Hit areas: the whole row is the link; the header and the action are not.
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
    expect(await hit(table.getByRole("columnheader").first(), 6, 6), "the header is not a link").toEqual({ link: false, button: false });
    const action = row.getByRole("button", { name: PRACTICE_COPY.landingNeedsPlan });
    const deleteButton = row.getByRole("button", { name: /^Delete/ });
    for (const button of [action, deleteButton]) {
      const rect = (await button.boundingBox())!;
      const top = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest("button")?.textContent ?? null, [rect.x + rect.width / 2, rect.y + rect.height / 2]);
      expect(top, "the button is above the stretched link").toBe(await button.innerText());
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

    // Keyboard: Tab reaches the name link, then the action, then Delete; the ring is drawn round the row; Enter opens the overview.
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
    expect(order).toEqual([expect.stringMatching(/^A .*thread #\d+$/), `BUTTON ${PRACTICE_COPY.landingNeedsPlan}`, expect.stringMatching(/^BUTTON Delete/)]);
    await link.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    expect(await link.evaluate((node) => getComputedStyle(node, "::after").outlineStyle), "a visible ring on the row").toBe("solid");
    await page.keyboard.press("Enter");
    await page.waitForURL(overviewUrl(id));

    // Middle click and cmd-click are a link's own: a new tab, this page stays.
    await openDesk(page, "/practice");
    for (const open of [{ button: "middle" as const }, { modifiers: ["ControlOrMeta" as const] }]) {
      const opened = context.waitForEvent("page");
      await row.click({ position: { x: 8, y: 8 }, ...open });
      const tab = await opened;
      await tab.waitForURL(new RegExp(`${overviewUrl(id).replace("?", "\\?")}$`));
      await tab.close();
      await expect(page).toHaveURL(/\/practice$/);
    }
  });
});

// Fix wave 5S, stream 1: the thread overview.
test.describe("Practice thread overview · fix wave 5S", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("a swing thread with open holds: the week gate is said once, the weeks table has Equity change, the balance line counts the holds, and the plan reads per week (D-080..D-085)", async ({ page, context }) => {
    test.setTimeout(180_000);
    const threadId = await gatedSwingThread(context);
    await openDesk(page, overviewUrl(threadId));
    // D-085: one sentence says why Day 6 waits, and "review ready" is not printed a second time.
    const gateLine = "Week 1 is done. Review it to unlock Day 6.";
    await expect(page.getByText(gateLine)).toHaveCount(1);
    await expect(page.getByText(/Week 1 review ready/)).toHaveCount(0);
    // D-080: two holds are open, so the balance line says what is realized and what the holds add, not "no change yet".
    const place = page.getByRole("region", { name: "Thread balance" });
    await expect(place).toContainText(/Started with \$[\d,]+ · realized .* · open holds /);
    await expect(place).not.toContainText("no change yet");
    // D-081: the weeks table carries the equity change beside the realized figure.
    const weeks = page.getByRole("table", { name: PRACTICE_COPY.overviewWeeksCaption });
    await expect(weeks.getByRole("columnheader", { name: PRACTICE_COPY.landingColEquityChange })).toBeVisible();
    // D-083: a swing plan's limits count per week.
    const plan = page.getByRole("region", { name: PRACTICE_COPY.overviewPlanCaption });
    await expect(plan).toContainText("Max loss, pretend dollars a week");
    await expect(plan).toContainText("Max trades a week");
    await expect(plan).not.toContainText("a day");
    // D-082: a day she passed says "Passed" (the day page's word), never "Skipped".
    const days = page.getByRole("table", { name: PRACTICE_COPY.overviewDaysCaption });
    await expect(rows(days).first()).toContainText("Passed");
    await expect(days).not.toContainText("Skipped");

    // D-085: the ended Day 5 says the same sentence, once, beside its review link.
    await rows(days).first().getByRole("link").click();
    await page.waitForURL(/\/practice\/day\?id=\d+/);
    await expect(page.getByText(gateLine)).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Open Week 1 review" })).toBeVisible();
  });

  test("while the plan's data prepares the step card says so once: one state, a unit on the count, Replace plan waits (D-084)", async ({ page, context }) => {
    test.setTimeout(180_000);
    await startThread(page, context);
    const id = threadIdOf(page);
    await page.route(/\/api\/desk\/replay\/daily(\?|$)/, async (route) => {
      const answer = await route.fetch();
      const body = await answer.json();
      if (body.plan) Object.assign(body.plan, { current: null, days_opened: 0, prep: { state: "running", done: 2, total: 18, failed: 0 } });
      await route.fulfill({ response: answer, json: body });
    });
    await openDesk(page, overviewUrl(id));
    const step = practiceDay(page);
    await expect(step).toContainText("Preparing data · 2 of 18 names");
    await expect(step).not.toContainText("Your thread is ready");
    await expect(step).not.toContainText("Day 1 is next");
    await expect(step.getByRole("button", { name: PRACTICE_COPY.threadPageReplace })).toBeDisabled();
    // The card keeps its height when the preparation ends (it used to be 40 px shorter then).
    const preparing = (await step.boundingBox())!.height;
    await page.unroute(/\/api\/desk\/replay\/daily(\?|$)/);
    await openDesk(page, overviewUrl(id));
    await expect(step.getByRole("button", { name: /^Start Day \d+$/ })).toBeVisible({ timeout: 60_000 }); // the real prepare may still be running
    expect((await step.boundingBox())!.height).toBe(preparing);
  });
});

// Fix wave 5S, stream 1: the thread page's panels and links.
test.describe("Practice thread page · fix wave 5S", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("the plan panel is titled Plan and names the filters once; Balance is a heading; the journal link is one amber 32 px link (D-118, D-119, D-120)", async ({ page, context }) => {
    test.setTimeout(180_000);
    await startThread(page, context);
    const plan = page.getByRole("region", { name: "Daily list plan" });
    await expect(plan).toContainText("Day 1 of 5", { timeout: 60_000 });
    await expect(plan.getByRole("heading", { name: "Plan", exact: true })).toBeVisible();
    await expect(plan).not.toContainText("Armed on practice days");
    await expect(plan.getByText("Any close"), "the filters line is said once").toHaveCount(1);
    await expect(page.getByRole("heading", { level: 2, name: PRACTICE_COPY.threadBalance, exact: true })).toBeVisible();
    const journal = page.getByRole("link", { name: PRACTICE_COPY.threadJournal });
    const box = (await journal.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(32);
    await expect(journal).toHaveCSS("color", "rgb(255, 176, 32)");
  });

  test("a closed thread's card finishes its sentence and offers the journal and a new thread (D-121)", async ({ page, context }) => {
    const id = await createThreadByApi(context);
    expect((await context.request.post(`${origin}/api/desk/replay/threads/${id}/close`)).ok()).toBeTruthy();
    await openDesk(page, overviewUrl(id));
    const card = practiceDay(page);
    await expect(card).toContainText("This thread is closed. Its journal and final balance stay here.");
    await expect(card.getByRole("link", { name: PRACTICE_COPY.threadOpenJournal })).toHaveAttribute("href", `/practice/journal?thread=${id}`);
    await expect(card.getByRole("link", { name: PRACTICE_COPY.threadStartNew })).toHaveAttribute("href", "/practice");
  });

  test("a week's link in the overview is stretched over its row, like the landing's (D-122)", async ({ page, context }) => {
    test.setTimeout(180_000);
    const threadId = await gatedSwingThread(context);
    await openDesk(page, overviewUrl(threadId));
    const link = page.getByRole("table", { name: PRACTICE_COPY.overviewWeeksCaption }).getByRole("link", { name: "Week 1", exact: true });
    expect(await link.evaluate((node) => getComputedStyle(node, "::after").position)).toBe("absolute");
  });
});

// Fix wave 5S, stream 1: the week review.
test.describe("Practice week review · fix wave 5S", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("the way on and a way back sit in the header, a tile's number never wraps, and the chart key names every mark (D-086, D-087, D-088)", async ({ page, context }) => {
    test.setTimeout(180_000);
    const threadId = await gatedSwingThread(context);
    await openDesk(page, `/practice/week?thread=${threadId}&week=1`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Week 1");
    // D-088: Start Week 2 is in the first screen beside the "Final" chip, and ← Thread goes to the thread's page.
    await expect(page.getByRole("button", { name: "Start Week 2" })).toBeInViewport();
    await expect(page.getByRole("link", { name: "← Thread" })).toHaveAttribute("href", `/practice/thread?id=${threadId}`);
    // D-086: every tile value is one line inside its tile, also in a narrow tile (the grid is squeezed to about 154 px a tile, as the audit saw it).
    await page.locator("#main-content ul[role=list]").filter({ has: page.locator("[data-tone]") }).first().evaluate((list) => ((list as HTMLElement).style.width = "470px"));
    const broken = await page.locator("#main-content [data-tone]").evaluateAll((nodes) =>
      nodes.flatMap((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
        const wraps = box.height > line * 1.5;
        const spills = node.scrollWidth > node.clientWidth + 1;
        return wraps || spills ? [`${node.textContent} (${Math.round(box.width)}x${Math.round(box.height)})`] : [];
      }),
    );
    expect(broken, "a tile value wraps or spills").toEqual([]);
    expect(await page.locator("#main-content [data-tone]").count(), "the tiles are there").toBeGreaterThan(5);
    // D-087: the key lists the day-close ticks too, and "this week is shaded" is a filled block, not a box that looks ticked.
    const key = page.getByRole("list", { name: "Chart key" });
    await expect(key).toContainText("Close of each day");
    const shade = key.getByRole("listitem").filter({ hasText: "This week is shaded" }).locator("span").first();
    await expect(shade).toHaveCSS("border-top-width", "0px");
  });

  test("a day thread's week page has a heading, a full sentence and a link to the thread's page (D-089)", async ({ page, context }) => {
    const id = await createThreadByApi(context);
    await openDesk(page, `/practice/week?thread=${id}&week=1`);
    await expect(page.getByRole("heading", { level: 1, name: "Weekly review" })).toBeVisible();
    await expect(page.getByText("Weekly reviews are for swing threads. This is a day thread, so it has no weeks.")).toBeVisible();
    await expect(page.getByText("swing threads only", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Back to your thread" })).toHaveAttribute("href", `/practice/thread?id=${id}`);
  });
});
