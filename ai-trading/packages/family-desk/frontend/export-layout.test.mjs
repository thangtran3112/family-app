import test from "node:test";
import { access } from "node:fs/promises";

test("static export contains the Desk entry point and Next assets", async () => {
  await access(new URL("./out/index.html", import.meta.url));
  await access(new URL("./out/_next/", import.meta.url));
});

// D-010: the browser asks for /favicon.ico on every load, so the export ships one (and the SVG its <link> points at).
test("static export ships the favicon", async () => {
  await access(new URL("./out/favicon.ico", import.meta.url));
  await access(new URL("./out/icon.svg", import.meta.url));
});

// Every route of the desktop MVP (02m §c1) plus the accepted legacy routes ships as a page.
const routes = [
  "today",
  "technicals",
  "watchlists",
  "screener",
  "screener/filters",
  "strategies",
  "strategies/new",
  "strategies/library",
  "alerts",
  "alerts/new",
  "practice",
  "practice/replay",
  "practice/journal",
  "practice/day",
  "practice/week",
  "settings",
  "more",
  "holdings",
  "covered-calls",
  "stocks",
  "paper",
  "backtests",
  "ask",
  "futures",
  "futures/specs",
];

for (const route of routes) {
  test(`static export contains /${route}`, async () => {
    await access(new URL(`./out/${route}.html`, import.meta.url));
  });
}
