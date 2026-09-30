'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

async function openImageViewer(h, id) {
  await seedViewerProject(h.page, h.baseURL, { id });
  await h.page.evaluate(async id => {
    const p = await ProjectStorage.getProject(id);
    delete p.normalization;
    p.valueDisplay = { mode: 'raw', scale: 'individual' };
    const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 2;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#8395a7'; ctx.fillRect(0, 0, 4, 2);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const blobId = await ProjectStorage.putBlob({ blob });
    p.images = { HE_Stain: { blobId, filename: 'HE.png' }, IF_Stain: { blobId, filename: 'IF.png' } };
    // IndexedDB can retain undefined properties, unlike the JSON cloud transport.
    p.layerDisplay = { HE_Stain: { rawRange: undefined, normalizedRange: undefined, annotation: null } };
    p.alignment = { HE_Stain: { flip_lr: false, flip_ud: false, scale_pct: 100, rotate_deg: 0, offx: 0, offy: 0, autoAligned: undefined } };
    await ProjectStorage.putProject(p);
  }, id);
  await h.page.goto(h.baseURL + '/viewer/index.html?project=' + id);
  await h.page.waitForFunction(id => typeof currentProject !== 'undefined' && currentProject?.id === id && viewerReady, id);
}

async function jsonCloud(page, { remote = null, remoteName = null, delayed = false } = {}) {
  await page.evaluate(async ({ remote, remoteName, delayed }) => {
    Cloud.configured = () => true; Cloud.signedIn = () => true;
    const json = value => JSON.parse(JSON.stringify(value));
    window.__jsonRemote = remote || { id: currentProject.id, updated_at: 'remote-initial',
      display_name: remoteName || currentProject.displayName, bundle_path: 'synthetic/bundle.zip', bundle_rev: 1,
      state: json(Cloud.stateOf(currentProject)), meta: json(Cloud.metaOf(currentProject)) };
    if (!remote) {
      viewerSaving++;
      try {
        const p = await ProjectStorage.patchProjectFields(currentProject.id, { cloudUpdatedAt: __jsonRemote.updated_at,
          cloudRev: 1, cloudBundlePath: __jsonRemote.bundle_path,
          cloudStateHash: (Cloud.hashSyncState || Cloud.hashState)(__jsonRemote.state), cloudDisplayName: __jsonRemote.display_name },
          { expectedUpdatedAt: currentProject.updatedAt });
        currentProject = p; viewerStoredProject = structuredClone(p); viewerStoredUpdatedAt = p.updatedAt;
      } finally { viewerSaving--; }
    }
    window.__jsonWriteCount = 0;
    let finish; const gate = new Promise(resolve => { finish = resolve; });
    window.__finishJsonWrite = finish;
    Cloud.getProject = async () => json(__jsonRemote);
    Cloud.patchRowIfUnchanged = async (id, patch, expected) => {
      if (id !== __jsonRemote.id || expected !== __jsonRemote.updated_at) return null;
      const sent = json(patch);
      window.__jsonWriteCount++;
      if (delayed) await gate;
      window.__jsonRemote = { ...__jsonRemote, ...sent, updated_at: 'remote-saved-' + __jsonWriteCount };
      return json(__jsonRemote);
    };
    refreshCloudSaveState();
  }, { remote, remoteName, delayed });
}

async function numericalSnapshot(page) {
  return page.evaluate(() => ({ roi: structuredClone(atlasData.roi),
    raw: Object.fromEntries(Object.entries(valueRasters).map(([key, raster]) => [key, Array.from(new Uint32Array(raster.values.buffer))])),
    stats: calcStats(extractRoiPixels('MSI_5-HT', 'all')),
  }));
}

test('HE and IF save cleanly through JSON cloud transport and remain clean on repeated save and reload', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(); h.page.on('dialog', d => d.dismiss());
  try {
    await openImageViewer(h, 'viewer-json-images');
    await jsonCloud(h.page);
    const before = await numericalSnapshot(h.page);
    await h.page.evaluate(() => saveToCloud());
    assert.equal(await h.page.evaluate(() => cloudDirty()), false, 'HE optional ranges must not cause a perpetual unsaved state');
    assert.equal(await h.page.locator('#cloud-save-label').textContent(), 'クラウドに保存済み');
    assert.equal(await h.page.evaluate(() => __jsonWriteCount), 1);
    const stored = await h.page.evaluate(async () => {
      const p = await ProjectStorage.getProject(currentProject.id);
      return { hasRaw: Object.hasOwn(p.layerDisplay.HE_Stain, 'rawRange'), hasNormalized: Object.hasOwn(p.layerDisplay.HE_Stain, 'normalizedRange'),
        annotation: p.layerDisplay.HE_Stain.annotation };
    });
    assert.deepEqual(stored, { hasRaw: false, hasNormalized: false, annotation: null });
    await h.page.evaluate(() => saveToCloud());
    assert.equal(await h.page.evaluate(() => __jsonWriteCount), 1, 'unchanged repeated save must only acknowledge the existing row');
    assert.equal(await h.page.evaluate(() => cloudDirty()), false);
    assert.deepEqual(await numericalSnapshot(h.page), before);
    const remote = await h.page.evaluate(() => __jsonRemote);
    await h.page.reload();
    await h.page.waitForFunction(() => typeof currentProject !== 'undefined' && viewerReady);
    await jsonCloud(h.page, { remote });
    assert.equal(await h.page.evaluate(() => cloudDirty()), false);
    await h.page.evaluate(() => saveToCloud());
    assert.equal(await h.page.evaluate(() => __jsonWriteCount), 0);
    assert.equal(await h.page.evaluate(() => cloudDirty()), false);
    assert.deepEqual(await numericalSnapshot(h.page), before);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});


