import type { BrowserContext, Page } from "@playwright/test";
import { PRACTICE_COPY } from "../../lib/desk/freshness.ts";
import { origin } from "../helpers";
import { expect, test } from "./helpers";

// Helpers for `swing.spec.ts` (02p): the E2E swing world is `S01`..`S12` and `SPY` (`backend/tests/e2e/swing_services.py`
// lists the scripted days). Setup that is not under test goes through the API; the screens under test are driven by hand.

export const SYMBOLS = ["S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10", "S11", "S12"];
/** Mon 2026-09-14, Day 1 of the world. Day 4 (Thu 09-17) S01 gaps up 6%, Day 6 (Mon 09-21) S03 splits 2 for 1, Day 7 (Tue 09-22) S02 gaps down 8%. */
export const FIRST_DAY = "2026-09-14";
/** The weekday of each swing day number, the first three weeks. */
export const DAY_ISO = [
  "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18",
  "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25",
  "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02",
];
export const DATE_TEXT = /20\d\d-\d\d-\d\d/;
export const REPLAY = `${origin}/api/desk/replay`;

/** A parsed answer of the replay API (the shapes are the generated `openapi.d.ts`; a spec reads only what it checks). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export async function get(context: BrowserContext, path: string): Promise<Json> {
  const response = await context.request.get(`${REPLAY}${path}`);
  expect(response.ok(), `GET ${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}

export async function send(context: BrowserContext, method: "POST" | "PATCH", path: string, data?: unknown, status = 200): Promise<Json> {
  const response = await context.request.fetch(`${REPLAY}${path}`, { method, data });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBe(status);
  return response.json();
}

/** A swing thread made through the API: the preview (twelve names, `fill` off), the create, then the prep it started. */
export async function createSwingThread(
  context: BrowserContext,
  options: { sessions?: number; maxOpenHolds?: number; plan?: Record<string, unknown> } = {},
): Promise<number> {
  const preview = await send(context, "POST", "/threads/swing-universe", {
    first_day: FIRST_DAY,
    sessions: options.sessions ?? 15,
    fill: "none",
    add: SYMBOLS,
    target: 12,
  });
  const swing = {
    firstDay: FIRST_DAY,
    sessions: options.sessions ?? 15,
    hideDates: "yes",
    universe: preview.rows.map((row: Json) => ({ symbol: row.symbol, source: row.source })),
    interval: "15m",
    tape: "off",
    armed: [],
    maxOpenHolds: options.maxOpenHolds ?? 3,
  };
  const plan = { stopNoteOnEntry: "no", tradeOnlyOnSignal: "no", ...options.plan };
  const created = await send(context, "POST", "/threads", { schemaVersion: 1, mode: "swing", startingBalance: 50_000, plan, swing });
  return created.thread.id;
}

