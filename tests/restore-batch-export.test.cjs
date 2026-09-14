'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

const datasetId = number => 'restore-' + String(number).padStart(3, '0');

// Exercise the real controller, synchronization checks, IndexedDB, native ZIP
// exporter/importer and browser downloads; only the cloud transport is replaced.
async function fixture({ count = 3, conflicts = [], missingRaw = [], missingImages = [] } = {}) {
  const h = await startBrowserHarness();
  try {
    for (const [pattern, filename] of [
      ['**/xlsx@*/dist/xlsx.full.min.js', require.resolve('xlsx/dist/xlsx.full.min.js')],
      ['**/jszip@*/dist/jszip.min.js', require.resolve('jszip/dist/jszip.min.js')],
    ]) {
      const body = await fs.readFile(filename, 'utf8');
      await h.context.route(pattern, route => route.fulfill({ contentType: 'application/javascript', body }));
    }
    await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
      contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};',
    }));
    const source = await fs.readFile(path.join(__dirname, '../lib/cloud.js'), 'utf8');
    await h.context.route(h.baseURL + '/lib/cloud.js', route => route.fulfill({
      contentType: 'application/javascript', body: source + `
      (() => {
        const rows = () => JSON.parse(localStorage.getItem('restore-test-remote') || '{}');
        window.__restoreCloudCalls = [];
        Cloud.configured = () => true;
        Cloud.signedIn = () => true;
        Cloud.listProjects = async () => {
          window.__restoreCloudCalls.push({ kind: 'list' });
          return Object.values(rows());
        };
        Cloud.getProject = async id => {
          window.__restoreCloudCalls.push({ kind: 'get', id });
          return rows()[id] || null;
        };
        Cloud.downloadBundle = async path => {
          window.__restoreCloudCalls.push({ kind: 'download', path });
          throw new Error('A conflict must not replace local source assets');
        };
        for (const method of ['putRow', 'patchRow', 'patchRowIfUnchanged', 'insertRowIfAbsent', 'uploadBundle', 'removeBundle', 'removeRow', 'removeRowIfUnchanged']) {
          Cloud[method] = async () => {
            window.__restoreCloudCalls.push({ kind: 'write', method });
            throw new Error('Restore export must not write to the cloud');
          };
        }
      })();`,
    }));
    await seedViewerProject(h.page, h.baseURL, { id: datasetId(1) });
    await h.page.addScriptTag({ url: h.baseURL + '/lib/cloud.js' });
    await h.page.evaluate(async config => {
      const template = await ProjectStorage.getProject('restore-001'), rows = {};
      for (let n = 1; n <= config.count; n++) {
        const p = structuredClone(template);
        p.id = 'restore-' + String(n).padStart(3, '0');
        // The first two have the same visible name in different folders.
        p.displayName = n <= 2 ? 'Cor_1_1' : 'Dataset ' + String(n).padStart(3, '0');
        const folderPath = n === 1 ? ['Marmoset', 'Coronal'] : n === 2 ? ['Mouse', 'Sagittal'] : [];
        p.folderId = await ProjectStorage.ensureFolderPath(folderPath);
        p.orientation = 'coronal'; p.plane = 'Cor'; p.sliceId = '1_' + n;
        p.grid.umPerPxX = 15; p.grid.umPerPxY = 20;
        p.world_coords = { T_he_to_msi: [1, 0, 0, 1, n, 2 * n] };
        p.alignment = { HE_Stain: { tx: n, ty: -n, scale: 1.25 } };
        p.layerDisplay = { MSI_5_HT: { opacity: 0.6, vmin: 0, vmax: 100 } };
        p.rotation = { all: 90, he: 0, msi: 180 };
        p.viewerTransform = { tx: 12 + n, ty: -5, scale: 2.5 };
        p.acquisitionRepair = { applied: true, source: 'synthetic test' };
        // Keep nontrivial Float32 values, signed zero and a missing pixel intact.
        const values = new Float32Array([0, -0, 1.234567891, NaN, 1e-10, 60, 70, 80]);
        p.molecules[0].blobId = await ProjectStorage.putValueRaster(values);
        p.molecules[0].stats = MSIRaster.deriveBakeStats(values);
        p.images = {};
        for (const [slot, color] of [['HE_Stain', '#a02050'], ['ATLAS', '#2050a0'], ['IMMUNO', '#20a050']]) {
          const canvas = document.createElement('canvas');
          canvas.width = 2; canvas.height = 2;
          const context = canvas.getContext('2d');
          context.fillStyle = color; context.fillRect(0, 0, 2, 2);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
          const filename = 'reference ' + n + '.png';
          const blobId = await ProjectStorage.putBlob({ blob, mime: 'image/png', filename });
          p.images[slot] = { blobId, mime: 'image/png', filename };
        }
        if (config.missingRaw.includes(n)) p.molecules[0].blobId = 'missing-raw-' + n;
        if (config.missingImages.includes(n)) p.images.HE_Stain.blobId = 'missing-image-' + n;
        p.cloudUpdatedAt = '2026-01-01T00:00:00.000Z';
        p.cloudBundlePath = 'synthetic/' + p.id + '/original.zip';
        p.cloudRev = 1; p.cloudPending = false;
        p.cloudDisplayName = p.displayName;
        p.cloudStateHash = Cloud.hashState(Cloud.stateOf(p));
        rows[p.id] = {
          id: p.id, display_name: p.displayName, folder_path: folderPath,
          meta: structuredClone(Cloud.metaOf(p)), state: structuredClone(Cloud.stateOf(p)),
          updated_at: p.cloudUpdatedAt, bundle_path: p.cloudBundlePath, bundle_rev: p.cloudRev,
        };
        if (config.conflicts.includes(n)) {
          p.roi.roi_names.all = 'Unsynchronized local ROI';
          rows[p.id].state.roi.roi_names.all = 'Different cloud ROI';
          rows[p.id].updated_at = '2026-01-01T00:00:10.000Z';
        }
        await ProjectStorage.putProject(p);
      }
      localStorage.setItem('restore-test-remote', JSON.stringify(rows));
    }, { count, conflicts, missingRaw, missingImages });
    await h.page.goto(h.baseURL + '/');
    await h.page.locator('#folder-tree .tree-node[title="Marmoset"]').waitFor();
    await h.page.waitForFunction(() => {
      const button = document.getElementById('restore-export-all');
      return button && !button.disabled;
    });
    h.downloads = []; h.dialogs = []; h.acceptCancellation = true;
    h.page.on('download', download => h.downloads.push(download));
    h.page.on('dialog', dialog => {
      h.dialogs.push(dialog.message());
      if (/未同期の変更.*失われます/s.test(dialog.message())) return dialog.dismiss();
      return /処理を開始しますか/.test(dialog.message()) || h.acceptCancellation
        ? dialog.accept() : dialog.dismiss();
    });
    return h;
  } catch (error) {
    await h.close();
    throw error;
  }
}

