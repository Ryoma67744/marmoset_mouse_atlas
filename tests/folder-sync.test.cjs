'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startBrowserHarness } = require('./browser-harness.cjs');

const PREFIX = 'marmoset:pendingFolderChange:';
const SERVER = 'synthetic-folder-sync-server';
const OFFLINE = 'synthetic-folder-sync-offline';

// All cloud calls stay inside this browser context. Shared localStorage makes
// the synthetic remote visible to both tabs without any real account or data.
async function fixture(h, { offline = true } = {}) {
  const source = await fs.readFile(path.join(__dirname, '../lib/cloud.js'), 'utf8');
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};',
  }));
  await h.context.route(h.baseURL + '/lib/cloud.js', route => route.fulfill({
    contentType: 'application/javascript', body: source + `
      (() => {
        const key = ${JSON.stringify(SERVER)}, offline = ${JSON.stringify(OFFLINE)};
        const read = () => JSON.parse(localStorage.getItem(key) || '{}');
        const online = () => { if (localStorage.getItem(offline) === '1') throw new Error('Synthetic offline cloud'); };
        Cloud.configured = () => true;
        Cloud.signedIn = () => true;
        Cloud.listProjects = async () => { online(); return Object.values(read()); };
        Cloud.getProject = async id => { online(); return read()[id] || null; };
        Cloud.patchRowIfUnchanged = async (id, patch, expected) => {
          online();
          const rows = read(), row = rows[id];
          if (!row || row.updated_at !== expected) return null;
          Object.assign(row, structuredClone(patch));
          row.updated_at = new Date(Date.parse(expected) + 1000).toISOString();
          localStorage.setItem(key, JSON.stringify(rows));
          localStorage.setItem('synthetic-folder-sync-patches', String(Number(localStorage.getItem('synthetic-folder-sync-patches') || 0) + 1));
          return structuredClone(row);
        };
        Cloud.removeRow = async id => { online(); const rows = read(); delete rows[id]; localStorage.setItem(key, JSON.stringify(rows)); };
        Cloud.removeBundle = async () => { online(); };
        Cloud.downloadBundle = async () => { throw new Error('No bundle should be downloaded by these metadata-only tests'); };
      })();`,
  }));
  await h.page.goto(h.baseURL + '/__test_seed');
  await h.page.addScriptTag({ url: h.baseURL + '/lib/cloud.js' });
  await h.page.evaluate(async ({ serverKey, offlineKey, offline }) => {
    await ProjectStorage.putFolder({ id: 'species', name: 'Marmoset', parentId: null });
    await ProjectStorage.putFolder({ id: 'coronal', name: 'Coronal', parentId: 'species', normalizationGroupId: 'group-coronal' });
    await ProjectStorage.putFolder({ id: 'sagittal', name: 'Sagittal', parentId: 'species', normalizationGroupId: 'group-sagittal' });
    const rows = {};
    for (const [id, folderId, folderName] of [['p', 'coronal', 'Coronal'], ['q', 'sagittal', 'Sagittal']]) {
      const groupId = 'group-' + folderId;
      const p = {
        id, displayName: 'Synthetic ' + id, folderId, grid: { W: 1, H: 1 }, molecules: [], images: {},
        roi: { roi_items: {}, roi_names: {}, palette: {}, roi_show_flags: {} },
        normalization: { id: 'profile-' + id, revision: 1, batchId: 'synthetic-batch', quality: 'provisional',
          scope: { type: 'folder-depth', depth: 2, includeDescendants: true, groupId,
            folderPath: ['Marmoset', folderName], memberIds: [id] } },
        normalizationBinding: { groupId, folderPath: ['Marmoset', folderName], memberId: id },
        cloudUpdatedAt: '2026-01-01T00:00:00.000Z', cloudBundlePath: 'synthetic/' + id + '.zip',
      };
      p.cloudStateHash = Cloud.hashState(Cloud.stateOf(p));
      await ProjectStorage.putProject(p);
      rows[id] = { id, display_name: p.displayName, folder_path: ['Marmoset', folderName],
        state: Cloud.stateOf(p), meta: Cloud.metaOf(p), updated_at: p.cloudUpdatedAt, bundle_path: p.cloudBundlePath };
    }
    localStorage.setItem(serverKey, JSON.stringify(rows));
    localStorage.setItem(offlineKey, offline ? '1' : '0');
    sessionStorage.setItem('marmoset:currentFolder', 'species');
  }, { serverKey: SERVER, offlineKey: OFFLINE, offline });
  await openMaster(h.page, h.baseURL);
}

