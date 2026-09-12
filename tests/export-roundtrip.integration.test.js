'use strict';

// Run with the application's exact SheetJS version and JSZip installed:
// ATLAS_TEST_SHEETJS=/path/to/node_modules/xlsx ATLAS_TEST_JSZIP=/path/to/jszip
// node --test tests/export-roundtrip.integration.test.js
// No test dependency or generated workbook is shipped with the static app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const XLSX = require(process.env.ATLAS_TEST_SHEETJS || 'xlsx');
const JSZip = require(process.env.ATLAS_TEST_JSZIP || 'jszip');
const requiresDependencies = {};

function app(maxRows) {
  assert.equal(XLSX.version, '0.18.5', 'test the same SheetJS version as index.html');
  const c = { console, XLSX, JSZip, Float32Array, Float64Array, Uint8Array, Blob };
  c.window = c;
  vm.createContext(c);
  for (const file of ['msi.js', 'normalization.js', 'otsu.js', 'zipio.js', 'excelio.js', 'cloud.js']) {
    let source = fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8');
    if (file === 'excelio.js' && maxRows) source = source.replace('const EXCEL_MAX_ROWS = 1048576;', 'const EXCEL_MAX_ROWS = ' + maxRows + ';');
    vm.runInContext(source, c, { filename: file });
  }
  return c;
}

function fixture(c, withCalibration) {
  const data = {
    h: new Float32Array([0, 4, 6, 8, 1.234567891, -0, 4, NaN]),
    d: new Float32Array([1, 2, 0, 4, 1, 2, 4, NaN]),
    a: new Float32Array([2, 4, 6, 8, 10, 12, 14, NaN]),
  };
  const project = {
    id: 'sample', displayName: 'sample', images: {},
    alignment: {}, layerDisplay: {}, visibleLayers: [], world_coords: {}, rotation: { all: 0, he: 0, msi: 0 },
    grid: { W: 4, H: 2, umPerPxX: 15, umPerPxY: 15, coordinateFingerprint: 'original-msi-grid' },
    molecules: [{ key: 'h', name: '5-HT', blobId: 'h', grid: { W: 4, H: 2 } },
      { key: 'd', name: 'd4-5-HT', blobId: 'd' }, { key: 'a', name: 'DA', blobId: 'a' }],
    roi: { roi_items: { r: [{ poly_msi: [[-1, -1], [5, -1], [5, 3], [-1, 3]] }] }, roi_names: { r: 'ROI' } },
    valueDisplay: { mode: 'normalized', scaleMode: 'common' },
    otsu: { applied: false, sourceKeys: ['h', 'a'], strength: 0, manualThreshold: 1000 },
  };
  const rasters = Object.fromEntries(Object.entries(data).map(([key, values]) => [key, { W: 4, H: 2, values }]));
  const reference = Object.assign({}, project, { id: 'reference', displayName: 'reference' });
  const refRasters = Object.fromEntries(Object.entries(data).map(([key, values]) => [key,
    { W: 4, H: 2, values: Float32Array.from(values, value => value * 2) }]));
  const config = { id: 'fixed-profile', revision: 1, batchId: 'batch', prepId: 'prep', quality: 'provisional',
    coordinateMatchConfirmed: true, comparabilityConfirmed: true,
    qc: { minD4: 0, saturationD4: 1000, minCoverage: 0.5 },
    reference: { kind: 'whole_tissue', projectIds: ['reference'], roiNames: [] },
    calibration: withCalibration ? { id: 'cal', model: 'linear', validated: true, source: 'Synthetic software fixture only',
      unit: 'pmol/mm2', slope: 2, intercept: 0, lloq: 0, uloq: 100,
      responseMin: 0, responseMax: 200, responseAggregation: 'mean_pixel_ratio', prepId: 'prep', batchId: 'batch' } : null,
    otsuSourceRoles: ['ht', 'da'],
  };
  const created = c.Normalization.createProfiles([{ project, rasters }, { project: reference, rasters: refRasters }], config);
  project.normalization = created.profiles[0].normalization;
  assert.equal(project.normalization.section.k, 2);
  let serial = 0;
  const storage = {
    getValueRaster: async id => data[id],
    putValueRaster: async values => { const id = 'imported_' + ++serial; data[id] = values; return id; },
    ensureFolderPath: async () => null, uid: prefix => prefix + '_new', putProject: async () => {},
  };
  return { project, rasters, storage, data };
}

