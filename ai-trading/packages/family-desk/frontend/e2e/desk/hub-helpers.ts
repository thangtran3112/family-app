import type { BrowserContext, Locator, Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { defaultDraft, draftToSpec, type SetupDraft } from "../../lib/replay/setup.ts";
import { origin } from "../helpers";
import { expect, openDesk } from "./helpers";

// The Practice landing and its New plan modal (02r2): the one way to start a thread in the UI. Specs that are not about
// creating a thread make one through the API (`createThreadByApi`), and specs that need a plan too use `startThread`.

/** The stub replay day (`replay/fixture.py`): TSLA on Fri 2026-09-25, its first ten minutes after the open. */
export const DAY = "2026-09-25";
/** The modal's one button: "Start 5-day practice", "Start 20-day swing practice" (M-07, D-076). */
export const START_BUTTON = /^Start (\d+-day )?(swing )?practice$/;
export const THREAD_URL = /\/practice\/thread\?id=\d+/;
export const DAY_URL = /\/practice\/day\?id=\d+/;
/** A day thread's one action is "Start Trading" (D-078, ADR-0023): a button when it opens the next day, a link when the day is already open (started or not; the thread clock's Play is the only Resume). It names no day number. */
export const START_TRADING = /^Start Trading$/;

/** A saved filter that lists the stub's TSLA only (the fixture's stand-in names trade below $200). */
export const ANY_CLOSE = {
  schemaVersion: 1,
  name: "Any close",
  watch: { universe: { market: "us_equities" }, session: "regular", runOn: "daily_close" },
  liquidity: { minPrice: 200, minAvgVolume: 1 },
  when: { op: "gt", left: { series: "close" }, right: { value: 1 } },
  maxResults: 50,
};

export async function saveFilter(context: BrowserContext, spec: Record<string, unknown> = ANY_CLOSE) {
  const created = await context.request.post(`${origin}/api/desk/screener/filters`, { data: { spec } });
  expect(created.ok(), await created.text()).toBeTruthy();
}

export type NewPlan = {
  balance?: string;
  /** The risk plan is not asked in the modal any more (D-076): `startThread` sets these on the thread through the API. */
  maxLoss?: string;
  maxTrades?: string;
  note?: string;
  /** The server still takes a plan that asks for a stop (a legacy row); the form no longer asks. `startThread` sets No unless a spec is about stops (D-060). */
  stop?: boolean;
  /** The saved filter to tick; defaults to "Any close", which `startThread` saves first. */
  filter?: string;
  /** Days of the plan: 5, 10, 20 or 30. */
  days?: string;
  /** The list time: the modal's default is 8:30; "10:00" or "10:45" makes a day that opens at 9:30 wait for its list (ADR-0023). */
  listAt?: "08:30" | "10:00" | "10:45";
  interval?: "1m" | "5m" | "15m";
};

/** The landing with the New plan modal open. */
export async function openNewPlan(page: Page): Promise<Locator> {
  await openDesk(page, "/practice");
  return clickNewPlan(page);
}

export async function clickNewPlan(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: PRACTICE_COPY.planNew, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: PRACTICE_COPY.newPlanTitle });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Fills the day-trading half of the modal: the balance, one filter, the stub day, `days` days, on `interval`. The day has no end of its own: the stub holds bars to 09:40 and the clock carries on after them. */
export async function fillNewPlan(dialog: Locator, plan: NewPlan = {}) {
  if (plan.balance) await dialog.getByLabel("Starting balance").fill(plan.balance);
  await dialog.getByRole("group", { name: PRACTICE_COPY.planFilters, exact: true }).getByRole("checkbox", { name: plan.filter ?? "Any close" }).check();
  await dialog.locator('input[type="date"]').fill(DAY);
  await dialog.getByRole("radiogroup", { name: "Days" }).getByRole("radio", { name: plan.days ?? "5", exact: true }).click();
  if (plan.listAt !== undefined) await dialog.getByRole("radiogroup", { name: PRACTICE_COPY.planListAt }).getByRole("radio", { name: new RegExp(`^${plan.listAt.replace(/^0/, "")}`) }).click();
  await dialog.getByRole("radiogroup", { name: "Chart interval" }).getByRole("radio", { name: plan.interval ?? "1m", exact: true }).click();
}

