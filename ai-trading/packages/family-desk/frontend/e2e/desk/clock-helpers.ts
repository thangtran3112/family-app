import type { Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { origin } from "../helpers";
import { expect } from "./helpers";

// A freestyle thread's clock is the server's (ADR-0018, ADR-0025), and a chart has no Step. A spec that needs the market to move on a chart moves the
// thread's clock the way the Summary does (`POST /replay/threads/{id}/clock`), and the chart on screen follows it on its own.

const SESSION_ID = /\/practice\/replay\?id=(\d+)/;

/** The thread of the lane on screen. */
async function threadOfSession(page: Page): Promise<number> {
  const id = SESSION_ID.exec(page.url())?.[1];
  if (id === undefined) throw new Error(`not a replay chart: ${page.url()}`);
  const response = await page.context().request.get(`${origin}/api/desk/replay/sessions/${id}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).thread_id;
}

/** Moves the thread's clock `times` bars on (the thread's interval, 1 minute in the stub) and waits for the chart on screen to show each. */
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

/** Jumps the Summary's clock to an ET date and time through the Jump form (ADR-0025) and waits for the answer. */
export async function jumpFromSummary(page: Page, date: string, time: string) {
  const jump = page.getByRole("group", { name: PRACTICE_COPY.clockJump });
  await jump.getByLabel(PRACTICE_COPY.clockJumpDate).fill(date);
  await jump.getByLabel(PRACTICE_COPY.clockJumpTime).fill(time);
  const answered = page.waitForResponse((response) => response.url().endsWith("/clock") && response.request().method() === "POST", { timeout: 90_000 });
  await jump.getByRole("button", { name: PRACTICE_COPY.clockJumpGo, exact: true }).click();
  expect((await answered).ok()).toBeTruthy();
}

/** Presses Next open on the Summary: a Jump to the first 9:30 AM ET open after the clock. Waits for the answer and returns the clock the server gave. */
export async function nextOpenFromSummary(page: Page) {
  const answered = page.waitForResponse((response) => response.url().endsWith("/clock") && response.request().method() === "POST", { timeout: 90_000 });
  await page.getByTestId("thread-clock-next-open").click();
  const response = await answered;
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
