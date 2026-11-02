import type { Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { origin } from "../helpers";
import { jumpFromSummary } from "./clock-helpers";
import { expect, expectCleanScreen, openDesk, prepareDesk, test } from "./helpers";
import { START_BUTTON, THREAD_URL, fillNewPlan, openFirstDay, openNewPlan, saveFilter, startThread, threadIdOf } from "./hub-helpers";
import { openNextDay, railSection, send } from "./swing-helpers";

// ADR-0023: a day runs open to open, so there is no End day; the Summary's Jump moves the thread clock to a date and time (New York time),
// forward only and no later than the plan's end; a day that opens at 9:30 before its list time shows when the list comes out, with nothing to
// open; and closing or deleting a day thread mid-plan needs no "end the day first" step. The stub day is TSLA on Fri 2026-09-25 (bars 9:30 to
// 9:40); a 5-day plan on it runs to the open of Fri 2026-10-02, 9:30 AM ET.

const readout = (page: Page) => page.getByTestId("thread-clock-time");
const jumpForm = (page: Page) => page.getByRole("group", { name: PRACTICE_COPY.clockJump });
const clockUrl = (threadId: number) => `${origin}/api/desk/replay/threads/${threadId}/clock`;

test.describe("Practice: Jump, the list that is not out yet, and closing mid-plan (ADR-0023)", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("Jump moves the clock to a date and time, forward only and no later than the plan's end, and there is no End day", async ({ page, context }) => {
    test.setTimeout(240_000);
    const threadId = await startThread(page, context);
    await openFirstDay(page);
    await openDesk(page, `/practice/thread?id=${threadId}`);
    await expect(page.getByRole("button", { name: /^End day/ }), "no End day (ADR-0023)").toHaveCount(0);
    const jump = jumpForm(page);
    const go = jump.getByRole("button", { name: PRACTICE_COPY.clockJumpGo, exact: true });
    const date = jump.getByLabel(PRACTICE_COPY.clockJumpDate);
    const time = jump.getByLabel(PRACTICE_COPY.clockJumpTime);
    await expect(go, "nothing typed: nothing to send").toBeDisabled();
    const before = await (await context.request.get(clockUrl(threadId))).json();
    expect(before.jump_limit, "the plan's end is the latest time the clock can be jumped to").not.toBeNull();
    await expect(jump, "the hint names the latest time").toContainText("Forward only, up to");

    // A time that is not ahead of the clock cannot be sent, and the form says why.
    await date.fill("2026-09-25");
    await time.fill("08:00");
    await expect(jump.getByRole("alert")).toContainText(PRACTICE_COPY.clockJumpBack);
    await expect(go).toBeDisabled();
    // Nor can one past the plan's end.
    await date.fill("2026-12-31");
    await time.fill("10:00");
    await expect(jump.getByRole("alert")).toContainText("The plan ends");
    await expect(go).toBeDisabled();

    // Forward, the same day: the clock reads it, stays paused, and the form is clear again.
    await jumpFromSummary(page, "2026-09-25", "11:00");
    await expect(readout(page)).toHaveText(/^Fri 2026-09-25 · 11:00:\d{2} AM ET$/, { timeout: 15_000 });
    const jumped = await (await context.request.get(clockUrl(threadId))).json();
    expect(jumped.state).toBe("paused");
    expect(Date.parse(jumped.clock)).toBe(Date.parse("2026-09-25T15:00:00Z")); // 11:00 AM ET is 15:00 UTC in September
    await expect(date).toHaveValue("");
    await expect(time).toHaveValue("");
    await expect(jump.getByRole("status")).toContainText("Jumped to");

    // Across a market open: Day 1 ends at the hand-over, and the clock stands on the new day.
    await jumpFromSummary(page, "2026-09-28", "10:00");
    await expect(page.getByTestId("thread-clock-rolled")).toContainText(/^The clock reached the next session\. Day 1 ended/, { timeout: 60_000 });
    await expect(readout(page)).toHaveText(/^Mon 2026-09-28 · 10:00:\d{2} AM ET$/);
    expect((await (await context.request.get(clockUrl(threadId))).json()).day_no).toBe(2);
    await expectCleanScreen(page);
  });

  test("a day that opens before its list time says when the list comes out: nothing to open, peek or star, and the list shows once the clock gets there", async ({ page, context }) => {
    test.setTimeout(300_000);
    await saveFilter(context);
    const dialog = await openNewPlan(page);
    await fillNewPlan(dialog, { listAt: "10:00" });
    await dialog.getByRole("button", { name: START_BUTTON }).click();
    await page.waitForURL(THREAD_URL, { timeout: 90_000 });
    const threadId = threadIdOf(page);
    await openFirstDay(page);

    // Day 1 begins at the plan's Start at (10:00, with its list); Skip day opens Day 2 at the open, 9:30, half an hour before its list.
    await send(context, "POST", `/threads/${threadId}/skip-day`);
    const dayTwo = await openNextDay(context, threadId);
    await openDesk(page, `/practice/day?id=${dayTwo}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Day 2 of 5");
    const pending = page.getByTestId("list-pending");
    await expect(pending).toContainText("The list comes out at Mon 2026-09-28 · 10:00 AM ET");
    await expect(pending).toContainText(PRACTICE_COPY.dayListPendingHint);
    await expect(pending.getByRole("link", { name: PRACTICE_COPY.dayListPendingSummary })).toHaveAttribute("href", `/practice/thread?id=${threadId}`);
    await expect(page.getByRole("table", { name: "Candidates" }), "no table of names, so no empty one").toHaveCount(0);
    await expect(page.getByText(PRACTICE_COPY.dayNoMatchTitle), "not an empty list: the list is not out").toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(Open|Peek at) / })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /star/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: PRACTICE_COPY.dayRescan }), "no re-scan before there is a list").toHaveCount(0);
    await expect(page.getByLabel("Status")).toContainText("List comes out 10:00 AM ET");
    await expect(page.getByTestId("day-clock-time")).toContainText(/Mon 2026-09-28 · 9:3\d:\d{2} AM ET/);
    await expectCleanScreen(page);

    // The server refuses to open a name before the list is out.
    const refused = await context.request.post(`${origin}/api/desk/replay/day-lists/${dayTwo}/sessions`, { data: { symbol: "TSLA" } });
    expect(refused.status()).toBe(409);
    expect(await refused.text()).toContain("The list comes out at");

    // The clock gets to 10:00 while this screen is open: the screen reads the list again on its own.
    const reached = await context.request.post(clockUrl(threadId), { data: { to: "2026-09-28T14:00:00Z" } }); // 10:00 AM ET (EDT)
    expect(reached.ok(), await reached.text()).toBeTruthy();
    await expect(pending).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText(PRACTICE_COPY.dayNoMatchTitle), "the stub holds no bars for Day 2: its list is out, and empty").toBeVisible();
    await expect(page.getByLabel("Status")).toContainText("List built 10:00 AM ET");
  });

  test("a day thread is closed mid-plan without ending its day first, and the open day ends with it", async ({ page, context }) => {
    test.setTimeout(240_000);
    const threadId = await startThread(page, context);
    await openFirstDay(page);
    await openDesk(page, `/practice/journal?thread=${threadId}`);
    const closing = await railSection(page, "Thread details", PRACTICE_COPY.threadClose);
    await expect(closing).toContainText(PRACTICE_COPY.threadCloseEndsDay);
    await closing.getByRole("button", { name: PRACTICE_COPY.threadClose, exact: true }).click();
    await closing.getByRole("group", { name: "Confirm closing the thread" }).getByRole("button", { name: PRACTICE_COPY.threadCloseConfirm }).click();
    await expect(page.getByRole("status").filter({ hasText: "This thread is closed" })).toBeVisible();
    await expect(closing.getByRole("alert")).toHaveCount(0);
    const thread = await (await context.request.get(`${origin}/api/desk/replay/threads/${threadId}`)).json();
    expect(thread.thread.status).toBe("closed");
    expect(thread.daily.map((day: { n: number }) => day.n), "the open day ended with the thread, so it is in the journal").toEqual([1]);
  });

  test("Delete plan on a day thread with its day open needs no End day: it closes the thread and removes it", async ({ page, context }) => {
    test.setTimeout(240_000);
    const threadId = await startThread(page, context);
    await openFirstDay(page);
    await openDesk(page, `/practice/thread?id=${threadId}`);
    const step = page.getByRole("region", { name: "Practice day" });
    await step.getByRole("button", { name: PRACTICE_COPY.planDelete, exact: true }).click();
    await page.getByRole("dialog", { name: /^Delete / }).getByRole("button", { name: PRACTICE_COPY.planDeleteConfirm }).click();
    await page.waitForURL("**/practice");
    expect((await context.request.get(`${origin}/api/desk/replay/threads/${threadId}`)).status()).toBe(404);
  });
});
