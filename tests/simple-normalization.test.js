'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sandbox = { window: {}, Float32Array, Float64Array, Uint8Array, ArrayBuffer, DataView, Date };
vm.createContext(sandbox);
for (const file of ['msi.js', 'normalization-scope.js', 'normalization.js', 'otsu.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8'), sandbox);
const N = sandbox.window.Normalization;
const plain = value => JSON.parse(JSON.stringify(value));
function entry(id, data, names = {}) {
  const W = Object.values(data)[0].length, project = { id, displayName: id, grid: { W, H: 1 }, molecules: [] }, rasters = {};
  for (const [key, values] of Object.entries(data)) {
    project.molecules.push({ key, name: names[key] === undefined ? ({ h: '5-HT', d: 'D4-5-HT', a: 'DA', g: 'Glutamate', b: 'GABA' }[key] || key) : names[key] });
    rasters[key] = { W, H: 1, values: new Float32Array(values) };
  }
  return { project, rasters };
}
function config(entries, changes = {}) {
  return { id: 'simple-test', revision: 1, scope: { type: 'folder-depth', depth: 2, includeDescendants: true,
    groupId: 'group', folderPath: ['Marmoset', 'Coronal'], memberIds: entries.map(e => e.project.normalizationBinding?.memberId || e.project.id) }, ...changes };
}
function apply(entries, changes = {}) {
  const result = N.createSimpleProfiles(entries, config(entries, changes));
  result.profiles.forEach((item, i) => {
    entries[i].project.normalization = item.normalization;
    entries[i].project.normalizationBinding = { groupId: item.normalization.scope.groupId, memberId: item.normalization.scope.memberIds.includes(entries[i].project.id) ? entries[i].project.id : entries[i].project.normalizationBinding.memberId, folderPath: item.normalization.scope.folderPath.slice() };
  });
  return result;
}
function quantify(e, mask) {
  return N.quantifyRoi(e.project, e.rasters, N.evaluate(e.project, e.rasters), mask || new Uint8Array(e.project.grid.W).fill(1));
}
function curve(changes = {}) {
  return { id: 'curve', model: 'linear', slope: 2, intercept: 1, unit: 'fmol/mm2', lloq: 0, uloq: 100,
    responseMin: 0, responseMax: 100, responseAggregation: 'mean_pixel_ratio', validated: true, source: 'measured standards', batchId: 'batch', prepId: 'prep', ...changes };
}

test('default schema3 auto maps analytes and computes independent HT ratios and section coefficients', () => {
  const entries = [entry('a', { h: [10, 20], d: [10, 10], g: [5, 10], b: [100, 200] }),
    entry('b', { h: [20, 40], d: [20, 20], g: [10, 20], b: [200, 400] }),
    entry('c', { h: [40, 80], d: [40, 40], g: [20, 40], b: [400, 800] })];
  const out = apply(entries);
  assert.equal(out.canSave, true); assert.deepEqual(out.preview.map(p => p.k), [2, 1, 0.5]);
  for (const e of entries) {
    const p = e.project.normalization, ev = N.evaluate(e.project, e.rasters);
    assert.equal(p.schemaVersion, 3); assert.equal(p.methodVersion, '2.0.0'); assert.equal(p.batchId, ''); assert.equal(p.prepId, '');
    assert.equal(p.coordinateMatchConfirmed, false); assert.equal(p.comparabilityConfirmed, false); assert.equal(p.quality, 'provisional');
    assert.deepEqual(Array.from(ev.channels.h.values), [1, 2]); assert.deepEqual(Array.from(ev.channels.g.values), [10, 20]);
    assert.equal(ev.channels.g.role, 'analyte'); assert.equal(N.isCorrectedChannel(ev.channels.g), true);
    assert.deepEqual(plain(N.rangeForChannel(p, ev.channels.g)), { min: 10, max: 20 });
    assert.deepEqual(plain(N.rangeForChannel(p, ev.channels.b)), { min: 200, max: 400 });
    assert.notEqual(ev.channels.g.rangeKey, ev.channels.b.rangeKey); assert.equal(ev.channels.d.values, null);
    assert.equal(quantify(e).find(r => r.key === 'h').absolute.status, 'NOT_CONFIGURED');
  }
});

