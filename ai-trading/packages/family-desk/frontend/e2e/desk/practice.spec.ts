import type { Page } from "@playwright/test";
import { PRACTICE_COPY, practiceBandText, practiceText } from "../../lib/desk/freshness.ts";
import { expect, expectCleanScreen, openDesk, prepareDesk, test, watchApi } from "./helpers";

// The Practice lane (02o §i, step 5): hub to start, play, step, B, T, S/X, end, the journal, and a resumed session.
// The backend runs with `DESK_REPLAY_STUB=1` (`replay/fixture.py`): the one replayable day is TSLA on Fri 2026-09-25
// and the tape holds its first ten minutes after the open, so every session here replays 09:30 to 09:40 ET.

const DAY = "2026-09-25";
const SESSION_URL = /\/practice\/replay\?id=\d+/;
const JOURNAL_URL = /\/practice\/journal\?id=\d+/;
const LIVE_DATA = /\/api\/desk\/(bars|technicals|quotes|charts)\b/;

/** Every `/api/desk/replay/...` answer, parsed, so a spec can check what the browser was ever told. */
function watchReplayAnswers(page: Page) {
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/desk/replay/") || !response.ok()) return;
    const body = await response.json().catch(() => null);
    if (body && typeof body === "object" && !Array.isArray(body)) bodies.push({ path: url.pathname, body: body as Record<string, unknown> });
  });
  return bodies;
}

const playhead = (page: Page) => page.locator("dt", { hasText: "Playhead" }).locator("xpath=following-sibling::dd");
const marksTab = (page: Page) => page.getByRole("tab", { name: "Marks" });

/** A right-rail section: stacked in the rail at 1440, a drawer behind the strip at 1180 (it opens here). */
async function railSection(page: Page, rail: string, section: string) {
  if (test.info().project.name !== "desktop-1180") return page.getByRole("complementary", { name: rail });
  await page.getByRole("tablist", { name: rail }).getByRole("tab", { name: section }).click();
  const drawer = page.getByRole("dialog", { name: section });
  await expect(drawer).toBeVisible();
  return drawer;
}

/** Fill the hub with the stub day and start. `from`/`to` default to the stub's ten minutes of tape. */
async function startStubSession(page: Page, setup: { stopRequired?: boolean } = {}) {
  await openDesk(page, "/practice");
  const form = page.locator("#start-practice");
  await form.getByRole("combobox").fill("TSLA");
  await form.locator('input[type="date"]').fill(DAY);
  await form.getByLabel("To", { exact: true }).fill("09:40");
  await form.getByRole("button", { name: "1m", exact: true }).click();
  if (setup.stopRequired === false) await form.getByRole("button", { name: "No", exact: true }).first().click();
  await form.getByRole("button", { name: "Start practice" }).click();
  await page.waitForURL(SESSION_URL);
  await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
  await expect(page.getByText(practiceText("ready", { time: "9:30 AM" }))).toBeVisible();
}

