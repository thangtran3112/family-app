import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const page = (path) => readFile(new URL(`./out/${path}`, import.meta.url), "utf8");

// Clerk intentionally renders only a loading shell during static prerender.
// Next's page data contains the server tree and client-component props that
// hydrate after sign-in; browser QA covers the resulting interactive DOM.
function pageData(html) {
  return [...html.matchAll(/<script[^>]*>(.*?)<\/script>/gs)]
    .map(([, script]) => script.match(/^self\.__next_f\.push\((.*)\)$/s))
    .filter(Boolean)
    .map((match) => JSON.parse(match[1]))
    .filter((chunk) => chunk[0] === 1)
    .map((chunk) => chunk[1])
    .join("");
}

test("exported overview contains the approved shell without bypassing the auth loading state", async () => {
  const html = await page("index.html");
  const data = pageData(html);
  assert.match(html, /Loading secure workspace/);
  assert.match(data, /Your research workspace\./);
  assert.ok(data.includes('"aria-label":"Workspace"'));
  assert.ok(data.includes('"href":"#main-content"'));
  assert.ok(data.includes('"id":"main-content"'));
  await access(new URL("./out/apps/desk.html", import.meta.url));
});

test("exported navigation preserves hub details and adds the Desk", async () => {
  const data = pageData(await page("index.html"));
  for (const slug of ["tradingagents", "ai-hedge-fund", "vibe-trading", "mirofish", "desk"]) {
    assert.ok(data.includes(`"href":"/apps/${slug}"`));
  }
});

test("terminal detail exports actual terminal destinations, not illustrative Paper content", async () => {
  for (const slug of ["tradingagents", "ai-hedge-fund"]) {
    const data = pageData(await page(`apps/${slug}.html`));
    assert.ok(data.includes(`"terminalPath":"/u/${slug}/"`));
    assert.ok(data.includes(`"hostUrl":"https://${slug}.tobytran.dev/"`));
    assert.doesNotMatch(data, /Enter ticker symbol:|Example state|Bull \/ bear debate/);
  }
});

test("exported Settings route keeps the Clerk loading shell and wires in the app-controls components", async () => {
  // AppControlsPanel/-Provider are "use client": like the rest of this app's
  // authenticated tree, their own rendered JSX (status words, copy) is never
  // part of the static server payload, only their module reference and
  // props are -- Clerk gates everything behind the same loading shell until
  // a real browser session exists, which is what the next test's "never a
  // literal status word" check actually relies on (not a load-state race).
  const html = await page("settings.html");
  const data = pageData(html);
  assert.match(html, /Loading secure workspace/);
  assert.ok(data.includes("AppControlsProvider"));
  assert.ok(data.includes("AppControlsPanel"));
});

test("exported Settings route never bakes a live app status into the static payload", async () => {
  // No build-time Clerk session exists, so there is no real ControlsState
  // to leak; this guards against a future default/fallback snapshot ever
  // being rendered server-side instead of staying behind the client gate.
  const data = pageData(await page("settings.html"));
  assert.doesNotMatch(data, /\bRunning\b|\bStopping\b|\bStopped\b|\bUnhealthy\b/);
});

test("exported navigation exposes a Settings route alongside the four apps", async () => {
  const data = pageData(await page("index.html"));
  assert.ok(data.includes('"href":"/settings"'));
});

test("exported external-app launch destinations are real configuration props, not conditional launch HTML", async () => {
  // Controller ruling (common-context.md): static assertions verify trusted
  // configuration props/loading, not unconditional Running/Launch HTML.
  // ExternalLaunch is "use client" (it needs live controls state), so its
  // rendered anchor never reaches the static payload -- only the `app` prop
  // passed into it does, which is what actually proves the real destination
  // made it into the build, not a Paper mockup placeholder.
  for (const slug of ["vibe-trading", "mirofish"]) {
    const data = pageData(await page(`apps/${slug}.html`));
    assert.ok(data.includes(`"url":"https://${slug}.tobytran.dev"`));
  }
  const desk = pageData(await page("apps/desk.html"));
  assert.ok(desk.includes('"url":"https://trading.tobytran.dev/"'));
});
