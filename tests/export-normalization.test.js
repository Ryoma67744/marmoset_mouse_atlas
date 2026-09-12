'use strict';

// Dependency-free structural tests. SheetJS is replaced at the serialization
// boundary only; production table iteration, export logic and ZIP import run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function context(maxRows) {
  const clone = value => JSON.parse(JSON.stringify(value));
  class FakeZip {
    constructor() { this.files = {}; }
    file(name, value) {
      if (arguments.length === 2) { this.files[name] = { dir: false, value }; return this; }
      return this.files[name] && { async: async () => this.files[name].value };
    }
    async generateAsync() { return this; }
    static async loadAsync(value) { return value; }
  }
  const c = { console, Float32Array, Float64Array, Uint8Array, Blob, JSZip: FakeZip };
  c.window = c;
  c.XLSX = {
    utils: {
      aoa_to_sheet: rows => ({ rows: clone(rows) }),
      sheet_add_aoa: (sheet, rows, options) => {
        rows.forEach((row, i) => { sheet.rows[options.origin.r + i] = clone(row); });
      },
      book_new: () => ({ SheetNames: [], Sheets: {} }),
      book_append_sheet: (workbook, sheet, name) => {
        assert.ok(name.length <= 31);
        assert.ok(!workbook.Sheets[name]);
        workbook.SheetNames.push(name); workbook.Sheets[name] = sheet;
      },
    },
    write: workbook => { c.lastWorkbook = workbook; return new Uint8Array([1, 2, 3]); },
  };
  vm.createContext(c);
  for (const file of ['msi.js', 'zipio.js', 'excelio.js', 'cloud.js']) {
    let source = fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8');
    if (file === 'excelio.js' && maxRows) source = source.replace('const EXCEL_MAX_ROWS = 1048576;', 'const EXCEL_MAX_ROWS = ' + maxRows + ';');
    vm.runInContext(source, c, { filename: file });
  }
  return c;
}

function fixture(c) {
  const data = {
    h: new Float32Array([0, 10, 10, NaN]),
    d: new Float32Array([1, 0, 2, NaN]),
    a: new Float32Array([3, 4, 5, NaN]),
  };
  const project = {
    id: 'original', displayName: 'example', grid: { W: 2, H: 2 }, images: {},
    molecules: [{ key: 'h', name: '5-HT', blobId: 'h' }, { key: 'd', name: 'd4-5-HT', blobId: 'd' }, { key: 'a', name: 'DA', blobId: 'a' }],
    roi: { roi_items: { r: [{ poly_msi: [[-1, -1], [3, -1], [3, 3], [-1, 3]] }] }, roi_names: { r: 'ROI' } },
    normalization: { id: 'profile', revision: 2, batchId: 'batch', quality: 'PROVISIONAL', section: { Ds: 1, Dref: 2, k: 2 } },
    valueDisplay: { mode: 'normalized', scaleMode: 'common' }, otsu: { applied: false, sourceKeys: ['h', 'a'] },
  };
  let id = 0;
  const storage = {
    getValueRaster: async key => data[key],
    putValueRaster: async values => { const key = 'new_' + ++id; data[key] = values; return key; },
    ensureFolderPath: async () => null,
    uid: prefix => prefix + '_new', putProject: async p => { storage.lastProject = p; },
  };
  let quantifyCalls = 0;
  c.Normalization = {
    reasonText: code => 'reason:' + code,
    evaluate: () => ({ profile: project.normalization, status: 'PROVISIONAL', reasonCodes: [],
      section: { k: 2, status: 'PROVISIONAL' }, fingerprint: 'stable-content',
      channels: {
        h: { role: 'ht', method: 'pixel_ratio', unit: 'ratio', values: new Float64Array([0, NaN, 5, NaN]), status: 'PARTIAL',
          reasonCodes: [], pixelReasons: [[], ['D4_LOW_SIGNAL'], [], ['NO_MEASURED_PIXELS']] },
        d: { role: 'd4', method: 'raw_qc', unit: '', values: null, status: 'RAW_QC', reasonCodes: [] },
        a: { role: 'da', method: 'section_factor', unit: 'a.u.', values: new Float64Array([6, 8, 10, NaN]), status: 'PROVISIONAL', reasonCodes: [] },
      } }),
    quantifyRoi: (_project, _rasters, _evaluation, mask) => {
      quantifyCalls += 1;
      assert.equal(mask.reduce((a, b) => a + b, 0), 4);
      return project.molecules.map(m => ({ key: m.key, name: m.name, role: m.key === 'h' ? 'ht' : m.key === 'd' ? 'd4' : 'da',
        raw: { mean: 3, sd: 2, n: 3 }, normalized: { mean: m.key === 'h' ? 2.5 : 8, sd: 2.5, n: 2 },
        absolute: { value: null, unit: '', status: 'UNAVAILABLE', reasonCodes: ['CALIBRATION_MISSING'] },
        nGeometry: 4, nMeasured: 3, nValid: 2, coverage: 2 / 3, status: 'PARTIAL', reasonCodes: [], reasonCounts: {} }));
    },
  };
  c.Otsu = { buildProjectRecord: () => ({ usable: true, status: 'VALID', reasonCodes: [],
    keep: new Uint8Array([0, 0, 0, 0]), evaluable: new Uint8Array([1, 1, 1, 0]) }) };
  return { project, data, storage, quantifyCalls: () => quantifyCalls };
}

