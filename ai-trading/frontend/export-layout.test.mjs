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
  await assert.rejects(access(new URL("./out/apps/desk.html", import.meta.url)), { code: "ENOENT" });
});

test("exported navigation preserves hub details and safe external app links", async () => {
  const data = pageData(await page("index.html"));
  for (const slug of ["tradingagents", "ai-hedge-fund", "vibe-trading", "mirofish"]) {
    assert.ok(data.includes(`"href":"/apps/${slug}"`));
  }
  for (const slug of ["vibe-trading", "mirofish"]) {
    const app = pageData(await page(`apps/${slug}.html`));
    assert.ok(app.includes(`"href":"https://${slug}.tobytran.dev"`));
    assert.ok(app.includes('"target":"_blank"'));
    assert.ok(app.includes('"rel":"noopener"'));
  }
  assert.ok(!data.includes('"href":"/apps/desk"'));
});

test("terminal detail exports actual terminal destinations, not illustrative Paper content", async () => {
  for (const slug of ["tradingagents", "ai-hedge-fund"]) {
    const data = pageData(await page(`apps/${slug}.html`));
    assert.ok(data.includes(`"terminalPath":"/u/${slug}/"`));
    assert.ok(data.includes(`"hostUrl":"https://${slug}.tobytran.dev/"`));
    assert.doesNotMatch(data, /Enter ticker symbol:|Example state|Bull \/ bear debate/);
  }
});
