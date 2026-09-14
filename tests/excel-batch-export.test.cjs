'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

const datasetId = number => 'excel-' + String(number).padStart(3, '0');

// Use the production controller, synchronizer, IndexedDB and exporters. Network
// transport is hermetic; real SheetJS/JSZip bytes cross the browser download API.
async function fixture({ count = 3, conflicts = [], missingRaw = [], absentStandard = [], warnings = [] } = {}) {
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
        const rows = () => JSON.parse(localStorage.getItem('excel-test-remote') || '{}');
        window.__excelCloudCalls = [];
        Cloud.configured = () => true;
        Cloud.signedIn = () => true;
        Cloud.listProjects = async () => {
          window.__excelCloudCalls.push({ kind: 'list' });
          if (window.__excelFailList) throw new Error('synthetic list unavailable');
          return Object.values(rows());
        };
        Cloud.getProject = async id => {
          window.__excelCloudCalls.push({ kind: 'get', id });
          return rows()[id] || null;
        };
        Cloud.downloadBundle = async path => {
          window.__excelCloudCalls.push({ kind: 'download', path });
          throw new Error('A conflict must not replace existing local rasters');
        };
        for (const method of ['patchRow', 'patchRowIfUnchanged', 'insertRowIfAbsent', 'uploadBundle', 'removeBundle', 'removeRow', 'removeRowIfUnchanged']) {
          Cloud[method] = async () => {
            window.__excelCloudCalls.push({ kind: 'write', method });
            throw new Error('Excel export must not write to the cloud');
          };
        }
      })();`,
    }));
    await seedViewerProject(h.page, h.baseURL, { id: datasetId(1) });
    await h.page.addScriptTag({ url: h.baseURL + '/lib/cloud.js' });
    await h.page.evaluate(async config => {
      const template = await ProjectStorage.getProject('excel-001'), rows = {};
      for (let n = 1; n <= config.count; n++) {
        const p = structuredClone(template);
        p.id = 'excel-' + String(n).padStart(3, '0');
        p.displayName = 'Dataset ' + String(n).padStart(3, '0');
        if (config.absentStandard.includes(n)) {
          p.molecules = p.molecules.filter(m => m.key !== 'MSI_D4-5-HT');
          delete p.normalization;
          p.valueDisplay.mode = 'raw';
        }
        if (config.missingRaw.includes(n)) p.molecules[0].blobId = 'missing-raw-' + n;
        if (config.warnings.includes(n)) p.roi.roi_items.invalid = [{}];
        p.cloudUpdatedAt = '2026-01-01T00:00:00.000Z';
        p.cloudBundlePath = 'synthetic/' + p.id + '/original.zip';
        p.cloudRev = 1;
        p.cloudPending = false;
        p.cloudDisplayName = p.displayName;
        p.cloudStateHash = Cloud.hashState(Cloud.stateOf(p));
        rows[p.id] = {
          id: p.id, display_name: p.displayName, folder_path: [],
          meta: structuredClone(Cloud.metaOf(p)), state: structuredClone(Cloud.stateOf(p)), updated_at: p.cloudUpdatedAt,
          bundle_path: p.cloudBundlePath, bundle_rev: p.cloudRev,
        };
        if (config.conflicts.includes(n)) {
          p.roi.roi_names.all = 'Unsynchronized local ROI';
          rows[p.id].state.roi.roi_names.all = 'Different cloud ROI';
          rows[p.id].updated_at = '2026-01-01T00:00:10.000Z';
        }
        await ProjectStorage.putProject(p);
      }
      localStorage.setItem('excel-test-remote', JSON.stringify(rows));
    }, { count, conflicts, missingRaw, absentStandard, warnings });
    await h.page.goto(h.baseURL + '/');
    await h.page.locator('#project-list [data-act="open"]').first().waitFor();
    await h.page.waitForFunction(() => !document.getElementById('excel-export-all').disabled);
    h.downloads = [];
    h.dialogs = [];
    h.acceptCancellation = true;
    h.page.on('download', download => h.downloads.push(download));
    h.page.on('dialog', dialog => {
      h.dialogs.push(dialog.message());
      // The start consent is accepted. Replacement is always declined so an
      // accidentally reintroduced bulk conflict prompt also fails the count.
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
  await h.page.waitForFunction(() => !document.getElementById('excel-export-all').disabled &&
    document.getElementById('excel-export-cancel').classList.contains('hidden'));
  assert.equal(await h.page.locator('#normalization-settings').isDisabled(), false);
  assert.equal(await h.page.locator('#bulk-export').isDisabled(), true, 'unselected bulk actions remain disabled');
  assert.deepEqual(h.errors, []);
}

async function runExport(h) {
  await h.page.locator('#excel-export-all').click();
  await waitFinished(h);
}

async function downloadedArchive(h) {
  assert.equal(h.downloads.length, 1, 'exactly one archive download is initiated');
  const download = h.downloads[0];
  assert.equal(await download.failure(), null);
  const archive = await JSZip.loadAsync(await fs.readFile(await download.path()));
  const workbooks = Object.keys(archive.files).filter(name => /^datasets\/.*\.xlsx$/.test(name));
  const index = XLSX.read(await archive.file('_Export_Index.xlsx').async('nodebuffer'), { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(index.Sheets.Index, { header: 1, defval: null });
  const headerAt = rows.findIndex(row => row[0] === 'No.');
  assert.ok(headerAt > 0);
  const headers = rows[headerAt];
  const records = rows.slice(headerAt + 1).filter(row => row[0] != null).map(row =>
    Object.fromEntries(headers.map((header, i) => [header, row[i]])));
  return { archive, filename: download.suggestedFilename(), workbooks, records,
    metadata: Object.fromEntries(rows.slice(0, headerAt).filter(row => row[0]).map(row => [row[0], row[1]])) };
}

async function scientificSnapshot(page) {
  return page.evaluate(async () => {
    const result = {};
    for (const p of await ProjectStorage.listProjects()) {
      const raw = {};
      for (const m of p.molecules) {
        const values = await ProjectStorage.getValueRaster(m.blobId);
        raw[m.key] = values ? Array.from(new Uint32Array(values.buffer, values.byteOffset, values.length)) : null;
      }
      result[p.id] = { normalization: p.normalization || null, roi: p.roi, valueDisplay: p.valueDisplay,
        molecules: p.molecules, raw, cloudUpdatedAt: p.cloudUpdatedAt, cloudStateHash: p.cloudStateHash };
    }
    return { projects: result, remote: JSON.parse(localStorage.getItem('excel-test-remote')) };
  });
}

async function directAnalyticalSheets(page, ids) {
  return page.evaluate(async ids => {
    const result = {};
    for (const id of ids) {
      const project = await ProjectStorage.getProject(id);
      project.folderPath = [];
      const output = await ExcelIO.buildProjectXlsx(project, { storage: ProjectStorage }, { folderPath: [] });
      const workbook = XLSX.read(output.bytes, { type: 'array' });
      result[id] = Object.fromEntries(workbook.SheetNames.filter(name => /^(Data|Normalized_Data|ROI_Quantification)(_|$)/.test(name))
        .map(name => [name, XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: null })]));
    }
    return result;
  }, ids);
}

async function assertAnalyticalSheets(output, expected) {
  for (const [id, sheets] of Object.entries(expected)) {
    const record = output.records.find(row => row['Project ID'] === id);
    const workbook = XLSX.read(await output.archive.file(record['Workbook path']).async('nodebuffer'), { type: 'buffer' });
    for (const [name, rows] of Object.entries(sheets)) {
      assert.deepEqual(XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: null }), rows,
        id + ' retains direct-export ' + name + ' values, blanks and coordinates');
    }
  }
}

for (const count of [3, 81]) test(`Excel batch downloads ${count - 1} successful workbooks across one conflict without another prompt`, { timeout: 120000 }, async () => {
  const skipped = count === 81 ? 77 : 2;
  const h = await fixture({ count, conflicts: [skipped] });
  try {
    const before = await scientificSnapshot(h.page);
    const expected = await directAnalyticalSheets(h.page, [datasetId(1), datasetId(count)]);
    await runExport(h);
    const output = await downloadedArchive(h);
    assert.equal(h.dialogs.length, 1, 'only the initial batch consent appears');
    assert.equal(output.workbooks.length, count - 1);
    assert.equal(output.records.length, count);
    assert.match(output.filename, /_PARTIAL\.zip$/);
    assert.equal(output.metadata['Archive status'], 'PARTIAL');
    assert.equal(output.metadata['Succeeded datasets'], count - 1);
    assert.equal(output.metadata['Failed datasets'], 1);
    const failed = output.records.find(row => row['Project ID'] === datasetId(skipped));
    assert.equal(failed.Status, 'error');
    assert.equal(failed['Workbook path'], '');
    assert.match(failed.Error, /手元の編集を保持.*クラウドにも更新/);
    await assertAnalyticalSheets(output, expected);
    assert.deepEqual(await scientificSnapshot(h.page), before);
    const status = await h.page.locator('#excel-export-status').innerText();
    assert.match(status, /ダウンロードを開始しました/);
    assert.match(status, /_Export_Index\.xlsx/);
    assert.match(status, /Dataset.*手元の編集を保持/s);
    assert.equal(await h.page.evaluate(() => window.__excelCloudCalls.some(call => ['write', 'download'].includes(call.kind))), false);
  } finally { await h.close(); }
});

test('Excel skips a missing registered raster, while absent internal standard and ROI warnings still export real raw data', { timeout: 90000 }, async () => {
  const h = await fixture({ count: 4, missingRaw: [2], absentStandard: [3], warnings: [4] });
  try {
    const before = await scientificSnapshot(h.page);
    const expected = await directAnalyticalSheets(h.page, [datasetId(1), datasetId(3), datasetId(4)]);
    await runExport(h);
    const output = await downloadedArchive(h);
    assert.equal(h.dialogs.length, 1);
    assert.equal(output.workbooks.length, 3);
    const byId = Object.fromEntries(output.records.map(record => [record['Project ID'], record]));
    assert.match(byId[datasetId(2)].Error, /登録済み分子.*生値ラスタ/);
    assert.equal(byId[datasetId(3)].Status, 'success');
    assert.equal(byId[datasetId(3)]['Molecules'], 3);
    assert.equal(byId[datasetId(4)].Status, 'warning');
    assert.match(byId[datasetId(4)].Warnings, /ROI/);
    await assertAnalyticalSheets(output, expected);
    assert.deepEqual(await scientificSnapshot(h.page), before);
  } finally { await h.close(); }
});

test('Warning-only Excel batch is complete and ordinary open still asks before replacing local edits', { timeout: 90000 }, async () => {
  const h = await fixture({ count: 1, warnings: [1] });
  try {
    await runExport(h);
    const output = await downloadedArchive(h);
    assert.doesNotMatch(output.filename, /_PARTIAL/);
    assert.equal(output.metadata['Archive status'], 'COMPLETE');
    assert.equal(output.records[0].Status, 'warning');
    await h.page.evaluate(async () => {
      const p = await ProjectStorage.getProject('excel-001');
      p.roi.roi_names.all = 'New local ROI';
      await ProjectStorage.saveProjectIfUnchanged(p, p.updatedAt);
      const rows = JSON.parse(localStorage.getItem('excel-test-remote'));
      rows[p.id].state.roi.roi_names.all = 'New remote ROI';
      rows[p.id].updated_at = '2026-01-01T00:00:10.000Z';
      localStorage.setItem('excel-test-remote', JSON.stringify(rows));
    });
    const before = await scientificSnapshot(h.page);
    await h.page.locator('#project-list [data-act="open"]').click();
    await h.page.waitForURL('**/viewer/index.html?project=excel-001');
    assert.equal(h.dialogs.length, 2);
    assert.match(h.dialogs[1], /未同期の変更.*失われます/s);
    assert.deepEqual(await scientificSnapshot(h.page), before);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

async function pauseWorkbook(page, at) {
  await page.evaluate(at => {
    const build = ExcelIO.buildProjectXlsx;
    window.__excelBuildCalls = 0;
    ExcelIO.buildProjectXlsx = async (...args) => {
      if (++window.__excelBuildCalls === at) {
        window.__excelWorkbookPaused = true;
        await new Promise(resolve => { window.__excelReleaseWorkbook = resolve; });
      }
      return build(...args);
    };
  }, at);
}

for (const [at, accept] of [[1, true], [1, false], [2, true], [2, false]]) {
  test(`Excel cancellation during ${at === 2 ? 'last' : 'first'} dataset ${accept ? 'offers and downloads' : 'declines'} completed work`, { timeout: 90000 }, async () => {
    const h = await fixture({ count: 2 });
    try {
      h.acceptCancellation = accept;
      await pauseWorkbook(h.page, at);
      await h.page.locator('#excel-export-all').click();
      await h.page.waitForFunction(() => window.__excelWorkbookPaused);
      assert.equal(await h.page.locator('#normalization-settings').isDisabled(), true);
      await h.page.locator('#excel-export-cancel').click();
      await h.page.evaluate(() => window.__excelReleaseWorkbook());
      await waitFinished(h);
      assert.equal(h.dialogs.length, 2, 'every accepted cancellation request requires a download decision');
      assert.match(h.dialogs[1], /キャンセル/);
      assert.equal(await h.page.evaluate(() => window.__excelBuildCalls), at);
      if (accept) {
        const output = await downloadedArchive(h);
        assert.equal(output.workbooks.length, at);
        assert.equal(output.records.length, 2);
        assert.equal(output.metadata['Archive status'], at === 1 ? 'PARTIAL' : 'COMPLETE');
        if (at === 1) {
          assert.match(output.filename, /_PARTIAL\.zip$/);
          assert.match(output.records[1].Error, /キャンセル.*未処理/);
        } else assert.doesNotMatch(output.filename, /_PARTIAL/);
      } else {
        assert.equal(h.downloads.length, 0);
        if (at === 2) {
          // Reuse this page immediately: stale cancellation/busy state must
          // neither stop the next batch nor add another partial-file consent.
          h.acceptCancellation = true;
          await runExport(h);
          const retry = await downloadedArchive(h);
          assert.equal(retry.workbooks.length, 2);
          assert.equal(retry.records.length, 2);
          assert.equal(retry.metadata['Archive status'], 'COMPLETE');
          assert.doesNotMatch(retry.filename, /_PARTIAL/);
          assert.equal(h.dialogs.length, 3, 'retry adds only its fresh start confirmation');
          assert.match(h.dialogs[2], /処理を開始しますか/);
          assert.equal(await h.page.evaluate(() => window.__excelBuildCalls), 4);
        }
      }
    } finally { await h.close(); }
  });
}

test('All failed datasets stop before index serialization and restore controls without a ZIP', { timeout: 90000 }, async () => {
  const h = await fixture({ count: 2, missingRaw: [1, 2] });
  try {
    await h.page.evaluate(() => {
      window.__excelIndexCalls = 0;
      ExcelIO.buildIndexXlsx = () => { window.__excelIndexCalls++; throw new Error('Index must not be built for zero successful datasets'); };
    });
    await runExport(h);
    assert.equal(h.downloads.length, 0);
    assert.equal(await h.page.evaluate(() => window.__excelIndexCalls), 0);
    assert.match(await h.page.locator('#excel-export-status').innerText(), /Excel を作成できたデータはありません/);
  } finally { await h.close(); }
});

for (const failure of ['list', 'index', 'zip']) test(`Excel ${failure} failure does not download and restores existing control states`, { timeout: 90000 }, async () => {
  const h = await fixture({ count: 1 });
  try {
    await h.page.evaluate(failure => {
      if (failure === 'list') window.__excelFailList = true;
      if (failure === 'index') ExcelIO.buildIndexXlsx = () => { throw new Error('synthetic index failure'); };
      if (failure === 'zip') JSZip.prototype.generateAsync = async () => { throw new Error('synthetic zip failure'); };
    }, failure);
    await runExport(h);
    assert.equal(h.downloads.length, 0);
    assert.equal(h.dialogs.length, failure === 'list' ? 0 : 1);
    assert.match(await h.page.locator('#excel-export-status').innerText(), failure === 'list' ? /最新一覧を取得できません/ : new RegExp('synthetic ' + failure + ' failure'));
  } finally { await h.close(); }
});