function rows(workbook, name) {
  return XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: null, raw: true });
}
function read(result) { return XLSX.read(result.bytes, { type: 'array' }); }

test('real XLSX preserves raw numbers and aligned derived blanks/zero; absolute ROI has no pixelwise absolute column', requiresDependencies, async () => {
  const c = app(), f = fixture(c, true);
  const snapshot = JSON.stringify(f.project);
  const rawBefore = Buffer.from(f.data.h.buffer).toString('hex');
  const result = await c.ExcelIO.buildProjectXlsx(f.project, { storage: f.storage }, { chunkSize: 2 });
  const workbook = read(result), raw = rows(workbook, 'Data'), normalized = rows(workbook, 'Normalized_Data');
  assert.equal(raw.length, 8);
  assert.equal(normalized.length, raw.length);
  assert.equal(raw[5][2], f.data.h[4]);
  assert.equal(normalized[1][2], 0);
  assert.equal(normalized[3][2], null);
  assert.equal(normalized[3][4], 12, 'local low D4 does not mask DA with a valid section factor');
  assert.match(normalized[3][7], /D4_LOW_SIGNAL/);
  assert.equal(normalized[3][6], 'UNAVAILABLE');
  assert.doesNotMatch(normalized[1][7], /D4_LOW_SIGNAL|D4_SATURATION(?!_UNKNOWN)/,
    'valid pixels must not inherit another pixel\'s local denominator faults');
  assert.equal(normalized[1][6], 'PROVISIONAL', 'pixel usability differs from channel PARTIAL status');
  assert.ok(!normalized[0].some(header => /absolute/i.test(header)));
  assert.equal(normalized[1].at(-3), null, 'Otsu off exports blank visibility');
  const roi = rows(workbook, 'ROI_Quantification');
  const h = roi[0], ht = roi.find(row => row[2] === 'h');
  const expected = c.Normalization.quantifyRoi(f.project, f.rasters,
    c.Normalization.evaluate(f.project, f.rasters), new Uint8Array(8).fill(1))[0];
  assert.equal(ht[h.indexOf('Absolute value')], expected.absolute.value);
  assert.equal(ht[h.indexOf('Absolute status')], 'VALID');
  assert.equal(ht[h.indexOf('Absolute unit')], 'pmol/mm2');
  assert.equal(JSON.stringify(f.project), snapshot);
  assert.equal(Buffer.from(f.data.h.buffer).toString('hex'), rawBefore);
});

test('real Otsu all-hidden export keeps numerical ROI and derived values and records saved mask flags', requiresDependencies, async () => {
  const c = app(), f = fixture(c, false);
  const off = read(await c.ExcelIO.buildProjectXlsx(f.project, { storage: f.storage }));
  f.project.otsu.applied = true;
  const on = read(await c.ExcelIO.buildProjectXlsx(f.project, { storage: f.storage }));
  assert.deepEqual(rows(on, 'Data'), rows(off, 'Data'));
  const offDerived = rows(off, 'Normalized_Data'), onDerived = rows(on, 'Normalized_Data');
  onDerived.slice(1).forEach((row, i) => {
    assert.deepEqual(row.slice(0, -3), offDerived[i + 1].slice(0, -3));
    assert.equal(row.at(-3), 0);
  });
  const offROI = rows(off, 'ROI_Quantification'), onROI = rows(on, 'ROI_Quantification');
  onROI.slice(1).forEach((row, i) => assert.deepEqual(row.slice(0, -1), offROI[i + 1].slice(0, -1)));
  assert.equal(onROI[1].at(-1), 0);
  assert.ok(onROI[1][onROI[0].indexOf('Normalized n')] > 0);
  assert.equal(onROI[1][onROI[0].indexOf('Absolute value')], null);
  assert.match(onROI[1][onROI[0].indexOf('Absolute reason codes')], /CALIBRATION_MISSING/);
});

