'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sandbox = { window: {}, Float32Array, Float64Array, Uint8Array, ArrayBuffer, DataView, Date };
vm.createContext(sandbox);
for (const file of ['msi.js', 'normalization-scope.js', 'normalization.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8'), sandbox);
const N = sandbox.window.Normalization;
const keys = { ht: 'MSI_5-HT', d4: 'MSI_D4-5-HT', da: 'MSI_DA', ne: 'MSI_NE' };
const names = { ht: '5-HT', d4: 'D4-5-HT', da: 'DA', ne: 'NE' };
function entry(id, data, width) {
  const first = Object.values(data)[0], W = width || first.length, H = first.length / W;
  const project = { id, displayName: id, grid: { W, H, umPerPxX: 10, umPerPxY: 10 }, molecules: [],
    roi: { roi_items: {}, roi_names: {} } };
  const rasters = {};
  for (const role of Object.keys(data)) {
    const key = keys[role] || role;
    project.molecules.push({ key, name: names[role] || role, blobId: id + '-' + role });
    rasters[key] = { W, H, values: new Float32Array(data[role]) };
  }
  return { project, rasters, mapping: N.suggestMapping(project.molecules) };
}
function config(ids, overrides) {
  return Object.assign({ id: 'profile', revision: 1, batchId: 'run-a', prepId: 'prep-a', quality: 'provisional',
    coordinateMatchConfirmed: true, comparabilityConfirmed: true,
    qc: { minD4: 0, saturationD4: 1000, minCoverage: 0.5 },
    reference: { kind: 'whole_tissue', projectIds: ids, roiNames: [] }, calibration: null, otsuSourceRoles: ['ht', 'da', 'ne'] }, overrides);
}
function apply(entries, options) {
  const result = N.createProfiles(entries, config(entries.map(e => e.project.id), options));
  result.profiles.forEach((p, i) => { entries[i].project.normalization = p.normalization; });
  return result;
}
function quantify(e, mask) { return N.quantifyRoi(e.project, e.rasters, N.evaluate(e.project, e.rasters), mask || new Uint8Array(e.project.grid.W * e.project.grid.H).fill(1)); }
function calibration(overrides) {
  return Object.assign({ id: 'cal', model: 'linear', slope: 1, intercept: 0, unit: 'pmol/mm²', lloq: 0.1, uloq: 100,
    responseMin: 0, responseMax: 100, responseAggregation: 'mean_pixel_ratio', validated: true, source: 'validation-run-001',
    prepId: 'prep-a', batchId: 'run-a' }, overrides);
}
function near(actual, expected, epsilon = 1e-10) { assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`); }

test('aliases handle D4-5-HT / D4-5HT and refuse an ambiguous automatic mapping', () => {
  assert.equal(N.suggestMapping([{ key: 'a', name: 'D4ー5HT' }]).d4, 'a');
  assert.equal(N.suggestMapping([{ key: 'a', name: 'D4-5-HT' }, { key: 'b', name: 'D4-5HT (2)' }]).d4, null);
  assert.equal(N.suggestMapping([{ key: 'a', name: '5-HT' }, { key: 'b', name: 'D4-5-HT' }]).ht, 'a');
});

test('common multiplicative gain is corrected, without scaling each target median to one', () => {
  const a = entry('a', { ht: [10, 20], d4: [2, 4], da: [6, 8], ne: [9, 12] });
  const b = entry('b', { ht: [20, 40], d4: [4, 8], da: [12, 16], ne: [18, 24] });
  const result = apply([a, b]);
  assert.equal(result.preview[0].Ds, 3); assert.equal(result.preview[0].Dref, 4.5); assert.equal(result.preview[0].k, 1.5);
  assert.equal(result.preview[1].k, 0.75);
  for (const e of [a, b]) {
    const evaluation = N.evaluate(e.project, e.rasters);
    assert.deepEqual(Array.from(evaluation.channels[keys.ht].values), [5, 5]);
    assert.deepEqual(Array.from(evaluation.channels[keys.da].values), [9, 12]);
    assert.deepEqual(Array.from(evaluation.channels[keys.ne].values), [13.5, 18]);
  }
});

test('calibration response is explicitly mean-of-pixel-ratios OR ratio-of-sums', () => {
  const a = entry('a', { ht: [10, 10], d4: [1, 9] });
  apply([a], { calibration: calibration() });
  let row = quantify(a).find(r => r.role === 'ht');
  near(row.normalized.mean, 50 / 9); near(row.absolute.value, 50 / 9);
  apply([a], { calibration: calibration({ responseAggregation: 'ratio_of_sums' }) });
  row = quantify(a).find(r => r.role === 'ht');
  near(row.normalized.mean, 50 / 9); assert.equal(row.absolute.value, 2);
  assert.equal(row.absolute.responseAggregation, 'ratio_of_sums');
  assert.equal(N.evaluate(a.project, a.rasters).channels[keys.ht].unit, '5-HT/D4-5-HT ratio');
});

test('zero numerator remains measured zero; missing D4 is never replaced by epsilon or zero', () => {
  const a = entry('a', { ht: [0, 5, 5, 5, 5], d4: [2, 0, NaN, 0.5, 10], da: [1, 2, 3, 4, 5] });
  apply([a], { qc: { minD4: 1, saturationD4: 10, minCoverage: 0.1 } });
  const ev = N.evaluate(a.project, a.rasters), channel = ev.channels[keys.ht];
  assert.equal(channel.values[0], 0);
  assert.ok(Array.from(channel.values).slice(1).every(Number.isNaN));
  assert.deepEqual(Array.from(channel.pixelReasons), [null, 'D4_LOW_SIGNAL', 'D4_NOT_MEASURED', 'D4_LOW_SIGNAL', 'D4_SATURATION']);
  assert.equal(quantify(a)[0].normalized.mean, 0);
  assert.equal(quantify(a)[0].absolute.value, null);
  assert.ok(quantify(a)[0].absolute.reasonCodes.includes('CALIBRATION_MISSING'));
});

test('bad local D4 does not invalidate DA or NE with a usable section factor', () => {
  const a = entry('a', { ht: [1, 2, 3], d4: [1, 0, 1], da: [10, 20, 30], ne: [2, 4, 6] });
  apply([a]);
  const ev = N.evaluate(a.project, a.rasters);
  assert.ok(Number.isNaN(ev.channels[keys.ht].values[1]));
  assert.equal(ev.channels[keys.da].values[1], 20);
  assert.equal(ev.channels[keys.ne].values[1], 4);
});

test('missing calibration does not prevent ratio images, but never supplies absolute concentration', () => {
  const a = entry('a', { ht: [6, 8], d4: [2, 2] }); apply([a]);
  const row = quantify(a)[0]; assert.equal(row.normalized.mean, 3.5); assert.equal(row.absolute.value, null);
  assert.ok(row.absolute.reasonCodes.includes('CALIBRATION_MISSING'));
});

test('no profile, missing D4 and ambiguous D4 have explicit scoped failures without suppressing raw statistics', () => {
  const a = entry('a', { ht: [0, 4], da: [2, 3] });
  let ev = N.evaluate(a.project, a.rasters);
  assert.ok(ev.channels[keys.ht].reasonCodes.includes('NORMALIZATION_PROFILE_MISSING'));
  assert.ok(ev.channels[keys.ht].reasonCodes.includes('D4_MISSING'));
  assert.equal(quantify(a)[0].raw.mean, 2);
  apply([a]); ev = N.evaluate(a.project, a.rasters);
  assert.ok(ev.channels[keys.ht].reasonCodes.includes('D4_MISSING'));
  assert.equal(ev.channels[keys.ht].values, null);
  const b = entry('b', { ht: [1], d4: [1] });
  b.project.molecules.push({ key: 'dup', name: 'D4-5HT' }); b.rasters.dup = { W: 1, H: 1, values: new Float32Array([1]) };
  delete b.mapping; apply([b]);
  assert.ok(N.evaluate(b.project, b.rasters).channels[keys.ht].reasonCodes.includes('D4_AMBIGUOUS'));
});

test('D4 QC and unconfigured molecules never masquerade as derived values', () => {
  const a = entry('a', { ht: [1], d4: [2], GABA: [3] }); apply([a]);
  const ev = N.evaluate(a.project, a.rasters);
  assert.equal(ev.channels[keys.d4].status, 'RAW_QC'); assert.equal(ev.channels[keys.d4].values, null);
  assert.equal(ev.channels.GABA.status, 'NOT_APPLIED'); assert.equal(ev.channels.GABA.values, null);
});

test('D4-only or explicitly unmapped datasets explain why no derived target is available', () => {
  const a = entry('a', { d4: [2], GABA: [3] }); apply([a]);
  let ev = N.evaluate(a.project, a.rasters);
  assert.equal(ev.status, 'UNAVAILABLE'); assert.ok(ev.reasonCodes.includes('NO_NORMALIZATION_TARGETS'));
  assert.equal(ev.channels[keys.d4].status, 'RAW_QC'); assert.equal(ev.channels.GABA.status, 'NOT_APPLIED');
  const b = entry('b', { ht: [2], d4: [1] }); b.mapping.ht = null; apply([b]);
  ev = N.evaluate(b.project, b.rasters);
  assert.ok(ev.reasonCodes.includes('NO_NORMALIZATION_TARGETS')); assert.equal(ev.channels[keys.ht].status, 'NOT_APPLIED');
  assert.match(N.reasonText('NO_NORMALIZATION_TARGETS'), /補正対象/);
});

test('unknown saturation is provisional and explicitly blocks absolute quantification', () => {
  const a = entry('a', { ht: [5], d4: [2], da: [8] });
  apply([a], { qc: { minD4: 0, saturationD4: null, minCoverage: 0.5 }, calibration: calibration() });
  const row = quantify(a)[0];
  assert.equal(row.normalized.mean, 2.5); assert.equal(row.status, 'PROVISIONAL');
  assert.equal(row.absolute.value, null); assert.ok(row.absolute.reasonCodes.includes('D4_SATURATION_UNKNOWN'));
});

test('out-of-range concentration and out-of-response-range are not silently extrapolated', () => {
  const a = entry('a', { ht: [0, 20, 200], d4: [1, 1, 1] });
  apply([a], { calibration: calibration({ lloq: 1, uloq: 10, responseMax: 100 }) });
  const one = i => { const mask = new Uint8Array(3); mask[i] = 1; return quantify(a, mask)[0].absolute; };
  assert.ok(one(0).reasonCodes.includes('BELOW_LLOQ')); assert.equal(one(0).value, null);
  assert.ok(one(1).reasonCodes.includes('ABOVE_ULOQ')); assert.equal(one(1).value, null);
  assert.ok(one(2).reasonCodes.includes('CALIBRATION_RESPONSE_OUT_OF_RANGE')); assert.equal(one(2).value, null);
});

test('calibration validation, aggregation, metadata and conditions are mandatory', () => {
  const a = entry('a', { ht: [2], d4: [1] });
  for (const changed of [{ validated: false }, { slope: 0 }, { source: '' }, { responseAggregation: 'median' }, { unit: '' }, { responseMin: null }]) {
    apply([a], { calibration: calibration(changed) });
    assert.ok(quantify(a)[0].absolute.reasonCodes.includes('CALIBRATION_INVALID'));
  }
  apply([a], { calibration: calibration({ prepId: 'different-prep' }) });
  assert.ok(quantify(a)[0].absolute.reasonCodes.includes('CALIBRATION_CONDITION_MISMATCH'));
});

test('ROI geometry count, measured count, valid count, missing and zero are separate', () => {
  const a = entry('a', { ht: [0, NaN, 4, 8], d4: [1, 1, 0, 2] }); apply([a]);
  const row = quantify(a)[0]; assert.equal(row.nGeometry, 4); assert.equal(row.nMeasured, 3); assert.equal(row.nValid, 2);
  assert.equal(row.coverage, 2 / 3); assert.equal(row.normalized.mean, 2); assert.equal(row.reasonCounts.D4_LOW_SIGNAL, 1);
  const empty = quantify(a, new Uint8Array(4))[0]; assert.equal(empty.raw.mean, null); assert.equal(empty.normalized.mean, null);
  assert.ok(empty.reasonCodes.includes('ROI_EMPTY_GEOMETRY'));
  const missing = quantify(a, new Uint8Array([0, 1, 0, 0]))[0]; assert.ok(missing.reasonCodes.includes('NO_MEASURED_PIXELS'));
});

test('low valid ROI coverage returns null summary but retains valid pixel ratios for display', () => {
  const a = entry('a', { ht: [2, 2, 2], d4: [1, 0, 0], da: [4, 4, 4] });
  apply([a], { qc: { minD4: 0, saturationD4: 1000, minCoverage: 0.8 }, calibration: calibration() });
  const ev = N.evaluate(a.project, a.rasters), row = quantify(a)[0];
  assert.equal(ev.channels[keys.ht].values[0], 2); assert.equal(row.nValid, 1); assert.equal(row.normalized.mean, null);
  assert.ok(row.reasonCodes.includes('INSUFFICIENT_VALID_COVERAGE')); assert.equal(row.absolute.value, null);
  assert.equal(ev.channels[keys.da].values, null);
});

test('Otsu, visible layers, scaling, rotation and display alignment never affect analytical ROI', () => {
  const a = entry('a', { ht: [1, 5, 9], d4: [1, 1, 1], da: [4, 6, 8] }); apply([a]);
  const before = JSON.stringify(quantify(a));
  a.project.otsu = { applied: true, manualThreshold: 100000, strength: 10 };
  a.project.visibleLayers = []; a.project.rotation = 90; a.project.alignment = { foo: { tx: 12, ty: 13 } };
  a.project.layerDisplay = { [keys.ht]: { vmin: 900, vmax: 901 } }; a.project.viewerValueMode = 'raw';
  assert.equal(JSON.stringify(quantify(a)), before);
});

test('raw Float32 bits are never changed by profile, evaluation or ROI arithmetic', () => {
  const a = entry('a', { ht: [-0, 0, 1 / 3, NaN, -10], d4: [1, 2, 3, 4, 5], da: [1, 2, 3, 4, 5] });
  const before = Object.fromEntries(Object.entries(a.rasters).map(([k, r]) => [k, Buffer.from(r.values.buffer).toString('hex')]));
  apply([a]); N.evaluate(a.project, a.rasters); quantify(a);
  for (const [k, r] of Object.entries(a.rasters)) assert.equal(Buffer.from(r.values.buffer).toString('hex'), before[k]);
});

test('content fingerprint ignores project/blob identity, order and display but detects actual bits or grid changes', () => {
  const a = entry('a', { ht: [1, 2, 3, 4], d4: [2, 2, 2, 2] }, 2); const f = N.fingerprint(a.project, a.rasters);
  a.project.id = 'imported'; a.project.molecules.reverse(); a.project.molecules.forEach(m => { m.blobId = 'new-' + m.key; });
  a.project.layerDisplay = { changed: true }; assert.equal(N.fingerprint(a.project, a.rasters), f);
  a.rasters[keys.ht].values[0] += 1; assert.notEqual(N.fingerprint(a.project, a.rasters), f);
  a.rasters[keys.ht].values[0] -= 1; a.project.grid.W = 4; a.project.grid.H = 1;
  assert.notEqual(N.fingerprint(a.project, a.rasters), f);
});

test('nonfinite raw missing values use the same portable content identity as blank CSV', () => {
  const a = entry('a', { ht: [Infinity, -Infinity, NaN], d4: [1, 1, 1] });
  const f = N.fingerprint(a.project, a.rasters); a.rasters[keys.ht].values.fill(NaN);
  assert.equal(N.fingerprint(a.project, a.rasters), f);
});

test('same-length but differently-shaped D4 and differing saved coordinates cannot be divided', () => {
  const a = entry('a', { ht: [1, 2, 3, 4], d4: [1, 1, 1, 1] }, 2); apply([a]);
  a.rasters[keys.d4].W = 4; a.rasters[keys.d4].H = 1;
  let ch = N.evaluate(a.project, a.rasters).channels[keys.ht]; assert.equal(ch.values, null); assert.ok(ch.reasonCodes.includes('COORDINATE_MISMATCH'));
  const b = entry('b', { ht: [1, 2], d4: [1, 1] }); b.rasters[keys.ht].xs = [0, 1]; b.rasters[keys.d4].xs = [1, 2]; apply([b]);
  ch = N.evaluate(b.project, b.rasters).channels[keys.ht]; assert.equal(ch.values, null); assert.ok(ch.reasonCodes.includes('COORDINATE_MISMATCH'));
});

test('fixed reference ROI ignores unrelated ROI changes, but invalidates when the reference geometry changes', () => {
  const a = entry('a', { ht: [1, 1, 1, 1], d4: [1, 1, 10, 10] }, 2);
  a.project.roi = { roi_items: { ref: [{ poly_msi: [[-0.5, -0.5], [1.5, -0.5], [1.5, 0.5], [-0.5, 0.5]] }] }, roi_names: { ref: 'Reference' } };
  apply([a], { reference: { kind: 'roi', projectIds: ['a'], roiNames: ['Reference'] } });
  assert.equal(a.project.normalization.section.Ds, 1);
  a.project.roi.roi_items.other = [{ poly_msi: [[0, 0], [1, 0], [1, 1]] }];
  assert.notEqual(N.evaluate(a.project, a.rasters).status, 'UNAVAILABLE');
  a.project.roi.roi_items.ref[0].poly_msi[2][1] = 1.5;
  assert.ok(N.evaluate(a.project, a.rasters).reasonCodes.includes('NORMALIZATION_PROFILE_STALE'));
});

test('whole measured footprint clears leftover ROI names and has no ROI geometry dependency', () => {
  const a = entry('a', { ht: [2, 2, 2, 2], d4: [1, 1, 9, 9], da: [1, 2, 3, 4] }, 2);
  a.project.roi = { roi_items: { ref: [{ poly_msi: [[-0.5, -0.5], [1.5, -0.5], [1.5, 0.5], [-0.5, 0.5]] }] }, roi_names: { ref: 'Reference' } };
  apply([a], { reference: { kind: 'whole_tissue', projectIds: ['a'], roiNames: ['Reference'] } });
  assert.equal(a.project.normalization.section.Ds, 5);
  assert.equal(a.project.normalization.section.nGeometry, 4);
  assert.deepEqual(Array.from(a.project.normalization.reference.roiNames), []);
  const referenceWithStaleNames = { kind: 'whole_tissue', roiNames: ['Reference'] };
  const before = N.referenceGeometryFingerprint(a.project, referenceWithStaleNames);
  a.project.roi.roi_items.ref[0].poly_msi[2][1] = 1.5;
  assert.equal(N.referenceGeometryFingerprint(a.project, referenceWithStaleNames), before);
  assert.notEqual(N.evaluate(a.project, a.rasters).status, 'UNAVAILABLE');
});

test('missing reference ROI and invalid member never silently shrink the fixed reference set', () => {
  const a = entry('a', { ht: [1], d4: [1], da: [10] }), b = entry('b', { ht: [1], d4: [0], da: [20] });
  apply([a, b]); assert.equal(a.project.normalization.section.k, null);
  assert.ok(a.project.normalization.section.reasonCodes.includes('REFERENCE_PARTIAL'));
  apply([a], { reference: { kind: 'roi', projectIds: ['a'], roiNames: ['absent'] } });
  assert.ok(a.project.normalization.section.reasonCodes.includes('REFERENCE_ROI_MISSING'));
  assert.equal(a.project.normalization.section.k, null);
});

test('saved factors and common ranges remain fixed when viewing/exporting a subset or adding unrelated projects', () => {
  const a = entry('a', { ht: [10, 10], d4: [1, 1], da: [5, 6] }), b = entry('b', { ht: [20, 20], d4: [2, 2], da: [10, 12] });
  apply([a, b]); const frozen = JSON.stringify(a.project.normalization);
  const alone = N.evaluate(a.project, a.rasters); const c = entry('c', { ht: [999], d4: [999], da: [999] }); apply([c]);
  assert.equal(JSON.stringify(a.project.normalization), frozen); assert.equal(alone.section.k, 1.5);
  assert.deepEqual(Array.from(alone.channels[keys.da].values), [7.5, 9]);
  assert.equal(a.project.normalization.commonRanges.da.min, 7.5); assert.equal(a.project.normalization.commonRanges.da.max, 9);
});

test('changing raw, calibration snapshot or explicit invalidation marks a profile stale', () => {
  const a = entry('a', { ht: [2], d4: [1] }); apply([a], { calibration: calibration() });
  a.project.normalization.calibration.slope = 2;
  assert.ok(N.evaluate(a.project, a.rasters).reasonCodes.includes('NORMALIZATION_PROFILE_STALE'));
  apply([a]); N.invalidate(a.project, 'molecule merge');
  assert.ok(N.evaluate(a.project, a.rasters).reasonCodes.includes('NORMALIZATION_PROFILE_STALE'));
});

test('validated section status requires known saturation and validation evidence; whole footprint remains provisional', () => {
  const a = entry('a', { ht: [2], d4: [1], da: [3] });
  assert.throws(() => apply([a], { quality: 'validated' }), /検証記録/);
  apply([a], { quality: 'validated', validationEvidence: 'run comparison', reference: { kind: 'qc', projectIds: ['a'], roiNames: [] } });
  assert.equal(N.evaluate(a.project, a.rasters).status, 'VALID');
  apply([a], { quality: 'validated', validationEvidence: 'run comparison' });
  assert.equal(a.project.normalization.quality, 'provisional');
});

test('configuration rejects missing authority-independent scientific confirmations and malformed fixed references', () => {
  const a = entry('a', { ht: [2], d4: [1] });
  for (const change of [{ coordinateMatchConfirmed: false }, { comparabilityConfirmed: false }, { batchId: '' },
    { reference: { kind: 'qc', projectIds: [] } }, { reference: { kind: 'qc', projectIds: ['absent'] } },
    { qc: { minD4: 0, saturationD4: null, minCoverage: 0 } }]) assert.throws(() => apply([a], change));
  a.mapping.ht = a.mapping.d4; assert.throws(() => apply([a]), /分子対応/);
});

test('fixed Otsu sources retain missing positions rather than silently changing the recipe', () => {
  const a = entry('a', { ht: [2], d4: [1] }); apply([a]);
  assert.deepEqual(Array.from(a.project.normalization.otsuSourceKeys), [keys.ht, null, null]);
  assert.ok(!a.project.normalization.otsuSourceKeys.includes(keys.d4));
});

test('legacy or malformed profile yields reasons, not crashes or false absolute zero', () => {
  const a = entry('a', { ht: [2], d4: [1] }); a.project.normalization = { schemaVersion: 0 };
  const ev = N.evaluate(a.project, a.rasters); assert.equal(ev.status, 'UNAVAILABLE');
  assert.ok(ev.reasonCodes.includes('NORMALIZATION_PROFILE_STALE')); assert.equal(quantify(a)[0].absolute.value, null);
});

test('loadRasters reads each saved Float32 source and preserves project coordinates', async () => {
  const a = entry('a', { ht: [2, 3], d4: [1, 1] });
  const values = Object.fromEntries(a.project.molecules.map(m => [m.blobId, a.rasters[m.key].values]));
  const loaded = await N.loadRasters(a.project, { storage: { async getValueRaster(id) { return values[id]; } } });
  assert.equal(loaded[keys.ht].W, 2); assert.equal(loaded[keys.ht].H, 1); assert.equal(loaded[keys.ht].values, values['a-ht']);
});

function scope(ids, groupId = 'group-a', folderPath = ['Marmoset', 'Coronal']) {
  return { type: 'folder-depth', depth: 2, includeDescendants: true, groupId, folderPath, memberIds: ids };
}
test('independent folder groups keep their own Dref and common ranges while retaining all raw bits', () => {
  const a = entry('a', { ht: [10, 10], d4: [2, 2], da: [10, 20], ne: [4, 8] });
  const b = entry('b', { ht: [20, 20], d4: [4, 4], da: [20, 40], ne: [8, 16] });
  const c = entry('c', { ht: [100, 100], d4: [20, 20], da: [100, 200], ne: [40, 80] });
  const d = entry('d', { ht: [200, 200], d4: [40, 40], da: [200, 400], ne: [80, 160] });
  const before = [a, b, c, d].map(e => Object.values(e.rasters).map(r => Buffer.from(r.values.buffer).toString('hex')));
  apply([a, b], { scope: scope(['b', 'a']) }); apply([c, d], { scope: scope(['c', 'd'], 'group-b', ['Marmoset', 'Sagittal']) });
  assert.equal(a.project.normalization.schemaVersion, 2); assert.deepEqual(Array.from(a.project.normalization.scope.memberIds), ['a', 'b']);
  assert.equal(a.project.normalization.section.Dref, 3); assert.equal(c.project.normalization.section.Dref, 30);
  assert.equal(a.project.normalization.section.k, 1.5); assert.equal(b.project.normalization.section.k, 0.75);
  assert.deepEqual(JSON.parse(JSON.stringify(a.project.normalization.commonRanges.da)), { min: 15, max: 30 });
  assert.deepEqual(JSON.parse(JSON.stringify(c.project.normalization.commonRanges.da)), { min: 150, max: 300 });
  const frozen = JSON.stringify(a.project.normalization);
  c.rasters[keys.da].values[0] = 999; apply([c, d], { scope: scope(['c', 'd'], 'group-b', ['Marmoset', 'Sagittal']) });
  assert.equal(JSON.stringify(a.project.normalization), frozen);
  assert.deepEqual(Array.from(N.evaluate(a.project, a.rasters).channels[keys.ht].values), [5, 5]);
  c.rasters[keys.da].values[0] = 100;
  assert.deepEqual([a, b, c, d].map(e => Object.values(e.rasters).map(r => Buffer.from(r.values.buffer).toString('hex'))), before);
});
test('scope members and references must be exactly the supplied group, without duplicate portable identities', () => {
  const a = entry('a', { ht: [2], d4: [1], da: [3] }), b = entry('b', { ht: [4], d4: [2], da: [6] });
  for (const invalid of [null, {}, scope(['a']), scope(['a', 'b', 'external']), scope(['a', 'a']),
    { ...scope(['a', 'b']), depth: 3 }, { ...scope(['a', 'b']), type: 'manual' }, { ...scope(['a', 'b']), includeDescendants: false },
    { ...scope(['a', 'b']), folderPath: ['One'] }, { ...scope(['a', 'b']), groupId: '' }, { ...scope(['a', 'b']), folderId: 'local-unsafe' }]) {
    assert.throws(() => apply([a, b], { scope: invalid }), /補正グループ/);
  }
  assert.throws(() => apply([a, b], { scope: scope(['a', 'b']), reference: { kind: 'whole_tissue', projectIds: ['external'] } }), /計算対象/);
  b.project.normalizationBinding = { memberId: 'a', groupId: 'old', folderPath: ['Old', 'Group'] };
  assert.throws(() => apply([a, b], { scope: scope(['a', 'b']) }), /補正グループ/);
});
test('portable members survive import and scoped references use original member identities', () => {
  const a = entry('import-a', { ht: [2], d4: [1], da: [3] }), b = entry('import-b', { ht: [4], d4: [2], da: [6] });
  a.project.normalizationBinding = { memberId: 'original-a', groupId: 'group-old', folderPath: ['Old', 'Place'] };
  b.project.normalizationBinding = { memberId: 'original-b', groupId: 'group-old', folderPath: ['Old', 'Place'] };
  const before = JSON.stringify(a.project);
  const configScope = scope(['original-b', 'original-a']);
  const result = N.createProfiles([a, b], config(['import-a', 'import-b'], { scope: configScope }));
  assert.equal(JSON.stringify(a.project), before); assert.deepEqual(configScope.memberIds, ['original-b', 'original-a']);
  const p = result.profiles[0].normalization;
  assert.deepEqual(Array.from(p.reference.projectIds), ['original-a', 'original-b']); assert.equal(p.reference.entries[0].memberId, 'original-a');
  assert.equal(p.commonRanges.da.min, 4.5); // Prospective destination binding is used for range calculation.
  a.project.normalization = p;
  a.project.normalizationBinding = { memberId: 'original-a', groupId: 'group-a', folderPath: ['Renamed', 'Current'] };
  const frozen = JSON.stringify(p), expected = Array.from(N.evaluate(a.project, a.rasters).channels[keys.da].values);
  a.project.id = 'another-local-id'; a.project.folderId = 'another-local-folder';
  assert.deepEqual(Array.from(N.evaluate(a.project, a.rasters).channels[keys.da].values), expected);
  delete a.project.normalizationBinding; // Standalone historical export remains usable without local membership evidence.
  assert.deepEqual(Array.from(N.evaluate(a.project, a.rasters).channels[keys.da].values), expected);
  assert.equal(JSON.stringify(a.project.normalization), frozen);
});
test('explicit moved binding blocks derived values but preserves original numeric snapshot and raw ROI summaries', () => {
  const a = entry('a', { ht: [2], d4: [1], da: [3] }); apply([a], { scope: scope(['a']) });
  const before = JSON.stringify(a.project.normalization);
  for (const binding of [null, { groupId: null, memberId: 'a', folderPath: null }, { groupId: 'other', memberId: 'a', folderPath: ['Other', 'Group'] }]) {
    a.project.normalizationBinding = binding;
    const ev = N.evaluate(a.project, a.rasters);
    assert.equal(ev.channels[keys.ht].values, null); assert.equal(ev.channels[keys.da].values, null);
    assert.ok(ev.reasonCodes.includes('GROUP_MEMBERSHIP_CHANGED')); assert.equal(quantify(a)[0].raw.mean, 2);
    assert.equal(ev.channels[keys.d4].status, 'RAW_QC'); assert.equal(JSON.stringify(a.project.normalization), before);
  }
});
test('all immutable scope fields are fingerprinted while malformed schemas and bindings fail explicitly', () => {
  for (const mutate of [p => { p.scope.groupId = 'changed'; }, p => { p.scope.folderPath[1] = 'Renamed audit record'; },
    p => { p.scope.memberIds.push('new'); }, p => { p.scope.includeDescendants = false; }]) {
    const a = entry('a', { ht: [2], d4: [1] }); apply([a], { scope: scope(['a']) }); mutate(a.project.normalization);
    assert.ok(N.evaluate(a.project, a.rasters).reasonCodes.includes('NORMALIZATION_PROFILE_STALE'));
  }
  const a = entry('a', { ht: [2], d4: [1] }); apply([a], { scope: scope(['a']) });
  a.project.normalizationBinding = { groupId: 'group-a', memberId: 'external', folderPath: ['Marmoset', 'Coronal'] };
  assert.ok(N.evaluate(a.project, a.rasters).reasonCodes.includes('NORMALIZATION_SCOPE_INVALID'));
  a.project.normalization.schemaVersion = 9;
  assert.ok(N.evaluate(a.project, a.rasters).reasonCodes.includes('NORMALIZATION_SCHEMA_UNSUPPORTED'));
});
test('legacy v1 calculation fingerprint is exactly preserved against an independently recorded pre-change golden value', () => {
  const e = { project: { id: 'legacy', displayName: 'legacy', grid: { W: 1, H: 1 }, molecules: [
    { key: 'h', name: '5-HT' }, { key: 'd', name: 'D4-5-HT' }, { key: 'a', name: 'DA' }
  ] }, rasters: { h: { W: 1, H: 1, values: new Float32Array([10]) }, d: { W: 1, H: 1, values: new Float32Array([2]) }, a: { W: 1, H: 1, values: new Float32Array([6]) } } };
  const result = N.createProfiles([e], config(['legacy'], { id: 'legacy-profile' }));
  e.project.normalization = result.profiles[0].normalization;
  assert.equal(e.project.normalization.schemaVersion, 1); assert.equal(e.project.normalization.scope, undefined);
  assert.equal(e.project.normalization.rawFingerprint, 'f32-v1:e935a0b55a2727c3');
  assert.equal(e.project.normalization.calculationFingerprint, '071de9bdf0813429');
  e.project.id = 'legacy-imported'; assert.equal(N.evaluate(e.project, e.rasters).channels.h.values[0], 5);
});
test('malformed scoped references fail with explicit reasons instead of throwing during imported ROI geometry checks', () => {
  const a = entry('a', { ht: [2], d4: [1] });
  for (const ref of [{ kind: 'roi', projectIds: ['a'], roiNames: 'wrong type' }, { kind: 'qc', projectIds: [5] },
    { kind: 'qc', projectIds: ['a', 'a'] }]) {
    assert.throws(() => apply([a], { scope: scope(['a']), reference: ref }), /参照/);
  }
  for (const ref of [null, { kind: 'roi', projectIds: ['a'], roiNames: 'wrong type' }, { kind: 'qc', projectIds: ['a'], entries: [] }]) {
    apply([a], { scope: scope(['a']) }); a.project.normalization.reference = ref;
    const ev = N.evaluate(a.project, a.rasters);
    assert.equal(ev.status, 'UNAVAILABLE'); assert.ok(ev.reasonCodes.includes('NORMALIZATION_SCOPE_INVALID'));
  }
});
