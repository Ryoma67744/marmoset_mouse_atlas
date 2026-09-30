'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const values = new Map(), timers = new Map(), events = new Map();
  let nextTimer = 0;
  values.set('marmoset:cloudSession', JSON.stringify({ access_token: 'synthetic', refresh_token: 'synthetic-refresh', expires_at: Date.now() + 3600000 }));
  const c = { console, Blob, AbortController,
    CLOUD_CONFIG: { url: 'https://example.invalid', anonKey: 'synthetic', requestTimeoutMs: 1000 },
    localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    addEventListener: (name, callback) => events.set(name, callback),
  };
  c.window = c; vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/cloud.js'), 'utf8'), c);
  return { c, values, timers, events,
    expire() { assert.equal(timers.size, 1); [...timers.values()][0].callback(); },
    expiredSession() { const session = JSON.parse(values.get('marmoset:cloudSession')); session.expires_at = 0; values.set('marmoset:cloudSession', JSON.stringify(session)); },
  };
}

test('stalled cloud reads terminate, abort the transport and preserve the session', async () => {
  const f = fixture(); let signal;
  f.c.fetch = async (_, options) => { signal = options.signal; return new Promise(() => {}); };
  const reading = f.c.Cloud.listProjects();
  const failed = assert.rejects(reading, error => error.code === 'CLOUD_TIMEOUT' && error.outcomeUnknown === false);
  await tick(); f.expire(); await failed;
  assert.equal(signal.aborted, true);
  assert.equal(f.c.Cloud.signedIn(), true);
  assert.equal(f.timers.size, 0);
});

test('a deadline includes the response body and an interrupted write has unknown outcome', async () => {
  const f = fixture(); let signal, committed;
  f.c.fetch = async (_, options) => {
    signal = options.signal; committed = JSON.parse(options.body);
    return { ok: true, status: 200, json: () => new Promise(() => {}) };
  };
  const writing = f.c.Cloud.patchRowIfUnchanged('p', { state: { roi: 'new' } }, '2026-01-01T00:00:00.000Z');
  const failed = assert.rejects(writing, error => error.code === 'CLOUD_TIMEOUT' && error.outcomeUnknown === true && /結果を確認できません/.test(error.message));
  await tick(); f.expire(); await failed;
  assert.equal(committed.state.roi, 'new');
  assert.equal(signal.aborted, true);
  assert.equal(f.timers.size, 0);
});

test('network failure of a deletion is unknown and does not imply successful deletion', async () => {
  const f = fixture(); f.c.fetch = async () => { throw new TypeError('disconnected'); };
  await assert.rejects(f.c.Cloud.removeRowIfUnchanged('p', '2026-01-01'), error => error.code === 'CLOUD_NETWORK_ERROR' && error.outcomeUnknown);
  assert.equal(f.timers.size, 0);
});

test('transient authentication transport failure preserves the login for a later retry', async () => {
  const f = fixture(); f.expiredSession(); f.c.fetch = () => new Promise(() => {});
  const failed = assert.rejects(f.c.Cloud.listProjects(), error => error.code === 'CLOUD_TIMEOUT');
  await tick(); f.expire(); await failed;
  assert.equal(f.c.Cloud.signedIn(), true);
});

test('sign-out during refresh cannot be undone by a late authentication response', async () => {
  const f = fixture(); f.expiredSession(); let release;
  f.c.fetch = () => new Promise(resolve => { release = resolve; });
  const failed = assert.rejects(f.c.Cloud.ensureToken(), error => error.status === 401);
  await tick(); f.c.Cloud.signOut();
  release({ ok: true, text: async () => JSON.stringify({ access_token: 'late', refresh_token: 'late-refresh', expires_in: 3600 }) });
  await failed;
  assert.equal(f.c.Cloud.signedIn(), false);
});

test('session subscriptions notify local and other-tab changes without exposing tokens', () => {
  const f = fixture(), seen = [];
  const unsubscribe = f.c.Cloud.subscribeSessionChanges(state => seen.push(JSON.parse(JSON.stringify(state))));
  f.c.Cloud.signOut();
  f.values.set('marmoset:cloudSession', JSON.stringify({ access_token: 'another', refresh_token: 'another' }));
  f.events.get('storage')({ key: 'marmoset:cloudSession' });
  assert.deepEqual(seen, [{ signedIn: false }, { signedIn: true }]);
  unsubscribe(); f.c.Cloud.signOut(); assert.equal(seen.length, 2);
});

test('completed read cancels the deadline and transfer reads use a separate limit', async () => {
  const f = fixture(); f.c.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
  assert.deepEqual(Array.from(await f.c.Cloud.listProjects()), []);
  assert.equal(f.timers.size, 0);
  let release;
  f.c.fetch = () => new Promise(resolve => { release = resolve; });
  const download = f.c.Cloud.downloadBundle('synthetic.zip'); await tick();
  assert.equal([...f.timers.values()][0].delay, 300000);
  release({ ok: true, status: 200, headers: { get: () => null }, blob: async () => new Blob(['synthetic']) });
  assert.equal((await download).size, 9);
  assert.equal(f.timers.size, 0);
});

test('authentication rejection retries the protected request at most once', async () => {
  const f = fixture(); let auth = 0, reads = 0;
  f.c.fetch = async url => {
    if (url.includes('/auth/')) {
      auth++;
      return { ok: true, status: 200, text: async () => JSON.stringify({
        access_token: 'refreshed', refresh_token: 'refreshed-refresh', expires_in: 3600 }) };
    }
    reads++;
    return { ok: false, status: 401, text: async () => 'unauthorized' };
  };
  await assert.rejects(f.c.Cloud.listProjects(), error => error.status === 401);
  assert.equal(auth, 1); assert.equal(reads, 2); assert.equal(f.timers.size, 0);
});

test('an expired session survives a temporary auth service failure but invalid credentials are cleared', async () => {
  const f = fixture(); f.expiredSession(); let status = 503;
  f.c.fetch = async () => ({ ok: false, status, text: async () => JSON.stringify({ message: 'synthetic failure' }) });
  await assert.rejects(f.c.Cloud.ensureToken(), error => error.status === 503);
  assert.equal(f.c.Cloud.signedIn(), true);
  status = 400;
  await assert.rejects(f.c.Cloud.ensureToken(), error => error.status === 401);
  assert.equal(f.c.Cloud.signedIn(), false);
  assert.equal(f.timers.size, 0);
});

test('bundle uploads use the transfer deadline and preserve uncertain outcomes for timeout or abort', async () => {
  for (const event of ['ontimeout', 'onabort', 'onerror']) {
    const f = fixture(); let xhr;
    f.c.CLOUD_CONFIG.transferTimeoutMs = 120000;
    f.c.XMLHttpRequest = class {
      constructor() { xhr = this; this.upload = {}; }
      open() {}
      setRequestHeader() {}
      send(blob) { this.sentSize = blob.size; }
    };
    const uploading = f.c.Cloud.uploadBundle('synthetic/bundle-2.zip', new Blob(['synthetic']));
    const failed = assert.rejects(uploading, error => error.outcomeUnknown === true &&
      error.code === (event === 'ontimeout' ? 'CLOUD_TIMEOUT' : 'CLOUD_NETWORK_ERROR'));
    await tick();
    assert.equal(xhr.timeout, 120000); assert.equal(xhr.sentSize, 9);
    xhr[event](); await failed;
    assert.equal(f.c.Cloud.signedIn(), true);
  }
});