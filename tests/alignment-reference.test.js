'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = { window: {}, Float32Array, Float64Array, Uint8Array, ArrayBuffer, DataView };
for (const file of ['otsu.js', 'alignment-reference.js']) {
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), context);
}
const Reference = context.window.AlignmentReference;
function fixture() {
  return {
    project: {
      grid: { W: 3, H: 2 },
      molecules: [
        { key: 'gaba', name: 'GABA-DPP' },
        { key: 'ht', name: 'Serotonin-DPP' },
        { key: 'd4', name: 'Serotonin-d4-DPP' }
      ],
      normalization: { mapping: { ht5: 'ht', d4: 'd4' }, otsuSourceKeys: ['ht'] }
    },
    rasters: {
      gaba: { W: 3, H: 2, values: new Float64Array([0, 10, 20, 30, 40, 100]) },
      ht: { W: 3, H: 2, values: new Float64Array([0, 1, 2, 3, 4, 10]) },
      d4: { W: 3, H: 2, values: new Float64Array([10, 10, 10, 10, 10, 10]) }
    }
  };
}
function build(f, mode = 'balanced', sourceKeys) {
  return Reference.build(f.project, f.rasters, { mode, ...(sourceKeys === undefined ? {} : { sourceKeys }) });
}
function throwsCode(callback, code, key) {
  assert.throws(callback, error => error.code === code && (key === undefined || error.sourceKey === key));
}
test('default recipe uses every registered endogenous molecule regardless of Otsu recipe or visibility', () => {
  const f = fixture();
  f.project.molecules[0].visible = false;
  assert.deepEqual(Array.from(Reference.sourceKeys(f.project, f.rasters)), ['gaba', 'ht']);
  const result = build(f);
  assert.deepEqual(Array.from(result.sourceKeys), ['gaba', 'ht']);
  assert.equal(result.metadata.sourceLabel, 'intensity-balanced-registered-channel-sum');
  assert.equal(result.metadata.quantileMethod, 'linear-h-n-minus-1');
  assert.equal(result.metadata.scales.gaba, 97);
  assert.ok(Math.abs(result.metadata.scales.ht - 9.7) < 1e-12);
  assert.equal(result.values[0], 0);
  assert.equal(result.values[5], 2);
  assert.equal(result.nValid, 6);
});
test('multiplying one molecule by 1000 leaves the balanced reference unchanged', () => {
  const f = fixture(), before = build(f);
  f.rasters.gaba.values = Float64Array.from(f.rasters.gaba.values, value => value * 1000);
  const after = build(f);
  assert.ok(Math.abs(after.metadata.scales.gaba - before.metadata.scales.gaba * 1000) < 1e-9);
  for (let i = 0; i < before.values.length; i++) assert.ok(Math.abs(after.values[i] - before.values[i]) < 1e-12);
  assert.notEqual(after.sourceFingerprint, before.sourceFingerprint);
});
test('all selected channels share the same finite nonnegative mask; measured zeros are included in P99', () => {
  const f = fixture();
  f.rasters.gaba.values[1] = NaN;
  f.rasters.ht.values[2] = -1;
  f.rasters.ht.values[5] = Infinity;
  const result = build(f);
  assert.equal(result.nValid, 3);
  assert.equal(result.nInvalid, 3);
  assert.equal(result.values[0], 0);
  for (const index of [1, 2, 5]) assert.ok(Number.isNaN(result.values[index]));
  assert.ok(Math.abs(result.metadata.scales.gaba - 39.8) < 1e-12);
  assert.ok(Math.abs(result.metadata.scales.ht - 3.98) < 1e-12);
  assert.equal(result.values[4], 2);
});
test('single raw channel allows internal standard, while composites reject it', () => {
  const f = fixture(), result = build(f, 'single', ['d4']);
  assert.deepEqual(Array.from(result.values), Array.from(f.rasters.d4.values));
  assert.notEqual(result.values, f.rasters.d4.values);
  assert.equal(result.metadata.quantile, null);
  for (const mode of ['rawsum', 'balanced']) {
    throwsCode(() => build(f, mode, ['ht', 'd4']), 'ALIGNMENT_REFERENCE_INTERNAL_STANDARD', 'd4');
  }
});
test('internal-standard selection uses names, flags, and normalization mapping', () => {
  for (const modify of [
    f => { f.project.molecules[0].name = 'GABA-d6-DPP'; },
    f => { f.project.molecules[0].isInternalStandard = true; },
    f => { f.project.normalization.internalStandardKey = 'gaba'; },
    f => { f.project.normalization.otsuSourceRoles = { gaba: 'isotope_internal_standard' }; },
    f => { f.project.molecules[0].name = '[U-13C4]GABA'; }
  ]) {
    const f = fixture(); modify(f);
    assert.deepEqual(Array.from(Reference.sourceKeys(f.project)), ['ht']);
    throwsCode(() => build(f, 'rawsum', ['gaba', 'ht']), 'ALIGNMENT_REFERENCE_INTERNAL_STANDARD', 'gaba');
  }
  const f = fixture();
  f.project.molecules[2].name = 'Renamed standard';
  assert.deepEqual(Array.from(Reference.sourceKeys(f.project)), ['gaba', 'ht']);
});
test('rawsum is the raw registered sum, without clipping or per-channel scaling', () => {
  const result = build(fixture(), 'rawsum');
  assert.deepEqual(Array.from(result.values), [0, 11, 22, 33, 44, 110]);
  assert.equal(result.range.min, 0);
  assert.equal(result.range.max, 110);
  assert.equal(result.metadata.sourceLabel, 'registered-channel-sum');
  assert.equal(result.metadata.recipe, 'sum(raw)');
  assert.equal(result.metadata.quantile, null);
});
test('missing sources never narrow a fixed recipe or use a visible fallback', () => {
  const f = fixture(); delete f.rasters.gaba;
  assert.deepEqual(Array.from(Reference.sourceKeys(f.project, f.rasters)), ['gaba', 'ht']);
  throwsCode(() => build(f), 'ALIGNMENT_REFERENCE_SOURCE_MISSING', 'gaba');
  throwsCode(() => build(f, 'single', ['missing']), 'ALIGNMENT_REFERENCE_SOURCE_UNKNOWN', 'missing');
});
test('dimension, length, per-molecule grid, and coordinate mismatches are rejected', () => {
  for (const modify of [
    f => { f.rasters.ht.W = 2; f.rasters.ht.H = 3; },
    f => { f.rasters.ht.values = new Float64Array(5); },
    f => { f.project.molecules[1].grid = { W: 6, H: 1 }; },
    f => { f.project.grid.xs = [0, 1, 2]; f.rasters.ht.xs = [1, 2, 3]; },
    f => { f.project.molecules[1].grid = { coordinateFingerprint: 'other' }; f.rasters.ht.coordinateFingerprint = 'base'; },
    f => { f.rasters.gaba.ys = [0, 1]; f.rasters.ht.ys = [0, 2]; }
  ]) {
    const f = fixture(); modify(f);
    throwsCode(() => build(f), 'ALIGNMENT_REFERENCE_COORDINATE_MISMATCH');
  }
});
test('invalid recipes, unknown models, and duplicate registered keys are explicit errors', () => {
  const f = fixture();
  for (const keys of [[], null, ['gaba', 'gaba'], ['gaba', ''], ['gaba', 5]]) {
    throwsCode(() => build(f, 'balanced', keys), 'ALIGNMENT_REFERENCE_RECIPE_INVALID');
  }
  throwsCode(() => build(f, 'single', ['gaba', 'ht']), 'ALIGNMENT_REFERENCE_RECIPE_INVALID');
  throwsCode(() => build(f, 'tic'), 'ALIGNMENT_REFERENCE_MODE_INVALID');
  f.project.molecules.push({ key: 'gaba', name: 'Other GABA' });
  throwsCode(() => build(f, 'rawsum', ['gaba']), 'ALIGNMENT_REFERENCE_SOURCE_UNKNOWN', 'gaba');
});
test('P99 zero is unavailable; no epsilon substitution or automatic source exclusion', () => {
  const f = fixture(); f.rasters.ht.values.fill(0);
  throwsCode(() => build(f), 'ALIGNMENT_REFERENCE_SCALE_INVALID', 'ht');
  assert.equal(build(f, 'rawsum').nValid, 6);
  // A rare positive value can still yield a zero P99: measured zeros count.
  f.project.grid = { W: 1000, H: 1 };
  for (const key of ['gaba', 'ht']) f.rasters[key] = { W: 1000, H: 1, values: new Float64Array(1000).fill(1) };
  f.rasters.ht.values.fill(0); f.rasters.ht.values[999] = 10;
  throwsCode(() => build(f), 'ALIGNMENT_REFERENCE_SCALE_INVALID', 'ht');
});
test('all-invalid and nonfinite raw sums are explicit unavailable errors', () => {
  const f = fixture(); f.rasters.gaba.values.fill(NaN);
  throwsCode(() => build(f), 'ALIGNMENT_REFERENCE_NO_VALID_PIXELS');
  f.rasters.gaba.values.fill(Number.MAX_VALUE); f.rasters.ht.values.fill(Number.MAX_VALUE);
  throwsCode(() => build(f, 'rawsum'), 'ALIGNMENT_REFERENCE_SUM_NONFINITE');
  assert.deepEqual(Array.from(build(f).values), [2, 2, 2, 2, 2, 2]);
});
test('build preserves all raw buffers and project metadata; returned data and frozen provenance are separate', () => {
  const f = fixture(), projectBefore = JSON.stringify(f.project);
  const buffers = Object.fromEntries(Object.entries(f.rasters).map(([key, raster]) => [key, Buffer.from(raster.values.buffer).toString('hex')]));
  const result = build(f);
  result.values[0] = 888;
  result.sourceKeys.push('other');
  assert.equal(JSON.stringify(f.project), projectBefore);
  for (const [key, raster] of Object.entries(f.rasters)) assert.equal(Buffer.from(raster.values.buffer).toString('hex'), buffers[key]);
  assert.deepEqual(Array.from(result.metadata.sourceKeys), ['gaba', 'ht']);
  assert.ok(Object.isFrozen(result.metadata));
  assert.ok(Object.isFrozen(result.metadata.scales));
  assert.throws(() => { result.metadata.scales.gaba = 5; }, TypeError);
});
test('fingerprint is deterministic, selected-source-only, coordinate-sensitive, and retains Float64 detail', () => {
  const f = fixture(), initial = build(f);
  assert.equal(build(f).sourceFingerprint, initial.sourceFingerprint);
  f.rasters.d4.values[0] = 12345;
  assert.equal(build(f).sourceFingerprint, initial.sourceFingerprint);
  f.rasters.gaba.values[1] += 1e-10;
  assert.notEqual(build(f).sourceFingerprint, initial.sourceFingerprint);
  f.rasters.gaba.values[1] = 10;
  f.project.grid.coordinateFingerprint = 'grid-v2';
  assert.notEqual(build(f).sourceFingerprint, initial.sourceFingerprint);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(initial.metadata)));
});