test('default Ds uses D4 measured footprint, not target measured union; report-only ROI keeps partial values', () => {
  const a = entry('a', { h: [0, 2, 4, 6, NaN], d: [2, 0, NaN, 2, NaN], g: [0, 10, 20, 30, NaN] });
  const out = apply([a]), p = a.project.normalization, rows = quantify(a), ht = rows.find(r => r.key === 'h');
  assert.equal(out.canSave, true); assert.equal(p.section.nMeasured, 3); assert.equal(p.section.nValid, 2); assert.equal(p.section.Ds, 2);
  assert.equal(ht.raw.n, 4); assert.equal(ht.nValid, 2); assert.equal(ht.coverage, 0.5); assert.equal(ht.normalized.mean, 1.5); assert.equal(ht.status, 'PARTIAL');
  assert.ok(ht.reasonCodes.includes('PARTIAL_VALID_PIXELS')); assert.ok(!ht.reasonCodes.includes('INSUFFICIENT_VALID_COVERAGE'));
  const ev = N.evaluate(a.project, a.rasters);
  assert.deepEqual(Array.from(ev.channels.g.values), [0, 10, 20, 30, NaN]);
  assert.equal(ev.channels.h.values[0], 0); assert.ok(Number.isNaN(ev.channels.h.values[1]));
  assert.equal(quantify(a, new Uint8Array([0, 1, 0, 0, 0])).find(r => r.key === 'h').normalized.mean, null);
});

test('advanced enforceCoverage suppresses summaries and invalid reference does not suppress otherwise usable HT pixels', () => {
  const a = entry('a', { h: [2, 2, 2, 2], d: [1, 0, 0, 1], g: [3, 3, 3, 3] });
  const out = apply([a], { mode: 'advanced', qc: { minD4: 0, saturationD4: 100, minCoverage: 0.8, enforceCoverage: true } });
  assert.equal(out.canSave, false); assert.equal(a.project.normalization.section.k, null);
  const ev = N.evaluate(a.project, a.rasters);
  assert.deepEqual(Array.from(ev.channels.h.values), [2, NaN, NaN, 2]); assert.equal(ev.channels.g.values, null);
  assert.equal(N.isCorrectedChannel(ev.channels.g), true);
  const row = quantify(a).find(r => r.key === 'h'); assert.equal(row.nValid, 2); assert.equal(row.normalized.mean, null);
  assert.ok(row.reasonCodes.includes('INSUFFICIENT_VALID_COVERAGE'));
});

test('all group references are fixed and never silently drop a section with no usable standard', () => {
  const a = entry('a', { h: [2], d: [1], g: [4] }), b = entry('b', { h: [2], d: [0], g: [4] });
  const out = apply([a, b]);
  assert.equal(out.canSave, false); assert.ok(out.reasonCodes.includes('REFERENCE_PARTIAL'));
  assert.equal(a.project.normalization.reference.entries.length, 2); assert.equal(a.project.normalization.section.Dref, null);
  assert.equal(N.evaluate(a.project, a.rasters).channels.h.values[0], 2);
  assert.throws(() => N.createSimpleProfiles([a, b], config([a, b], { reference: { kind: 'd4_measured', projectIds: ['a'], roiNames: [] } })), /参照/);
});