test('Data remains raw; aligned normalized rows preserve zero and do not remove a low-D4 pixel', async () => {
  const c = context(), f = fixture(c);
  const before = Object.fromEntries(Object.entries(f.data).map(([key, values]) => [key, Buffer.from(values.buffer).toString('hex')]));
  const result = await c.ExcelIO.buildProjectXlsx(f.project, { storage: f.storage }, { chunkSize: 1 });
  const w = c.lastWorkbook;
  assert.equal(w.SheetNames[0], 'Data');
  assert.deepEqual(w.Sheets.Data.rows, [
    ['x', 'y', '5-HT', 'd4-5-HT', 'DA', 'ROI'],
    [1, 1, 0, 1, 3, 1], [2, 1, 10, 0, 4, 1], [1, 2, 10, 2, 5, 1],
  ]);
  const rows = w.Sheets.Normalized_Data.rows;
  assert.equal(rows.length, w.Sheets.Data.rows.length);
  assert.match(rows[0][2], /5-HT.*ratio/);
  assert.equal(rows[1][2], 0);
  assert.equal(rows[2][2], null);
  assert.equal(rows[2][4], 8, 'DA uses a section factor even when local d4 is zero');
  assert.equal(rows[2][7], 'D4_LOW_SIGNAL');
  for (const row of rows.slice(1)) assert.equal(row[rows[0].indexOf('Otsu_Visible')], null);
  for (const [key, values] of Object.entries(f.data)) assert.equal(Buffer.from(values.buffer).toString('hex'), before[key]);
  assert.equal(result.normalization.factor, 2);
  assert.equal(result.normalization.absoluteStatus, 'UNAVAILABLE');
  assert.equal(f.quantifyCalls(), 1);
});

