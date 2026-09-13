'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const XLSX = require('xlsx');
const JSZip = require('jszip');

const plain = value => JSON.parse(JSON.stringify(value));
function app() {
  const c = { console, XLSX, JSZip, Float32Array, Float64Array, Uint8Array, ArrayBuffer, DataView, Blob };
  c.window = c;
  vm.createContext(c);
  for (const file of ['msi.js', 'normalization-scope.js', 'normalization.js', 'display-range.js', 'otsu.js',
    'zipio.js', 'excelio.js', 'cloud.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), c, { filename: file });
  }
  return c;
}

function fixture(c) {
  const data = {}, count = 200;
  const entries = ['sample', 'reference'].map(id => {
    const project = { id, displayName: id, grid: { W: count, H: 1 }, images: {},
      folderPath: ['Marmoset', 'Coronal'],
      normalizationBinding: { groupId: 'group', memberId: id, folderPath: ['Marmoset', 'Coronal'] },
      valueDisplay: { mode: 'normalized', scale: 'common' },
      layerDisplay: { h: { normalizedRange: [0, 439284000], rawRange: [0, 250] } },
      molecules: [], roi: { roi_items: { all: [{ poly_msi: [[-1, -1], [201, -1], [201, 2], [-1, 2]] }] },
        roi_names: { all: 'All' } } };
    const rasters = {};
    for (const [key, name, base] of [['h', '5-HT', 100], ['d', 'D4-5-HT', 100], ['a', 'DA', 10]]) {
      const blobId = id + '_' + key;
      data[blobId] = new Float32Array(count).fill(base);
      project.molecules.push({ key, name, blobId });
      rasters[key] = { W: count, H: 1, values: data[blobId] };
    }
    if (id === 'sample') {
      rasters.h.values[0] = 0.327383;
      rasters.h.values[count - 1] = 222.131;
    } else {
      rasters.h.values[0] = 439.284;
      rasters.d.values[0] = 0.000001;
    }
    return { project, rasters };
  });
  const created = c.Normalization.createSimpleProfiles(entries, { id: 'profile', revision: 1,
    scope: { type: 'folder-depth', depth: 2, includeDescendants: true, groupId: 'group',
      folderPath: ['Marmoset', 'Coronal'], memberIds: ['sample', 'reference'] } });
  assert.equal(created.canSave, true);
  created.profiles.forEach((record, i) => { entries[i].project.normalization = record.normalization; });
  let serial = 0;
  const storage = { getValueRaster: async id => data[id],
    putValueRaster: async values => { const id = 'imported_' + ++serial; data[id] = values; return id; },
    uid: prefix => prefix + '_import',
    commitImportedProject: async p => { p.folderId = 'restored-folder'; return p; } };
  return { ...entries[0], entries, storage, data };
}

function rows(workbook, name) {
  return XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: null, raw: true });
}
async function exportWorkbook(c, f, project = f.project) {
  const result = await c.ExcelIO.buildProjectXlsx(project, { storage: f.storage });
  return XLSX.read(result.bytes, { type: 'array' });
}
function effective(workbook, key = 'h', mode = 'normalized') {
  const metadata = rows(workbook, 'Normalization_Metadata');
  const index = metadata.findIndex(row => row[0] === 'Effective display molecule key');
  assert.ok(index > 0, 'effective display provenance accompanies the immutable profile ranges');
  const headers = metadata[index], value = metadata.slice(index + 1).find(row => row[0] === key && row[2] === mode);
  assert.ok(value);
  return Object.fromEntries(headers.map((header, i) => [header, value[i]]));
}

test('Excel resolves legacy giant windows on detached state and distinguishes effective P99 from frozen profile ranges', async () => {
  const c = app(), f = fixture(c), original = JSON.stringify(f.project);
  const bits = Object.fromEntries(Object.entries(f.data).map(([key, values]) => [key, Buffer.from(values.buffer).toString('hex')]));
  const workbook = await exportWorkbook(c, f);
  const h = effective(workbook);
  assert.equal(h['Effective strategy'], 'individual');
  assert.equal(h['Effective display minimum'], 0);
  assert.equal(h['Effective display maximum'], 1);
  assert.equal(h['Display quantile'], 0.99);
  assert.ok(h['Actual maximum'] > 2.2 && h['Actual maximum'] < 2.3);
  assert.ok(h['Clipped pixels'] > 0);
  const roi = rows(workbook, 'ROI_Quantification');
  const frozenMax = roi[1][roi[0].indexOf('Fixed display maximum')];
  assert.ok(frozenMax > 4e8, 'legacy analytical profile range remains unchanged');
  const metadata = new Map(rows(workbook, 'Normalization_Metadata').map(row => [row[0], row[1]]));
  assert.equal(metadata.get('layerDisplay.h.normalizedRange.1'), 439284000);
  assert.equal(metadata.get('resolvedDisplay.valueDisplay.rangeVersion'), 1);
  assert.match(metadata.get('Effective display convention'), /brightness only/);
  assert.equal(JSON.stringify(f.project), original, 'export must not persist the old-settings migration');
  for (const [key, values] of Object.entries(f.data)) assert.equal(Buffer.from(values.buffer).toString('hex'), bits[key]);
});