test.describe("Practice", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("the hub shows the Practice band, notable days with hidden dates, and starts the stub day", async ({ page }) => {
    const api = watchApi(page);
    await openDesk(page, "/practice");
    await expect(page.getByRole("status", { name: "Practice" })).toHaveText(practiceBandText(null));
    await expect(page.getByRole("heading", { name: "Start a practice session" })).toBeVisible();
    await expect(page.getByText(PRACTICE_COPY.notableHeader)).toBeVisible();

    // Dates stay masked until "Show dates" is on; the weekday is kept.
    const notable = page.locator("#notable-days");
    await expect(notable.getByText(PRACTICE_COPY.hiddenDay).first()).toBeVisible();
    await expect(notable).not.toContainText(/20\d\d-\d\d-\d\d/);
    await notable.getByRole("switch", { name: "Show dates" }).check();
    await expect(notable).toContainText(/20\d\d-\d\d-\d\d/);
    await expectCleanScreen(page);

    await startStubSession(page);
    await expect(page.getByRole("status", { name: "Practice" })).toHaveText(practiceBandText(DAY));
    await expectCleanScreen(page);
    expect(api.paths().filter((path) => path === "POST /api/desk/replay/sessions")).toHaveLength(1);
    expect(api.paths().filter((path) => LIVE_DATA.test(path)), "a replay screen never reads the live store").toEqual([]);
  });

  test("arming a saved alert strategy starts a session that lists it", async ({ page }) => {
    await openDesk(page, "/practice");
    const form = page.locator("#start-practice");
    await form.getByRole("combobox").fill("TSLA");
    await form.locator('input[type="date"]').fill(DAY);
    await form.getByLabel("To", { exact: true }).fill("09:40");
    await form.getByRole("checkbox", { name: /^ORB 15m/ }).check();
    await expect(form.getByText("1 armed")).toBeVisible();
    await form.getByRole("button", { name: "Start practice" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    // The armed list lives in the left rail (1440) or its collapsed strip (1180); the session itself says what it armed.
    const answer = await page.request.get(page.url().replace(/\/practice\/replay\?id=/, "/api/desk/replay/sessions/"));
    const body = (await answer.json()) as { armed: Array<{ name: string; fires_so_far: number }> };
    expect(body.armed.map((item) => item.name)).toEqual(["ORB 15m"]);
    await expectCleanScreen(page);
  });

  test("a hidden notable day keeps its date off the screen", async ({ page }) => {
    await openDesk(page, "/practice");
    const notable = page.locator("#notable-days");
    await notable.getByRole("button", { name: /^Practise TSLA$/ }).first().click();
    await expect(page.locator("#start-practice")).toContainText(PRACTICE_COPY.hiddenDay);
    await expect(page.locator("#start-practice").locator('input[type="date"]')).toHaveCount(0);
    await expectCleanScreen(page);
  });

  test("a day with no stored trades says so on the hub instead of opening a session", async ({ page }) => {
    await openDesk(page, "/practice");
    const form = page.locator("#start-practice");
    await form.getByRole("combobox").fill("NVDA");
    await form.locator('input[type="date"]').fill("2026-09-24");
    await form.getByRole("button", { name: "Start practice" }).click();
    await expect(form.getByRole("alert").first()).toBeVisible();
    await expect(page).toHaveURL(/\/practice$/);
    await expectCleanScreen(page);
  });

  test("play moves the playhead, step moves it one bar, and the shortcuts overlay opens on ?", async ({ page }) => {
    const answers = watchReplayAnswers(page);
    await startStubSession(page);
    const clock = playhead(page);
    await expect(clock).toContainText("9:30");

    // Space plays; key 4 picks 10x. The clock only ever moves forward.
    await page.keyboard.press("4");
    await page.keyboard.press("Space");
    await expect(page.getByText(practiceText("playing", { speed: 10 }))).toBeVisible();
    await expect(clock).not.toContainText("9:30:00", { timeout: 10_000 });
    await page.keyboard.press("Space");
    await expect(page.getByText(/^Paused at /)).toBeVisible();

    const before = await clock.innerText();
    await page.keyboard.press("ArrowRight");
    await expect(clock).not.toHaveText(before);

    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveCount(0);
    await expectCleanScreen(page);

    // Nothing the browser was told ever lies past the playhead it was told about (the owner's network-log check).
    expect(answers.length).toBeGreaterThan(0);
    for (const { path, body } of answers) {
      const through = body.revealed_through as string | undefined;
      if (!through) continue;
      const limit = Date.parse(through);
      for (const row of ((body.prints as { rows?: Array<[string, ...unknown[]]> } | undefined)?.rows ?? [])) {
        expect(Date.parse(row[0]), `${path}: a print after the playhead`).toBeLessThanOrEqual(limit);
      }
      for (const bar of (body.bars as Array<{ t: string }> | undefined) ?? []) {
        expect(Date.parse(bar.t) + 60_000, `${path}: a bar that has not closed`).toBeLessThanOrEqual(limit);
      }
      for (const signal of (body.signals as Array<{ bar_close: string }> | undefined) ?? []) {
        expect(Date.parse(signal.bar_close), `${path}: a signal that has not fired`).toBeLessThanOrEqual(limit);
      }
    }
  });

  test("B, T and X place practice marks; undo removes the last one; End and score opens the journal with the trade", async ({ page }) => {
    await startStubSession(page, { stopRequired: false });
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(playhead(page)).not.toContainText("9:30:00");

    // A practice long, priced at the replayed last price.
    await page.keyboard.press("b");
    await marksTab(page).click();
    const marks = page.getByRole("tabpanel");
    await expect(marks).toContainText("Practice long");

    // T opens the stop note; Enter saves it.
    await page.keyboard.press("t");
    const stop = page.getByRole("form", { name: "Stop note" });
    await expect(stop).toBeVisible();
    await stop.getByRole("textbox").fill("180");
    await stop.getByRole("button", { name: "Save" }).click();
    await expect(marks).toContainText("Practice stop");

    // Exit with X, take it back with undo, exit again.
    await page.keyboard.press("x");
    await expect(marks).toContainText("Practice exit");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.getByText(PRACTICE_COPY.undone)).toBeVisible();
    await expect(marks).not.toContainText("Practice exit");
    await page.keyboard.press("s"); // the opposite key exits an open long
    await expect(marks).toContainText("Practice exit");
    await expectCleanScreen(page);

    // Ending early asks first, then scores and opens the journal.
    await page.getByRole("button", { name: "End session…" }).click();
    await expect(page.getByText(PRACTICE_COPY.endEarlyWarning)).toBeVisible();
    await page.getByRole("button", { name: PRACTICE_COPY.endAndScore }).click();
    await page.waitForURL(JOURNAL_URL);

    await expect(page.getByRole("heading", { level: 1 })).toContainText("Practice journal");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("TSLA");
    await expect(page.getByRole("listitem").filter({ hasText: /^Trades/ })).toContainText("1");
    await expect(page.getByRole("table", { name: "Practice trades" }).getByRole("row")).toHaveCount(2); // header + the trade
    await expectCleanScreen(page);

    // Notes and the self-rating save through the one PATCH route.
    const details = await railSection(page, "Journal details", "Adherence");
    await details.getByLabel("Session notes").fill("Waited for the first pullback.");
    await details.getByRole("button", { name: "Save notes" }).click();
    await expect(details.getByText(PRACTICE_COPY.notesSaved)).toBeVisible();
    await details.getByRole("radio", { name: "4" }).click();
    await expect(details.getByRole("radio", { name: "4" })).toBeChecked();
  });

  test("a resumed session restores the playhead; the hub offers Resume", async ({ page }) => {
    await startStubSession(page);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const clock = playhead(page);
    await expect(clock).not.toContainText("9:30:00");
    const placed = await clock.innerText();

    await page.reload();
    await expect(page.getByRole("heading", { name: "TSLA", level: 1 })).toBeVisible();
    await expect(playhead(page)).toHaveText(placed);

    await openDesk(page, "/practice");
    const sessions = await railSection(page, "Practice sessions", "Resume");
    const resume = sessions.getByRole("article", { name: "Active practice session" });
    await expect(resume).toContainText("TSLA");
    await resume.getByRole("link", { name: "Resume" }).click();
    await page.waitForURL(SESSION_URL);
    await expect(playhead(page)).toHaveText(placed);
    await expectCleanScreen(page);
  });

  test("jump to the window end shows the end prompt, and the journal of an unfinished session stays open", async ({ page }) => {
    await startStubSession(page);
    await page.getByRole("button", { name: /^Jump/ }).click();
    await page.getByRole("menuitem", { name: /^To the window end/ }).click();
    await expect(page.getByRole("button", { name: PRACTICE_COPY.endAndScore })).toBeVisible();
    await expect(page.getByText(/^Session over/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Play" })).toBeDisabled();
    await expectCleanScreen(page);

    await page.getByRole("button", { name: PRACTICE_COPY.endAndScore }).click();
    await page.waitForURL(JOURNAL_URL);
    await expect(page.getByText(PRACTICE_COPY.noTradesJournal).first()).toBeVisible();
    await expectCleanScreen(page);
  });
});
