'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

// Exercise the real Master / Viewer / storage / state serializers. Only network
// transport is replaced; remote revisions and conditional writes remain real
// constraints, shared across tabs through a separate synthetic row store.
async function installCloud(h) {
  const source = await fs.readFile(path.join(__dirname, '../lib/cloud.js'), 'utf8');
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
    contentType: 'application/javascript; charset=utf-8', body: 'window.CLOUD_CONFIG = {};'
  }));
  await h.context.route(h.baseURL + '/lib/cloud.js', route => route.fulfill({
    contentType: 'application/javascript; charset=utf-8', body: source + `
    (() => {
      const read = key => JSON.parse(localStorage.getItem(key) || '{}');
      const write = (key, value) => localStorage.setItem(key, JSON.stringify(value));
      const log = entry => {
        const entries = JSON.parse(localStorage.getItem('reliability-calls') || '[]');
        entries.push(entry); write('reliability-calls', entries);
      };
      Cloud.configured = () => true;
      Cloud.signedIn = () => true;
      Cloud.listProjects = async () => Object.values(read('reliability-remote'));
      Cloud.getProject = async id => read('reliability-remote')[id] || null;
      Cloud.patchRowIfUnchanged = async (id, patch, expected) => {
        const rows = read('reliability-remote'), row = rows[id];
        log({ kind: 'patch', id, expected, actual: row && row.updated_at, keys: Object.keys(patch) });
        if (!row || row.updated_at !== expected) return null;
        Object.assign(row, structuredClone(patch));
        row.updated_at = new Date(Date.parse(row.updated_at) + 1000).toISOString();
        write('reliability-remote', rows);
        if (window.__holdPublishedBundle && patch.bundle_path) {
          window.__bundlePublished = true;
          await new Promise(resolve => { window.__releaseBundleAcknowledgement = resolve; });
        }
        return structuredClone(row);
      };
      Cloud.patchRow = async () => { throw new Error('Unconditional cloud writes are forbidden in this regression'); };
      Cloud.downloadBundle = async bundlePath => {
        log({ kind: 'download', path: bundlePath });
        throw new Error('Existing raw data must not be downloaded over newer local edits');
      };
      Cloud.bundlePath = (id, revision) => 'synthetic/' + id + '/v' + revision + '.zip';
      Cloud.uploadBundle = async (bundlePath, blob, progress) => {
        const bundles = read('reliability-bundles'); bundles[bundlePath] = { size: blob.size };
        write('reliability-bundles', bundles); log({ kind: 'upload', path: bundlePath });
        if (progress) progress(1);
      };
      Cloud.removeBundle = async bundlePath => {
        const bundles = read('reliability-bundles'); delete bundles[bundlePath];
        write('reliability-bundles', bundles); log({ kind: 'remove', path: bundlePath });
      };
      Cloud.removeRow = async () => { throw new Error('Source deletion must check the reviewed cloud revision'); };
      Cloud.removeRowIfUnchanged = async (id, expected) => {
        const rows = read('reliability-remote'), row = rows[id];
        log({ kind: 'delete-row', id, expected, actual: row && row.updated_at });
        if (!row || row.updated_at !== expected) return null;
        delete rows[id]; write('reliability-remote', rows);
        return structuredClone(row);
      };
    })();`
  }));
}

