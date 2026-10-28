'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const sessions = new Map([['marmoset:cloudSession', JSON.stringify({ access_token: 'synthetic', refresh_token: 'synthetic-refresh', expires_at: Date.now() + 3600000 })]]);
  const requests = [], timers = new Map();
  let nextTimer = 0;
  const context = { AbortController, DOMException, console,
    CLOUD_CONFIG: { url: 'https://example.invalid', anonKey: 'synthetic', requestTimeoutMs: 1000 },
    localStorage: { getItem: key => sessions.get(key) || null, setItem: (key, value) => sessions.set(key, value), removeItem: key => sessions.delete(key) },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  const state = { fetch: async () => { throw new Error('No response fixture'); } };
  context.fetch = (url, options) => { requests.push({ url, options }); return state.fetch(url, options); };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/cloud.js'), 'utf8'), context);
  return { cloud: context.Cloud, requests, state, timers, sessions, expire() { assert.equal(timers.size, 1); [...timers.values()][0].callback(); } };
}
function response(rows, range, status = 200) {
  return new Response(JSON.stringify(rows), { status, headers: range == null ? {} : { 'Content-Range': range } });
}
function records(count) { return Array.from({ length: count }, (_, i) => ({ id: 'p-' + String(i).padStart(5, '0'), updated_at: 'revision-' + i })); }

test('complete cloud inventory includes rows beyond the ordinary server cap with stable ID pagination', async () => {
  const f = fixture(), expected = records(1251);
  f.state.fetch = async (url, options) => {
    const query = new URL(url).searchParams, offset = Number(query.get('offset')), limit = Number(query.get('limit'));
    assert.equal(query.get('select'), '*'); assert.equal(query.get('order'), 'id.asc');
    assert.ok(limit > 0 && limit <= 200);
    assert.equal(options.headers.Prefer, 'count=exact');
    assert.equal(options.headers.Authorization, 'Bearer synthetic');
    const rows = expected.slice(offset, offset + limit);
    return response(rows, offset + '-' + (offset + rows.length - 1) + '/' + expected.length, 206);
  };
  assert.deepEqual(Array.from(await f.cloud.listAllProjects()), expected);
  assert.equal(f.requests.length, 7);
  assert.equal(f.timers.size, 0);
});

test('complete inventory advances by actual returned rows when server cap is lower than requested size', async () => {
  const f = fixture(), expected = records(251), offsets = [];
  f.state.fetch = async url => {
    const query = new URL(url).searchParams, offset = Number(query.get('offset')), requested = Number(query.get('limit'));
    offsets.push(offset);
    const rows = expected.slice(offset, offset + Math.min(100, requested));
    return response(rows, offset + '-' + (offset + rows.length - 1) + '/251');
  };
  assert.deepEqual(Array.from(await f.cloud.listAllProjects()), expected);
  assert.deepEqual(offsets, [0, 100, 200]);
});

test('empty cloud inventory requires an exact verified zero count', async () => {
  const f = fixture(); f.state.fetch = async () => response([], '*/0');
  assert.deepEqual(Array.from(await f.cloud.listAllProjects()), []);
  assert.equal(f.requests.length, 1);
  for (const range of [null, '*/*', '*/1', '0-0/0']) {
    const invalid = fixture(); invalid.state.fetch = async () => response([], range);
    await assert.rejects(invalid.cloud.listAllProjects(), /全データ一覧を確認できません/);
  }
});

test('cloud inventory rejects unknown totals, malformed ranges, gaps, inconsistent lengths, and oversized pages', async () => {
  const cases = [
    [records(2), null], [records(2), '0-1/*'], [records(2), 'items 0-1/3'],
    [records(2), '1-2/3'], [records(2), '0-2/3'], [records(2), '0-1/1'],
    [records(201), '0-200/300'], [{ id: 'not-an-array' }, '0-0/1'],
    [records(1), '0-0/9007199254740992'], [records(1), '0-0/10001'],
  ];
  for (const [rows, range] of cases) {
    const f = fixture(); f.state.fetch = async () => response(rows, range);
    await assert.rejects(f.cloud.listAllProjects(), /全データ一覧を確認できません/);
    assert.equal(f.requests.length, 1);
  }
});

test('cloud inventory rejects changed totals and duplicate or missing IDs across pages', async () => {
  const cases = [
    { rows: [{ id: 'c' }], range: '2-2/4' },
    { rows: [{ id: 'b' }], range: '2-2/3' },
    { rows: [{}], range: '2-2/3' },
    { rows: [], range: '*/0' },
    { rows: [{ id: 'c' }], range: '3-3/4' },
  ];
  for (const next of cases) {
    const f = fixture(); let call = 0;
    f.state.fetch = async () => ++call === 1 ? response([{ id: 'a' }, { id: 'b' }], '0-1/3') : response(next.rows, next.range);
    await assert.rejects(f.cloud.listAllProjects(), /全データ一覧を確認できません/);
    assert.equal(f.requests.length, 2);
  }
  const samePage = fixture(); samePage.state.fetch = async () => response([{ id: 'a' }, { id: 'a' }], '0-1/2');
  await assert.rejects(samePage.cloud.listAllProjects(), /ID が重複/);
});

test('a failed later inventory page never returns the successful subset', async () => {
  const f = fixture(); let call = 0;
  f.state.fetch = async () => ++call === 1 ? response([{ id: 'a' }], '0-0/2') : new Response('unavailable', { status: 503 });
  await assert.rejects(f.cloud.listAllProjects(), error => error.status === 503);
  assert.equal(f.requests.length, 2); assert.equal(f.cloud.signedIn(), true);
});

test('full inventory retains the existing request-body deadline and authentication retry', async () => {
  const stalled = fixture(); let transportSignal;
  stalled.state.fetch = async (_, options) => {
    transportSignal = options.signal;
    return { ok: true, status: 200, headers: { get: () => '0-0/1' }, json: () => new Promise(() => {}) };
  };
  const pending = assert.rejects(stalled.cloud.listAllProjects(), error => error.code === 'CLOUD_TIMEOUT');
  await tick(); stalled.expire(); await pending;
  assert.equal(transportSignal.aborted, true); assert.equal(stalled.cloud.signedIn(), true);
  const retried = fixture(); let reads = 0;
  retried.state.fetch = async url => {
    if (url.includes('/auth/')) return new Response(JSON.stringify({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 3600 }));
    return ++reads === 1 ? new Response('unauthorized', { status: 401 }) : response([{ id: 'a' }], '0-0/1');
  };
  assert.deepEqual(Array.from(await retried.cloud.listAllProjects()), [{ id: 'a' }]);
  assert.equal(reads, 2); assert.equal(retried.requests[2].options.headers.Authorization, 'Bearer new-token');
  assert.equal(retried.timers.size, 0);
});

test('full inventory stops between pages on cancellation and leaves the ordinary list API unchanged', async () => {
  const f = fixture(), controller = new AbortController();
  f.state.fetch = async () => { controller.abort(); return response([{ id: 'a' }], '0-0/2'); };
  await assert.rejects(f.cloud.listAllProjects({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.requests.length, 1);
  const initial = fixture();
  await assert.rejects(initial.cloud.listAllProjects({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(initial.requests.length, 0);
  const ordinary = fixture(); ordinary.state.fetch = async () => response([{ id: 'a' }], null);
  assert.deepEqual(Array.from(await ordinary.cloud.listProjects()), [{ id: 'a' }]);
  assert.equal(new URL(ordinary.requests[0].url).searchParams.get('order'), 'updated_at.desc');
  assert.equal(ordinary.requests[0].options.headers.Prefer, undefined);
});
