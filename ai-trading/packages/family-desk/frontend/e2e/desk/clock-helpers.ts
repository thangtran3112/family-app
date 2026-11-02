import type { Locator, Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { origin } from "../helpers";
import { expect, openDesk } from "./helpers";

// A day thread's clock is the server's (ADR-0018), and a chart has no Step. A spec that needs the market to move on a chart moves the
// thread's clock the way the Summary does (`POST /replay/threads/{id}/clock`), and the chart on screen follows it on its own.

const SESSION_ID = /\/practice\/replay\?id=(\d+)/;

/** The thread of the session on screen. */
async function threadOfSession(page: Page): Promise<number> {
  const id = SESSION_ID.exec(page.url())?.[1];
  if (id === undefined) throw new Error(`not a replay chart: ${page.url()}`);
  const response = await page.context().request.get(`${origin}/api/desk/replay/sessions/${id}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).thread_id;
}

/** A standalone replay has its own clock bar: Step reveals `times` bars, one click each, and waits for the clock to show each. */
export async function stepSession(page: Page, times = 1) {
  const readout = page.getByTestId("thread-clock-time");
  for (let bar = 0; bar < times; bar += 1) {
    const before = (await readout.textContent()) ?? "";
    await page.getByRole("button", { name: "Step", exact: true }).click();
    await expect(readout).not.toHaveText(before, { timeout: 10_000 });
  }
}

/** Moves the thread's clock `times` bars on (the plan's interval, 1 minute in the stub) and waits for the chart on screen to show each. */
export async function stepBar(page: Page, times = 1) {
  const thread = await threadOfSession(page);
  const readout = page.getByTestId("thread-clock-time");
  for (let bar = 0; bar < times; bar += 1) {
    const before = (await readout.textContent()) ?? "";
    const response = await page.context().request.post(`${origin}/api/desk/replay/threads/${thread}/clock`, { data: { step: "bar" } });
    expect(response.ok(), await response.text()).toBeTruthy();
    await expect(readout).not.toHaveText(before, { timeout: 10_000 });
  }
}

/**
 * Finishes the open day the only way a day-trade thread can (ADR-0023, no End day): Skip day on the Summary, which asks first, ends the day at the
 * tape's end and opens the next one. Then the page shows the review of the day that ended (its Day list). `check` reads the question before it is answered.
 */
export async function skipDayToReview(page: Page, check?: (ask: Locator) => Promise<void>) {
  await page.getByRole("tab", { name: "Summary" }).click();
  await page.getByRole("button", { name: PRACTICE_COPY.clockSkipDay, exact: true }).click();
  const ask = page.getByRole("group", { name: "Confirm skipping the day" });
  await check?.(ask);
  const skipped = page.waitForResponse((response) => response.url().endsWith("/skip-day") && response.request().method() === "POST", { timeout: 90_000 });
  await ask.getByRole("button", { name: PRACTICE_COPY.clockSkipConfirm, exact: true }).click();
  const { ended_day_list_id: ended } = (await (await skipped).json()) as { ended_day_list_id: number };
  await openDesk(page, `/practice/day?id=${ended}`);
}

/** Jumps the Summary's clock to an ET date and time through the Jump form (ADR-0023) and waits for the answer. */
export async function jumpFromSummary(page: Page, date: string, time: string) {
  const jump = page.getByRole("group", { name: PRACTICE_COPY.clockJump });
  await jump.getByLabel(PRACTICE_COPY.clockJumpDate).fill(date);
  await jump.getByLabel(PRACTICE_COPY.clockJumpTime).fill(time);
  const answered = page.waitForResponse((response) => response.url().endsWith("/clock") && response.request().method() === "POST", { timeout: 90_000 });
  await jump.getByRole("button", { name: PRACTICE_COPY.clockJumpGo, exact: true }).click();
  expect((await answered).ok()).toBeTruthy();
}
