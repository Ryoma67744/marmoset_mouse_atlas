'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const plain = value => JSON.parse(JSON.stringify(value));
const names = ['GABA-DPP', 'Histamine-DPP', 'Dopamine-DPP', 'Norepinephrine-DPP', 'Serotonin-DPP', 'Serotonin-d4-DPP'];

function fixture(valid = false) {
  const c = { console, JSZip, XLSX, Float32Array, Float64Array, Uint8Array, ArrayBuffer, DataView, Blob };
  c.window = c; vm.createContext(c);
  for (const file of ['msi.js', 'normalization-scope.js', 'normalization.js', 'display-range.js', 'section-display.js',
    'stack3d.js', 'otsu.js', 'zipio.js', 'excelio.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), c, { filename: file });
  }
  const p = { id: 'mouse-11', displayName: 'Mouse_11', plane: 'coronal', images: {},
    atlas: { species: 'mouse', seriesId: 'mouse_tissue_1set', sectionNumber: 11, sourceCandidateId: 'C028',
      coordinateMode: 'pixel', displaySpacing: 2, physicalSectionSpacing: null },
    grid: { W: 4, H: 2, umPerPxX: null, umPerPxY: null }, valueDisplay: { mode: 'normalized' },
    molecules: names.map((name, i) => ({ key: 'm' + i, name, analyteId: name, blobId: 'raw' + i })) };
  const rasters = {}, data = {};
  names.forEach((name, i) => {
    const values = new Float32Array(i === 5 ? valid ? [2, 2, 2, 2, 2, 2, 2, 2] : [2, 0, -1, NaN, Infinity, 1e-8, 4, 2]
      : [4 + i, 1, 1, 1, 1, 1, NaN, -0]);
    rasters['m' + i] = { W: 4, H: 2, values }; data['raw' + i] = values;
  });
  const config = { id: 'mouse-d4-ratio', revision: 1, standardKey: 'm5', targetKeys: ['m0', 'm1', 'm2', 'm3', 'm4'],
    standardApplication: { method: 'uniform_spray', confirmed: true, source: 'user' } };
  let serial = 0;
  const storage = { getValueRaster: async id => data[id],
    putValueRaster: async values => { const id = 'restored-' + ++serial; data[id] = values; return id; },
    uid: () => 'imported-mouse', commitImportedProject: async project => project };
  return { c, p, rasters, data, config, storage };
}

test('all five targets use exact per-pixel ratios, no positive-d4 percentile mask, and the standard stays raw QC', () => {
  const { c, p, rasters, config } = fixture(), before = plain(p);
  const rawBits = Object.values(rasters).map(r => Buffer.from(r.values.buffer));
  const profile = c.Normalization.createPixelRatioProfile(p, rasters, config);
  const result = c.Normalization.evaluate({ ...p, normalization: profile }, rasters);
  assert.equal(profile.schemaVersion, 4); assert.equal(profile.section, null);
  assert.equal(profile.reference, null); assert.equal(profile.scope, null);
  assert.equal(result.status, 'PARTIAL');
  for (let i = 0; i < 5; i++) {
    const channel = result.channels['m' + i];
    assert.equal(channel.method, 'pixel_ratio'); assert.equal(channel.applicable, true);
    assert.equal(channel.values[0], (4 + i) / 2);
    assert.ok(Object.is(channel.values[7], -0), 'measured zero is a valid ratio');
    assert.equal(channel.values[5], 1 / rasters.m5.values[5], 'even a tiny positive denominator remains valid');
    for (const j of [1, 2, 3, 4, 6]) assert.ok(Number.isNaN(channel.values[j]), `missing ratio ${i},${j}`);
    assert.equal(channel.nValid, 3); assert.equal(channel.nMeasured, 7); assert.equal(channel.coverage, 3 / 7);
    assert.deepEqual(plain(channel.pixelReasons), [null, 'D4_LOW_SIGNAL', 'D4_LOW_SIGNAL',
      'D4_NOT_MEASURED', 'D4_NOT_MEASURED', null, 'RAW_NOT_MEASURED', null]);
    assert.equal(channel.unit, `${names[i]} / Serotonin-d4-DPP ratio`);
  }
  assert.equal(result.channels.m5.method, 'raw_qc'); assert.equal(result.channels.m5.values, null);
  assert.equal(result.channels.m5.status, 'RAW_QC'); assert.equal(result.channels.m5.applicable, false);
  assert.deepEqual(plain(p), before);
  Object.values(rasters).forEach((r, i) => assert.deepEqual(Buffer.from(r.values.buffer), rawBits[i]));
});

test('pixel ratios remain independent of folder membership, viewer state, other slices and raw blob/project IDs', () => {
  const { c, p, rasters, config } = fixture(true);
  p.normalization = c.Normalization.createPixelRatioProfile(p, rasters, config);
  const initial = c.Normalization.evaluate(p, rasters);
  const moved = { ...p, id: 'new-project-id', folderId: 'another-folder', rotation: { all: 123 }, stack3d: { offsetXPx: 99 },
    molecules: p.molecules.map(m => ({ ...m, blobId: 'new-' + m.blobId })),
    normalizationBinding: { groupId: 'irrelevant-old-group', memberId: 'old-id', folderPath: ['Old', 'Folder'] } };
  const context = c.NormalizationScope.resolveContext(moved, [{ id: 'another-folder', name: 'Elsewhere' }], [moved]);
  assert.equal(context.assessment.status, 'CURRENT');
  assert.deepEqual(plain(context.project.normalization), plain(p.normalization));
  const after = c.Normalization.evaluate(context.project, rasters);
  assert.equal(after.fingerprint, initial.fingerprint); assert.equal(after.status, 'PROVISIONAL');
  assert.deepEqual(Array.from(after.channels.m2.values), Array.from(initial.channels.m2.values));
  assert.ok(!after.reasonCodes.includes('GROUP_MEMBERSHIP_CHANGED'));
});

test('an entirely unusable standard never creates zero-filled or raw-fallback corrected data', () => {
  const { c, p, rasters, config } = fixture();
  rasters.m5.values.fill(0);
  p.normalization = c.Normalization.createPixelRatioProfile(p, rasters, config);
  const result = c.Normalization.evaluate(p, rasters);
  assert.equal(result.status, 'UNAVAILABLE');
  for (let i = 0; i < 5; i++) {
    assert.equal(result.channels['m' + i].nValid, 0);
    assert.ok(result.channels['m' + i].values.every(Number.isNaN));
  }
  assert.deepEqual(plain(p.normalization.commonRanges), {});
  assert.equal(result.channels.m5.values, null);
});

test('profile creation and evaluation reject missing/mismatched inputs, extra masks, invalid mappings and stale data', () => {
  const { c, p, rasters, config } = fixture(true);
  assert.throws(() => c.Normalization.createPixelRatioProfile(p, rasters, { ...config, standardApplication: null }), /散布量/);
  assert.throws(() => c.Normalization.createPixelRatioProfile(p, rasters, { ...config, targetKeys: ['m0', 'm5'] }), /分子対応/);
  assert.throws(() => c.Normalization.createPixelRatioProfile(p, rasters, { ...config, targetKeys: ['m0', 'm0'] }), /分子対応/);
  assert.throws(() => c.Normalization.createPixelRatioProfile(p, rasters, { ...config, qc: { minD4: 1 } }), /追加の閾値/);
  assert.throws(() => c.Normalization.createPixelRatioProfile(p, { ...rasters, m5: null }, config), /D4/);
  assert.throws(() => c.Normalization.createPixelRatioProfile(p, { ...rasters, m0: { ...rasters.m0, W: 2 } }, config), /座標/);
  assert.throws(() => c.Normalization.createPixelRatioProfile(p, { ...rasters,
    m0: { ...rasters.m0, coordinateFingerprint: 'A' }, m5: { ...rasters.m5, coordinateFingerprint: 'B' } }, config), /座標/);
  p.normalization = c.Normalization.createPixelRatioProfile(p, rasters, config);
  const changed = { ...rasters, m2: { ...rasters.m2, values: new Float32Array(rasters.m2.values) } };
  changed.m2.values[0] = 100;
  const stale = c.Normalization.evaluate(p, changed);
  assert.equal(stale.status, 'UNAVAILABLE'); assert.equal(stale.channels.m2.values, null);
  assert.ok(stale.reasonCodes.includes('NORMALIZATION_PROFILE_STALE'));
  const altered = plain(p.normalization); altered.qc.minD4 = .1;
  const tampered = c.Normalization.evaluate({ ...p, normalization: altered }, rasters);
  assert.equal(tampered.channels.m0.values, null); assert.ok(tampered.reasonCodes.includes('QC_THRESHOLDS_MISSING'));
});

test('3D and ROI calculations consume the same ratios, preserve partial coverage and exclude d4 from corrected outputs', () => {
  const { c, p, rasters, config } = fixture();
  p.normalization = c.Normalization.createPixelRatioProfile(p, rasters, config);
  const section = c.Stack3D.createSection(p, rasters, { folders: [], projects: [p] });
  const result = c.Normalization.evaluate(p, rasters);
  assert.deepEqual(Array.from(section.channels['Dopamine-DPP'].normalized), Array.from(result.channels.m2.values));
  assert.equal(section.channels['Serotonin-d4-DPP'].normalized, null);
  assert.equal(section.coordinateMode, 'pixel'); assert.equal(section.umPerPxX, null);
  const roi = c.Normalization.quantifyRoi(p, rasters, result, new Uint8Array(8).fill(1));
  assert.equal(roi[0].normalized.n, 3); assert.equal(roi[0].coverage, 3 / 7);
  assert.ok(Math.abs(roi[0].normalized.mean - ((4 / 2) + 1 / rasters.m5.values[5]) / 3) < 1e-7);
  assert.equal(roi[0].status, 'PARTIAL'); assert.equal(roi[0].applicable, true);
  assert.equal(roi[0].absolute.value, null); assert.equal(roi[0].absolute.status, 'NOT_APPLICABLE');
  assert.equal(roi[5].normalized.n, 0); assert.equal(roi[5].status, 'RAW_QC');
});

test('ZIP preserves pixel-ratio profiles and original finite float32 values; Excel labels all ratios accurately', async () => {
  const { c, p, rasters, config, storage, data } = fixture(true);
  p.normalization = c.Normalization.createPixelRatioProfile(p, rasters, config);
  const zip = await c.ZipIO.exportProject(p, { storage }, { strict: true });
  const restored = (await c.ZipIO.importZip(await zip.arrayBuffer(), { storage })).project;
  const restoredRasters = await c.Normalization.loadRasters(restored, { storage });
  assert.deepEqual(plain(restored.normalization), plain(p.normalization));
  assert.equal(c.Normalization.evaluate(restored, restoredRasters).status, 'PROVISIONAL');
  restored.molecules.forEach((m, i) => assert.deepEqual(Buffer.from(data[m.blobId].buffer), Buffer.from(rasters['m' + i].values.buffer)));
  const output = await c.ExcelIO.buildProjectXlsx(p, { storage });
  const workbook = XLSX.read(output.bytes, { type: 'array' });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets.Normalized_Data, { header: 1, defval: null, raw: true });
  for (let i = 0; i < 5; i++) {
    assert.ok(rows[0][i + 2].includes(`${names[i]} / Serotonin-d4-DPP ratio`));
    assert.equal(rows[1][i + 2], (4 + i) / 2);
  }
  assert.equal(rows[1][7], null, 'd4 has no derived measurement');
  assert.equal(output.normalization.absoluteStatus, 'NOT_APPLIED');
});
