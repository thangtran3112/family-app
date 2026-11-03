import type { BrowserContext, Locator, Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { origin } from "../helpers";
import { expect, openDesk, test } from "./helpers";

// The Practice landing, its New thread modal and the API calls the specs use to set a freestyle thread up (ADR-0025). A thread is a paper account
// with one clock: it starts at an instant (`startAt`), a Screen scans her saved filters at the clock, and a lane is one name's book. Specs that are
// not about creating a thread make one through the API (`createThreadByApi`), and specs that need the modal use `startThread`.

/** The stub replay day (`replay/fixture.py`): TSLA on Fri 2026-09-25 (extended-hours 1-minute bars; prints for the first ten minutes after the open). */
export const DAY = "2026-09-25";
/** September and October 2026 are on daylight time: ET is UTC-4. */
export const ET_OFFSET = "-04:00";
/** The modal's one button: "Start thread". */
export const START_BUTTON = /^Start thread$/;
export const THREAD_URL = /\/practice\/thread\?id=\d+/;
export const SCREEN_URL = /\/practice\/screen\?thread=\d+/;
export const REPLAY_URL = /\/practice\/replay\?id=\d+/;

/** A saved filter that lists the stub's TSLA only (the fixture's stand-in names trade below $200). */
export const ANY_CLOSE = {
  schemaVersion: 1,
  name: "Any close",
  watch: { universe: { market: "us_equities" }, session: "regular", runOn: "daily_close" },
  liquidity: { minPrice: 200, minAvgVolume: 1 },
  when: { op: "gt", left: { series: "close" }, right: { value: 1 } },
  maxResults: 50,
};

/** Saves a filter and returns its id. */
export async function saveFilter(context: BrowserContext, spec: Record<string, unknown> = ANY_CLOSE): Promise<number> {
  const created = await context.request.post(`${origin}/api/desk/screener/filters`, { data: { spec } });
  expect(created.ok(), await created.text()).toBeTruthy();
  return ((await created.json()) as { id: number }).id;
}

/** The id of the saved filter called `name`, saving "Any close" first when it is not there yet. */
async function filterId(context: BrowserContext, name = "Any close"): Promise<number> {
  const listed = await context.request.get(`${origin}/api/desk/screener/filters`);
  expect(listed.ok(), await listed.text()).toBeTruthy();
  const found = ((await listed.json()) as Array<{ id: number; name: string }>).find((filter) => filter.name === name);
  return found?.id ?? (await saveFilter(context));
}

export type NewPlan = {
  balance?: string;
  /** The optional risk rules: `startThread` sets them on the thread through the API after it starts. */
  maxLoss?: string;
  maxTrades?: string;
  note?: string;
  /** A stop note on every entry (a legacy rule; the form no longer asks). Set through the API; off unless a spec is about stops (D-060). */
  stop?: boolean;
  /** The saved filter to tick; defaults to "Any close", which `startThread` saves first. */
  filter?: string;
  interval?: "1m" | "5m" | "15m";
  /** The start in ET; defaults to the stub day at the 9:30 open. */
  startAt?: { date: string; time: string };
};

/** The landing with the New thread modal open. */
export async function openNewPlan(page: Page): Promise<Locator> {
  await openDesk(page, "/practice");
  return clickNewPlan(page);
}

export async function clickNewPlan(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: PRACTICE_COPY.newThreadTitle, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: PRACTICE_COPY.newThreadTitle });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Fills the modal: the balance, one filter, the start date and time (the stub day at 9:30 AM ET unless `plan.startAt` says otherwise) and the chart interval. */
export async function fillNewPlan(dialog: Locator, plan: NewPlan = {}) {
  if (plan.balance) await dialog.getByLabel(PRACTICE_COPY.threadStartingBalance).fill(plan.balance);
  await dialog.getByRole("group", { name: PRACTICE_COPY.planFilters, exact: true }).getByRole("checkbox", { name: plan.filter ?? "Any close" }).check();
  await dialog.locator('input[type="date"]').fill(plan.startAt?.date ?? DAY);
  await dialog.locator('input[type="time"]').fill(plan.startAt?.time ?? "09:30");
  await dialog.getByRole("radiogroup", { name: PRACTICE_COPY.planInterval }).getByRole("radio", { name: plan.interval ?? "1m", exact: true }).click();
}

/** Sets the thread's risk rules through the API. Stops are No unless `stop` is set (D-060). */
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