async function fixture(h, id, { configured = false, pending = false } = {}) {
  await installCloud(h);
  await seedViewerProject(h.page, h.baseURL, { id });
  await h.page.addScriptTag({ url: h.baseURL + '/lib/cloud.js' });
  const before = await h.page.evaluate(async ({ id, configured, pending }) => {
    const p = await ProjectStorage.getProject(id);
    localStorage.setItem('reliability-valid-profile', JSON.stringify(p.normalization));
    if (!configured) { p.normalization = null; p.valueDisplay.mode = 'raw'; }
    p.cloudUpdatedAt = '2026-01-01T00:00:00.000Z';
    p.cloudBundlePath = 'synthetic/' + id + '/original.zip'; p.cloudRev = 1;
    p.cloudStateHash = Cloud.hashState(Cloud.stateOf(p)); p.cloudPending = pending;
    await ProjectStorage.putProject(p);
    localStorage.setItem('reliability-remote', JSON.stringify({ [id]: {
      id, display_name: p.displayName, folder_path: [], meta: Cloud.metaOf(p), state: Cloud.stateOf(p),
      updated_at: p.cloudUpdatedAt, bundle_path: p.cloudBundlePath, bundle_rev: p.cloudRev
    } }));
    localStorage.setItem('reliability-bundles', JSON.stringify({ [p.cloudBundlePath]: { size: 100 } }));
    const bits = {};
    for (const m of p.molecules) {
      const values = await ProjectStorage.getValueRaster(m.blobId);
      bits[m.key] = Array.from(new Uint32Array(values.buffer, values.byteOffset, values.length));
    }
    return { profile: JSON.parse(localStorage.getItem('reliability-valid-profile')), bits, roi: p.roi };
  }, { id, configured, pending });
  await h.page.goto(h.baseURL + '/');
  await h.page.waitForSelector('#project-list [data-act="open"]');
  return before;
}

async function snapshot(page, id) {
  return page.evaluate(async id => {
    const p = await ProjectStorage.getProject(id), bits = {};
    for (const m of p.molecules) {
      const values = await ProjectStorage.getValueRaster(m.blobId);
      bits[m.key] = Array.from(new Uint32Array(values.buffer, values.byteOffset, values.length));
    }
    return { project: p, bits, remote: JSON.parse(localStorage.getItem('reliability-remote'))[id],
      calls: JSON.parse(localStorage.getItem('reliability-calls') || '[]'),
      bundles: JSON.parse(localStorage.getItem('reliability-bundles') || '{}') };
  }, id);
}

