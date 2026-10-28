'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { startBrowserHarness } = require('./browser-harness.cjs');

const templateBytes = Buffer.from('Synthetic app template; archive packaging is verified separately');
const templateManifest = { format: 'marmoset-atlas-app-template', schemaVersion: 1, platform: 'win32-x64', runtimeIncluded: true,
  archive: 'atlas-app.zip', appVersion: 'test-version', size: templateBytes.length, sha256: createHash('sha256').update(templateBytes).digest('hex') };

async function ready(h, { offline = false, failure = null, invalidManifest = false } = {}) {
  if (offline) await h.page.addInitScript(() => { window.ATLAS_OFFLINE_WORKSPACE_ID = 'ui-workspace'; });
  await h.page.route('**/offline/atlas-app.manifest.json', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ...templateManifest, ...(invalidManifest ? { appVersion: 'wrong-version' } : {}) }) }));
  await h.page.route('**/offline/atlas-app.zip', route => route.fulfill({ status: 200, contentType: 'application/zip', body: templateBytes }));
  await h.page.route('**/data/workspace.zip', route => route.fulfill({ status: 200, contentType: 'application/zip', body: Buffer.from('Synthetic workspace') }));
  await h.page.goto(h.baseURL + '/__test_seed');
  await h.page.evaluate(({ offline, failure }) => {
    document.body.innerHTML = '<main><button id="offline-export">Export</button><button id="edit">Edit</button>' +
      '<div id="offline-panel" class="hidden"><span id="offline-status"></span><button id="offline-cancel" class="hidden" disabled>Cancel</button></div>' +
      '<span id="offline-mode-label" class="hidden">Offline</span></main>';
    window.APP_VERSION = 'test-version';
    window.ATLAS_OFFLINE = offline ? { enabled: true, workspaceId: 'ui-workspace' } : null;
    window.failurePhase = failure;
    window.uiCalls = { busy: [], prepare: 0, encode: 0, package: 0, decode: 0, restore: 0, abortSeen: false };
    window.syntheticSnapshot = () => ({ projects: [{ id: 'section', displayName: 'Original', molecules: [], images: {} }],
      folders: [{ id: 'empty-folder', name: 'Empty', parentId: null }], blobs: [] });
    window.OfflineWorkspace = {
      LIMITS: { archive: 1024 * 1024 },
      encode: async () => { uiCalls.encode++; if (failurePhase === 'encode') throw new Error('Synthetic encode failure'); return new Blob(['data']); },
      packageApp: async () => { uiCalls.package++; if (failurePhase === 'package') throw new Error('Synthetic package failure'); return new Blob(['package']); },
      decode: async () => {
        uiCalls.decode++; if (failurePhase === 'decode') throw new Error('Synthetic checksum mismatch');
        return { manifest: { workspaceId: failurePhase === 'identity' ? 'wrong-workspace' : 'ui-workspace' }, snapshot: syntheticSnapshot() };
      },
    };
    const originalRestore = ProjectStorage.restoreWorkspaceSnapshot.bind(ProjectStorage);
    window.originalRestore = originalRestore;
    ProjectStorage.restoreWorkspaceSnapshot = async (...args) => { uiCalls.restore++; return originalRestore(...args); };
    window.uiOptions = {
      prepareSnapshot: async ({ signal }) => {
        uiCalls.prepare++;
        if (failurePhase === 'prepare') throw new Error('Synthetic snapshot failure');
        if (failurePhase === 'cancel') return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => { uiCalls.abortSeen = true; reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
        });
        return syntheticSnapshot();
      },
      setBusy: value => { uiCalls.busy.push(value); document.getElementById('offline-export').disabled = value; document.getElementById('edit').disabled = value; },
    };
  }, { offline, failure });
  await h.page.addScriptTag({ url: h.baseURL + '/lib/offline-ui.js' });
  await h.page.evaluate(() => { window.offlineUI = OfflineUI.init(uiOptions); });
}

async function bootResult(page) {
  return page.evaluate(async () => {
    let error = null, code = null;
    try { await offlineUI.bootstrap(); } catch (e) { error = e.message; code = e.code || null; }
    return { error, code, marker: await ProjectStorage.hasWorkspaceRestore(), calls: uiCalls,
      projectIds: (await ProjectStorage.listProjects()).map(p => p.id), folderIds: (await ProjectStorage.listFolders()).map(f => f.id),
      exportDisabled: document.getElementById('offline-export').disabled, editDisabled: document.getElementById('edit').disabled,
      status: document.getElementById('offline-status').textContent };
  });
}

