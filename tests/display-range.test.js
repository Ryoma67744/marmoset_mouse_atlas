'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sandbox = { window: {}, Float32Array, Float64Array, Uint8Array, ArrayBuffer, DataView, Date };
vm.createContext(sandbox);
for (const file of ['msi.js', 'normalization-scope.js', 'normalization.js', 'display-range.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8'), sandbox);
const D = sandbox.window.DisplayRange, N = sandbox.window.Normalization;
const plain = value => JSON.parse(JSON.stringify(value));
function entry(id, data, names = {}) {
  const W = Object.values(data)[0].length, project = { id, displayName: id, grid: { W, H: 1 }, molecules: [] }, rasters = {};
  for (const [key, values] of Object.entries(data)) {
    project.molecules.push({ key, name: names[key] === undefined ? ({ h: '5-HT', d: 'D4-5-HT', a: 'DA', n: 'NE' }[key] || key) : names[key] });
    rasters[key] = { W, H: 1, values: new Float32Array(values) };
  }
  return { project, rasters };
}
function apply(entries, changes = {}) {
  const result = N.createSimpleProfiles(entries, { id: 'display-test', revision: 1, scope: { type: 'folder-depth', depth: 2, includeDescendants: true,
    groupId: 'group', folderPath: ['Marmoset', 'Coronal'], memberIds: entries.map(e => e.project.id) }, ...changes });
  result.profiles.forEach((item, i) => {
    entries[i].project.normalization = item.normalization;
    entries[i].project.normalizationBinding = { groupId: item.normalization.scope.groupId, memberId: entries[i].project.id, folderPath: item.normalization.scope.folderPath.slice() };
  });
  return result;
}
function display(e, key = 'h', mode = 'normalized') {
  const evaluation = N.evaluate(e.project, e.rasters), channel = evaluation.channels[key];
  return D.resolve({ project: e.project, key, mode, channel, rawFingerprint: evaluation.fingerprint,
    values: mode === 'normalized' ? channel.values : e.rasters[key].values });
}
function installSnapshot(entries) {
  const snapshot = D.buildGroupSnapshot(entries);
  for (const e of entries) { D.prepareProject(e.project); e.project.valueDisplay.groupRangeSnapshot = plain(snapshot); }
  return snapshot;
}

test('nearest rank P99 sorts a finite COPY and preserves measured zero and coordinate order', () => {
  const values = new Float64Array([439284000, ...Array.from({ length: 99 }, (_, i) => i), NaN, Infinity, -Infinity]);
  const original = Array.from(values), range = D.stats(values);
  assert.equal(range.min, 0); assert.equal(range.max, 98); assert.equal(range.nFinite, 100);
  assert.equal(range.actualMax, 439284000); assert.equal(range.nClipped, 1); assert.equal(range.clippedFraction, 0.01);
  assert.deepEqual(Array.from(values), original);
  assert.deepEqual(plain(D.stats(values)), plain(range));
});

test('sparse positive signals remain visible and zero, absent and signed constants are distinguished', () => {
  const sparse = D.stats(new Float64Array([...new Array(999).fill(0), 10]));
  assert.equal(sparse.max, 10); assert.equal(sparse.status, 'SPARSE_FALLBACK'); assert.equal(sparse.nFinite, 1000);
  const zero = D.stats(new Float64Array([0, 0, NaN]));
  assert.equal(zero.status, 'ALL_ZERO'); assert.equal(zero.actualMax, 0); assert.equal(zero.nFinite, 2);
  const absent = D.stats(new Float64Array([NaN, Infinity]));
  assert.equal(absent.status, 'NO_FINITE_VALUES'); assert.equal(absent.actualMin, null); assert.equal(absent.nFinite, 0);
  for (const value of [-5, -Number.MAX_VALUE, -Number.MIN_VALUE, 5, Number.MAX_VALUE]) {
    const range = D.stats(new Float64Array([value, value]));
    assert.ok(Number.isFinite(range.min) && Number.isFinite(range.max));
    assert.ok(range.max > range.min); assert.ok(Number.isFinite(range.max - range.min));
  }
  assert.ok(D.stats(new Float64Array([-5, -5])).min < -5);
  assert.equal(D.stats(new Float64Array([-2, -1, 2])).min, -2);
});

