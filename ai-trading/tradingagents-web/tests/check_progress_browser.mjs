// Opt-in offline DOM regression check. Reuses an installed playwright-core;
// adds no application dependency and never reaches a live service/provider.
// PLAYWRIGHT_CORE_PATH=/path/to/playwright-core/index.mjs \
// PLAYWRIGHT_CHROME_EXECUTABLE=/path/to/isolated-browser node tests/check_progress_browser.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_CORE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_CORE_PATH).href : 'playwright-core');
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROME_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROME_EXECUTABLE } : {}),
});
const staticFiles = Object.fromEntries(await Promise.all(['index.html', 'app.mjs', 'app.css'].map(async name => [
  name, await readFile(new URL(`../ta_web/static/${name}`, import.meta.url), 'utf8'),
])));
const id = 'b3f34c8d-5cbd-49cf-a7b5-d7a2d65b1d39';
const started = Date.now() - 300_000;
let mode = 'running';
let reads = 0;
let writes = 0;
const iso = value => new Date(value).toISOString();
const record = () => ({
  id, origin: 'web', status: mode === 'completed' ? 'completed' : mode === 'failed' ? 'failed' : 'running',
  stage: mode === 'failed-publishing' ? 'exporting' : 'risk', created_at: iso(started), updated_at: iso(started + 20_000),
  heartbeat_at: iso(Date.now() - 1000), last_progress_at: iso(mode === 'stalled' ? Date.now() - 181_000 : started + 285_000),
  ended_at: mode === 'completed' || mode === 'failed' ? iso(started + 290_000) : null,
  shared: false, partial: mode === 'failed' || mode === 'failed-publishing', artifacts_ready: mode === 'failed',
  error_code: mode === 'failed' || mode === 'failed-publishing' ? 'RESEARCH_FAILED' : null,
  inputs: { ticker: 'SPY', analysis_date: '2026-10-09', asset_type: 'stock', analysts: ['market'], research_depth: 1 },
  state: { market_report: 'saved-analysis-fixture' }, settings: {}, can_share: true, can_rerun: true,
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // A skewed laptop clock must not falsely report a stale worker.
  await page.addInitScript(() => {
    const realNow = Date.now;
    Date.now = () => realNow() + 3_600_000;
  });
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.hostname, 'research.test', 'offline check attempted an external request');
    if (request.method() !== 'GET') writes += 1;
    const prefix = url.pathname.startsWith('/u/tradingagents/') ? '/u/tradingagents' : '';
    const path = url.pathname.slice(prefix.length);
    const headers = { date: new Date().toUTCString() };
    if (path.startsWith('/api/research')) {
      reads += 1;
      if (path.includes('/report')) return route.fulfill({ body: '<p>saved-analysis-fixture</p>', contentType: 'text/html', headers });
      if (mode === 'offline') return route.abort('internetdisconnected');
      if (mode === 'unauthorized') return route.fulfill({ status: 401, json: { error: 'UNAUTHENTICATED' }, headers });
      if (mode === 'malformed') return route.fulfill({ json: {}, headers });
      const json = path === '/api/research'
        ? { items: [record()], owner_id: 'a'.repeat(64), limit: 25, offset: 0, today: '2026-10-11', defaults: {} }
        : record();
      return route.fulfill({ json, headers });
    }
    const name = path.split('/').at(-1);
    if (name === 'app.mjs' || name === 'app.css') return route.fulfill({
      body: staticFiles[name], contentType: name === 'app.mjs' ? 'text/javascript' : 'text/css', headers,
    });
    if (path.includes('/research')) return route.fulfill({
      body: staticFiles['index.html'].replaceAll('__APP_PREFIX__', prefix), contentType: 'text/html', headers,
    });
    return route.fulfill({ status: 204 });
  });

  await page.goto(`http://research.test/research/${id}`);
  await page.locator('.progress-metrics').waitFor({ timeout: 2000 });
  assert.match(await page.locator('.progress-metrics').innerText(), /elapsed.*heartbeat/is);
  assert.doesNotMatch(await page.locator('.progress-metrics').innerText(), /Elapsed: 6\dm/);
  assert.equal(await page.locator('.progress-panel').getAttribute('data-tone'), 'running');
  assert.notEqual(await page.locator('.progress-panel').evaluate(el => getComputedStyle(el).animationName), 'none');
  if (process.env.UI_DETAIL_SCREENSHOT_PATH) await page.screenshot({ path: process.env.UI_DETAIL_SCREENSHOT_PATH, fullPage: true });

  const rerun = page.getByRole('button', { name: 'Run again', exact: true });
  await rerun.focus();
  await rerun.evaluate(el => { window.savedFocusedButton = el; });
  const nextPoll = page.waitForResponse(response => response.url().includes('/api/research/'));
  await nextPoll;
  assert.equal(await page.evaluate(() => window.savedFocusedButton.isConnected
    && document.activeElement === window.savedFocusedButton), true, 'heartbeat polling destroyed focus');

  mode = 'malformed';
  await page.locator('.connection-warning').waitFor({ timeout: 7000 });
  assert.equal(await page.locator('.report-text').innerText(), 'saved-analysis-fixture', 'malformed status response replaced authorized research');
  mode = 'running';
  await page.locator('.connection-warning').waitFor({ state: 'detached' });

  mode = 'stalled';
  await page.waitForFunction(() => document.querySelector('.progress-panel')?.dataset.tone === 'warning');
  assert.match(await page.locator('.progress-message').innerText(), /no new research activity/i);
  assert.equal(await page.locator('.badge-running').count(), 1, 'warning invented a terminal result');
  assert.equal(await page.locator('progress').isVisible(), false, 'warning still animated an active progress bar');

  mode = 'running';
  await page.waitForFunction(() => document.querySelector('.progress-panel')?.dataset.tone === 'running');
  assert.equal(await page.locator('progress').isVisible(), true);

  mode = 'offline';
  await page.locator('.connection-warning').waitFor();
  assert.equal(await page.locator('.report-text').innerText(), 'saved-analysis-fixture');
  assert.equal(await page.locator('.progress-panel').getAttribute('data-tone'), 'disconnected');
  assert.equal(await page.locator('progress').isVisible(), false, 'connection loss still animated active progress');
  const beforeReconnect = reads;
  mode = 'running';
  await page.locator('.connection-warning').waitFor({ state: 'detached' });
  assert.ok(reads > beforeReconnect, 'connection recovery never retried the read');
  assert.equal(writes, 0, 'connection recovery submitted a mutation or model rerun');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.progress-panel').evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.equal(await page.locator('progress').isVisible(), false, 'reduced motion still showed the native animated progress bar');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  mode = 'unauthorized';
  await page.locator('.error-state').waitFor();
  assert.equal(await page.locator('.report-text').count(), 0, 'authorization loss retained private report text');
  assert.equal(await page.getByRole('button', { name: 'Run again', exact: true }).count(), 0);

  mode = 'failed-publishing';
  await page.goto(`http://research.test/research/${id}`);
  await page.locator('.progress-message').waitFor();
  assert.match(await page.locator('.progress-message').innerText(), /error.*preparing/is);
  assert.equal(await page.locator('.progress-panel.is-running').count(), 0);
  mode = 'failed';
  await page.waitForFunction(() => document.querySelector('.badge-failed'));
  assert.match(await page.locator('.progress-message').innerText(), /saved analysis/i);
  assert.equal(await page.locator('.badge-failed').count(), 1);
  assert.equal(await page.locator('.report-text').innerText(), 'saved-analysis-fixture');
  assert.equal(await page.locator('.download-links a').count(), 3, 'error finalization stopped before downloads became available');

  mode = 'completed';
  await page.goto(`http://research.test/u/tradingagents/research/${id}`);
  await page.waitForFunction(() => document.querySelector('.progress-panel')?.dataset.tone === 'completed');
  assert.equal(await page.locator('.progress-panel.is-running').count(), 0);
  assert.equal(await page.locator('.badge-completed').count(), 1);
  assert.equal(await page.locator('progress').isVisible(), false, 'completed research still showed a running progress bar');

  mode = 'running';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://research.test/u/tradingagents/research');
  await page.locator('.research-card .task-activity').waitFor();
  assert.match(await page.locator('.research-card .task-activity').innerText(), /elapsed/i);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  if (process.env.UI_SCREENSHOT_PATH) await page.screenshot({ path: process.env.UI_SCREENSHOT_PATH, fullPage: true });
  console.log(JSON.stringify({
    result: 'PASS', heartbeatFocus: true, noProgressWarning: true, connectionRecovery: true,
    authLossClearsPrivateState: true, failurePreservesAnalysis: true, reducedMotion: true,
    prefixCompletion: true, mobileHistory: true, automaticMutations: writes,
    malformedResponseRetainsSnapshot: true,
    partialDownloadsAfterError: true,
  }));
} finally {
  await browser.close();
}