test('committed Otsu mask changes only visibility columns, not raw/derived/ROI analytical values', async () => {
  const c = context(), f = fixture(c);
  await c.ExcelIO.buildProjectXlsx(f.project, { storage: f.storage });
  const off = c.lastWorkbook;
  f.project.otsu.applied = true;
  const snapshot = JSON.stringify(f.project);
  await c.ExcelIO.buildProjectXlsx(f.project, { storage: f.storage });
  const on = c.lastWorkbook;
  assert.deepEqual(on.Sheets.Data.rows, off.Sheets.Data.rows);
  on.Sheets.Normalized_Data.rows.slice(1).forEach((row, i) => {
    assert.deepEqual(row.slice(0, -3), off.Sheets.Normalized_Data.rows[i + 1].slice(0, -3));
    assert.equal(row.at(-3), 0);
  });
  on.Sheets.ROI_Quantification.rows.slice(1).forEach((row, i) => {
    assert.deepEqual(row.slice(0, -1), off.Sheets.ROI_Quantification.rows[i + 1].slice(0, -1));
  });
  assert.equal(on.Sheets.ROI_Quantification.rows[1].at(-1), 0);
  assert.equal(JSON.stringify(f.project), snapshot);
});

test('missing normalization library or calculation exception does not prevent raw export', async () => {
  const c = context(), f = fixture(c);
  delete c.Normalization;
  let result = await c.ExcelIO.buildProjectXlsx(f.project, { storage: f.storage });
  assert.equal(result.rowCount, 3);
  assert.equal(result.normalization.status, 'UNAVAILABLE');
  assert.match(c.lastWorkbook.Sheets.Normalized_Data.rows[1][8], /読み込まれていない/);
  c.Normalization = { evaluate: () => { throw new Error('synthetic failure'); } };
  result = await c.ExcelIO.buildProjectXlsx(f.project, { storage: f.storage });
  assert.equal(result.rowCount, 3);
  assert.deepEqual(Array.from(result.normalization.reasonCodes), ['NORMALIZATION_CALCULATION_FAILED']);
});

test('index appends normalization metadata without conflating file success and unavailable quantification', () => {
  const c = context();
  const result = c.ExcelIO.buildIndexXlsx([{ status: 'success', projectId: 'p', moleculeNames: ['5-HT'],
    normalization: { status: 'UNAVAILABLE', profileId: 'profile', revision: 3, absoluteStatus: 'UNAVAILABLE',
      absoluteReasonCodes: ['CALIBRATION_MISSING'], absoluteReasonText: '検量線がありません' } }]);
  const rows = c.lastWorkbook.Sheets.Index.rows;
  const headerIndex = rows.findIndex(row => row[0] === 'No.');
  const header = rows[headerIndex], row = rows[headerIndex + 1];
  assert.deepEqual(header.slice(0, 13), ['No.', 'Status', 'Project ID', 'Project name', 'Folder', 'Workbook path',
    'Data rows', 'Molecules', 'Molecule names', 'ROIs', 'Data sheets', 'Warnings', 'Error']);
  assert.equal(row[1], 'success');
  assert.equal(row[header.indexOf('Normalization status')], 'UNAVAILABLE');
  assert.equal(result.successCount, 1);
});

test('cloud state and ZIP round-trip preserve fixed profile/display settings and raw Float32 values', async () => {
  const c = context(), f = fixture(c);
  f.data.h[1] = Math.fround(1.234567891);
  f.project.normalization.rawFingerprint = 'content-not-blob-id';
  const state = c.Cloud.stateOf(f.project), restored = c.Cloud.applyState({}, state);
  assert.deepEqual(restored.normalization, f.project.normalization);
  assert.deepEqual(restored.valueDisplay, f.project.valueDisplay);
  assert.equal(c.Cloud.metaOf(f.project).normalization.factor, 2);
  assert.equal(c.Cloud.metaOf(f.project).normalization.status, 'SAVED_NOT_REEVALUATED');
  const hash = c.Cloud.hashState(state);
  assert.equal(c.Cloud.hashState(c.Cloud.stateOf(restored)), hash);
  const zip = await c.ZipIO.exportProject(f.project, { storage: f.storage });
  const imported = await c.ZipIO.importZip(zip, { storage: f.storage });
  assert.notEqual(imported.project.id, f.project.id);
  assert.deepEqual(JSON.parse(JSON.stringify(imported.project.normalization)), f.project.normalization);
  assert.deepEqual(JSON.parse(JSON.stringify(imported.project.valueDisplay)), f.project.valueDisplay);
  imported.project.molecules.forEach((m, i) => {
    assert.deepEqual(Buffer.from(f.data[m.blobId].buffer), Buffer.from(f.data[f.project.molecules[i].blobId].buffer));
  });
});