test('automatic mapping excludes isotope standards and image-only data; ambiguity requires explicit selections', () => {
  const a = entry('a', { h: [2], d: [1], g: [4], isotope: [5], other: [3], he: [3] }, { isotope: 'Glutamine-13C5', other: 'D3-Dopamine', he: 'HE Stain' });
  const s = N.suggestSimpleMapping(a.project, a.rasters); assert.deepEqual(Array.from(s.targetKeys), ['h', 'g']);
  a.project.molecules.push({ key: 'image', name: 'Unknown image' });
  assert.ok(N.suggestSimpleMapping(a.project, a.rasters).excludedKeys.includes('image'));
  const ambiguous = entry('ambiguous', { h: [2], h2: [3], d: [1], d2: [2] }, { h2: 'Serotonin', d2: '5-HT-d4' });
  assert.deepEqual(Array.from(N.suggestSimpleMapping(ambiguous.project, ambiguous.rasters).issues), ['D4_AMBIGUOUS', 'HT_AMBIGUOUS']);
  assert.throws(() => apply([ambiguous]), /D4/);
  ambiguous.simpleMapping = { standardKey: 'd' }; assert.throws(() => apply([ambiguous]), /5-HT/);
  ambiguous.simpleMapping = { standardKey: 'd', htKey: null, targetKeys: ['h', 'h2'] };
  assert.equal(apply([ambiguous]).canSave, true); assert.equal(N.evaluate(ambiguous.project, ambiguous.rasters).channels.h.method, 'section_scale');
});

test('a failed registered numeric blob stops the group instead of silently dropping the analyte', async () => {
  const a = entry('affected-section', { h: [2], d: [1], g: [4] });
  const b = entry('other-section', { h: [2], d: [1] }); // Glutamate genuinely absent here is allowed.
  for (const m of a.project.molecules) m.blobId = 'raw-' + m.key;
  a.project.molecules.push({ key: 'image-only', name: 'Reference image', imageBlobId: 'image-blob' });
  const original = JSON.stringify(a.project), values = a.rasters;
  a.rasters = await N.loadRasters(a.project, { storage: { getValueRaster: async id => id === 'raw-g' ? null : values[id.slice(4)].values } });
  assert.throws(() => N.createSimpleProfiles([a, b], config([a, b])), error => {
    assert.equal(error.code, 'RAW_MISSING'); assert.equal(error.projectId, 'affected-section');
    assert.deepEqual(Array.from(error.missingRawKeys), ['g']); assert.match(error.message, /affected-section.*Glutamate/);
    return true;
  });
  assert.equal(JSON.stringify(a.project), original);
  a.rasters.g = values.g;
  const output = N.createSimpleProfiles([a, b], config([a, b]));
  assert.equal(output.canSave, true);
  assert.ok(!output.profiles[1].normalization.targets.some(t => t.key === 'g'));
  assert.ok(!output.profiles[0].normalization.targets.some(t => t.key === 'image-only'));
});

test('exact names share ranges across different local keys; duplicate, blank and ambiguous names retain individual ranges', () => {
  const a = entry('a', { d: [1], g: [1], g2: [100], blank: [1000] }, { g2: 'Glutamate', blank: '' });
  const b = entry('b', { d: [1], gl: [2], blank: [2000] }, { gl: 'Glutamate', blank: '' });
  apply([a, b]);
  const ea = N.evaluate(a.project, a.rasters), eb = N.evaluate(b.project, b.rasters);
  for (const c of [ea.channels.g, ea.channels.g2, eb.channels.gl, ea.channels.blank, eb.channels.blank]) assert.equal(c.rangeScope, 'individual');
  assert.notEqual(ea.channels.g.rangeKey, ea.channels.g2.rangeKey); assert.notEqual(ea.channels.g.rangeKey, eb.channels.gl.rangeKey);
  assert.deepEqual(plain(N.rangeForChannel(a.project.normalization, ea.channels.g)), { min: 1, max: 1 });
  const c = entry('c', { d: [1], glutamate: [3], other: [5] }, { glutamate: 'Glutamate', other: 'glutamate' });
  const e = entry('e', { d: [1], differentKey: [7] }, { differentKey: ' Glutamate ' }); apply([c, e]);
  const ec = N.evaluate(c.project, c.rasters), ee = N.evaluate(e.project, e.rasters);
  assert.equal(ec.channels.glutamate.rangeKey, ee.channels.differentKey.rangeKey);
  assert.notEqual(ec.channels.other.rangeKey, ee.channels.differentKey.rangeKey);
  assert.deepEqual(plain(N.rangeForChannel(c.project.normalization, ec.channels.glutamate)), { min: 3, max: 7 });
});

