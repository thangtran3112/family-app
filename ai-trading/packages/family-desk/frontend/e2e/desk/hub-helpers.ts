import type { BrowserContext, Locator, Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { defaultDraft, draftToSpec, type SetupDraft } from "../../lib/replay/setup.ts";
import { origin } from "../helpers";
import { expect, openDesk } from "./helpers";

// The Practice landing and its New plan modal (02r2): the one way to start a thread in the UI. Specs that are not about
// creating a thread make one through the API (`createThreadByApi`), and specs that need a plan too use `startThread`.

/** The stub replay day (`replay/fixture.py`): TSLA on Fri 2026-09-25, its first ten minutes after the open. */
export const DAY = "2026-09-25";
export const THREAD_URL = /\/practice\/thread\?id=\d+/;
export const DAY_URL = /\/practice\/day\?id=\d+/;
/** A day thread's one action says what it does (D-078): the button that opens the next day starts it, the link to a listed day opens it, and a day in progress resumes. */
export const START_DAY = /^Start Day \d+$/;
export const OPEN_DAY = /^(Open|Resume) Day \d+$/;

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
  maxLoss?: string;
  maxTrades?: string;
  note?: string;
  /** The plan asks for a stop on every entry by default and refuses an entry without one (D-060); No unless a spec is about stops. */
  stop?: boolean;
  /** The saved filter to tick; defaults to "Any close", which `startThread` saves first. */
  filter?: string;
  /** Days of the plan: 5, 10, 20 or 30. */
  days?: string;
  to?: string;
  interval?: "1m" | "5m" | "15m";
  /** The modal replaces an active thread's plan: no balance or risk plan to fill. */
  replace?: boolean;
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

/** Fills the day-trading half of the modal: the stub day, `days` days, the window to `to` on `interval`, one filter, the risk plan. */
export async function fillNewPlan(dialog: Locator, plan: NewPlan = {}) {
  if (!plan.replace) {
    if (plan.balance) await dialog.getByLabel("Starting balance").fill(plan.balance);
    if (plan.maxLoss) await dialog.getByLabel("Max loss ($)").fill(plan.maxLoss);
    if (plan.maxTrades) await dialog.getByLabel("Max trades").fill(plan.maxTrades);
    if (plan.note) await dialog.getByLabel(/^Plan note/).fill(plan.note);
    if (!plan.stop) await dialog.getByRole("group", { name: PRACTICE_COPY.threadStopOnEntry }).getByRole("button", { name: "No", exact: true }).click();
  }
  await dialog.getByRole("group", { name: PRACTICE_COPY.planFilters, exact: true }).getByRole("checkbox", { name: plan.filter ?? "Any close" }).check();
  await dialog.locator('input[type="date"]').fill(DAY);
  await dialog.getByRole("group", { name: "Days" }).getByRole("button", { name: plan.days ?? "5", exact: true }).click();
  await dialog.getByLabel("To", { exact: true }).fill(plan.to ?? "09:40");
  await dialog.getByRole("group", { name: "Chart interval" }).getByRole("button", { name: plan.interval ?? "1m", exact: true }).click();
}

/** The thread id in the thread page's URL. */
export const threadIdOf = (page: Page): number => Number(new URL(page.url()).searchParams.get("id"));

/** Starts a day thread and its plan through the modal and lands on the thread page. Saves "Any close" first unless `plan.filter` names another saved filter. */
export async function startThread(page: Page, context: BrowserContext, plan: NewPlan = {}): Promise<number> {
  if (plan.filter === undefined) await saveFilter(context);
  const dialog = await openNewPlan(page);
  await fillNewPlan(dialog, plan);
  await dialog.getByRole("button", { name: PRACTICE_COPY.newPlanSubmit, exact: true }).click();
  await page.waitForURL(THREAD_URL, { timeout: 90_000 });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return threadIdOf(page);
}

/** A landing row is one click target (its name link is stretched over the whole row): a click on the row's top-left corner, clear of the action and Delete, opens the thread page. */
export async function openRow(page: Page, row: Locator) {
  await row.click({ position: { x: 8, y: 8 } });
  await page.waitForURL(THREAD_URL);
}

/** On the thread page after `startThread`: the plan's data is prepared in the background, then Day 1 opens (here `Start Day 1`, or Open Day 1 when the modal already opened it). */
export async function openFirstDay(page: Page) {
  const start = page.getByRole("button", { name: START_DAY });
  const resume = page.getByRole("link", { name: OPEN_DAY });
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