test('legacy correction windows migrate to individual with exact backup and raw manual retained', () => {
  const e = entry('a', { h: [1, 2], d: [1, 1] }); apply([e]);
  e.project.valueDisplay = { mode: 'normalized', scale: 'common' };
  e.project.layerDisplay = { h: { vmin: 0, vmax: 439284000, rawRange: [133.69, 51993.8], normalizedRange: [0, 439284000], opacity: 0.4 } };
  const profile = JSON.stringify(e.project.normalization);
  D.prepareProject(e.project);
  assert.equal(D.layerState(e.project, 'h', 'normalized').strategy, 'individual');
  assert.deepEqual(plain(D.layerState(e.project, 'h', 'normalized').legacy), { min: 0, max: 439284000 });
  assert.deepEqual(plain(D.layerState(e.project, 'h', 'raw').manual), { min: 133.69, max: 51993.8 });
  assert.equal(e.project.valueDisplay.rangeMigration.normalizedToIndividual, true);
  assert.equal(display(e).max, 2); assert.equal(display(e, 'h', 'raw').max, 51993.8);
  assert.equal(D.restoreLegacy(e.project, 'h', 'normalized'), true);
  assert.equal(display(e).max, 439284000); assert.equal(display(e).strategy, 'manual');
  const serialized = D.serializeLayer(e.project, 'h', { opacity: 0.5, vmin: 0, vmax: 439284000 });
  assert.equal(serialized.opacity, 0.5); assert.equal(serialized.displayRanges.normalized.manual.max, 439284000);
  assert.equal(profile, JSON.stringify(e.project.normalization));
});

test('common to individual never adopts the giant common window as manual and ROI remains unchanged', () => {
  const a = entry('a', { h: [0.00327383, 0.123571, 0.25, 0.4, 0.8, 1, 2, 2.22131], d: new Array(8).fill(1), a: [1, 2, 3, 4, 5, 6, 7, 8] });
  const b = entry('b', { h: [439.284, 1, 1, 1, 1, 1, 1, 1], d: [1e-6, 1, 1, 1, 1, 1, 1, 1], a: [1, 2, 3, 4, 5, 6, 7, 8] });
  apply([a, b]);
  const profile = JSON.stringify(a.project.normalization), before = N.evaluate(a.project, a.rasters);
  const roi = plain(N.quantifyRoi(a.project, a.rasters, before, new Uint8Array(8).fill(1)));
  const snapshot = installSnapshot([a, b]);
  D.setStrategy(a.project, 'h', 'normalized', 'common');
  const common = display(a); assert.ok(common.max > 4e8); assert.equal(common.source, 'group');
  assert.equal(common.snapshotId, snapshot.id); assert.equal(common.maximum.memberId, 'b');
  assert.equal(common.maximum.index, 0); assert.ok(common.maximum.denominator < 2e-6);
  assert.equal(Math.round(255 * 2.22131 / common.max), 0);
  D.setStrategy(a.project, 'h', 'normalized', 'individual');
  const local = display(a); assert.ok(local.max < 2.23); assert.equal(local.strategy, 'individual');
  assert.equal(D.layerState(a.project, 'h', 'normalized').manual, null);
  assert.ok(Math.round(255 * 2.22131 / local.max) > 250);
  D.setStrategy(a.project, 'h', 'normalized', 'common'); assert.equal(display(a).max, common.max);
  assert.equal(display(a, 'a').max, 8);
  const after = N.evaluate(a.project, a.rasters);
  assert.deepEqual(Array.from(after.channels.h.values), Array.from(before.channels.h.values));
  assert.deepEqual(plain(N.quantifyRoi(a.project, a.rasters, after, new Uint8Array(8).fill(1))), roi);
  assert.equal(JSON.stringify(a.project.normalization), profile);
});