/** Starts a thread through the modal and lands on its Summary. Saves "Any close" first unless `plan.filter` names another saved filter. */
export async function startThread(page: Page, context: BrowserContext, plan: NewPlan = {}): Promise<number> {
  if (plan.filter === undefined) await saveFilter(context);
  const dialog = await openNewPlan(page);
  await fillNewPlan(dialog, plan);
  await dialog.getByRole("button", { name: START_BUTTON }).click();
  await page.waitForURL(THREAD_URL, { timeout: 90_000 });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const id = threadIdOf(page);
  if (plan.maxLoss !== undefined || plan.maxTrades !== undefined || plan.note !== undefined || plan.stop !== undefined) {
    await setRiskPlan(context, id, plan);
    await openDesk(page, `/practice/thread?id=${id}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
  return id;
}

/** A landing row is one click target (its name link is stretched over the whole row): a click on the row's top-left corner, clear of the action and Delete, opens the thread page. */
export async function openRow(page: Page, row: Locator) {
  await row.click({ position: { x: 8, y: 8 } });
  await page.waitForURL(THREAD_URL);
}

export type NewThread = {
  balance?: number;
  maxLoss?: number;
  maxTrades?: number;
  note?: string;
  stop?: boolean;
  /** The ET instant the clock starts at, as an ISO time with its offset. Defaults to the stub day at the 9:30 open. */
  startAt?: string;
  interval?: "1m" | "5m" | "15m";
  /** A saved filter's id; "Any close" is saved (once) when it is left out. */
  filterId?: number;
};

/** A freestyle thread made through the API WITH its setup, so it has a clock paused at `startAt` and a Screen. Returns the thread id. */
export async function createThreadByApi(context: BrowserContext, opts: NewThread = {}): Promise<number> {
  const body = {
    schemaVersion: 1,
    mode: "day", // the contract still requires it until the contract migration; the server ignores it
    startingBalance: opts.balance ?? 50_000,
    plan: {
      stopNoteOnEntry: opts.stop ? "yes" : "no",
      tradeOnlyOnSignal: "no",
      ...(opts.maxLoss === undefined ? {} : { maxLossUsd: opts.maxLoss }),
      ...(opts.maxTrades === undefined ? {} : { maxTrades: opts.maxTrades }),
      ...(opts.note === undefined ? {} : { planNote: opts.note }),
    },
    setup: {
      schemaVersion: 2,
      startAt: opts.startAt ?? `${DAY}T09:30:00${ET_OFFSET}`,
      screen: { filters: [{ id: opts.filterId ?? (await filterId(context)) }], maxList: 30 },
      setup: { interval: opts.interval ?? "1m", session: "regular", armed: [] },
    },
  };
  const created = await context.request.post(`${origin}/api/desk/replay/threads`, { data: body });
  expect(created.ok(), await created.text()).toBeTruthy();
  return ((await created.json()) as { thread: { id: number } }).thread.id;
}

// ---- the replay API, for setup that is not under test ------------------------------------------------------------------

export const REPLAY = `${origin}/api/desk/replay`;

/** A parsed answer of the replay API (the shapes are the generated `openapi.d.ts`; a spec reads only what it checks). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export async function get(context: BrowserContext, path: string): Promise<Json> {
  const response = await context.request.get(`${REPLAY}${path}`);
  expect(response.ok(), `GET ${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}

export async function send(context: BrowserContext, method: "POST" | "PATCH" | "PUT", path: string, data?: unknown, status = 200): Promise<Json> {
  const response = await context.request.fetch(`${REPLAY}${path}`, { method, data });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBe(status);
  return response.json();
}

/** The UTC instant of an ET wall time on a September or October 2026 day (daylight time: UTC-4). */
export const at = (day: string, hhmm: string) => `${day}T${String(Number(hhmm.slice(0, 2)) + 4).padStart(2, "0")}:${hhmm.slice(3)}:00Z`;

/** Opens (or resumes) the thread's lane on `symbol` at the thread's clock. Returns the lane's session id. */
export async function openLaneByApi(context: BrowserContext, threadId: number, symbol = "TSLA"): Promise<number> {
  return (await send(context, "POST", `/threads/${threadId}/lanes`, { symbol })).id;
}

/** A mark on a lane through the API, at the thread's clock. */
export async function markByApi(
  context: BrowserContext,
  sessionId: number,
  mark: { kind: "long_entry" | "short_entry" | "long_exit" | "short_exit"; shares?: number; stopPrice?: number },
): Promise<Json> {
  return send(context, "POST", `/sessions/${sessionId}/marks`, { schemaVersion: 1, ...mark });
}

/** One clock command (`running`, `speed`, `step`, `to`); returns the clock the server answers with. */
export async function clockByApi(context: BrowserContext, threadId: number, body: { running?: boolean; speed?: 1 | 2 | 5 | 10; step?: "bar"; to?: string }): Promise<Json> {
  return send(context, "POST", `/threads/${threadId}/clock`, body);
}

export const playByApi = (context: BrowserContext, threadId: number, speed?: 1 | 2 | 5 | 10) => clockByApi(context, threadId, { running: true, ...(speed === undefined ? {} : { speed }) });

/** Jumps the thread clock to `to` (an ISO instant). */
export const jumpByApi = (context: BrowserContext, threadId: number, to: string) => clockByApi(context, threadId, { to });

/** Runs the Screen's scan at the thread's clock and waits for it to finish. Returns the Screen. */
export async function scanByApi(context: BrowserContext, threadId: number): Promise<Json> {
  await send(context, "POST", `/threads/${threadId}/screen/rescan`, {});
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const screen = await get(context, `/threads/${threadId}/screen`);
    if (screen.rescan_job === null || screen.rescan_job.state !== "running") return screen;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error("the scan did not finish");
}

// ---- the workspace's rails and ticket, by clicking -----------------------------------------------------------------------

/** The workspace's right rail section `section` ("Practice", "Signals"): stacked at 1440, a drawer behind the strip at 1180 (opened here). */
export async function replayRail(page: Page, section: string) {
  if (test.info().project.name !== "desktop-1180") return page.getByRole("complementary", { name: "Replay context" });
  const tab = page.getByRole("tablist", { name: "Replay context" }).getByRole("tab", { name: section });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  const drawer = page.getByRole("dialog", { name: section });
  await expect(drawer).toBeVisible();
  return drawer;
}

/**
 * Buy, Sell or Close position by clicking, as she does (Practice has no keyboard shortcuts). At 1440 the order ticket is in the right
 * rail: this picks the side, then presses the submit button of the same name. At 1180 the chart toolbar carries the same three buttons
 * so they work with the drawer closed; they are used unless the Practice drawer is already open (opening it would change the layout
 * a spec is measuring). Buy and Sell send the ticket as it stands.
 */
export async function placeOrder(page: Page, action: "Buy" | "Sell" | "Close position") {
  if (test.info().project.name === "desktop-1180" && !(await page.getByRole("dialog", { name: "Practice" }).isVisible())) {
    await page.getByRole("group", { name: "Practice buttons" }).getByRole("button", { name: action, exact: true }).click();
    return;
  }
  const practice = await replayRail(page, "Practice");
  if (action !== "Close position") await practice.getByRole("radio", { name: action }).click();
  await practice.getByRole("button", { name: action, exact: true }).click();
}

/** A right-rail section of the journal: stacked in the rail at 1440, a drawer behind the strip at 1180 (it opens here). */
export async function railSection(page: Page, rail: string, section: string) {
  if (test.info().project.name !== "desktop-1180") return page.getByRole("complementary", { name: rail });
  await page.getByRole("tablist", { name: rail }).getByRole("tab", { name: section }).click();
  const drawer = page.getByRole("dialog", { name: section });
  await expect(drawer).toBeVisible();
  return drawer;
}

/** Every JSON answer of the replay API this page received, in order (`path` has the query string; `body` is the parsed answer). */
export function watchAnswers(page: Page) {
  const answers: Array<{ method: string; path: string; body: Json }> = [];
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/desk/replay/") || !response.ok()) return;
    const body = await response.json().catch(() => null);
    if (body && typeof body === "object") answers.push({ method: response.request().method(), path: url.pathname.replace("/api/desk/replay", "") + url.search, body });
  });
  return answers;
}

// ---- the freestyle vocabulary ------------------------------------------------------------------------------------------

/** Words of the retired day model: a day that ends or is skipped, a hand-over, a numbered day of a plan, a block of days, Swing, the day list. */
export const DAY_LANGUAGE = /\b(end day|skip day|skipped|swing|hands? over|hand-over|day list|block of days|start day)\b|\bday \d+ of\b/i;

/** The page's main region says nothing of the retired day model (ADR-0025): nothing ends, closes or resets at a day. */
export async function expectNoDayLanguage(page: Page) {
  const text = await page.locator("#main-content").innerText();
  expect(text.match(DAY_LANGUAGE)?.[0] ?? null, "the day model is gone: no End day, Skip day, Swing, hand-over or numbered day").toBeNull();
}