test('offline download rejects a mismatched app template and restores controls without producing a download', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    const downloads = []; h.page.on('download', item => downloads.push(item));
    await ready(h, { invalidManifest: true });
    await h.page.click('#offline-export');
    await h.page.waitForFunction(() => document.getElementById('offline-status').textContent.includes('出力できませんでした'));
    const result = await h.page.evaluate(() => ({ calls: uiCalls, disabled: document.getElementById('offline-export').disabled, status: document.getElementById('offline-status').textContent }));
    assert.match(result.status, /版が一致しません/);
    assert.deepEqual(result.calls.busy, [true, false]);
    assert.equal(result.calls.prepare + result.calls.encode + result.calls.package, 0);
    assert.equal(result.disabled, false); assert.equal(downloads.length, 0);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('snapshot, encoding, and final packaging failures never download partial archives and always release export controls', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    const downloads = []; h.page.on('download', item => downloads.push(item));
    for (const failure of ['prepare', 'encode', 'package']) {
      await ready(h, { failure });
      await h.page.click('#offline-export');
      await h.page.waitForFunction(() => document.getElementById('offline-status').textContent.includes('Synthetic'));
      const result = await h.page.evaluate(() => ({ calls: uiCalls, disabled: document.getElementById('offline-export').disabled,
        editDisabled: document.getElementById('edit').disabled, cancelDisabled: document.getElementById('offline-cancel').disabled }));
      assert.deepEqual(result.calls.busy, [true, false]);
      assert.equal(result.calls.prepare, 1);
      assert.equal(result.calls.encode, failure === 'prepare' ? 0 : 1);
      assert.equal(result.calls.package, failure === 'package' ? 1 : 0);
      assert.equal(result.disabled || result.editDisabled, false);
      assert.equal(result.cancelDisabled, true); assert.equal(downloads.length, 0);
    }
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('cancelling preparation prevents later encoding/download and releases controls while duplicate starts are ignored', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    const downloads = []; h.page.on('download', item => downloads.push(item));
    await ready(h, { failure: 'cancel' });
    await h.page.click('#offline-export');
    await h.page.waitForFunction(() => uiCalls.prepare === 1);
    await h.page.evaluate(() => document.getElementById('offline-export').dispatchEvent(new Event('click')));
    await h.page.click('#offline-cancel');
    await h.page.waitForFunction(() => document.getElementById('offline-status').textContent === '出力をキャンセルしました。');
    const result = await h.page.evaluate(() => ({ calls: uiCalls, disabled: document.getElementById('offline-export').disabled }));
    assert.deepEqual(result.calls.busy, [true, false]);
    assert.equal(result.calls.abortSeen, true);
    assert.equal(result.calls.prepare, 1); assert.equal(result.calls.encode + result.calls.package, 0);
    assert.equal(result.disabled, false); assert.equal(downloads.length, 0);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('corrupt bootstrap data never writes or marks a restore and a repaired archive can be retried safely', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await ready(h, { offline: true, failure: 'decode' });
    const failed = await bootResult(h.page);
    assert.match(failed.error, /checksum mismatch/); assert.equal(failed.marker, false);
    assert.equal(failed.calls.restore, 0); assert.deepEqual(failed.projectIds, []); assert.deepEqual(failed.folderIds, []);
    assert.equal(failed.exportDisabled && failed.editDisabled, true);
    await h.page.evaluate(() => { failurePhase = null; });
    const success = await bootResult(h.page);
    assert.equal(success.error, null); assert.equal(success.marker, true);
    assert.equal(success.calls.restore, 1); assert.deepEqual(success.projectIds, ['section']);
    assert.deepEqual(success.folderIds, ['empty-folder']); assert.equal(success.exportDisabled || success.editDisabled, false);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('bootstrap checks workspace identity and available storage before writing any records', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await ready(h, { offline: true, failure: 'identity' });
    const identity = await bootResult(h.page);
    assert.match(identity.error, /識別情報が一致/); assert.equal(identity.marker, false); assert.equal(identity.calls.restore, 0);
    await h.page.evaluate(() => {
      failurePhase = null;
      const old = syntheticSnapshot;
      syntheticSnapshot = () => ({ ...old(), blobs: [{ id: 'large', blob: new Blob([new Uint8Array(20)]) }] });
      ProjectStorage.estimate = async () => ({ quota: 15, usage: 5 });
    });
    const space = await bootResult(h.page);
    assert.match(space.error, /保存領域が不足/); assert.equal(space.marker, false); assert.equal(space.calls.restore, 0);
    assert.deepEqual(space.projectIds, []); assert.deepEqual(space.folderIds, []);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('bootstrap accepts a simultaneous restore only with its committed database marker', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await ready(h, { offline: true });
    await h.page.evaluate(() => {
      ProjectStorage.restoreWorkspaceSnapshot = async snapshot => {
        uiCalls.restore++;
        await originalRestore(snapshot); // The competing tab commits first.
        return originalRestore(snapshot); // This tab receives WORKSPACE_NOT_EMPTY.
      };
    });
    const result = await bootResult(h.page);
    assert.equal(result.error, null); assert.equal(result.marker, true); assert.equal(result.calls.restore, 1);
    assert.deepEqual(result.projectIds, ['section']); assert.deepEqual(result.folderIds, ['empty-folder']);
    assert.equal(result.exportDisabled || result.editDisabled, false);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('bootstrap does not hide arbitrary restore errors or bless preexisting data without an atomic marker', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    for (const mismatch of [false, true]) {
      await ready(h, { offline: true });
      await h.page.evaluate(async mismatch => {
        await ProjectStorage.clearAll();
        ProjectStorage.restoreWorkspaceSnapshot = async snapshot => {
          uiCalls.restore++;
          if (mismatch) {
            await ProjectStorage.putProject({ id: 'other-section' }); return originalRestore(snapshot);
          }
          await ProjectStorage.putProject({ id: 'partial-data' });
          const error = new Error('Synthetic storage failure'); error.code = 'STORAGE_FAILED'; throw error;
        };
      }, mismatch);
      const result = await bootResult(h.page);
      assert.equal(result.marker, false); assert.equal(result.exportDisabled && result.editDisabled, true);
      if (mismatch) { assert.equal(result.code, 'WORKSPACE_NOT_EMPTY'); assert.deepEqual(result.projectIds, ['other-section']); }
      else { assert.equal(result.code, 'STORAGE_FAILED'); assert.match(result.error, /Synthetic storage failure/); }
    }
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('orphan blobs alone cannot be mistaken for a successfully restored nonempty workspace', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await ready(h, { offline: true });
    await h.page.evaluate(() => ProjectStorage.putBlob({ id: 'orphan', blob: new Blob(['leftover']), mime: 'application/octet-stream' }));
    const result = await bootResult(h.page);
    assert.equal(result.code, 'WORKSPACE_NOT_EMPTY'); assert.equal(result.marker, false);
    assert.deepEqual(result.projectIds, []); assert.deepEqual(result.folderIds, []);
    assert.equal(result.exportDisabled && result.editDisabled, true);
    assert.equal(await h.page.evaluate(async () => !!await ProjectStorage.getBlob('orphan')), true);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('bootstrap preserves intentionally emptied workspaces and recovers after database-only clearing without trusting localStorage', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await ready(h, { offline: true });
    const first = await bootResult(h.page);
    assert.equal(first.marker, true);
    await h.page.evaluate(async () => {
      await ProjectStorage.deleteProject('section');
      await ProjectStorage.deleteFolder('empty-folder');
      localStorage.setItem('atlas-offline-restored:ui-workspace', '1');
    });
    const intentionallyEmpty = await bootResult(h.page);
    assert.equal(intentionallyEmpty.error, null); assert.equal(intentionallyEmpty.marker, true);
    assert.deepEqual(intentionallyEmpty.projectIds, []); assert.deepEqual(intentionallyEmpty.folderIds, []);
    assert.equal(intentionallyEmpty.calls.decode, 1); assert.equal(intentionallyEmpty.calls.restore, 1);
    // clearAll resets this test database, including its durable import marker;
    // a stale localStorage marker must not suppress restoration after this.
    await h.page.evaluate(() => ProjectStorage.clearAll());
    const recovered = await bootResult(h.page);
    assert.equal(recovered.error, null); assert.equal(recovered.marker, true);
    assert.deepEqual(recovered.projectIds, ['section']); assert.deepEqual(recovered.folderIds, ['empty-folder']);
    assert.equal(recovered.calls.decode, 2); assert.equal(recovered.calls.restore, 2);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