/** `POST /daily/next` opens the next day of a swing thread; while the background prep runs it answers no list, so ask again. */
export async function openNextDay(context: BrowserContext, threadId: number): Promise<number> {
  for (let attempt = 0; attempt < 240; attempt++) {
    const opened = await send(context, "POST", "/daily/next", { threadId });
    if (opened.day_list_id !== null) return opened.day_list_id;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("the swing prep did not finish");
}

/** The UTC instant of an ET wall time on a swing day (September and October 2026 are on daylight time: UTC-4). */
export const at = (day: string, hhmm: string) => `${day}T${String(Number(hhmm.slice(0, 2)) + 4).padStart(2, "0")}:${hhmm.slice(3)}:00Z`;

/** Play one swing day by API: star the names, practise `symbol`, run the clock to `to` (ET) and enter a long or short. */
export async function enterByApi(
  context: BrowserContext,
  dayListId: number,
  entry: { symbol: string; watch?: string[]; day: string; to?: string; kind?: "long_entry" | "short_entry"; shares?: number; stopPrice?: number },
): Promise<Json> {
  await send(context, "PATCH", `/day-lists/${dayListId}`, { watch: entry.watch ?? [entry.symbol] });
  const session = await send(context, "POST", `/day-lists/${dayListId}/sessions`, { symbol: entry.symbol });
  await send(context, "POST", `/sessions/${session.id}/advance`, { to: at(entry.day, entry.to ?? "10:00") });
  return send(context, "POST", `/sessions/${session.id}/marks`, {
    schemaVersion: 1,
    kind: entry.kind ?? "long_entry",
    shares: entry.shares ?? 100,
    ...(entry.stopPrice !== undefined ? { stopPrice: entry.stopPrice } : {}),
  });
}

/** The page shows no calendar date (02p: dates stay hidden for the whole session screens). */
export async function expectNoDates(page: Page) {
  await expect(page.locator("body")).not.toContainText(DATE_TEXT);
}

/** A screenshot of the whole scrolling screen: the desk shell scrolls inside its frame, so the viewport is made tall for it. */
export async function shot(page: Page, name: string, tall = true) {
  const size = page.viewportSize();
  if (!size || !process.env.SWING_SHOTS) return;
  await page.setViewportSize({ width: size.width, height: tall ? 2400 : size.height });
  await page.evaluate(() => document.querySelectorAll("*").forEach((node) => node.scrollTop > 0 && (node.scrollTop = 0)));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `/tmp/swing-sdd/shots/${name}-${test.info().project.name}.png` });
  await page.setViewportSize(size);
}

/** The workspace's right rail section `section` ("Practice", "Tape"): stacked at 1440, a drawer behind the strip at 1180 (opened here). */
export async function replayRail(page: Page, section: string) {
  if (test.info().project.name !== "desktop-1180") return page.getByRole("complementary", { name: "Replay context" });
  const tab = page.getByRole("tablist", { name: "Replay context" }).getByRole("tab", { name: section });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  const drawer = page.getByRole("dialog", { name: section });
  await expect(drawer).toBeVisible();
  return drawer;
}

/** A mark through the API on a name's session at the day clock (the session opens there; it is advanced first only when `clock` is given). */
export async function markByApi(
  context: BrowserContext,
  dayListId: number,
  symbol: string,
  mark: { kind: "long_entry" | "short_entry" | "long_exit" | "short_exit"; shares?: number; stopPrice?: number },
  clock?: { day: string; to: string },
): Promise<Json> {
  const session = await send(context, "POST", `/day-lists/${dayListId}/sessions`, { symbol });
  if (clock) await send(context, "POST", `/sessions/${session.id}/advance`, { to: at(clock.day, clock.to) });
  return send(context, "POST", `/sessions/${session.id}/marks`, { schemaVersion: 1, ...mark });
}

/** Every JSON answer of the replay API this page received, in order (`path` has the query string; `body` is the parsed answer). */
export function watchSwingAnswers(page: Page) {
  const answers: Array<{ method: string; path: string; body: Json }> = [];
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/desk/replay/") || !response.ok()) return;
    const body = await response.json().catch(() => null);
    if (body && typeof body === "object") answers.push({ method: response.request().method(), path: url.pathname.replace("/api/desk/replay", "") + url.search, body });
  });
  return answers;
}

/** A right-rail section of the journal: stacked in the rail at 1440, a drawer behind the strip at 1180 (it opens here). */
export async function railSection(page: Page, rail: string, section: string) {
  if (test.info().project.name !== "desktop-1180") return page.getByRole("complementary", { name: rail });
  await page.getByRole("tablist", { name: rail }).getByRole("tab", { name: section }).click();
  const drawer = page.getByRole("dialog", { name: section });
  await expect(drawer).toBeVisible();
  return drawer;
}

/** The swing thread's row of the landing's table: its line, balance, and the Start or Continue Day N button or the week review link. */
export function swingRow(page: Page) {
  return page.getByRole("table", { name: PRACTICE_COPY.landingTableLabel }).getByRole("row", { name: /Swing/ });
}