test('group P99 pools pixels instead of averaging per-section quantiles and keeps molecules separate', () => {
  const a = entry('a', { h: new Array(100).fill(1), d: new Array(100).fill(1), a: new Array(100).fill(50) });
  const b = entry('b', { h: [439284000], d: [1], a: [100] }); apply([a, b]);
  const snapshot = installSnapshot([a, b]);
  D.setStrategy(a.project, 'h', 'normalized', 'common'); D.setStrategy(b.project, 'h', 'normalized', 'common');
  assert.equal(display(a).max, 1); assert.equal(display(b).max, 1);
  assert.equal(display(a).groupNFinite, 101); assert.equal(display(a).groupContributorCount, 2);
  assert.equal(display(b).nClipped, 1); assert.equal(display(a).nClipped, 0);
  D.setStrategy(a.project, 'a', 'normalized', 'common'); assert.equal(display(a, 'a').max, 50);
  assert.equal(Object.keys(snapshot.ranges).length, 2);
});

test('manual policies are independent per molecule and per raw/corrected mode; source changes invalidate application', () => {
  const e = entry('a', { h: [1, 2], d: [1, 1], a: [10, 20] }); apply([e]);
  display(e); D.setManual(e.project, 'h', 'normalized', 0.1, 0.9);
  assert.equal(display(e).max, 0.9); assert.equal(display(e, 'a').max, 20); assert.equal(display(e, 'h', 'raw').max, 2);
  D.setStrategy(e.project, 'h', 'normalized', 'individual'); assert.equal(display(e).max, 2);
  D.setStrategy(e.project, 'h', 'normalized', 'manual'); assert.equal(display(e).max, 0.9);
  apply([e], { revision: 2 });
  const changed = display(e); assert.equal(changed.strategy, 'individual'); assert.equal(changed.reason, 'DISPLAY_SOURCE_CHANGED');
  assert.equal(D.layerState(e.project, 'h', 'normalized').manual.max, 0.9);
  assert.throws(() => D.setManual(e.project, 'h', 'normalized', 1, 1), /INVALID/);
  assert.throws(() => D.setManual(e.project, 'h', 'normalized', -Number.MAX_VALUE, Number.MAX_VALUE), /INVALID/);
});

test('skipped standards remain in group inventory and contribute no corrected pixels', () => {
  const a = entry('a', { h: [1, 2], d: [1, 1] }), b = entry('b', { h: [1000, 2000] }); apply([a, b]);
  const snapshot = installSnapshot([a, b]);
  assert.deepEqual(Array.from(snapshot.memberIds), ['a', 'b']); assert.equal(snapshot.members[1].skipped, true);
  assert.equal(Object.values(snapshot.ranges)[0].nFinite, 2); assert.deepEqual(Array.from(Object.values(snapshot.ranges)[0].memberIds), ['a']);
  assert.equal(display(b, 'h', 'raw').max, 2000); assert.equal(N.evaluate(b.project, b.rasters).status, 'SKIPPED');
  const profile = JSON.stringify(b.project.normalization);
  D.prepareProject(b.project); assert.equal(JSON.stringify(b.project.normalization), profile);
  const all = entry('all', { h: [1, 2] }); apply([all]); assert.equal(Object.keys(D.buildGroupSnapshot([all]).ranges).length, 0);
});

test('incomplete, duplicate, cross-scope and stale sources cannot build a replacement common range', () => {
  const a = entry('a', { h: [1, 2], d: [1, 1] }), b = entry('b', { h: [3, 4], d: [1, 1] }); apply([a, b]);
  assert.throws(() => D.buildGroupSnapshot([a]), /INCOMPLETE/);
  assert.throws(() => D.buildGroupSnapshot([a, a]), /INCOMPLETE/);
  const c = entry('c', { h: [3, 4], d: [1, 1] }); apply([c]);
  assert.throws(() => D.buildGroupSnapshot([a, c]), /INCOMPLETE/);
  const saved = b.rasters.h.values[0]; b.rasters.h.values[0] = 99;
  assert.throws(() => D.buildGroupSnapshot([a, b]), /STALE/); b.rasters.h.values[0] = saved;
  b.project.normalizationBinding.groupId = 'elsewhere';
  assert.throws(() => D.buildGroupSnapshot([a, b]), /INVALID/);
});

