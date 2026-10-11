import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apiPath, routeFor, isListRefresh, shouldRebuildListShell,
  researchProgress, retryableReadError, runFailureMessage,
} from '../ta_web/static/app.mjs';

test('research routes retain trusted deployment prefix', () => {
  const id = 'b3f34c8d-5cbd-49cf-a7b5-d7a2d65b1d39';
  assert.deepEqual(routeFor(`/u/tradingagents/research/${id}`, '/u/tradingagents'), { kind: 'detail', id });
  assert.equal(apiPath('/u/tradingagents', `/research/${id}`), `/u/tradingagents/api/research/${id}`);
  assert.deepEqual(routeFor('/u/tradingagents/research/', '/u/tradingagents'), { kind: 'list' });
  assert.throws(() => routeFor('/u/tradingagents-evil/research', '/u/tradingagents'));
});

test('root deployment keeps research paths at root', () => {
  assert.deepEqual(routeFor('/research', ''), { kind: 'list' });
  assert.deepEqual(routeFor('/research/', ''), { kind: 'list' });
  assert.equal(apiPath('', '/research?limit=25&offset=0'), '/api/research?limit=25&offset=0');
});

test('route helpers reject malformed prefixes and unsafe API suffixes', () => {
  assert.throws(() => routeFor('/research', '/u/tradingagents/../evil'));
  assert.throws(() => apiPath('/u/tradingagents', '//evil.example/api'));
  assert.throws(() => apiPath('/u/tradingagents', '/../api/research'));
});

test('isListRefresh only keeps the list shell mounted for a list-to-list navigation', () => {
  assert.equal(isListRefresh({ kind: 'list' }, { kind: 'list' }), true);
  assert.equal(isListRefresh({ kind: 'detail', id: 'x' }, { kind: 'list' }), false);
  assert.equal(isListRefresh({ kind: 'list' }, { kind: 'detail', id: 'x' }), false);
  assert.equal(isListRefresh(undefined, { kind: 'list' }), false);
});

test('shouldRebuildListShell rebuilds the owner-specific shell whenever the response owner differs', () => {
  assert.equal(shouldRebuildListShell(undefined, 'owner-a'), true);
  assert.equal(shouldRebuildListShell('owner-a', 'owner-a'), false);
  assert.equal(shouldRebuildListShell('owner-a', 'owner-b'), true);
  assert.equal(shouldRebuildListShell('owner-a', ''), true);
  assert.equal(shouldRebuildListShell('', 'owner-a'), true);
});

const now = Date.parse('2026-10-11T10:05:00Z');
const running = {
  status: 'running', stage: 'risk', created_at: '2026-10-11T10:00:00Z',
  last_progress_at: '2026-10-11T10:04:30Z', heartbeat_at: '2026-10-11T10:04:55Z',
};

test('recent heartbeat and research progress show active work with honest elapsed time', () => {
  const progress = researchProgress(running, now);
  assert.equal(progress.elapsedSeconds, 300);
  assert.equal(progress.progressAgeSeconds, 30);
  assert.equal(progress.heartbeatAgeSeconds, 5);
  assert.equal(progress.tone, 'running');
  assert.match(progress.label, /risk/i);
});

test('heartbeat and sharing changes never hide a three-minute no-progress warning', () => {
  const progress = researchProgress({
    ...running, last_progress_at: '2026-10-11T10:02:00Z', updated_at: '2026-10-11T10:05:00Z',
  }, now);
  assert.equal(progress.progressAgeSeconds, 180);
  assert.equal(progress.tone, 'warning');
  assert.match(progress.warning, /no new research activity/i);
  assert.equal(researchProgress({ ...running, last_progress_at: '2026-10-11T10:02:01Z' }, now).tone, 'running');
});

test('stale heartbeat warns without inventing a failed or completed result', () => {
  const progress = researchProgress({ ...running, heartbeat_at: '2026-10-11T10:04:30Z' }, now);
  assert.equal(progress.tone, 'warning');
  assert.match(progress.warning, /heartbeat/i);
  assert.equal(running.status, 'running');
});

test('saved runs without heartbeat metadata remain readable and completed timers stop', () => {
  const progress = researchProgress({
    status: 'completed', created_at: '2026-10-11T10:00:00Z', updated_at: '2026-10-11T10:02:00Z',
    ended_at: '2026-10-11T10:02:00Z',
  }, now);
  assert.equal(progress.elapsedSeconds, 120);
  assert.equal(progress.tone, 'completed');
  assert.equal(progress.warning, '');
  assert.equal(progress.heartbeatAgeSeconds, null);
});

test('sharing a completed run does not increase its recorded research duration', () => {
  const progress = researchProgress({
    ...running, status: 'completed', last_progress_at: '2026-10-11T10:02:00Z',
    ended_at: '2026-10-11T10:02:00Z',
    updated_at: '2026-10-11T10:05:00Z', shared: true,
  }, now);
  assert.equal(progress.elapsedSeconds, 120);
});

test('failed-run duration stops at failure rather than a later sharing change', () => {
  const progress = researchProgress({
    ...running, status: 'failed', ended_at: '2026-10-11T10:02:00Z', updated_at: '2026-10-11T10:05:00Z',
  }, now);
  assert.equal(progress.elapsedSeconds, 120);
  assert.equal(researchProgress({ status: 'completed', created_at: running.created_at }, now).elapsedSeconds, null);
});

test('only transient read failures retry; authorization loss clears private state', () => {
  for (const status of [0, 408, 429, 500, 502, 503]) assert.equal(retryableReadError({ status }), true);
  for (const status of [400, 401, 403, 404, 422]) assert.equal(retryableReadError({ status }), false);
  assert.equal(retryableReadError(new TypeError('offline')), true);
});

test('failure explanations are helpful without exposing arbitrary backend errors', () => {
  assert.match(runFailureMessage({ status: 'failed', error_code: 'LAUNCH_FAILED' }), /start/i);
  assert.match(runFailureMessage({ status: 'failed', error_code: 'EXPORT_FAILED' }), /download/i);
  assert.match(runFailureMessage({ status: 'interrupted' }), /interrupted/i);
  assert.doesNotMatch(runFailureMessage({ status: 'failed', error_code: 'secret-sentinel' }), /secret-sentinel/);
});