test('stale Master rename preserves a profile saved in another tab and later Viewer cloud save', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), id = 'stale-rename';
  const dialogs = [];
  h.page.on('dialog', dialog => {
    dialogs.push(dialog.message());
    return dialog.type() === 'prompt' ? dialog.accept('Renamed from stale Master') : dialog.dismiss();
  });
  try {
    const before = await fixture(h, id);
    const other = await h.context.newPage();
    await other.goto(h.baseURL + '/__test_seed');
    await other.addScriptTag({ url: h.baseURL + '/lib/cloud.js' });
    await other.evaluate(async id => {
      const p = await ProjectStorage.getProject(id);
      p.normalization = JSON.parse(localStorage.getItem('reliability-valid-profile'));
      p.valueDisplay.mode = 'normalized';
      const rows = JSON.parse(localStorage.getItem('reliability-remote'));
      rows[id].state = Cloud.stateOf(p); rows[id].meta = Cloud.metaOf(p);
      rows[id].updated_at = '2026-01-01T00:00:10.000Z';
      p.cloudUpdatedAt = rows[id].updated_at; p.cloudStateHash = Cloud.hashState(rows[id].state);
      localStorage.setItem('reliability-remote', JSON.stringify(rows));
      await ProjectStorage.saveProjectIfUnchanged(p, p.updatedAt);
    }, id);
    // This row's event handler still closes over the original profile-free p.
    await h.page.locator('#project-list [data-act="rename"]').click();
    await h.page.waitForFunction(id => JSON.parse(localStorage.getItem('reliability-remote'))[id].display_name === 'Renamed from stale Master', id);
    await h.page.waitForFunction(async id => (await ProjectStorage.getProject(id)).cloudUpdatedAt === '2026-01-01T00:00:11.000Z', id);
    const renamed = await snapshot(h.page, id);
    assert.equal(renamed.project.displayName, 'Renamed from stale Master');
    assert.deepEqual(renamed.project.normalization, before.profile);
    assert.deepEqual(renamed.remote.state.normalization, before.profile);
    assert.deepEqual(renamed.remote.meta.normalization, await h.page.evaluate(id => Cloud.metaOf(JSON.parse(localStorage.getItem('reliability-remote'))[id].state).normalization, id));
    assert.deepEqual(renamed.bits, before.bits);
    assert.deepEqual(renamed.project.roi, before.roi);

    await h.page.locator('#project-list [data-act="open"]').click();
    await h.page.waitForURL('**/viewer/index.html?project=' + id);
    await h.page.waitForFunction(() => typeof viewerReady !== 'undefined' && viewerReady && normalizationEvaluation && Object.keys(imageSettings).length > 0);
    await h.page.evaluate(async () => { await saveToCloud(); });
    const saved = await snapshot(h.page, id);
    assert.ok(saved.calls.some(call => call.kind === 'patch' && call.keys.includes('state')), 'Viewer submitted a conditional state save');
    assert.deepEqual(saved.project.normalization, before.profile);
    assert.deepEqual(saved.remote.state.normalization, before.profile);
    assert.deepEqual(saved.bits, before.bits);
    assert.deepEqual(saved.project.roi, before.roi);
    assert.equal(saved.calls.some(call => call.kind === 'download'), false);
    assert.equal(dialogs.length, 1, 'renaming was the only dialog; no accidental loss / save failure prompt');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Open from an old Master list uses current local edits and declining replacement preserves normalization', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), id = 'stale-open';
  const dialogs = [];
  h.page.on('dialog', dialog => { dialogs.push(dialog.message()); return dialog.dismiss(); });
  try {
    const before = await fixture(h, id);
    const other = await h.context.newPage();
    await other.goto(h.baseURL + '/__test_seed');
    await other.evaluate(async id => {
      const p = await ProjectStorage.getProject(id);
      p.normalization = JSON.parse(localStorage.getItem('reliability-valid-profile'));
      p.valueDisplay.mode = 'normalized'; p.roi.roi_names.all = 'Locally edited ROI';
      await ProjectStorage.saveProjectIfUnchanged(p, p.updatedAt);
      const rows = JSON.parse(localStorage.getItem('reliability-remote'));
      rows[id].state.roi.roi_names.all = 'Different remote ROI';
      rows[id].updated_at = '2026-01-01T00:00:10.000Z';
      localStorage.setItem('reliability-remote', JSON.stringify(rows));
    }, id);
    await h.page.locator('#project-list [data-act="open"]').click();
    await h.page.waitForURL('**/viewer/index.html?project=' + id);
    await h.page.waitForFunction(() => typeof viewerReady !== 'undefined' && viewerReady && normalizationEvaluation);
    const result = await snapshot(h.page, id);
    assert.ok(dialogs.some(message => /未同期.*変更/s.test(message)), 'actual latest local changes were detected before replacement');
    assert.deepEqual(result.project.normalization, before.profile);
    assert.equal(result.project.roi.roi_names.all, 'Locally edited ROI');
    assert.deepEqual(result.bits, before.bits);
    assert.equal(result.remote.state.normalization, null, 'declining download does not publish local settings');
    assert.equal(result.remote.state.roi.roi_names.all, 'Different remote ROI');
    assert.equal(result.calls.some(call => call.kind === 'download'), false, 'no replacement ZIP is requested over unsynchronized local edits');
    assert.equal(result.calls.some(call => call.kind === 'patch'), false, 'opening is not a remote write');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('published replacement bundle survives a local edit before upload acknowledgement', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), id = 'published-upload';
  try {
    const before = await fixture(h, id, { configured: true, pending: true });
    await h.page.evaluate(() => {
      // ZIP byte construction is tested separately; pause this regression only
      // after its row has been successfully published by the conditional write.
      ZipIO.exportProject = async () => new Blob(['synthetic replacement raw bundle']);
      window.__holdPublishedBundle = true;
    });
    await h.page.locator('#project-list [data-act="push"]').click();
    await h.page.waitForFunction(() => window.__bundlePublished === true);
    const other = await h.context.newPage();
    await other.goto(h.baseURL + '/__test_seed');
    await other.evaluate(async id => {
      const p = await ProjectStorage.getProject(id);
      p.roi.roi_names.all = 'Edited while upload acknowledgement was pending';
      await ProjectStorage.saveProjectIfUnchanged(p, p.updatedAt);
    }, id);
    await h.page.evaluate(() => window.__releaseBundleAcknowledgement());
    await h.page.waitForFunction(() => /アップロードに失敗しました/.test(document.body.textContent));
    const result = await snapshot(h.page, id);
    assert.equal(result.project.roi.roi_names.all, 'Edited while upload acknowledgement was pending');
    assert.equal(result.project.cloudPending, true, 'unacknowledged newer local data remains pending');
    assert.deepEqual(result.project.normalization, before.profile);
    assert.deepEqual(result.remote.state.normalization, before.profile);
    assert.deepEqual(result.bits, before.bits);
    assert.equal(result.remote.bundle_rev, 2);
    assert.notEqual(result.remote.bundle_path, result.project.cloudBundlePath);
    assert.ok(result.bundles[result.remote.bundle_path], 'the row-referenced published raw bundle still exists');
    assert.ok(result.bundles[result.project.cloudBundlePath], 'the old bundle remains available for in-flight readers');
    assert.equal(result.calls.some(call => call.kind === 'remove'), false, 'local acknowledgement failure does not delete a published cloud bundle');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('merge keeps a source changed remotely during target upload and retains all merged raw rasters', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), targetId = 'merge-target', sourceId = 'merge-source';
  const dialogs = [];
  h.page.on('dialog', dialog => {
    dialogs.push(dialog.message());
    return dialog.type() === 'confirm' ? dialog.accept() : dialog.dismiss();
  });
  try {
    await fixture(h, targetId, { configured: true });
    await seedViewerProject(h.page, h.baseURL, { id: sourceId });
    await h.page.addScriptTag({ url: h.baseURL + '/lib/cloud.js' });
    const before = await h.page.evaluate(async ({ targetId, sourceId }) => {
      const rows = JSON.parse(localStorage.getItem('reliability-remote'));
      const bundles = JSON.parse(localStorage.getItem('reliability-bundles'));
      const target = await ProjectStorage.getProject(targetId);
      // The production selection rule chooses a dataset with HE as the target.
      const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 2;
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      target.images.HE_Stain = { blobId: await ProjectStorage.putBlob({ blob, mime: 'image/png', filename: 'synthetic.png' }), mime: 'image/png' };
      target.displayName = 'Merge target';
      await ProjectStorage.saveProjectIfUnchanged(target, target.updatedAt);
      rows[targetId].display_name = target.displayName; rows[targetId].meta = Cloud.metaOf(target);
      const source = await ProjectStorage.getProject(sourceId);
      source.displayName = 'Merge source'; source.cloudUpdatedAt = '2026-01-01T00:00:00.000Z';
      source.cloudBundlePath = 'synthetic/' + sourceId + '/original.zip'; source.cloudRev = 1;
      source.cloudStateHash = Cloud.hashState(Cloud.stateOf(source)); source.cloudPending = false;
      await ProjectStorage.saveProjectIfUnchanged(source, source.updatedAt);
      rows[sourceId] = { id: sourceId, display_name: source.displayName, folder_path: [],
        state: Cloud.stateOf(source), meta: Cloud.metaOf(source), updated_at: source.cloudUpdatedAt,
        bundle_path: source.cloudBundlePath, bundle_rev: source.cloudRev };
      bundles[source.cloudBundlePath] = { size: 100 };
      localStorage.setItem('reliability-remote', JSON.stringify(rows));
      localStorage.setItem('reliability-bundles', JSON.stringify(bundles));
      localStorage.setItem('reliability-merge-source-before', JSON.stringify(source));
      const bits = {};
      for (const p of [target, source]) for (const m of p.molecules) {
        const values = await ProjectStorage.getValueRaster(m.blobId);
        bits[m.blobId] = Array.from(new Uint32Array(values.buffer, values.byteOffset, values.length));
      }
      return { bits, sourceRevision: rows[sourceId].updated_at, sourceBundle: rows[sourceId].bundle_path,
        sourceProfile: source.normalization, targetProfile: target.normalization, targetRoi: target.roi };
    }, { targetId, sourceId });
    await h.page.goto(h.baseURL + '/');
    await h.page.waitForFunction(() => document.querySelectorAll('#project-list input.sel').length === 2);
    await h.page.evaluate(() => {
      ZipIO.exportProject = async () => new Blob(['synthetic merged raw bundle']);
      window.__holdPublishedBundle = true;
    });
    for (const checkbox of await h.page.locator('#project-list input.sel').all()) await checkbox.check();
    await h.page.locator('#bulk-merge').click();
    await h.page.waitForFunction(() => window.__bundlePublished === true);

    const other = await h.context.newPage();
    await other.goto(h.baseURL + '/__test_seed');
    await other.addScriptTag({ url: h.baseURL + '/lib/cloud.js' });
    const newRemote = await other.evaluate(async sourceId => {
      // Simulate a second PC that still owns this source and saves new valid
      // settings while the first PC is publishing the merged target.
      const source = JSON.parse(localStorage.getItem('reliability-merge-source-before'));
      source.roi.roi_names.all = 'Source ROI edited on another PC during merge';
      const rasters = await Normalization.loadRasters(source, { storage: ProjectStorage });
      source.normalization = Normalization.createProfiles([{ project: source, rasters,
        mapping: Normalization.suggestMapping(source.molecules) }], {
        id: 'new-source-profile', revision: 2, batchId: 'new-source-batch', prepId: 'synthetic-prep', quality: 'provisional',
        coordinateMatchConfirmed: true, comparabilityConfirmed: true,
        qc: { minD4: 0, saturationD4: 1000, minCoverage: 0.8 },
        reference: { kind: 'whole_tissue', projectIds: [sourceId], roiNames: [] },
        calibration: null, otsuSourceRoles: ['ht', 'da']
      }).profiles[0].normalization;
      const rows = JSON.parse(localStorage.getItem('reliability-remote'));
      rows[sourceId].state = Cloud.stateOf(source); rows[sourceId].meta = Cloud.metaOf(source);
      rows[sourceId].updated_at = '2026-01-01T00:00:30.000Z';
      localStorage.setItem('reliability-remote', JSON.stringify(rows));
      return JSON.parse(JSON.stringify(rows[sourceId]));
    }, sourceId);
    await h.page.evaluate(() => window.__releaseBundleAcknowledgement());
    await h.page.waitForFunction(() => JSON.parse(localStorage.getItem('reliability-calls') || '[]').some(call => call.kind === 'delete-row'));
    await h.page.waitForFunction(() => /クラウド.*更新|更新.*クラウド|統合元|元データ/.test(document.body.textContent));
    const result = await h.page.evaluate(async ({ targetId, sourceId }) => {
      const project = await ProjectStorage.getProject(targetId), bits = {};
      for (const m of project.molecules) {
        const values = await ProjectStorage.getValueRaster(m.blobId);
        bits[m.blobId] = Array.from(new Uint32Array(values.buffer, values.byteOffset, values.length));
      }
      return { project, bits, sourceLocal: await ProjectStorage.getProject(sourceId),
        rows: JSON.parse(localStorage.getItem('reliability-remote')),
        calls: JSON.parse(localStorage.getItem('reliability-calls') || '[]'),
        bundles: JSON.parse(localStorage.getItem('reliability-bundles')) };
    }, { targetId, sourceId });
    assert.deepEqual(result.rows[sourceId], newRemote, 'source ROI and newer normalization remain available remotely');
    const deletion = result.calls.find(call => call.kind === 'delete-row' && call.id === sourceId);
    assert.ok(deletion, 'source deletion uses conditional API');
    assert.equal(deletion.expected, before.sourceRevision, 'deletion is pinned to the source version reviewed before upload');
    assert.equal(deletion.actual, newRemote.updated_at);
    assert.ok(result.bundles[before.sourceBundle], 'a changed source retains its original cloud bundle');
    assert.equal(result.calls.some(call => call.kind === 'remove' && call.path === before.sourceBundle), false);
    assert.equal(result.project.molecules.length, 8);
    assert.deepEqual(result.bits, before.bits, 'local merge transferred every raw raster without changing values');
    assert.equal(result.sourceLocal, undefined, 'local source ownership was transferred atomically to the merged target');
    assert.deepEqual(result.project.roi, before.targetRoi);
    assert.equal(result.project.normalization.calculationFingerprint, before.targetProfile.calculationFingerprint);
    assert.equal(result.project.normalization.invalidated.code, 'NORMALIZATION_PROFILE_STALE');
    assert.equal(result.project.cloudPending, false, 'the merged target is safely acknowledged');
    assert.ok(result.bundles[result.rows[targetId].bundle_path]);
    assert.equal(result.rows[targetId].bundle_path, result.project.cloudBundlePath);
    assert.ok(dialogs.filter(message => /統合/.test(message)).length >= 2);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