async function waitFinished(h) {
  await h.page.waitForFunction(() => !document.getElementById('restore-export-all').disabled &&
    document.getElementById('excel-export-cancel').classList.contains('hidden'));
  assert.equal(await h.page.locator('#excel-export-all').isDisabled(), false);
  assert.equal(await h.page.locator('#normalization-settings').isDisabled(), false);
  assert.equal(await h.page.locator('#bulk-export').isDisabled(), true, 'unselected bulk actions remain disabled');
  assert.deepEqual(h.errors, []);
}

async function runExport(h) {
  await h.page.locator('#restore-export-all').click();
  await waitFinished(h);
}

async function downloadedArchive(h) {
  assert.equal(h.downloads.length, 1, 'one outer archive crosses the browser download API');
  const download = h.downloads[0];
  assert.equal(await download.failure(), null);
  const archive = await JSZip.loadAsync(await fs.readFile(await download.path()));
  const archives = Object.keys(archive.files).filter(name => /^datasets\/.*\.zip$/.test(name));
  assert.ok(archive.file('_Restore_Export_Index.json'), 'the download contains its restore index');
  assert.ok(archive.file('README.txt'), 'the download contains restoration instructions');
  const index = JSON.parse(await archive.file('_Restore_Export_Index.json').async('string'));
  return { archive, filename: download.suggestedFilename(), archives, index };
}