/** Sets the thread's risk plan through the API: the modal no longer asks for it (D-076). Stops are No unless `stop` is set (D-060). */
export async function setRiskPlan(context: BrowserContext, threadId: number, plan: Pick<NewPlan, "maxLoss" | "maxTrades" | "note" | "stop"> = {}) {
  const body = {
    schemaVersion: 1,
    plan: {
      stopNoteOnEntry: plan.stop ? "yes" : "no",
      tradeOnlyOnSignal: "no",
      ...(plan.maxLoss === undefined ? {} : { maxLossUsd: Number(plan.maxLoss) }),
      ...(plan.maxTrades === undefined ? {} : { maxTrades: Number(plan.maxTrades) }),
      ...(plan.note === undefined ? {} : { planNote: plan.note }),
    },
  };
  const patched = await context.request.patch(`${origin}/api/desk/replay/threads/${threadId}`, { data: body });
  expect(patched.ok(), await patched.text()).toBeTruthy();
}

/** Closes an edited modal with Escape: it asks first (M-05), so this discards. */
export async function discardNewPlan(page: Page) {
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: PRACTICE_COPY.newPlanDiscard, exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/** The thread id in the thread page's URL. */
export const threadIdOf = (page: Page): number => Number(new URL(page.url()).searchParams.get("id"));

/** Starts a day thread and its plan through the modal and lands on the thread page. Saves "Any close" first unless `plan.filter` names another saved filter. */
export async function startThread(page: Page, context: BrowserContext, plan: NewPlan = {}): Promise<number> {
  if (plan.filter === undefined) await saveFilter(context);
  const dialog = await openNewPlan(page);
  await fillNewPlan(dialog, plan);
  await dialog.getByRole("button", { name: START_BUTTON }).click();
  await page.waitForURL(THREAD_URL, { timeout: 90_000 });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const id = threadIdOf(page);
  await setRiskPlan(context, id, plan); // no session has started: the plan applies from the first one
  await openDesk(page, `/practice/thread?id=${id}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return id;
}

/** A landing row is one click target (its name link is stretched over the whole row): a click on the row's top-left corner, clear of the action and Delete, opens the thread page. */
export async function openRow(page: Page, row: Locator) {
  await row.click({ position: { x: 8, y: 8 } });
  await page.waitForURL(THREAD_URL);
}

/** On the thread page after `startThread`: the plan's data is prepared in the background, then Day 1 opens (the Start Trading button, or its link when the modal already opened it). */
export async function openFirstDay(page: Page) {
  const start = page.getByRole("button", { name: START_TRADING });
  const resume = page.getByRole("link", { name: START_TRADING });
  await expect(start.or(resume)).toBeVisible({ timeout: 60_000 });
  if (await start.isVisible()) await start.click();
  else await resume.click();
  await page.waitForURL(DAY_URL);
}

/** A day thread made through the API, with no plan: the risk plan only (`stop` is No unless given). Returns the thread id. */
export async function createThreadByApi(
  context: BrowserContext,
  plan: { balance?: number; maxLoss?: number; maxTrades?: number; note?: string; stop?: boolean } = {},
): Promise<number> {
  const body = {
    schemaVersion: 1,
    mode: "day",
    startingBalance: plan.balance ?? 50_000,
    plan: {
      stopNoteOnEntry: plan.stop ? "yes" : "no",
      tradeOnlyOnSignal: "no",
      ...(plan.maxLoss === undefined ? {} : { maxLossUsd: plan.maxLoss }),
      ...(plan.maxTrades === undefined ? {} : { maxTrades: plan.maxTrades }),
      ...(plan.note === undefined ? {} : { planNote: plan.note }),
    },
  };
  const created = await context.request.post(`${origin}/api/desk/replay/threads`, { data: body });
  expect(created.ok(), await created.text()).toBeTruthy();
  return ((await created.json()) as { thread: { id: number } }).thread.id;
}

/** A single stub-day replay session made through the API (the landing no longer starts one): TSLA on `DAY`, 09:30 to 09:40 ET on 1m, with `draft` fields (such as `armed`) laid over that. */
export async function createStubSession(context: BrowserContext, draft: Partial<SetupDraft> = {}): Promise<number> {
  const spec = draftToSpec({ ...defaultDraft(), symbol: "TSLA", day: DAY, to: "09:40", interval: "1m", ...draft });
  const response = await context.request.post(`${origin}/api/desk/replay/sessions`, { data: spec });
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { id: number }).id;
}
