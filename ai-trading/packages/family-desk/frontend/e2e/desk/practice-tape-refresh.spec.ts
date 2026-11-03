import type { CDPSession, Page } from "@playwright/test";
import { origin } from "../helpers";
import { expect, prepareDesk, test } from "./helpers";
import { openNameFromScreen } from "./lane-helpers";

// D-212: a busy tape at 10x still cost long tasks. The left rail's tape panel redrew on every ~2 s poll that brought prints, and each redraw was dear three ways:
// every row was formatted with `toLocaleString` (a new Intl.NumberFormat per call, 240 a poll), once the tape was capped (the latest 500 of N) the place-based row keys
// changed for all 120 rows (a remount of the whole table), and the table measured its columns again (forced layouts) because its column list changed identity with
// its rows. The live page landed a 50 to 317 ms task on nearly every poll; the stub day (TSLA's first ten minutes: 100,000 prints) is busy enough to show it.
//
// The page watches its own long tasks (50 ms or more on the main thread) and long animation frames (the same line, counting the style and layout after the scripts).
// The rig's machine is quicker than the live one, so the main thread runs SLOWDOWN times slower, as a loaded machine would. The thread's clock runs
// through its route, the way the Summary's Play does, and the chart and the tape follow it on their own.

const SYMBOL = "XOM"; // a name no other spec opens on its own: the server keeps the prepared bars of every name it has served
/** The longest single task a poll may cost, ms: the browser calls anything past 50 ms a long task. */
const POLL_TASK_CEILING_MS = 50;
/** Long animation frames (50 ms or more, style and layout included) the 40 s may hold: the old page had 17 at this slowdown, the page now 0 to 2. */
const RUN_FRAMES_CEILING = 5;
const RUN_MS = 40_000;
/** The live page's machine is slower than the rig's (a loaded laptop, a phone-class core): the main thread runs this many times slower. */
const SLOWDOWN = 4;

type Watched = Window & { __tasks?: number[]; __frames?: number[] };

const watch = (page: Page) =>
  page.evaluate(() => {
    const tasks: number[] = [];
    const frames: number[] = [];
    (window as Watched).__tasks = tasks;
    (window as Watched).__frames = frames;
    new PerformanceObserver((list) => list.getEntries().forEach((entry) => tasks.push(Math.round(entry.duration)))).observe({ entryTypes: ["longtask"] });
    // A long animation frame (50 ms or more from the first task to the paint) counts the style and layout work after the scripts, which a long task does not.
    new PerformanceObserver((list) => list.getEntries().forEach((entry) => frames.push(Math.round(entry.duration)))).observe({ type: "long-animation-frame" });
  });
const drain = (page: Page) => page.evaluate(() => (window as Watched).__tasks!.splice(0));
const drainFrames = (page: Page) => page.evaluate(() => (window as Watched).__frames!.splice(0));
/** Main-thread time spent in tasks so far, ms (the browser's own `TaskDuration`): it counts the work under 50 ms that a long-task observer cannot see. */
const busy = async (cdp: CDPSession) => Math.round(((await cdp.send("Performance.getMetrics")).metrics.find((metric) => metric.name === "TaskDuration")?.value ?? 0) * 1000);

test("a busy tape at 10x costs the page no task over 50 ms, on All and on Big only (D-212)", async ({ page, context }, testInfo) => {
  test.setTimeout(240_000);
  await prepareDesk(context);
  const thread = await openNameFromScreen(page, context, SYMBOL);
  const tape = page.getByTestId("tape-panel");
  const rows = tape.getByRole("table", { name: "Time and sales" }).locator("tbody tr");
  const control = (data: Record<string, unknown>) => context.request.post(`${origin}/api/desk/replay/threads/${thread}/clock`, { data });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await watch(page);

  // The clock runs ten market seconds a second; the first polls fill the tape past its 500-print cap and then every poll slides it.
  expect((await control({ speed: 10 })).ok()).toBeTruthy();
  expect((await control({ running: true })).ok()).toBeTruthy();
  await expect(tape.getByText(/Fast tape · showing the latest 500 of/)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => rows.count(), { message: "the tape shows its 120 newest prints" }).toBe(120);
  await page.waitForTimeout(2500); // the fill's own work settles
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: SLOWDOWN });
  await drain(page);
  await drainFrames(page);

  const measured: Record<string, unknown> = {};
  const measure = async (label: string) => {
    const before = await busy(cdp);
    await page.waitForTimeout(RUN_MS);
    const tasks = await drain(page);
    const frames = await drainFrames(page);
    const spent = (await busy(cdp)) - before;
    measured[label] = { longTasks: tasks, longFrames: frames, mainThreadMs: spent };
    console.log(`D-212 ${label}: long tasks ${JSON.stringify(tasks)} ms, long frames ${JSON.stringify(frames)} ms, main thread busy ${spent} ms`);
    return { tasks, frames, spent };
  };

  const all = await measure("tape on All");
  expect.soft(Math.max(0, ...all.tasks), `tape on All: the longest task at 10x, ms (${JSON.stringify(all.tasks)})`).toBeLessThan(POLL_TASK_CEILING_MS);
  expect.soft(all.frames.length, `tape on All: long frames in ${RUN_MS / 1000} s at 10x (${JSON.stringify(all.frames)} ms)`).toBeLessThanOrEqual(RUN_FRAMES_CEILING);

  await tape.getByRole("button", { name: "Big only" }).click();
  await expect(tape.getByRole("button", { name: "Big only" })).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(2500);
  await drain(page);
  await drainFrames(page);
  const big = await measure("tape on Big only");
  expect.soft(Math.max(0, ...big.tasks), `tape on Big only: the longest task at 10x, ms (${JSON.stringify(big.tasks)})`).toBeLessThan(POLL_TASK_CEILING_MS);
  expect.soft(big.frames.length, `tape on Big only: long frames in ${RUN_MS / 1000} s at 10x (${JSON.stringify(big.frames)} ms)`).toBeLessThanOrEqual(RUN_FRAMES_CEILING);

  expect((await control({ running: false })).ok()).toBeTruthy();
  testInfo.annotations.push({ type: "D-212 measured (ms)", description: JSON.stringify(measured) });
});