test('simple profile, evaluation and ROI preserve raw Float32 bits including minus zero and missing', () => {
  const a = entry('a', { h: [-0, 0, 1 / 3, NaN, -5], d: [1, 2, 3, 4, 5], g: [-0, NaN, 0, 1 / 3, -2] });
  const before = Object.fromEntries(Object.entries(a.rasters).map(([key, r]) => [key, Buffer.from(r.values.buffer).toString('hex')]));
  apply([a]); N.evaluate(a.project, a.rasters); quantify(a);
  for (const [key, r] of Object.entries(a.rasters)) assert.equal(Buffer.from(r.values.buffer).toString('hex'), before[key]);
  const frozen = JSON.stringify(a.project.normalization), out = plain(quantify(a));
  a.project.otsu = { applied: true, manualThreshold: 1e9 }; a.project.viewerValueMode = 'raw'; a.project.visibleLayers = []; a.project.rotation = 90;
  assert.deepEqual(plain(quantify(a)), out); assert.equal(JSON.stringify(a.project.normalization), frozen);
});

test('simple scope preserves portable target range identity on import and blocks actual moved bindings', () => {
  const a = entry('local', { d: [2], x: [5] }, { x: 'Unknown' });
  a.project.normalizationBinding = { groupId: 'old', memberId: 'portable', folderPath: ['Old', 'Folder'] }; apply([a]);
  const original = N.evaluate(a.project, a.rasters), rangeKey = original.channels.x.rangeKey;
  a.project.id = 'reimported'; assert.equal(N.evaluate(a.project, a.rasters).channels.x.rangeKey, rangeKey);
  const frozen = JSON.stringify(a.project.normalization);
  a.project.normalizationBinding = null;
  assert.equal(N.evaluate(a.project, a.rasters).channels.x.values, null);
  assert.ok(N.evaluate(a.project, a.rasters).reasonCodes.includes('GROUP_MEMBERSHIP_CHANGED'));
  assert.equal(quantify(a)[1].raw.mean, 5); assert.equal(JSON.stringify(a.project.normalization), frozen);
  delete a.project.normalizationBinding;
  assert.equal(N.evaluate(a.project, a.rasters).channels.x.values[0], 5);
});

test('all schema3 scientific settings and target dispatch are fingerprinted; unknown schemas remain unsupported', () => {
  for (const mutate of [p => { p.targets[0].method = 'section_scale'; }, p => { p.targets[0].analyteId = 'changed'; },
    p => { p.qc.enforceCoverage = true; }, p => { p.scope.folderPath[1] = 'Changed'; }, p => { p.mode = 'advanced'; },
    p => { p.commonRanges.extra = { min: 0, max: 1 }; }, p => { p.calibration = curve(); }]) {
    const a = entry('a', { h: [2], d: [1], g: [3] }); apply([a]); mutate(a.project.normalization);
    assert.ok(N.evaluate(a.project, a.rasters).reasonCodes.includes('NORMALIZATION_PROFILE_STALE'));
  }
  const a = entry('a', { h: [2], d: [1] }); apply([a]); a.project.normalization.schemaVersion = 99;
  assert.ok(N.evaluate(a.project, a.rasters).reasonCodes.includes('NORMALIZATION_SCHEMA_UNSUPPORTED'));
});

test('malformed scope, target dispatch, QC and references fail explicitly without mutation or import crashes', () => {
  const a = entry('a', { h: [2], d: [1] });
  for (const change of [{ scope: null }, { qc: { enforceCoverage: 'false' } }, { reference: { kind: 'roi', projectIds: ['a'], roiNames: [] } }]) assert.throws(() => N.createSimpleProfiles([a], config([a], change)));
  for (const change of [{ targets: [null] }, { qc: null }, { reference: null }, { scope: null }]) {
    apply([a]); Object.assign(a.project.normalization, change);
    assert.equal(N.evaluate(a.project, a.rasters).status, 'UNAVAILABLE');
    assert.equal(quantify(a)[0].raw.mean, 2);
  }
});

