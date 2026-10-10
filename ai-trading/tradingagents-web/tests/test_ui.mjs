import test from 'node:test';
import assert from 'node:assert/strict';
import { apiPath, routeFor } from '../ta_web/static/app.mjs';

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