test('P99 brightness clipping retains the finite large ratio and all ROI numbers in Excel', async () => {
  const c = app(), f = fixture(c), reference = f.entries[1];
  const evaluation = c.Normalization.evaluate(reference.project, reference.rasters);
  const roiExpected = c.Normalization.quantifyRoi(reference.project, reference.rasters, evaluation,
    new Uint8Array(200).fill(1)).find(item => item.key === 'h');
  const workbook = await exportWorkbook(c, f, reference.project);
  const derived = rows(workbook, 'Normalized_Data');
  assert.ok(derived[1][2] > 4e8);
  assert.equal(derived[1][2], evaluation.channels.h.values[0]);
  assert.equal(effective(workbook)['Effective display maximum'], 1);
  const roi = rows(workbook, 'ROI_Quantification'), ht = roi.find(row => row[2] === 'h');
  assert.equal(ht[roi[0].indexOf('Normalized mean')], roiExpected.normalized.mean);
  assert.equal(ht[roi[0].indexOf('Normalized SD (population)')], roiExpected.normalized.sd);
  assert.equal(ht[roi[0].indexOf('Valid normalized pixels')], roiExpected.nValid);
  const d4 = effective(workbook, 'd');
  assert.equal(d4['Displayed value mode'], 'raw');
  assert.equal(d4['Displayed unit'], 'raw a.u.');
});

test('missing display engine leaves numerical export intact and explicitly marks missing display provenance', async () => {
  const c = app(), f = fixture(c), withDisplay = await exportWorkbook(c, f);
  c.DisplayRange = null;
  const withoutDisplay = await exportWorkbook(c, f);
  for (const sheet of ['Data', 'Normalized_Data', 'ROI_Quantification']) {
    assert.deepEqual(rows(withoutDisplay, sheet), rows(withDisplay, sheet));
  }
  const metadata = new Map(rows(withoutDisplay, 'Normalization_Metadata').map(row => [row[0], row[1]]));
  assert.equal(metadata.get('Display provenance error'), 'DISPLAY_RANGE_ENGINE_UNAVAILABLE');
});

test('effective active mode follows Viewer defaults and never claims normalization without a profile', async () => {
  const c = app(), f = fixture(c);
  delete f.project.valueDisplay;
  let workbook = await exportWorkbook(c, f);
  assert.equal(effective(workbook)['Active value mode'], true, 'a valid profile without a saved mode starts normalized');
  assert.equal(effective(workbook, 'h', 'raw')['Active value mode'], false);
  f.project.valueDisplay = { mode: 'raw' };
  workbook = await exportWorkbook(c, f);
  assert.equal(effective(workbook, 'h', 'raw')['Active value mode'], true, 'an explicit raw mode is preserved');
  f.project.valueDisplay.mode = 'normalized';
  delete f.project.normalization;
  workbook = await exportWorkbook(c, f);
  assert.equal(effective(workbook, 'h', 'raw')['Active value mode'], true, 'no profile always starts raw');
  assert.equal(effective(workbook)['Displayed value mode'], 'raw');
  const metadata = new Map(rows(workbook, 'Normalization_Metadata').map(row => [row[0], row[1]]));
  assert.equal(metadata.get('resolvedDisplay.valueDisplay.mode'), 'raw');
});

test('manual and common displays change provenance while raw, normalized and ROI worksheet cells remain identical', async () => {
  const c = app(), f = fixture(c), individual = await exportWorkbook(c, f);
  const fingerprint = f.project.normalization.calculationFingerprint;
  c.DisplayRange.setManual(f.project, 'h', 'normalized', 0.1, 0.5);
  const manual = await exportWorkbook(c, f), manualRange = effective(manual);
  assert.equal(manualRange['Effective strategy'], 'manual');
  assert.equal(manualRange['Effective display minimum'], 0.1);
  assert.equal(manualRange['Effective display maximum'], 0.5);
  assert.equal(manualRange['Display quantile'], null);
  const snapshot = c.DisplayRange.buildGroupSnapshot(f.entries);
  f.project.valueDisplay.groupRangeSnapshot = snapshot;
  c.DisplayRange.setStrategy(f.project, 'h', 'normalized', 'common');
  const common = await exportWorkbook(c, f), commonRange = effective(common);
  assert.equal(commonRange['Effective strategy'], 'common');
  assert.equal(commonRange['Display source'], 'group');
  assert.equal(commonRange['Effective display maximum'], 1);
  assert.equal(commonRange['Display group ID'], 'group');
  assert.equal(commonRange['Display snapshot ID'], snapshot.id);
  assert.equal(commonRange['Display group members'], 2);
  assert.equal(commonRange['Display group contributors'], 2);
  const maximum = JSON.parse(commonRange['Display group maximum source']);
  assert.equal(maximum.memberId, 'reference');
  assert.equal(maximum.index, 0);
  assert.ok(maximum.value > 4e8);
  assert.ok(maximum.denominator < 0.00001);
  for (const workbook of [manual, common]) {
    for (const sheet of ['Data', 'Normalized_Data', 'ROI_Quantification']) {
      assert.deepEqual(rows(workbook, sheet), rows(individual, sheet));
    }
  }
  assert.equal(f.project.normalization.calculationFingerprint, fingerprint);
});