test('coordinate mismatch prevents save and raw scalar targets do not need valid D4 at the same pixel', () => {
  const a = entry('a', { h: [2, 4], d: [1, 0], g: [3, 5] });
  a.rasters.h.xs = [0, 1]; a.rasters.d.xs = [1, 2];
  const out = apply([a]); assert.equal(out.canSave, false); assert.ok(out.reasonCodes.includes('COORDINATE_MISMATCH'));
  assert.equal(N.evaluate(a.project, a.rasters).channels.h.values, null);
  assert.deepEqual(Array.from(N.evaluate(a.project, a.rasters).channels.g.values), [3, 5]);
});

test('absolute HT calibration requires real matching experiment confirmations and known saturation', () => {
  const a = entry('a', { h: [10, 20], d: [2, 2], g: [6, 8] });
  const mismatched = apply([a], { calibration: curve({ batchId: '', prepId: '' }) });
  assert.equal(mismatched.canSave, false); assert.ok(mismatched.reasonCodes.includes('CALIBRATION_CONDITION_MISMATCH'));
  assert.ok(quantify(a)[0].absolute.reasonCodes.includes('CALIBRATION_CONDITION_MISMATCH'));
  const conditions = { mode: 'advanced', batchId: 'batch', prepId: 'prep', coordinateMatchConfirmed: true, comparabilityConfirmed: true, calibration: curve() };
  const noSaturation = apply([a], conditions); assert.equal(noSaturation.canSave, false); assert.ok(quantify(a)[0].absolute.reasonCodes.includes('D4_SATURATION_UNKNOWN'));
  const invalid = apply([a], { ...conditions, qc: { saturationD4: 100 }, calibration: curve({ source: '' }) });
  assert.equal(invalid.canSave, false); assert.ok(invalid.reasonCodes.includes('CALIBRATION_INVALID'));
  assert.equal(apply([a], { ...conditions, qc: { saturationD4: 100 } }).canSave, true);
  assert.equal(quantify(a)[0].absolute.value, 3.25); assert.equal(quantify(a)[2].absolute.status, 'NOT_APPLICABLE');
});

test('v2 golden fingerprint, formulas and role keyed range are unchanged from released v2.10.1 source', () => {
  const a = entry('legacy', { h: [10], d: [2], a: [6] });
  const result = N.createProfiles([a], { id: 'legacy-profile', revision: 1, batchId: 'run-a', prepId: 'prep-a', quality: 'provisional',
    coordinateMatchConfirmed: true, comparabilityConfirmed: true, qc: { minD4: 0, saturationD4: 1000, minCoverage: 0.5 },
    reference: { kind: 'whole_tissue', projectIds: ['legacy'], roiNames: [] }, calibration: null, otsuSourceRoles: ['ht', 'da', 'ne'],
    scope: { type: 'folder-depth', depth: 2, includeDescendants: true, groupId: 'golden-group', folderPath: ['Marmoset', 'Coronal'], memberIds: ['legacy'] } });
  a.project.normalization = result.profiles[0].normalization;
  // Independently captured from 949b4f31e191c9f448fe96949b55f0a8fd84d20d.
  assert.equal(a.project.normalization.calculationFingerprint, '62a7a1ae8a8c6828');
  assert.equal(a.project.normalization.rawFingerprint, 'f32-v1:e935a0b55a2727c3');
  const ev = N.evaluate(a.project, a.rasters); assert.equal(ev.channels.h.values[0], 5); assert.equal(ev.channels.a.values[0], 6);
  assert.deepEqual(plain(N.rangeForChannel(a.project.normalization, ev.channels.a)), { min: 6, max: 6 });
  assert.equal(N.SCHEMA_VERSION, 2); assert.equal(N.METHOD_VERSION, '1.0.0');
});
