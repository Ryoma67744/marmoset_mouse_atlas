'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ configured = true, signedIn = true } = {}) {
  const context = { DOMException }; context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/offline-prepare.js'), 'utf8'), context);
  const local = { id: 'local-only', updatedAt: 'local-revision', roi: { name: 'Local ROI' } };
  const remote = { id: 'remote', display_name: 'Cloud section', updated_at: 'remote-revision', bundle_path: 'bundle.zip', bundle_rev: 2,
    folder_path: ['Study', 'Group'], state: { normalization: { id: 'profile' } } };
  const projects = new Map([[local.id, structuredClone(local)]]);
  const rows = [remote], status = new WeakMap(), calls = [], progress = [];
  const snapshot = () => ({ projects: [...projects.values()].map(p => structuredClone(p)), folders: [{ id: 'empty-folder', parentId: null }], blobs: [] });
  const storage = {
    listProjects: async () => { calls.push('local-list'); return [...projects.values()].map(p => structuredClone(p)); },
    exportWorkspaceSnapshot: async () => { calls.push('snapshot'); return snapshot(); },
  };
  const cloud = {
    configured: () => configured, signedIn: () => signedIn,
    listAllProjects: async () => { calls.push('cloud-list'); return structuredClone(rows); },
  };
  const sync = {
    ensureLocal: async (id, options) => {
      calls.push(['ensure', id]);
      assert.equal(await options.confirmReplace(), false, 'offline export must not authorize discarding local edits');
      assert.equal(options.storage, storage); assert.equal(options.cloud, cloud);
      const row = rows.find(r => r.id === id);
      const p = { id, updatedAt: 'cached-' + row.updated_at, normalization: structuredClone(row.state.normalization) };
      projects.set(id, p); status.set(p, { status: 'updated', remoteRow: structuredClone(row) }); return p;
    },
    statusOf: p => status.get(p) || { status: 'unknown', reason: 'Unknown state' },
  };
  const options = { storage, cloud, sync, zip: {}, pendingFolderChanges: () => ({}), onProgress: message => progress.push(message) };
  return { collect: extras => context.OfflinePrepare.collect({ ...options, ...extras }), options, local, remote, projects, rows, status, calls, progress, storage, cloud, sync, snapshot };
}

test('offline export captures all local-only data and empty folders without touching cloud services', async () => {
  const f = fixture({ configured: false });
  f.cloud.listAllProjects = () => { throw new Error('Cloud access forbidden'); };
  const result = await f.collect();
  assert.deepEqual(result.projects, [f.local]);
  assert.deepEqual(result.folders, [{ id: 'empty-folder', parentId: null }]);
  assert.deepEqual(f.calls, ['local-list', 'snapshot']);
});

test('complete export joins the cloud inventory with local-only datasets and keeps saved local edits', async () => {
  for (const freshness of ['current', 'updated', 'local-edits']) {
    const f = fixture();
    const ensure = f.sync.ensureLocal;
    f.sync.ensureLocal = async (id, options) => {
      assert.equal(options.pendingFolderChanges, f.options.pendingFolderChanges);
      const p = await ensure(id, options);
      p.roi = { name: 'Saved local edit' };
      f.status.get(p).status = freshness;
      return p;
    };
    const result = await f.collect();
    assert.deepEqual(result.projects.map(p => p.id).sort(), ['local-only', 'remote']);
    assert.equal(result.projects.find(p => p.id === 'remote').roi.name, 'Saved local edit');
    assert.equal(result.projects.find(p => p.id === 'remote').normalization.id, 'profile');
    assert.deepEqual(f.calls, ['local-list', 'cloud-list', ['ensure', 'remote'], 'cloud-list', 'snapshot']);
    assert.ok(f.progress.length >= 3);
  }
});

test('signed-out or failed cloud inventories never produce a local-only archive labelled complete', async () => {
  const signedOut = fixture({ signedIn: false });
  await assert.rejects(signedOut.collect(), /ログイン/);
  assert.deepEqual(signedOut.calls, ['local-list']);
  for (const result of [null, {}, undefined]) {
    const f = fixture(); f.cloud.listAllProjects = async () => result;
    await assert.rejects(f.collect(), /全データ一覧/);
    assert.equal(f.calls.includes('snapshot'), false);
  }
  const failure = fixture(); failure.cloud.listAllProjects = async () => { throw new Error('Synthetic network failure'); };
  await assert.rejects(failure.collect(), /Synthetic network failure/);
  assert.equal(failure.calls.includes('snapshot'), false);
});