test('cloud and real ZIP round-trip retain nested manual/legacy/group settings and the unchanged scientific profile', async () => {
  const c = app(), f = fixture(c), D = c.DisplayRange;
  const beforeProfile = JSON.stringify(f.project.normalization);
  D.prepareProject(f.project);
  f.project.valueDisplay.groupRangeSnapshot = D.buildGroupSnapshot(f.entries);
  D.setManual(f.project, 'a', 'normalized', 0, 20);
  D.setStrategy(f.project, 'h', 'normalized', 'common');
  const evaluation = c.Normalization.evaluate(f.project, f.rasters);
  const expected = D.resolve({ project: f.project, key: 'h', mode: 'normalized',
    values: evaluation.channels.h.values, channel: evaluation.channels.h, rawFingerprint: evaluation.fingerprint });
  const manualExpected = D.resolve({ project: f.project, key: 'a', mode: 'normalized',
    values: evaluation.channels.a.values, channel: evaluation.channels.a, rawFingerprint: evaluation.fingerprint });
  assert.equal(manualExpected.strategy, 'manual');
  const state = plain(c.Cloud.stateOf(f.project));
  const restored = c.Cloud.applyState({}, state);
  assert.deepEqual(plain(restored.valueDisplay), plain(f.project.valueDisplay));
  assert.deepEqual(plain(restored.layerDisplay), plain(f.project.layerDisplay));
  assert.equal(c.Cloud.hashState(c.Cloud.stateOf(restored)), c.Cloud.hashState(state));
  const archive = await c.ZipIO.exportProject(f.project, { storage: f.storage });
  const imported = (await c.ZipIO.importZip(await archive.arrayBuffer(), { storage: f.storage })).project;
  assert.notEqual(imported.id, f.project.id);
  assert.deepEqual(plain(imported.normalization), plain(f.project.normalization));
  assert.deepEqual(plain(imported.valueDisplay), plain(f.project.valueDisplay));
  assert.deepEqual(plain(imported.layerDisplay), plain(f.project.layerDisplay));
  const importedRasters = Object.fromEntries(imported.molecules.map(m => [m.key,
    { W: imported.grid.W, H: imported.grid.H, values: f.data[m.blobId] }]));
  const importedEvaluation = c.Normalization.evaluate(imported, importedRasters);
  assert.ok(!Array.from(importedEvaluation.reasonCodes).includes('NORMALIZATION_PROFILE_STALE'));
  const actual = D.resolve({ project: imported, key: 'h', mode: 'normalized', values: importedEvaluation.channels.h.values,
    channel: importedEvaluation.channels.h, rawFingerprint: importedEvaluation.fingerprint });
  assert.equal(actual.strategy, 'common');
  assert.equal(actual.min, expected.min);
  assert.equal(actual.max, expected.max);
  assert.equal(actual.snapshotId, expected.snapshotId);
  const manualActual = D.resolve({ project: imported, key: 'a', mode: 'normalized', values: importedEvaluation.channels.a.values,
    channel: importedEvaluation.channels.a, rawFingerprint: importedEvaluation.fingerprint });
  assert.equal(manualActual.strategy, 'manual', 'ZIP-added null grid units do not discard a bound manual window');
  assert.equal(manualActual.min, manualExpected.min);
  assert.equal(manualActual.max, manualExpected.max);
  assert.equal(JSON.stringify(f.project.normalization), beforeProfile);
  assert.deepEqual(Array.from(importedEvaluation.channels.h.values), Array.from(evaluation.channels.h.values));
});

test('skipped internal-standard data export effective raw display without claiming a corrected or common scale', async () => {
  const c = app(), f = fixture(c);
  f.project.molecules = f.project.molecules.filter(m => m.key !== 'd');
  delete f.rasters.d;
  const profiles = c.Normalization.createSimpleProfiles(f.entries, { ...plain(f.project.normalization),
    id: 'with-skip', revision: 2 });
  assert.equal(profiles.canSave, true);
  profiles.profiles.forEach((record, i) => { f.entries[i].project.normalization = record.normalization; });
  assert.equal(c.Normalization.isSkippedProfile(f.project.normalization), true);
  const workbook = await exportWorkbook(c, f);
  const h = effective(workbook);
  assert.equal(h['Displayed value mode'], 'raw');
  assert.notEqual(h['Effective strategy'], 'common');
  assert.equal(h['Display group ID'], '');
  const raw = effective(workbook, 'h', 'raw');
  assert.equal(raw['Active value mode'], true);
  const normalized = rows(workbook, 'Normalized_Data');
  assert.ok(normalized.slice(1).every(row => row[2] === null));
  assert.ok(rows(workbook, 'Data').slice(1).every(row => Number.isFinite(row[2])));
});
