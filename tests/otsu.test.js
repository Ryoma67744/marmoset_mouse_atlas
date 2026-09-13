'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = { window: {}, Float32Array, Float64Array, Uint8Array };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/otsu.js'), 'utf8'), context);
const Otsu = context.window.Otsu;
function fixture() {
  return {
    project: {
      grid: { W: 2, H: 2 },
      molecules: [{ key: 'ht', name: '5-HT' }, { key: 'da', name: 'DA' }, { key: 'is', name: 'D4-5-HT' }],
      normalization: { mapping: { ht5: 'ht', da: 'da', d4: 'is' }, otsuSourceKeys: ['ht', 'da'] }
    },
    rasters: {
      ht: { W: 2, H: 2, values: new Float32Array([0, 1, 100, 200]) },
      da: { W: 2, H: 2, values: new Float32Array([0, 2, 200, 400]) },
      is: { W: 2, H: 2, values: new Float32Array([999, 999, 999, 999]) }
    }
  };
}
test('fixed endogenous recipe, measured zero, explicit registered-channel-sum label', () => {
  const { project, rasters } = fixture(), r = Otsu.buildProjectRecord(project, rasters, {});
  assert.equal(r.usable, true);
  assert.equal(r.sourceLabel, 'registered-channel-sum');
  assert.deepEqual(Array.from(r.sourceKeys), ['ht', 'da']);
  assert.deepEqual(Array.from(r.evaluable), [1, 1, 1, 1]);
  assert.equal(r.nOriginal, 4);
  assert.equal(r.nKept + r.nRemoved, 4);
  assert.equal(r.histCounts.reduce((a, b) => a + b, 0), 4);
});
test('all selected raw channels must be valid per pixel; no missing-to-zero sum', () => {
  const { project, rasters } = fixture();
  rasters.ht.values[0] = NaN; rasters.da.values[1] = -1;
  const r = Otsu.buildProjectRecord(project, rasters, {});
  assert.equal(r.usable, true);
  assert.deepEqual(Array.from(r.evaluable), [0, 0, 1, 1]);
  assert.equal(r.nOriginal, 2);
  assert.equal(r.nUnevaluable, 2);
  assert.equal(r.pixelReasonCounts.OTSU_SOURCE_PIXEL_NONFINITE, 1);
  assert.equal(r.pixelReasonCounts.OTSU_SOURCE_PIXEL_NEGATIVE, 1);
});
test('D4 aliases, d3, IS role and mapping cannot be selected', () => {
  for (const name of ['D4-5-HT', 'D4-5HT', 'd4ー5HT', '5-HT-d4', 'D3-DA', 'DA IS', 'internal standard']) {
    const { project, rasters } = fixture();
    project.molecules[2].name = name; project.molecules[2].key = 'candidate';
    delete project.normalization.mapping.d4; rasters.candidate = rasters.is;
    const r = Otsu.buildProjectRecord(project, rasters, { sourceKeys: ['ht', 'candidate'] });
    assert.equal(r.usable, false, name);
    assert.equal(r.reasonCodes[0], 'OTSU_INTERNAL_STANDARD_SOURCE', name);
  }
  const { project, rasters } = fixture();
  project.molecules[2].name = 'arbitrary displayed name';
  assert.equal(Otsu.buildProjectRecord(project, rasters, { sourceKeys: ['is'] }).reasonCodes[0], 'OTSU_INTERNAL_STANDARD_SOURCE');
  project.molecules[1].role = 'internal_standard';
  assert.equal(Otsu.buildProjectRecord(project, rasters, {}).reasonCodes[0], 'OTSU_INTERNAL_STANDARD_SOURCE');
  delete project.molecules[1].role;
  project.normalization.otsuSourceRoles = { da: 'isotope_internal_standard' };
  assert.equal(Otsu.buildProjectRecord(project, rasters, {}).reasonCodes[0], 'OTSU_INTERNAL_STANDARD_SOURCE');
});
test('missing source blocks fixed recipe without selecting other molecules', () => {
  const { project, rasters } = fixture(); delete rasters.da;
  assert.equal(Otsu.buildProjectRecord(project, rasters, {}).reasonCodes[0], 'OTSU_SOURCE_MISSING');
  delete project.normalization.otsuSourceKeys;
  assert.equal(Otsu.buildProjectRecord(project, rasters, {}).reasonCodes[0], 'OTSU_SOURCE_RECIPE_MISSING');
});
test('generic analytes use a separately committed recipe; schema3 targets never enable or expand Otsu', () => {
  const { project, rasters } = fixture();
  project.molecules.push({ key: 'g', name: 'Glutamate' });
  rasters.g = { W: 2, H: 2, values: new Float32Array([0, 1, 30, 300]) };
  project.normalization.schemaVersion = 3;
  project.normalization.targets = [{ key: 'g', method: 'section_scale' }];
  project.normalization.otsuSourceKeys = [];
  project.otsu = { applied: false, sourceKeys: [] };
  const before = JSON.stringify(project);
  assert.equal(Otsu.buildProjectRecord(project, rasters, project.otsu).reasonCodes[0], 'OTSU_SOURCE_RECIPE_MISSING');
  const committed = { sourceKeys: ['g'], applied: true };
  const record = Otsu.buildProjectRecord(project, rasters, committed);
  assert.equal(record.usable, true);
  assert.deepEqual(Array.from(record.sourceKeys), ['g']);
  assert.equal(JSON.stringify(project), before);
  for (const name of ['Glutamate-d5', '[U-13C5]Glutamate', '15N2-Glutamine', '34S-Methionine', '2H3-Carnitine']) {
    project.molecules[3].name = name;
    assert.equal(Otsu.buildProjectRecord(project, rasters, committed).reasonCodes[0], 'OTSU_INTERNAL_STANDARD_SOURCE', name);
  }
  project.molecules[3].name = 'recorded standard';
  project.molecules[3].isIsotope = true;
  assert.equal(Otsu.buildProjectRecord(project, rasters, committed).reasonCodes[0], 'OTSU_INTERNAL_STANDARD_SOURCE');
});
test('invalid explicit source recipe never falls back to profile', () => {
  const { project, rasters } = fixture();
  for (const sourceKeys of [[], null, ['ht', 'ht'], ['ht', ''], ['ht', 1]]) {
    assert.equal(Otsu.buildProjectRecord(project, rasters, { sourceKeys }).usable, false);
  }
  assert.equal(Otsu.buildProjectRecord(project, rasters, { sourceKeys: ['unknown'] }).reasonCodes[0], 'OTSU_SOURCE_UNKNOWN');
});
test('grid equality requires W and H, not merely total length', () => {
  const { project, rasters } = fixture(); rasters.da.W = 4; rasters.da.H = 1;
  assert.equal(Otsu.buildProjectRecord(project, rasters, {}).reasonCodes[0], 'OTSU_COORDINATE_MISMATCH');
  rasters.da.W = 2; rasters.da.H = 2; rasters.da.values = new Float32Array(3);
  assert.equal(Otsu.buildProjectRecord(project, rasters, {}).reasonCodes[0], 'OTSU_COORDINATE_MISMATCH');
  project.grid.W = '2';
  assert.equal(Otsu.buildProjectRecord(project, rasters, {}).reasonCodes[0], 'OTSU_COORDINATE_MISMATCH');
});
test('all missing/uniform signals unusable even with manual threshold', () => {
  for (const values of [[NaN, NaN, NaN, NaN], [0, 0, 0, 0], [5, 5, 5, 5]]) {
    const r = Otsu.buildOtsuRecord(new Float32Array(values), 2, 2, { manualThreshold: 2 });
    assert.equal(r.usable, false); assert.equal(r.keep.length, 0);
    assert.ok(r.histCounts.every(Number.isFinite));
    assert.ok(Number.isFinite(r.histMin)); assert.ok(Number.isFinite(r.histMax));
  }
});
test('invalid thresholds never silently become zero/default', () => {
  const { project, rasters } = fixture();
  for (const settings of [{ manualThreshold: -1 }, { manualThreshold: 'bad' }, { manualThreshold: '' },
    { manualThreshold: Infinity }, { strength: NaN }, { strength: -1000 }]) {
    const r = Otsu.buildProjectRecord(project, rasters, settings);
    assert.equal(r.usable, false); assert.equal(r.reasonCodes[0], 'OTSU_THRESHOLD_INVALID');
  }
});
test('valid manual threshold can hide all pixels without changing analytic count', () => {
  const { project, rasters } = fixture(), r = Otsu.buildProjectRecord(project, rasters, { manualThreshold: 1000 });
  assert.equal(r.usable, true); assert.equal(r.nOriginal, 4); assert.equal(r.nKept, 0); assert.equal(r.nRemoved, 4);
  assert.deepEqual(Array.from(r.evaluable), [1, 1, 1, 1]);
});
test('source recipe copied; raw Float32 bytes, project and settings never mutated', () => {
  const { project, rasters } = fixture();
  const settings = { applied: true, sourceKeys: ['da', 'ht'], strength: 0.1, manualThreshold: null };
  const settingsBefore = JSON.stringify(settings), projectBefore = JSON.stringify(project);
  const before = Object.fromEntries(Object.entries(rasters).map(([k, v]) => [k, Buffer.from(v.values.buffer).toString('hex')]));
  const r = Otsu.buildProjectRecord(project, rasters, settings); assert.equal(r.usable, true);
  r.sourceKeys.push('is');
  assert.equal(JSON.stringify(settings), settingsBefore); assert.equal(JSON.stringify(project), projectBefore);
  for (const [k, v] of Object.entries(rasters)) assert.equal(Buffer.from(v.values.buffer).toString('hex'), before[k]);
  rasters.unrelated = { W: 2, H: 2, values: new Float32Array([1e9, 1e9, 1e9, 1e9]) };
  const again = Otsu.buildProjectRecord(project, rasters, settings);
  assert.deepEqual(Array.from(again.keep), Array.from(r.keep)); assert.equal(again.effLog, r.effLog);
});
test('legacy helpers retained but reject partial-input/grid fallback', () => {
  const { rasters } = fixture(); rasters.ht.values[0] = NaN;
  const sum = Otsu.buildTic([rasters.ht, rasters.da]);
  assert.ok(sum instanceof Float32Array); assert.ok(Number.isNaN(sum[0])); assert.equal(sum[1], 3);
  rasters.da.W = 4; rasters.da.H = 1; assert.equal(Otsu.buildTic([rasters.ht, rasters.da]), null);
  assert.equal(Otsu.computeOtsuThreshold([1, 1]).degenerate, true);
  assert.equal(Otsu.computeOtsuThreshold([NaN]).degenerate, true);
  assert.equal(Otsu.computeOtsuThreshold([0, 0, 4, 4]).degenerate, false);
});
test('alignment raw silhouette thresholding retains its separate legacy contract', () => {
  const alignmentContext = { window: { Otsu }, Float32Array, Float64Array, Uint8Array };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/align.js'), 'utf8'), alignmentContext);
  const values = new Float32Array(400);
  for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) values[y * 20 + x] = 100;
  const before = Buffer.from(values.buffer).toString('hex');
  const silhouette = alignmentContext.window.Align.msiTissueMaskFromValues(values, 20, 20);
  assert.ok(silhouette);
  assert.equal(silhouette.mask.reduce((a, b) => a + b, 0), 100);
  assert.equal(Buffer.from(values.buffer).toString('hex'), before);
  assert.equal(alignmentContext.window.Align.msiTissueMaskFromValues(new Float32Array(400).fill(10), 20, 20), null);
});
test('optional committed data/profile snapshot must match current context', () => {
  const snapshotContext = { window: {}, Float32Array, Float64Array, Uint8Array };
  for (const file of ['normalization.js', 'otsu.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), snapshotContext);
  }
  const { project, rasters } = fixture();
  project.normalization.id = 'profile-1'; project.normalization.revision = 3;
  const settings = { applied: true, sourceKeys: ['ht', 'da'], profileId: 'profile-1', profileRevision: 3,
    dataFingerprint: snapshotContext.window.Normalization.fingerprint(project, rasters) };
  const calculate = () => snapshotContext.window.Otsu.buildProjectRecord(project, rasters, settings);
  assert.equal(calculate().usable, true);
  project.normalization.revision = 4;
  assert.equal(calculate().reasonCodes[0], 'OTSU_SNAPSHOT_STALE');
  project.normalization.revision = 3; project.normalization.id = 'different';
  assert.equal(calculate().reasonCodes[0], 'OTSU_SNAPSHOT_STALE');
  project.normalization.id = 'profile-1'; rasters.ht.values[1] = 999;
  assert.equal(calculate().reasonCodes[0], 'OTSU_SNAPSHOT_STALE');
  settings.dataFingerprint = snapshotContext.window.Normalization.fingerprint(project, rasters);
  assert.equal(calculate().usable, true);
  const roundtrip = JSON.parse(JSON.stringify(settings));
  assert.equal(snapshotContext.window.Otsu.buildProjectRecord(project, rasters, roundtrip).usable, true);
});
test('supplied raw snapshot is not falsely verified when fingerprint engine is unavailable', () => {
  const { project, rasters } = fixture();
  const result = Otsu.buildProjectRecord(project, rasters, { dataFingerprint: 'saved-fingerprint' });
  assert.equal(result.usable, false);
  assert.equal(result.reasonCodes[0], 'OTSU_SNAPSHOT_UNVERIFIED');
});