async function projectSnapshots(page, ids) {
  return page.evaluate(async ids => {
    const result = {};
    const tree = ProjectStorage.buildFolderTree(await ProjectStorage.listFolders());
    for (const p of await ProjectStorage.listProjects()) {
      if (ids && !ids.includes(p.id)) continue;
      const raw = {}, images = {};
      for (const m of p.molecules) {
        const values = await ProjectStorage.getValueRaster(m.blobId);
        raw[m.key] = values ? Array.from(new Uint32Array(values.buffer, values.byteOffset, values.length)) : null;
      }
      for (const [key, im] of Object.entries(p.images || {})) {
        const record = await ProjectStorage.getBlob(im.blobId);
        images[key] = { filename: im.filename, mime: im.mime,
          bytes: record && record.blob ? Array.from(new Uint8Array(await record.blob.arrayBuffer())) : null };
      }
      result[p.id] = {
        displayName: p.displayName, folderPath: ProjectStorage.folderPathNames(p.folderId, tree.byId),
        grid: p.grid, orientation: p.orientation, plane: p.plane, sliceId: p.sliceId,
        state: Cloud.stateOf(p), viewerTransform: p.viewerTransform, acquisitionRepair: p.acquisitionRepair,
        moleculeNames: p.molecules.map(m => ({ key: m.key, name: m.name })), raw, images,
      };
    }
    return result;
  }, ids);
}

async function assertNoCloudMutation(h, remoteBefore) {
  assert.equal(await h.page.evaluate(() => window.__restoreCloudCalls.some(call => ['write', 'download'].includes(call.kind))), false);
  assert.deepEqual(await h.page.evaluate(() => JSON.parse(localStorage.getItem('restore-test-remote'))), remoteBefore);
}