test('Viewer separates a pending name from saved settings and links to Master without renaming the remote row', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(); h.page.on('dialog', d => d.dismiss());
  try {
    await openImageViewer(h, 'viewer-json-name');
    const localName = await h.page.evaluate(() => currentProject.displayName);
    await jsonCloud(h.page, { remoteName: 'Previous remote name' });
    await h.page.evaluate(() => saveToCloud());
    assert.equal(await h.page.evaluate(() => cloudDirty()), true, 'a real pending name must remain unsynced');
    assert.match(await h.page.locator('#cloud-save-label').textContent(), /設定保存済み.*名前未同期/);
    const status = await h.page.locator('#viewer-action-status').textContent();
    assert.match(status, /設定.*保存済み/);
    assert.match(status, /名前.*未同期/);
    const master = h.page.locator('#viewer-action-status a');
    assert.equal(await master.getAttribute('href'), '../index.html');
    assert.equal(await master.getAttribute('target'), '_blank');
    assert.match(await master.getAttribute('rel'), /noopener/);
    assert.equal(await h.page.evaluate(() => __jsonRemote.display_name), 'Previous remote name');
    assert.equal(await h.page.evaluate(() => currentProject.displayName), localName);
    const pending = await h.page.evaluate(() => ProjectSync.localStatus(currentProject, { cloud: Cloud, remoteRow: __jsonRemote }));
    assert.deepEqual(pending.changeReasons.map(reason => reason.code), ['name']);
    assert.deepEqual(pending.changedFields, []);
    await h.page.evaluate(() => saveToCloud());
    assert.equal(await h.page.evaluate(() => __jsonWriteCount), 1);
    assert.equal(await h.page.evaluate(() => __jsonRemote.display_name), 'Previous remote name');
    assert.match(await h.page.locator('#cloud-save-label').textContent(), /名前未同期/);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Viewer reports the real ROI draft created during a JSON cloud save without discarding it', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(); h.page.on('dialog', d => d.dismiss());
  try {
    await openImageViewer(h, 'viewer-json-draft');
    await jsonCloud(h.page, { delayed: true });
    const before = await numericalSnapshot(h.page);
    await h.page.evaluate(() => { window.__savingJson = saveToCloud(); });
    await h.page.waitForFunction(() => __jsonWriteCount === 1);
    await h.page.evaluate(async () => {
      atlasData.roi.roi_names.all = 'ROI edited after sending';
      persistRoi();
      __finishJsonWrite();
      await __savingJson;
    });
    assert.equal(await h.page.evaluate(() => viewerSaveConflict), false);
    assert.equal(await h.page.evaluate(() => cloudDirty()), true);
    assert.match(await h.page.locator('#cloud-save-label').textContent(), /未保存/);
    assert.match(await h.page.locator('#viewer-action-status').textContent(), /ROI.*未同期/);
    assert.equal(await h.page.evaluate(() => currentProject.roi.roi_names.all), 'ROI edited after sending');
    assert.equal(await h.page.evaluate(() => __jsonRemote.state.roi.roi_names.all), 'All pixels');
    await h.page.waitForFunction(() => !saveTimer && !viewerSaving);
    assert.equal(await h.page.evaluate(async () => (await ProjectStorage.getProject(currentProject.id)).roi.roi_names.all), 'ROI edited after sending');
    const after = await numericalSnapshot(h.page);
    assert.deepEqual(after.raw, before.raw);
    assert.deepEqual(after.stats, before.stats);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Manual alignment omits unused automatic metadata and can be saved cleanly through JSON', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(); h.page.on('dialog', d => d.dismiss());
  try {
    await openImageViewer(h, 'viewer-json-alignment');
    await jsonCloud(h.page);
    const before = await numericalSnapshot(h.page);
    await h.page.locator('#align-btn').click();
    await h.page.locator('[data-p="rotate_deg"]').fill('15');
    await h.page.locator('[data-p="rotate_deg"]').dispatchEvent('input');
    await h.page.locator('[data-act="apply"]').click();
    await h.page.locator('.modal-backdrop').waitFor({ state: 'detached' });
    assert.equal(await h.page.evaluate(() => Object.hasOwn(atlasData.alignment.HE_Stain, 'autoAligned')), false);
    assert.equal(await h.page.evaluate(() => currentProject.alignment.HE_Stain.rotate_deg), 15);
    await h.page.evaluate(() => saveToCloud());
    assert.equal(await h.page.evaluate(() => cloudDirty()), false);
    assert.equal(await h.page.evaluate(() => __jsonRemote.state.alignment.HE_Stain.rotate_deg), 15);
    assert.deepEqual(await numericalSnapshot(h.page), before, 'alignment presentation must not change MSI values or ROI coordinates/statistics');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