test('complete export refuses the ordinary potentially truncated cloud list API', async () => {
  const f = fixture(); delete f.cloud.listAllProjects;
  f.cloud.listProjects = () => { throw new Error('Must not fall back to an unverified inventory'); };
  await assert.rejects(f.collect(), /全データの一覧を取得する機能がありません/);
  assert.equal(f.calls.includes('snapshot'), false);
});

test('failed fetches and unresolved sync states abort the full export instead of skipping affected datasets', async () => {
  const failure = fixture(); failure.sync.ensureLocal = async () => { throw new Error('Synthetic incomplete download'); };
  await assert.rejects(failure.collect(), /Synthetic incomplete download/);
  assert.equal(failure.calls.includes('snapshot'), false);
  for (const freshness of ['offline', 'conflict', 'pending', 'missing-remote', 'local-only', 'unknown']) {
    const f = fixture(), ensure = f.sync.ensureLocal;
    f.sync.ensureLocal = async (...args) => { const p = await ensure(...args); f.status.get(p).status = freshness; return p; };
    await assert.rejects(f.collect(), /Cloud section/);
    assert.equal(f.calls.includes('snapshot'), false);
  }
});

test('a cloud project changing during fetch or a changing final inventory cannot produce a mixed archive', async () => {
  const mismatched = fixture(), ensure = mismatched.sync.ensureLocal;
  mismatched.sync.ensureLocal = async (...args) => {
    const p = await ensure(...args); mismatched.status.get(p).remoteRow.state.normalization.id = 'newer-profile'; return p;
  };
  await assert.rejects(mismatched.collect(), /クラウドの内容が変更/);
  assert.equal(mismatched.calls.includes('snapshot'), false);
  for (const mutate of [rows => rows.pop(), rows => rows.push({ ...rows[0], id: 'new-section' }), rows => { rows[0].updated_at = 'later'; },
    rows => { rows[0].bundle_path = 'new-bundle.zip'; }, rows => { rows[0].bundle_rev++; }, rows => { rows[0].state.normalization.id = 'new-profile'; }]) {
    const f = fixture(); let count = 0;
    f.cloud.listAllProjects = async () => { const rows = structuredClone(f.rows); if (++count === 2) mutate(rows); return rows; };
    await assert.rejects(f.collect(), /クラウドの一覧が変更/);
    assert.equal(f.calls.includes('snapshot'), false);
  }
});

test('local dataset deletion or checked-cloud revision changes before the final snapshot abort export', async () => {
  for (const mutate of [projects => projects.delete('local-only'), projects => projects.delete('remote'),
    projects => { projects.get('remote').updatedAt = 'concurrent-edit'; }]) {
    const f = fixture();
    f.storage.exportWorkspaceSnapshot = async () => { mutate(f.projects); return f.snapshot(); };
    await assert.rejects(f.collect(), /削除|別の画面でデータが変更/);
  }
  const localEdit = fixture();
  localEdit.storage.exportWorkspaceSnapshot = async () => {
    localEdit.projects.get('local-only').updatedAt = 'saved-before-snapshot';
    return localEdit.snapshot();
  };
  const result = await localEdit.collect();
  assert.equal(result.projects.find(p => p.id === 'local-only').updatedAt, 'saved-before-snapshot');
});

test('cancellation before or during preparation prevents a completed export result', async () => {
  const already = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(already.collect({ signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(already.calls, []);
  for (const phase of ['cloud-list', 'ensure', 'snapshot']) {
    const f = fixture(), controller = new AbortController();
    if (phase === 'cloud-list') { const read = f.cloud.listAllProjects; f.cloud.listAllProjects = async () => { const rows = await read(); controller.abort(); return rows; }; }
    if (phase === 'ensure') { const read = f.sync.ensureLocal; f.sync.ensureLocal = async (...args) => { const p = await read(...args); controller.abort(); return p; }; }
    if (phase === 'snapshot') { const read = f.storage.exportWorkspaceSnapshot; f.storage.exportWorkspaceSnapshot = async () => { const snapshot = await read(); controller.abort(); return snapshot; }; }
    await assert.rejects(f.collect({ signal: controller.signal }), { name: 'AbortError' });
  }
});
