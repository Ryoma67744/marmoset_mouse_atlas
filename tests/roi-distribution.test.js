'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function load(withDistribution = true) {
  const sandbox = { window: {}, Float32Array, Float64Array, Uint8Array, ArrayBuffer, DataView, Date };
  vm.createContext(sandbox);
  const files = ['msi.js', 'normalization-scope.js', 'normalization.js'];
  if (withDistribution) files.push('roi-distribution.js');
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8'), sandbox);
  return sandbox.window;
}
const api = load(), D = api.RoiDistribution, N = api.Normalization;
const plain = value => JSON.parse(JSON.stringify(value));
const summaries = result => { const { points, sampled, ...summary } = plain(result); return summary; };
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`); }
function entry(data) {
  const W = Object.values(data)[0].length;
  const project = { id: 'section', grid: { W, H: 1 }, molecules: [] }, rasters = {};
  for (const [key, values] of Object.entries(data)) {
    project.molecules.push({ key, name: ({ h: '5-HT', d: 'D4-5-HT', g: 'Glutamate' })[key] || key });
    rasters[key] = { W, H: 1, values: new Float32Array(values) };
  }
  return { project, rasters };
}
function apply(e, changes = {}) {
  const result = N.createSimpleProfiles([e], { id: 'distribution-test', revision: 1,
    scope: { type: 'folder-depth', depth: 2, includeDescendants: true, groupId: 'group',
      folderPath: ['Marmoset', 'Coronal'], memberIds: [e.project.id] }, ...changes });
  e.project.normalization = result.profiles[0].normalization;
  e.project.normalizationBinding = { groupId: 'group', memberId: e.project.id, folderPath: ['Marmoset', 'Coronal'] };
}
function quantify(e, mode, keys = ['h'], mask, normalization = N) {
  return normalization.quantifyRoi(e.project, e.rasters, normalization.evaluate(e.project, e.rasters),
    mask || new Uint8Array(e.project.grid.W).fill(1), mode ? { distribution: { keys, mode, maxPoints: 2000 } } : undefined);
}

test('odd/even quantiles interpolate all finite values and preserve input order and bits', () => {
  const values = new Float64Array([4, NaN, 0, Infinity, 2, -Infinity, 1, 3]);
  const before = Buffer.from(values.buffer).toString('hex');
  const result = D.summarize(values);
  assert.deepEqual(summaries(result), { n: 5, min: 0, max: 4, q1: 1, median: 2, q3: 3,
    whiskerLow: 0, whiskerHigh: 3.96, upperTailCount: 1, quantileMethod: 'linear-h-n-minus-1' });
  assert.deepEqual(plain(result.points), [0, 1, 2, 3, 4].map((value, rank) => ({ value, rank, upperTail: rank === 4 })));
  assert.equal(result.sampled, false);
  assert.equal(Buffer.from(values.buffer).toString('hex'), before);
  const even = D.summarize([-4, -2, 0, 2]);
  assert.equal(even.q1, -2.5); assert.equal(even.median, -1); assert.equal(even.q3, 0.5);
  near(even.whiskerHigh, 1.94);
});

test('empty, single, zero, constant and tied upper bounds have honest summaries', () => {
  assert.equal(D.summarize([]), null);
  assert.equal(D.summarize([NaN, Infinity, -Infinity, null, '2']), null);
  for (const values of [[7], [0, 0, 0], [-2, -2]]) {
    const result = D.summarize(values);
    for (const field of ['min', 'max', 'q1', 'median', 'q3', 'whiskerLow', 'whiskerHigh']) assert.equal(result[field], values[0]);
    assert.equal(result.upperTailCount, 0); assert.ok(result.points.every(p => !p.upperTail));
  }
  const tied = D.summarize([...Array(98).fill(0), 1, 1]);
  assert.equal(tied.whiskerHigh, 1); assert.equal(tied.upperTailCount, 0);
  assert.ok(tied.points.every(p => !p.upperTail), 'points exactly on P99 remain blue');
  const extreme = D.summarize([-Number.MAX_VALUE, Number.MAX_VALUE]);
  assert.equal(extreme.median, 0); assert.ok(Number.isFinite(extreme.q1)); assert.ok(Number.isFinite(extreme.q3));
});

test('deterministic sampling preserves full-population summaries and represents both tails', () => {
  const values = Float64Array.from({ length: 10001 }, (_, i) => (i * 7919) % 10001);
  const full = D.summarize(values, { maxPoints: 20000 });
  const sampled = D.summarize(values, { maxPoints: 100 });
  assert.deepEqual(summaries(sampled), summaries(full));
  assert.deepEqual(plain(sampled), plain(D.summarize(values, { maxPoints: 100 })));
  assert.equal(sampled.sampled, true); assert.equal(sampled.points.length, 100);
  assert.equal(sampled.points[0].value, 0); assert.equal(sampled.points.at(-1).value, 10000);
  assert.ok(sampled.points.some(p => p.upperTail));
  assert.ok(sampled.points.some(p => p.rank === 9901), 'first point strictly above P99 is preserved');
  assert.equal(new Set(sampled.points.map(p => p.rank)).size, 100);
  assert.ok(sampled.points.every(p => p.upperTail === (p.value > sampled.whiskerHigh)));
  const minimumBudget = D.summarize(values, { maxPoints: 2 });
  assert.deepEqual(Array.from(minimumBudget.points, p => p.value), [0, 10000]);
  for (const maxPoints of [0, 1, 2.5, NaN, Infinity]) assert.throws(() => D.summarize(values, { maxPoints }), /maxPoints/);
});

test('opt-in distributions add only requested channels and leave every legacy field and raw bit unchanged', () => {
  const e = entry({ h: [0, 4, 8, NaN], d: [2, 2, 2, NaN], g: [2, 4, 6, NaN] }); apply(e);
  const before = Object.fromEntries(Object.entries(e.rasters).map(([key, r]) => [key, Buffer.from(r.values.buffer).toString('hex')]));
  const legacy = plain(quantify(e));
  const summarize = D.summarize, requests = [];
  D.summarize = (values, options) => { requests.push(Array.from(values)); return summarize(values, options); };
  try {
    assert.deepEqual(plain(quantify(e)), legacy); assert.equal(requests.length, 0);
    const rows = quantify(e, 'normalized');
    assert.equal(requests.length, 1); assert.deepEqual(requests[0], [0, 2, 4]);
    assert.equal(rows[0].distribution.n, 3); assert.equal(rows[0].distribution.median, 2);
    assert.ok(!Object.hasOwn(rows[1], 'distribution')); assert.ok(!Object.hasOwn(rows[2], 'distribution'));
    assert.deepEqual(plain(rows).map(({ distribution, ...row }) => row), legacy);
    assert.equal(quantify(e, 'raw')[0].distribution.median, 4);
    assert.equal(quantify(e, 'normalized', ['d'])[1].distribution.median, 2, 'uncorrected standard uses raw values');
  } finally { D.summarize = summarize; }
  for (const [key, r] of Object.entries(e.rasters)) assert.equal(Buffer.from(r.values.buffer).toString('hex'), before[key]);
});

test('report-only partial coverage retains valid pixels, enforced coverage suppresses the complete distribution', () => {
  const e = entry({ h: [0, 4, 8, 12], d: [2, 0, NaN, 2], g: [1, 2, 3, 4] }); apply(e);
  let row = quantify(e, 'normalized')[0];
  assert.equal(row.status, 'PARTIAL'); assert.equal(row.coverage, 0.5); assert.equal(row.distribution.n, 2);
  assert.equal(row.distribution.median, 3); assert.equal(row.distribution.min, 0);
  apply(e, { mode: 'advanced', qc: { minD4: 0, saturationD4: 100, minCoverage: 0.8, enforceCoverage: true } });
  row = quantify(e, 'normalized')[0];
  assert.equal(row.normalized.n, 2); assert.equal(row.normalized.mean, null); assert.equal(row.distribution, null);
  assert.ok(row.reasonCodes.includes('INSUFFICIENT_VALID_COVERAGE'));
  assert.equal(quantify(e, 'raw')[0].distribution.n, 4, 'correction QC never hides raw measurements');
  assert.equal(quantify(e, 'normalized', ['g'])[2].distribution, null, 'unavailable section factor is not raw fallback');
});

test('missing profile, missing values and image-only channels remain unavailable; skipped correction stays raw', () => {
  const e = entry({ h: [2, 4], d: [2, 2] });
  assert.equal(quantify(e, 'normalized')[0].distribution, null);
  assert.equal(quantify(e, 'raw')[0].distribution.median, 3);
  apply(e);
  assert.equal(quantify(e, 'raw', ['h'], new Uint8Array(2))[0].distribution, null);
  e.project.molecules.push({ key: 'image', name: 'Image only' });
  assert.equal(quantify(e, 'raw', ['image']).at(-1).distribution, null);
  const missing = entry({ h: [NaN, NaN], d: [1, 1] });
  assert.equal(quantify(missing, 'raw')[0].distribution, null);
  const skipped = entry({ h: [-2, 0, 8] }); apply(skipped);
  const row = quantify(skipped, 'normalized')[0];
  assert.equal(row.status, 'SKIPPED'); assert.equal(row.distribution.min, -2); assert.equal(row.distribution.median, 0);
});

test('legacy callers do not require distribution module and opt-in failure is explicit', () => {
  const legacy = load(false).Normalization, e = entry({ h: [0, 4] });
  assert.equal(quantify(e, undefined, undefined, undefined, legacy)[0].raw.mean, 2);
  assert.throws(() => quantify(e, 'raw', ['h'], undefined, legacy), /Load roi-distribution.js/);
  assert.throws(() => N.quantifyRoi(e.project, e.rasters, null, new Uint8Array(2), { distribution: { keys: ['h'], mode: 'invalid' } }), /distribution requires/);
  assert.throws(() => N.quantifyRoi(e.project, e.rasters, null, new Uint8Array(2), { distribution: { keys: ['h'], mode: 'normalized', maxPoints: 1 } }), /maxPoints/,
    'invalid drawing budgets fail even when every selected distribution is unavailable');
});