test('real JSZip CSV9 round-trip remaps IDs but preserves raw bits, grid metadata and valid frozen profile fingerprint', requiresDependencies, async () => {
  const c = app(), f = fixture(c, false);
  const fingerprint = c.Normalization.fingerprint(f.project, f.rasters);
  const before = c.Normalization.evaluate(f.project, f.rasters);
  const zipBlob = await c.ZipIO.exportProject(f.project, { storage: f.storage });
  const result = await c.ZipIO.importZip(await zipBlob.arrayBuffer(), { storage: f.storage });
  const importedRasters = await c.Normalization.loadRasters(result.project, { storage: f.storage });
  assert.notEqual(result.project.id, f.project.id);
  assert.equal(result.project.normalization.rawFingerprint, fingerprint);
  assert.equal(c.Normalization.fingerprint(result.project, importedRasters), fingerprint);
  result.project.molecules.forEach((m, i) => assert.deepEqual(Buffer.from(f.data[m.blobId].buffer),
    Buffer.from(f.data[f.project.molecules[i].blobId].buffer)));
  const after = c.Normalization.evaluate(result.project, importedRasters);
  assert.equal(after.status, before.status);
  assert.ok(!after.reasonCodes.includes('NORMALIZATION_PROFILE_STALE'));
  assert.equal(after.section.k, 2);
  assert.deepEqual(Array.from(after.channels.a.values), Array.from(before.channels.a.values));
  assert.equal(c.Cloud.hashState(c.Cloud.stateOf(result.project)), c.Cloud.hashState(c.Cloud.stateOf(f.project)));
});

test('real XLSX paired sheet splitting is readable with identical x/y boundaries', requiresDependencies, async () => {
  const c = app(4), f = fixture(c, false);
  const result = await c.ExcelIO.buildProjectXlsx(f.project, { storage: f.storage }, { chunkSize: 2 });
  const w = read(result);
  assert.equal(result.dataSheetCount, 3);
  for (const suffix of ['001', '002', '003']) {
    const raw = rows(w, 'Data_' + suffix), normalized = rows(w, 'Normalized_Data_' + suffix);
    assert.deepEqual(raw.map(row => row.slice(0, 2)), normalized.map(row => row.slice(0, 2)));
    assert.ok(raw.length <= 4);
  }
});

test('real missing D4/profile and stale-profile workbooks keep raw Data and explain unavailability', requiresDependencies, async () => {
  const c = app(), f = fixture(c, false);
  f.data.h[1] += 1;
  let result = await c.ExcelIO.buildProjectXlsx(f.project, { storage: f.storage });
  assert.equal(result.rowCount, 7);
  assert.ok(result.normalization.reasonCodes.includes('NORMALIZATION_PROFILE_STALE'));
  let normalized = rows(read(result), 'Normalized_Data');
  assert.equal(normalized[1][2], null);
  assert.match(normalized[1][8], /変更されています/);
  f.project.molecules = f.project.molecules.filter(m => m.key !== 'd');
  delete f.project.normalization;
  result = await c.ExcelIO.buildProjectXlsx(f.project, { storage: f.storage });
  assert.equal(result.rowCount, 7);
  assert.ok(result.normalization.reasonCodes.includes('D4_MISSING'));
  assert.ok(result.normalization.reasonCodes.includes('NORMALIZATION_PROFILE_MISSING'));
  normalized = rows(read(result), 'Normalized_Data');
  assert.equal(normalized[1][2], null);
});

test('real Otsu unevaluable pixel has a local missing-input explanation, while a valid neighbor does not', requiresDependencies, async () => {
  const c = app(), f = fixture(c, false);
  // DA remains measured at index 6, so the raw row must be exported even though
  // one of the fixed Otsu source channels (5-HT) is missing there.
  f.data.h[6] = NaN;
  f.project.otsu.applied = true;
  const result = await c.ExcelIO.buildProjectXlsx(f.project, { storage: f.storage });
  const normalized = rows(read(result), 'Normalized_Data');
  assert.equal(normalized[7].at(-3), null);
  assert.equal(normalized[7].at(-2), 'NOT_EVALUABLE');
  assert.match(normalized[7].at(-1), /この画素.*欠損.*算出できません/);
  assert.equal(normalized[6].at(-3), 0);
  assert.equal(normalized[6].at(-1), '', 'other-pixel Otsu problems are not local reasons');
});