test('Restore batch works without ExcelIO, downloads all folders, and each native inner ZIP restores source bytes and saved state', { timeout: 120000 }, async () => {
  const h = await fixture();
  try {
    // Scope must stay global even while the user is viewing just one subfolder.
    await h.page.locator('#folder-tree .tree-node[title="Marmoset"] .tree-twisty').click();
    await h.page.locator('#folder-tree .tree-node[title="Coronal"]').click();
    assert.deepEqual(await h.page.locator('#project-list input.sel').evaluateAll(inputs => inputs.map(input => input.value)), [datasetId(1)]);
    const before = await projectSnapshots(h.page);
    const remoteBefore = await h.page.evaluate(() => JSON.parse(localStorage.getItem('restore-test-remote')));
    await h.page.evaluate(() => { window.ExcelIO = undefined; });
    await runExport(h);
    const output = await downloadedArchive(h);
    assert.match(output.filename, /^marmoset_atlas_restore_\d{8}_\d{6}\.zip$/);
    assert.equal(h.dialogs.length, 1);
    assert.equal(output.index.status, 'COMPLETE');
    assert.equal(output.index.requestedCount, 3);
    assert.equal(output.index.records.length, 3);
    assert.equal(output.archives.length, 3);
    assert.equal(new Set(output.archives).size, 3, 'duplicate display names do not overwrite another dataset');
    assert.deepEqual(await projectSnapshots(h.page), before, 'export preserves stored scientific and display state');
    await assertNoCloudMutation(h, remoteBefore);

    for (const record of output.index.records) {
      const expected = before[record.projectId];
      assert.ok(expected);
      assert.equal(record.status, 'success');
      assert.equal(record.projectName, expected.displayName);
      assert.equal(record.folderPath, expected.folderPath.length ? expected.folderPath.join(' / ') : '(ルート)');
      assert.match(record.archivePath, /^datasets\/\d+_[A-Za-z0-9_.-]+\.zip$/);
      assert.ok(output.archives.includes(record.archivePath));
      const bytes = await output.archive.file(record.archivePath).async('nodebuffer');
      const inner = await JSZip.loadAsync(bytes);
      const manifestName = Object.keys(inner.files).find(name => !name.includes('/') && /\.json$/.test(name));
      assert.ok(manifestName);
      const manifest = JSON.parse(await inner.file(manifestName).async('string'));
      assert.equal(manifest.format, 'marmoset_atlas_v1');
      assert.deepEqual(manifest.folderPath, expected.folderPath);
      assert.deepEqual(manifest.normalization, expected.state.normalization);
      assert.deepEqual(manifest.roi, expected.state.roi);
      assert.deepEqual(manifest.alignment, expected.state.alignment);
      assert.deepEqual(manifest.viewerTransform, expected.viewerTransform);
      const csv = await inner.file(manifest.data.path).async('string');
      assert.match(csv, /^x,y,5-HT,D4-5-HT,DA,NE,/);
      assert.equal(csv.trimEnd().split('\n').length, 9, 'all eight measured pixels survive the native CSV');
      for (const [key, image] of Object.entries(expected.images)) {
        const entry = manifest.images[key];
        assert.ok(entry, key + ' is included in the native manifest');
        assert.deepEqual(Array.from(await inner.file(entry.path).async('uint8array')), image.bytes);
      }

      const imported = await h.page.evaluate(async bytes => {
        const result = await ZipIO.importZip(new Uint8Array(bytes));
        return { id: result.project.id, warnings: result.warnings };
      }, Array.from(bytes));
      assert.deepEqual(imported.warnings, [], 'existing native import accepts each extracted dataset ZIP');
      const restored = (await projectSnapshots(h.page, [imported.id]))[imported.id];
      assert.deepEqual(restored, expected, 'native restoration preserves folder, all raw Float32 bits, image originals and saved settings');
    }
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

for (const missing of ['missingRaw', 'missingImages']) {
  test(`Restore batch skips one ${missing} dataset and records a partial archive without another prompt`, { timeout: 90000 }, async () => {
    const h = await fixture({ [missing]: [1] });
    try {
      const before = await projectSnapshots(h.page);
      const remoteBefore = await h.page.evaluate(() => JSON.parse(localStorage.getItem('restore-test-remote')));
      await runExport(h);
      const output = await downloadedArchive(h);
      assert.equal(h.dialogs.length, 1);
      assert.match(output.filename, /_PARTIAL\.zip$/);
      assert.equal(output.index.status, 'PARTIAL');
      assert.equal(output.index.requestedCount, 3);
      assert.equal(output.index.records.length, 3);
      assert.equal(output.archives.length, 2);
      const failed = output.index.records.find(record => record.projectId === datasetId(1));
      assert.equal(failed.status, 'error');
      assert.equal(failed.archivePath, '');
      assert.match(failed.error, missing === 'missingRaw' ? /生値ラスタ/ : /画像/);
      assert.equal(output.index.records.filter(record => record.status === 'success').length, 2);
      assert.deepEqual(await projectSnapshots(h.page), before);
      await assertNoCloudMutation(h, remoteBefore);
      assert.match(await h.page.locator('#excel-export-status').innerText(), /_Restore_Export_Index\.json/);
    } finally { await h.close(); }
  });
}

test('Restore batch retains conflicting local edits and automatically downloads the other datasets', { timeout: 90000 }, async () => {
  const h = await fixture({ conflicts: [2] });
  try {
    const before = await projectSnapshots(h.page);
    const remoteBefore = await h.page.evaluate(() => JSON.parse(localStorage.getItem('restore-test-remote')));
    await runExport(h);
    const output = await downloadedArchive(h);
    assert.equal(h.dialogs.length, 1, 'bulk export never asks to overwrite conflicting local edits');
    assert.equal(output.archives.length, 2);
    assert.equal(output.index.status, 'PARTIAL');
    const failed = output.index.records.find(record => record.projectId === datasetId(2));
    assert.equal(failed.status, 'error');
    assert.equal(failed.archivePath, '');
    assert.match(failed.error, /手元の編集を保持.*クラウドにも更新/);
    assert.deepEqual(await projectSnapshots(h.page), before);
    await assertNoCloudMutation(h, remoteBefore);
  } finally { await h.close(); }
});

async function pauseNativeArchive(page, at) {
  await page.evaluate(at => {
    const build = ZipIO.exportProject;
    window.__restoreBuildCalls = 0;
    ZipIO.exportProject = async (...args) => {
      if (++window.__restoreBuildCalls === at) {
        window.__restoreArchivePaused = true;
        await new Promise(resolve => { window.__restoreReleaseArchive = resolve; });
      }
      return build(...args);
    };
  }, at);
}

for (const [at, accept] of [[1, true], [1, false], [2, true], [2, false]]) {
  test(`Restore cancellation during ${at === 2 ? 'last' : 'first'} dataset ${accept ? 'downloads' : 'declines'} completed archives`, { timeout: 90000 }, async () => {
    const h = await fixture({ count: 2 });
    try {
      h.acceptCancellation = accept;
      await pauseNativeArchive(h.page, at);
      await h.page.locator('#restore-export-all').click();
      await h.page.waitForFunction(() => window.__restoreArchivePaused);
      assert.equal(await h.page.locator('#excel-export-all').isDisabled(), true, 'Excel cannot race with a restoration batch');
      assert.equal(await h.page.locator('#normalization-settings').isDisabled(), true);
      await h.page.locator('#excel-export-cancel').click();
      await h.page.evaluate(() => window.__restoreReleaseArchive());
      await waitFinished(h);
      assert.equal(h.dialogs.length, 2, 'accepted cancellation requires a separate save decision');
      assert.match(h.dialogs[1], /キャンセル/);
      assert.equal(await h.page.evaluate(() => window.__restoreBuildCalls), at);
      if (accept) {
        const output = await downloadedArchive(h);
        assert.equal(output.archives.length, at);
        assert.equal(output.index.records.length, 2);
        assert.equal(output.index.status, at === 1 ? 'PARTIAL' : 'COMPLETE');
        if (at === 1) {
          assert.match(output.filename, /_PARTIAL\.zip$/);
          assert.equal(output.index.records[1].archivePath, '');
          assert.match(output.index.records[1].error, /キャンセル.*未処理/);
        } else assert.doesNotMatch(output.filename, /_PARTIAL/);
      } else {
        assert.equal(h.downloads.length, 0);
        if (at === 2) {
          h.acceptCancellation = true;
          await runExport(h);
          const retry = await downloadedArchive(h);
          assert.equal(retry.archives.length, 2);
          assert.equal(retry.index.status, 'COMPLETE');
          assert.equal(h.dialogs.length, 3, 'retry needs only its fresh start consent');
          assert.equal(await h.page.evaluate(() => window.__restoreBuildCalls), 4);
        }
      }
    } finally { await h.close(); }
  });
}

test('All failed restoration datasets produce no ZIP and restore the controls for another attempt', { timeout: 90000 }, async () => {
  const h = await fixture({ count: 2, missingRaw: [1], missingImages: [2] });
  try {
    const before = await projectSnapshots(h.page);
    await runExport(h);
    assert.equal(h.downloads.length, 0);
    assert.equal(h.dialogs.length, 1);
    assert.match(await h.page.locator('#excel-export-status').innerText(), /作成できたデータはありません/);
    assert.deepEqual(await projectSnapshots(h.page), before);
  } finally { await h.close(); }
});