test('old ZIP without a profile restores in unconfigured state', async () => {
  const c = context(), f = fixture(c);
  delete f.project.normalization; delete f.project.valueDisplay;
  const zip = await c.ZipIO.exportProject(f.project, { storage: f.storage });
  const manifestFile = Object.values(zip.files).find(file => typeof file.value === 'string' && file.value.startsWith('{'));
  const old = JSON.parse(manifestFile.value);
  delete old.normalization; delete old.valueDisplay;
  manifestFile.value = JSON.stringify(old);
  const imported = await c.ZipIO.importZip(zip, { storage: f.storage });
  assert.equal(imported.project.normalization, null);
  assert.equal(imported.project.valueDisplay, null);
});

test('raw and derived sheets split at exactly the same row boundary', async () => {
  // Shrink the constant in the test VM, keeping the production splitting code.
  const c = context(3), f = fixture(c);
  const result = await c.ExcelIO.buildProjectXlsx(f.project, { storage: f.storage }, { chunkSize: 1 });
  assert.equal(result.dataSheetCount, 2);
  assert.equal(result.normalizedDataSheetCount, 2);
  const w = c.lastWorkbook;
  for (const suffix of ['001', '002']) {
    const raw = w.Sheets['Data_' + suffix].rows;
    const normalized = w.Sheets['Normalized_Data_' + suffix].rows;
    assert.equal(raw.length, normalized.length);
    assert.deepEqual(raw.map(row => row.slice(0, 2)), normalized.map(row => row.slice(0, 2)));
    assert.ok(raw.length <= 3);
  }
});

test('cancellation remains a file-export failure rather than producing a truncated workbook', async () => {
  const c = context(), f = fixture(c);
  await assert.rejects(c.ExcelIO.buildProjectXlsx(f.project, { storage: f.storage }, { shouldCancel: () => true }),
    error => error.code === 'EXPORT_CANCELLED');
  assert.equal(c.lastWorkbook, undefined);
});

test('missing registered raw blob fails explicitly, unlike absence of the d4 channel', async () => {
  const c = context(), f = fixture(c);
  delete f.data.d;
  await assert.rejects(c.ExcelIO.buildProjectXlsx(f.project, { storage: f.storage }), /登録済み分子.*生値ラスタ.*未登録/);
  f.project.molecules = f.project.molecules.filter(m => m.key !== 'd');
  delete f.project.normalization;
  delete c.Normalization;
  const result = await c.ExcelIO.buildProjectXlsx(f.project, { storage: f.storage });
  assert.equal(result.rowCount, 3);
  assert.equal(result.moleculeCount, 2);
  assert.equal(result.normalization.status, 'UNAVAILABLE');
});

test('valid pixel status and reasons exclude another pixel\'s low signal, saturation and channel coverage failure', async () => {
  const c = context(), f = fixture(c);
  const evaluate = c.Normalization.evaluate;
  c.Normalization.evaluate = () => {
    const result = evaluate();
    result.channels.h.reasonCodes = ['D4_LOW_SIGNAL', 'D4_SATURATION', 'INSUFFICIENT_VALID_COVERAGE'];
    return result;
  };
  await c.ExcelIO.buildProjectXlsx(f.project, { storage: f.storage });
  const rows = c.lastWorkbook.Sheets.Normalized_Data.rows;
  assert.equal(rows[1][6], 'VALID');
  assert.equal(rows[1][7], '');
  assert.equal(rows[2][6], 'UNAVAILABLE');
  assert.equal(rows[2][7], 'D4_LOW_SIGNAL');
});