test('unknown or duplicated names stay individual, while method and exact names delimit analytes', () => {
  const a = entry('a', { h: [1], d: [1], a: [4], z: [8] }, { a: 'Unknown', z: 'Unknown' }); apply([a]);
  const snapshot = installSnapshot([a]);
  assert.equal(Object.keys(snapshot.ranges).length, 1);
  D.setStrategy(a.project, 'a', 'normalized', 'common');
  assert.equal(display(a, 'a').strategy, 'individual'); assert.equal(display(a, 'a').reason, 'COMMON_RANGE_UNAVAILABLE');
  const ev = N.evaluate(a.project, a.rasters), channel = { ...ev.channels.h, method: 'section_scale' };
  assert.notEqual(D.analyteKey(a.project, 'h', channel), D.analyteKey(a.project, 'h', ev.channels.h));
  assert.notEqual(D.analyteKey(a.project, 'h', { ...channel, unit: 'different unit' }), D.analyteKey(a.project, 'h', channel));
});

test('common snapshots survive JSON and portable project IDs, with tampering and source changes rejected', () => {
  const a = entry('a', { h: [1, 2], d: [1, 1] }); apply([a]); const snapshot = installSnapshot([a]);
  D.setStrategy(a.project, 'h', 'normalized', 'common');
  assert.equal(display(a).source, 'group');
  a.project = plain(a.project); a.project.id = 'restored-local-id';
  assert.equal(display(a).source, 'group');
  const range = Object.values(a.project.valueDisplay.groupRangeSnapshot.ranges)[0]; range.max = 100;
  assert.equal(display(a).reason, 'COMMON_RANGE_INVALID'); assert.equal(display(a).max, 2);
  a.project.valueDisplay.groupRangeSnapshot = plain(snapshot);
  a.project.normalizationBinding.groupId = 'moved'; assert.equal(display(a).reason, 'COMMON_RANGE_SCOPE_CHANGED');
});

test('materialized optional grid nulls do not reset manual windows after a portable round trip', () => {
  const a = entry('a', { h: [1, 2], d: [1, 1] }); apply([a]);
  display(a); D.setManual(a.project, 'h', 'normalized', 0, 0.7); display(a);
  a.project = plain(a.project); a.project.grid.umPerPxX = null; a.project.grid.umPerPxY = null;
  const restored = display(a);
  assert.equal(restored.strategy, 'manual'); assert.equal(restored.max, 0.7); assert.equal(restored.reason, null);
});

test('missing common cache is explicit and cannot fall back to old normalization.commonRanges', () => {
  const a = entry('a', { h: [1, 2], d: [1, 1] }); apply([a]);
  D.setStrategy(a.project, 'h', 'normalized', 'common');
  const range = display(a);
  assert.equal(range.strategy, 'individual'); assert.equal(range.requestedStrategy, 'common'); assert.equal(range.reason, 'COMMON_RANGE_NOT_BUILT');
  assert.equal(D.layerState(a.project, 'h', 'normalized').manual, null);
});

test('group snapshot identity is deterministic for reordered inputs and does not rewrite numerical fingerprints', () => {
  const a = entry('a', { h: [1, 2], d: [1, 1] }), b = entry('b', { h: [3, 4], d: [1, 1] }); apply([a, b]);
  const before = [a, b].map(e => JSON.stringify(e.project.normalization));
  const forward = D.buildGroupSnapshot([a, b]), reverse = D.buildGroupSnapshot([b, a]);
  assert.equal(forward.id, reverse.id);
  assert.deepEqual([a, b].map(e => JSON.stringify(e.project.normalization)), before);
  for (const e of [a, b]) assert.ok(!N.evaluate(e.project, e.rasters).reasonCodes.includes('NORMALIZATION_PROFILE_STALE'));
});