async function openMaster(page, baseURL) {
  await page.goto(baseURL + '/');
  await page.locator('.tree-node[title="Marmoset"]').waitFor();
  await page.locator('.tree-node[title="Marmoset"]').click();
  await page.locator('#project-list [data-act="enter"]').first().waitFor();
}

async function renameFolder(page, before, after) {
  const row = page.locator('#project-list > div').filter({ has: page.locator('[data-act="enter"]', { hasText: before }) });
  page.once('dialog', dialog => dialog.accept(after));
  await row.locator('[data-act="rename"]').click();
  await page.waitForFunction(name => [...document.querySelectorAll('#project-list [data-act="enter"]')]
    .some(el => el.textContent.includes(name)), after);
}

async function queue(page) {
  return page.evaluate(prefix => Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith(prefix))
    .map(key => [decodeURIComponent(key.slice(prefix.length)), JSON.parse(localStorage.getItem(key))])), PREFIX);
}

async function waitForQueue(page, count) {
  await page.waitForFunction(({ prefix, count }) => Object.keys(localStorage).filter(key => key.startsWith(prefix)).length === count,
    { prefix: PREFIX, count });
}

test('offline cached cloud records without __row preserve and later synchronize a folder rename', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await fixture(h);
    assert.equal(await h.page.evaluate(async () => Object.hasOwn(await ProjectStorage.getProject('p'), '__row')), false);
    await renameFolder(h.page, 'Coronal', 'Coronal renamed');
    await waitForQueue(h.page, 1);
    const queued = await queue(h.page);
    assert.deepEqual(queued.p.path, ['Marmoset', 'Coronal renamed']);
    assert.equal(queued.p.expectedUpdatedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(queued.p.binding.groupId, 'group-coronal');
    await h.page.reload();
    await h.page.locator('#folder-sync-retry').waitFor();
    assert.deepEqual((await queue(h.page)).p.path, queued.p.path);
    await h.page.evaluate(key => localStorage.setItem(key, '0'), OFFLINE);
    await h.page.reload();
    await waitForQueue(h.page, 0);
    const remote = await h.page.evaluate(key => JSON.parse(localStorage.getItem(key)).p, SERVER);
    assert.deepEqual(remote.folder_path, queued.p.path);
    assert.deepEqual(remote.state.normalizationBinding.folderPath, queued.p.path);
    assert.deepEqual(remote.state.normalization.scope.folderPath, ['Marmoset', 'Coronal'], 'calculation provenance stays immutable');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('two offline tabs preserve distinct folder intents across reload and reconnect', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await fixture(h);
    const second = await h.context.newPage();
    second.on('pageerror', error => h.errors.push(error.message));
    await openMaster(second, h.baseURL);
    assert.equal(await h.page.evaluate(() => !!navigator.locks), true, 'the browser exercises Web Locks');
    await renameFolder(h.page, 'Coronal', 'Coronal first tab');
    await waitForQueue(h.page, 1);
    await second.waitForFunction(() => document.getElementById('folder-sync-status')?.textContent.includes('1件'));
    await renameFolder(second, 'Sagittal', 'Sagittal second tab');
    await waitForQueue(second, 2);
    await h.page.waitForFunction(() => document.getElementById('folder-sync-status')?.textContent.includes('2件'));
    const pending = await queue(second);
    assert.deepEqual(Object.keys(pending).sort(), ['p', 'q']);
    assert.deepEqual(pending.p.path, ['Marmoset', 'Coronal first tab']);
    assert.deepEqual(pending.q.path, ['Marmoset', 'Sagittal second tab']);
    await second.reload();
    await second.locator('#folder-sync-retry').waitFor();
    assert.deepEqual(await queue(second), pending, 'reloading one tab preserves both durable intents');
    await second.evaluate(key => localStorage.setItem(key, '0'), OFFLINE);
    await second.reload();
    await waitForQueue(second, 0);
    const remote = await second.evaluate(key => JSON.parse(localStorage.getItem(key)), SERVER);
    assert.deepEqual(remote.p.folder_path, pending.p.path);
    assert.deepEqual(remote.q.folder_path, pending.q.path);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('remote folder refresh preserves a clean local state baseline and does not echo a cloud write', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await fixture(h, { offline: false });
    await h.page.evaluate(key => {
      const rows = JSON.parse(localStorage.getItem(key));
      rows.p.folder_path = ['Marmoset', 'Sagittal'];
      rows.p.state.normalizationBinding = { groupId: 'group-sagittal', folderPath: ['Marmoset', 'Sagittal'], memberId: 'p' };
      rows.p.updated_at = '2026-01-01T00:01:00.000Z';
      localStorage.setItem(key, JSON.stringify(rows));
    }, SERVER);
    await h.page.reload();
    await h.page.waitForFunction(async () => (await ProjectStorage.getProject('p')).folderId === 'sagittal');
    const current = await h.page.evaluate(async () => {
      const p = await ProjectStorage.getProject('p');
      return { group: p.normalizationBinding.groupId, clean: Cloud.hashState(Cloud.stateOf(p)) === p.cloudStateHash,
        cloudUpdatedAt: p.cloudUpdatedAt, source: p.normalization.scope.folderPath,
        patches: Number(localStorage.getItem('synthetic-folder-sync-patches') || 0) };
    });
    assert.equal(current.group, 'group-coronal', 'listing location alone cannot rewrite the scientific state associated with the old cloud baseline');
    assert.equal(current.clean, true, 'a remote location change is not an unsaved local scientific edit');
    assert.equal(current.cloudUpdatedAt, '2026-01-01T00:00:00.000Z', 'newer cloud content must still be fetched before opening');
    assert.deepEqual(current.source, ['Marmoset', 'Coronal']);
    assert.equal(current.patches, 0, 'read-only refresh never pushes local paths back to the server');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('discarding the pending intent for a remotely deleted record unblocks another group setup', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await fixture(h);
    await renameFolder(h.page, 'Coronal', 'Coronal pending');
    await waitForQueue(h.page, 1);
    await h.page.evaluate(({ serverKey, offlineKey }) => {
      const rows = JSON.parse(localStorage.getItem(serverKey));
      delete rows.p;
      localStorage.setItem(serverKey, JSON.stringify(rows));
      localStorage.setItem(offlineKey, '0');
    }, { serverKey: SERVER, offlineKey: OFFLINE });
    await h.page.reload();
    await h.page.locator('#folder-sync-revert').waitFor();
    h.page.once('dialog', dialog => dialog.accept());
    await h.page.locator('#folder-sync-revert').click();
    await waitForQueue(h.page, 0);
    await h.page.waitForFunction(() => !document.getElementById('folder-sync-status')?.textContent.trim());
    await h.page.locator('#normalization-settings').click();
    await h.page.locator('#normalization-group').selectOption('sagittal');
    await h.page.locator('#normalization-load').click();
    await h.page.locator('#normalization-form').waitFor();
    assert.match(await h.page.locator('#normalization-body').innerText(), /Sagittal/);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('an older remote listing cannot move a project whose newer cloud location has already been read', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await fixture(h, { offline: false });
    // A newer ensureLocal operation completed while an older list response was
    // still in flight. Keep the mock listing at rev1 and store the read rev2.
    const before = await h.page.evaluate(async () => {
      const project = await ProjectStorage.getProject('p');
      project.folderId = 'sagittal';
      project.normalizationBinding = { groupId: 'group-sagittal', folderPath: ['Marmoset', 'Sagittal'], memberId: 'p' };
      project.cloudUpdatedAt = '2026-01-01T00:02:00.000Z';
      project.cloudStateHash = Cloud.hashState(Cloud.stateOf(project));
      return await ProjectStorage.saveProjectIfUnchanged(project, project.updatedAt);
    });
    await h.page.reload();
    await h.page.locator('.tree-node[title="Marmoset"]').waitFor();
    const after = await h.page.evaluate(async () => ({
      project: await ProjectStorage.getProject('p'),
      patches: Number(localStorage.getItem('synthetic-folder-sync-patches') || 0),
    }));
    assert.equal(after.project.folderId, 'sagittal');
    assert.equal(after.project.cloudUpdatedAt, '2026-01-01T00:02:00.000Z');
    assert.deepEqual(after.project, before, 'a stale listing must not write over the newer local location or advance its revision');
    assert.equal(after.patches, 0);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
