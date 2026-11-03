import type { Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { origin } from "../helpers";
import { jumpFromSummary, nextOpenFromSummary } from "./clock-helpers";
import { expect, expectCleanScreen, openDesk, prepareDesk, test } from "./helpers";
import { DAY, createThreadByApi, expectNoDayLanguage, get, jumpByApi, playByApi, railSection } from "./hub-helpers";

// Jump and Next open (ADR-0025): the Summary moves the thread clock to a date and time (New York time) or to the next 9:30 open, forward only and no later than
// the horizon (the latest time the data reaches). Nothing a move crosses ends, closes or resets anything, so there is no End day and no Skip day. The
// stub day is TSLA on Fri 2026-09-25; the horizon on the E2E clock (Thu 2026-10-15, 8:00 PM ET) is the extended close of Wed 2026-10-14.

const readout = (page: Page) => page.getByTestId("thread-clock-time");
const jumpForm = (page: Page) => page.getByRole("group", { name: PRACTICE_COPY.clockJump });
const clockUrl = (threadId: number) => `${origin}/api/desk/replay/threads/${threadId}/clock`;

test.describe("Practice: Jump, Next open and the horizon (ADR-0025)", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("Jump moves the clock to a date and time, forward only and no later than the horizon, and there is no End day or Skip day", async ({ page, context }) => {
    test.setTimeout(240_000);
    const threadId = await createThreadByApi(context);
    await openDesk(page, `/practice/thread?id=${threadId}`);
    for (const gone of ["End day", "Skip day"]) await expect(page.getByRole("button", { name: new RegExp(`^${gone}`, "i") })).toHaveCount(0);
    const jump = jumpForm(page);
    const go = jump.getByRole("button", { name: PRACTICE_COPY.clockJumpGo, exact: true });
    const date = jump.getByLabel(PRACTICE_COPY.clockJumpDate);
    const time = jump.getByLabel(PRACTICE_COPY.clockJumpTime);
    await expect(go, "nothing typed: nothing to send").toBeDisabled();
    const before = await (await context.request.get(clockUrl(threadId))).json();
    expect(before.horizon, "the latest time the data reaches is the clock's upper bound").toBeTruthy();
    expect(Date.parse(before.horizon)).toBeLessThanOrEqual(Date.parse("2026-10-16T00:00:00Z") - 15 * 60_000); // nothing the embargo has not released
    await expect(jump, "the hint names the latest time").toContainText("Forward only, up to");

    // A time that is not ahead of the clock cannot be sent, and the form says why.
    await date.fill(DAY);
    await time.fill("08:00");
    await expect(jump.getByRole("alert")).toContainText(PRACTICE_COPY.clockJumpBack);
    await expect(go).toBeDisabled();
    // Nor can one past the horizon.
    await date.fill("2026-12-31");
    await time.fill("10:00");
    await expect(jump.getByRole("alert")).toContainText("The data reaches");
    await expect(go).toBeDisabled();

    // The server says the same: a time already past is a 422, the clock's own time changes nothing, and a time past the horizon is a 422.
    const past = await context.request.post(clockUrl(threadId), { data: { to: `${DAY}T13:00:00Z` } }); // 9:00 AM ET, before the 9:30 start
    expect(past.status()).toBe(422);
    expect(await past.text()).toMatch(/forward/i);
    const same = await context.request.post(clockUrl(threadId), { data: { to: before.clock } });
    expect(same.ok(), await same.text()).toBeTruthy();
    expect(Date.parse((await same.json()).clock)).toBe(Date.parse(before.clock));
    const over = await context.request.post(clockUrl(threadId), { data: { to: new Date(Date.parse(before.horizon) + 3_600_000).toISOString() } });
    expect(over.status()).toBe(422);

    // Forward, the same day: the clock reads it, stays paused, and the form is clear again.
    await jumpFromSummary(page, DAY, "11:00");
    await expect(readout(page)).toHaveText(/^Fri 2026-09-25 · 11:00:\d{2} AM ET$/, { timeout: 15_000 });
    const jumped = await (await context.request.get(clockUrl(threadId))).json();
    expect(jumped.state).toBe("paused");
    expect(Date.parse(jumped.clock)).toBe(Date.parse(`${DAY}T15:00:00Z`)); // 11:00 AM ET is 15:00 UTC in September
    await expect(date).toHaveValue("");
    await expect(time).toHaveValue("");
    await expect(jump.getByRole("status")).toContainText("Jumped to");

    // Across a market open: nothing happens at the open. The clock stands on Monday, still paused, and no day was handed over.
    await jumpFromSummary(page, "2026-09-28", "10:00");
    await expect(readout(page)).toHaveText(/^Mon 2026-09-28 · 10:00:\d{2} AM ET$/, { timeout: 15_000 });
    const crossed = await (await context.request.get(clockUrl(threadId))).json();
    expect(crossed.state).toBe("paused");
    expect(Date.parse(crossed.clock)).toBe(Date.parse("2026-09-28T14:00:00Z"));
    for (const gone of ["day_no", "day_list_id", "next_start", "jump_limit"]) expect(crossed, `the clock has no ${gone}: it has no day`).not.toHaveProperty(gone);
    await expect(page.getByTestId("thread-clock-rolled")).toHaveCount(0);
    await expectNoDayLanguage(page);
    await expectCleanScreen(page);
  });

  test("Next open is a Jump to the first 9:30 AM ET open after the clock: it names the open, goes there, and never goes back", async ({ page, context }) => {
    test.setTimeout(240_000);
    const threadId = await createThreadByApi(context);
    await openDesk(page, `/practice/thread?id=${threadId}`);
    const chip = page.getByTestId("thread-clock-next-open");
    await expect(chip).toHaveText("Next open · Mon 2026-09-28 · 9:30 AM ET");

    const first = await nextOpenFromSummary(page);
    expect(Date.parse(first.clock)).toBe(Date.parse("2026-09-28T13:30:00Z"));
    await expect(readout(page)).toHaveText(/^Mon 2026-09-28 · 9:30:\d{2} AM ET$/, { timeout: 15_000 });
    await expect(chip, "the chip moves to the open after that one").toHaveText("Next open · Tue 2026-09-29 · 9:30 AM ET");
    expect(Date.parse(first.next_open)).toBe(Date.parse("2026-09-29T13:30:00Z"));
    await expect(page.getByTestId("thread-clock-state")).toHaveText(PRACTICE_COPY.clockStatePaused);

    // From a Friday evening the next open is Monday's (a weekend has no open); from the open itself it is the next session's.
    await jumpByApi(context, threadId, "2026-10-02T23:00:00Z"); // Fri 2026-10-02, 7:00 PM ET
    await openDesk(page, `/practice/thread?id=${threadId}`);
    await expect(chip).toHaveText("Next open · Mon 2026-10-05 · 9:30 AM ET");
    await expectNoDayLanguage(page);
  });

  test("the clock stops by itself only at the horizon, where the data ends: it says so, Play and Next open wait, and a Jump past it is refused", async ({ page, context }) => {
    test.setTimeout(240_000);
    const threadId = await createThreadByApi(context);
    const { horizon } = await (await context.request.get(clockUrl(threadId))).json();
    // Five minutes before the horizon at 10x: the clock gets there in about half a minute and pauses itself.
    await jumpByApi(context, threadId, new Date(Date.parse(horizon) - 5 * 60_000).toISOString());
    await playByApi(context, threadId, 10);
    await expect.poll(async () => (await get(context, `/threads/${threadId}/clock`)).pause?.kind ?? null, { timeout: 90_000 }).toBe("horizon");
    const stopped = await get(context, `/threads/${threadId}/clock`);
    expect(stopped.running).toBe(false);
    expect(Date.parse(stopped.clock), "never past the horizon").toBeLessThanOrEqual(Date.parse(horizon));

    await openDesk(page, `/practice/thread?id=${threadId}`);
    await expect(page.getByTestId("thread-clock-state")).toHaveText(PRACTICE_COPY.clockStateHorizon);
    await expect(page.getByTestId("thread-clock-horizon")).toBeVisible();
    await expect(page.getByRole("button", { name: PRACTICE_COPY.clockPlay, exact: true })).toBeDisabled();
    await expect(page.getByTestId("thread-clock-next-open")).toBeDisabled();
    await expect(page.getByTestId("thread-clock-next-none")).toHaveText(PRACTICE_COPY.clockNextOpenNone);
    const past = await context.request.post(clockUrl(threadId), { data: { to: new Date(Date.parse(horizon) + 60_000).toISOString() } });
    expect(past.status()).toBe(422);
    await expectNoDayLanguage(page);
    await expectCleanScreen(page);
  });

  test("a thread is closed without ending anything first: its clock stops where it is and the journal says its positions stay", async ({ page, context }) => {
    test.setTimeout(240_000);
    const threadId = await createThreadByApi(context);
    await jumpByApi(context, threadId, `${DAY}T15:00:00Z`);
    await openDesk(page, `/practice/journal?thread=${threadId}`);
    const closing = await railSection(page, "Thread details", PRACTICE_COPY.threadClose);
    await expect(closing).toContainText(PRACTICE_COPY.journalCloseCaption);
    await expect(closing).toContainText(PRACTICE_COPY.journalCloseKeeps);
    await closing.getByRole("button", { name: PRACTICE_COPY.threadClose, exact: true }).click();
    await closing.getByRole("group", { name: "Confirm closing the thread" }).getByRole("button", { name: PRACTICE_COPY.threadCloseConfirm }).click();
    await expect(page.getByRole("status").filter({ hasText: "This thread is closed" })).toBeVisible();
    await expect(closing.getByRole("alert")).toHaveCount(0);
    const thread = await (await context.request.get(`${origin}/api/desk/replay/threads/${threadId}`)).json();
    expect(thread.thread.status).toBe("closed");
    const clock = await (await context.request.get(clockUrl(threadId))).json();
    expect(clock.running).toBe(false);
    expect(Date.parse(clock.clock), "the clock froze at the time of the Jump").toBe(Date.parse(`${DAY}T15:00:00Z`));
  });
});
