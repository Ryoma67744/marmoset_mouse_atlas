'use strict';
// Synthetic fixtures only: original values, anatomical labels and data exports
// are never part of this display mask's committed test data.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const A = 'Dopamine-DPP', B = 'Norepinephrine-DPP', D4 = 'Serotonin-d4-DPP';
function app() {
  const c = { Uint8Array, Uint16Array, Uint32Array, Float64Array, ArrayBuffer };
  c.window = c; vm.createContext(c);
  for (const file of ['section-edge-mask.js', 'stack3d-high-value-mask.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), c, { filename: file });
  return c;
}
function section(W = 41, H = 41, fill = i => i % 9 + 1) {
  const values = Float64Array.from({ length: W * H }, (_, i) => fill(i));
  return { W, H, coordinateMode: 'pixel', angleDeg: 0, channels: {
    [A]: { raw: values.slice(), normalized: values, corrected: { status: 'VALID' }, ranges: { normalized: { min: 0, max: 100 }, raw: { min: 0, max: 100 } }, opacity: 1 }
  }, rasters: { raw: { W, H, values: values.slice() } }, project: { roi: {}, grid: { W, H } }, evaluation: { status: 'VALID' }, scope: {} };
}
const idx = (s, x, y) => y * s.W + x;
function spike(s, x, y, value = 100) { const i = idx(s, x, y); s.channels[A].normalized[i] = value; s.channels[A].raw[i] = value; s.rasters.raw.values[i] = value; return i; }
function bytes(s) { return [s.channels[A].raw, s.channels[A].normalized, ...Object.values(s.rasters).map(r => r.values)].map(v => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex')); }

test('inclusive protection changes only the boundary band and keeps source values', () => {
  const c = app(), s = section(), edge = spike(s, 2, 12), seven = spike(s, 6, 16), eight = spike(s, 7, 26), center = spike(s, 20, 20);
  const before = bytes(s), metadata = JSON.stringify(s.project), model = c.Stack3DHighValueMask.create([s]);
  const d8 = model.masksFor(s), d9 = model.masksFor(s, 9), d20 = model.masksFor(s, 20);
  assert.equal(d8[A][edge], 1); assert.equal(d8[A][seven], 1); assert.equal(d8[A][eight], 0);
  assert.equal(d9[A][eight], 1); assert.equal(d20[A][center], 0);
  for (let i = 0; i < d8[A].length; i++) assert(d8[A][i] <= d9[A][i] && d9[A][i] <= d20[A][i]);
  assert.equal(model.masksFor(s), d8, 'threshold masks are cached without progressively filtering values');
  assert.deepEqual(bytes(s), before); assert.equal(JSON.stringify(s.project), metadata);
  assert.equal(Object.isFrozen(model.thresholds[A]), true);
  for (const depth of [4, 21, 7.5, '8', NaN]) assert.throws(() => model.masksFor(s, depth), /integer from 5 to 20/);
});

test('thresholds pool original loaded sections using nearest rank, including zeros', () => {
  const c = app(), a = section(10, 10, i => i), b = section(10, 10, i => i + 100);
  a.channels[D4] = { raw: new Float64Array(100).fill(1e9), normalized: new Float64Array(100).fill(1e9), corrected: { status: 'VALID' } };
  const model = c.Stack3DHighValueMask.create([a, b]);
  assert.equal(model.thresholds[A].p95, 189); assert.equal(model.thresholds[A].p99, 197); assert.equal(model.thresholds[A].finiteCount, 200);
  assert.equal(model.thresholds[D4], undefined); assert.equal(model.masksFor(a)[D4], undefined);
  a.project.roi = { roi_names: { 1: 'ROI is not a mask input' } }; a.hidden = true;
  assert.equal(model.thresholds[A].p95, 189);
});

test('MAD defers incomplete neighbors and zero spread, while the outer rule remains independent', () => {
  const c = app(), s = section(), interior = spike(s, 5, 15), outer = spike(s, 2, 26);
  s.channels[A].normalized[interior - 1] = NaN; s.channels[A].normalized[outer - 1] = NaN;
  const result = c.Stack3DHighValueMask.create([s]).masksFor(s);
  assert.equal(result[A][interior], 0, 'all 24 original neighboring values are required'); assert.equal(result[A][outer], 1);
  const flat = section(31, 31, () => 1), high = spike(flat, 5, 15), rim = spike(flat, 2, 24);
  const flatMask = c.Stack3DHighValueMask.create([flat]).masksFor(flat);
  assert.equal(flatMask[A][high], 0, 'zero MAD is deferred, not divided by epsilon'); assert.equal(flatMask[A][rim], 1);
});

test('MAD uses a strict P95 gate rather than hiding a high local contrast at P95', () => {
  const c = app(), s = section(31, 31, () => 10), x = 5, y = 15;
  let count = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dx || dy)
    s.channels[A].normalized[idx(s, x + dx, y + dy)] = count++ % 2 ? 2 : 0;
  const model = c.Stack3DHighValueMask.create([s]);
  assert.equal(model.thresholds[A].p95, 10); assert.equal(model.masksFor(s)[A][idx(s, x, y)], 0);
});

test('internal missing holes do not move the exterior and finite zero raw samples remain acquired', () => {
  const c = app(), s = section(), target = spike(s, 7, 20), hole = idx(s, 7, 16);
  s.rasters.raw.values[hole] = NaN; s.channels[A].raw[hole] = NaN; s.channels[A].normalized[hole] = NaN;
  s.rasters.raw.values[idx(s, 7, 19)] = 0;
  const model = c.Stack3DHighValueMask.create([s]);
  assert.equal(model.masksFor(s, 8)[A][target], 0, 'enclosed hole four pixels away is not a new boundary');
  assert.equal(model.masksFor(s, 9)[A][target], 1);
});

test('empty acquisitions and unavailable channels produce no additional mask', () => {
  const c = app(), empty = section(5, 5, () => NaN), invalid = section(5, 5);
  invalid.channels[A].corrected.status = 'INVALID';
  const model = c.Stack3DHighValueMask.create([empty, invalid]);
  assert.equal(model.masksFor(empty)[A].some(Boolean), false); assert.equal(model.masksFor(invalid)[A], undefined);
  assert.throws(() => model.masksFor(section()), /unavailable/);
  empty.released = true; assert.throws(() => model.masksFor(empty), /unavailable/);
});

test('renderer masks one normalized channel before merging, with original arrays and ranges intact', () => {
  const c = app(), s = section(3, 3), target = 4, mask = new Uint8Array(9); mask[target] = 1;
  s.channels[B] = { ...s.channels[A], raw: new Float64Array(9).fill(4), normalized: new Float64Array(9).fill(2) };
  const before = bytes(s), otherBefore = Array.from(s.channels[B].normalized); let merged;
  const canvas = () => ({ width: 3, height: 3, getContext: () => ({ translate() {}, rotate() {}, drawImage() {} }) });
  c.document = { createElement: canvas };
  c.SectionDisplay = { paintChannel: () => canvas(), mergeChannels: layers => {
    merged = layers; return { canvas: canvas(), previewCanvas: canvas(), invalidPixels: 0, measuredPixels: 9, visiblePixels: 9 };
  } };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/stack3d.js'), 'utf8'), c);
  const opts = { channels: [A, B], mode: 'normalized', signalMasks: { [A]: mask } };
  const result = c.Stack3D.renderSection(s, opts);
  assert(Number.isNaN(merged[0].values[target])); assert(Number.isNaN(merged[0].rawValues[target]), 'no invalid-value gray for a deliberate mask');
  assert.equal(merged[1].values[target], 2, 'other molecule is still merged at this coordinate');
  assert.equal(merged[0].values[0], s.channels[A].normalized[0]); assert.equal(result.ranges[A], s.channels[A].ranges.normalized);
  assert.deepEqual(bytes(s), before); assert.deepEqual(Array.from(s.channels[B].normalized), otherBefore);
  c.Stack3D.renderSection(s, { ...opts, mode: 'raw' }); assert.equal(merged[0].values, s.channels[A].raw, 'raw callers keep their original behavior');
  c.Stack3D.renderSection(s, { ...opts, signalMasks: undefined }); assert.equal(merged[0].values, s.channels[A].normalized, 'unfiltered render callers keep their original behavior');
});
