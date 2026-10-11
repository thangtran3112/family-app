import test from "node:test";
import assert from "node:assert/strict";
import { filterHubApps, getAppLaunch, hubApps } from "./apps.ts";

test("launcher search is case-insensitive and trims whitespace", () => {
  assert.deepEqual(filterHubApps(hubApps, "  vIbE  ", "all").map((app) => app.slug), ["vibe-trading"]);
  assert.equal(filterHubApps(hubApps, "   ", "all").length, hubApps.length);
});

test("search covers visible descriptions, data notes and tags", () => {
  assert.deepEqual(filterHubApps(hubApps, "SEC filings", "all").map((app) => app.slug), ["ai-hedge-fund"]);
  assert.deepEqual(filterHubApps(hubApps, "multi-agent", "all").map((app) => app.slug), ["tradingagents", "mirofish"]);
});

test("category and query intersect; an unmatched query returns no apps", () => {
  assert.deepEqual(filterHubApps(hubApps, "", "research").map((app) => app.slug), ["tradingagents", "vibe-trading"]);
  assert.deepEqual(filterHubApps(hubApps, "Vibe", "funds"), []);
  assert.deepEqual(filterHubApps(hubApps, "no such application", "all"), []);
});

test("planned Desk stays searchable but cannot be launched", () => {
  const [desk] = filterHubApps(hubApps, "Family Desk", "all");
  assert.equal(desk.kind, "planned");
  assert.equal(getAppLaunch(desk), null);
});

test("terminal launchers retain the hub routes and do not open a new tab", () => {
  for (const slug of ["tradingagents", "ai-hedge-fund"]) {
    const app = hubApps.find((entry) => entry.slug === slug)!;
    assert.equal(getAppLaunch(app)?.href, `/apps/${slug}`);
    assert.equal(getAppLaunch(app)?.newTab, false);
  }
});

test("web app launchers use their actual configured URL in a new tab", () => {
  for (const app of hubApps.filter((entry) => entry.kind === "external")) {
    assert.equal(getAppLaunch(app)?.href, app.url);
    assert.equal(getAppLaunch(app)?.newTab, true);
  }
});
