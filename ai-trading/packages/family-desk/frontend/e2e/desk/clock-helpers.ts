import type { Page } from "@playwright/test";
import { origin } from "../helpers";
import { expect } from "./helpers";

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
