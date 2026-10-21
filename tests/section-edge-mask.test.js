'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = { Uint8Array, Uint16Array, Uint32Array }; context.window = context; vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/section-edge-mask.js'), 'utf8'), context);
const fromSection = (s, width) => context.Stack3DEdgeMask.fromSection(s, width);
function section(rows, value = 1) {
  const W = rows[0].length, H = rows.length;
  return { W, H, rasters: { a: { W, H, values: Float64Array.from(rows.join(''), v => v === '#' ? value : NaN) } } };
}
function solid(W, H) { return section(Array(H).fill('#'.repeat(W))); }
function at(result, x, y) { return result.hiddenMask[y * result.width + x]; }
function unchanged(s, run) {
  const bytes = Object.values(s.rasters).map(r => Buffer.from(r.values.buffer).toString('hex'));
  const before = JSON.stringify(s);
  const result = run();
  assert.equal(JSON.stringify(s), before);
  assert.deepEqual(Object.values(s.rasters).map(r => Buffer.from(r.values.buffer).toString('hex')), bytes);
  return result;
}
// Independent oracle: explicit padding, four-neighbor flood, then direct
// Chebyshev distance to every exterior seed (not the helper's bounded BFS).
function oracle(rows, width) {
  const W = rows[0].length, H = rows.length, P = W + 2, Q = H + 2;
  const exterior = new Set(['0,0']), queue = [[0, 0]];
  const measured = (x, y) => x > 0 && x <= W && y > 0 && y <= H && rows[y - 1][x - 1] === '#';
  for (let h = 0; h < queue.length; h++) {
    const [x, y] = queue[h];
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dx, ny = y + dy, key = `${nx},${ny}`;
      if (nx >= 0 && nx < P && ny >= 0 && ny < Q && !measured(nx, ny) && !exterior.has(key)) {
        exterior.add(key); queue.push([nx, ny]);
      }
    }
  }
  return Array.from({ length: W * H }, (_, i) => {
    const x = i % W + 1, y = Math.floor(i / W) + 1;
    return measured(x, y) && queue.some(([sx, sy]) => Math.max(Math.abs(x - sx), Math.abs(y - sy)) <= width) ? 1 : 0;
  });
}

test('full rectangular acquisition uses its image border and defaults to exactly two pixels', () => {
  const s = solid(7, 7), r = unchanged(s, () => fromSection(s));
  assert.equal(r.status, 'available'); assert.equal(r.width, 7); assert.equal(r.height, 7);
  assert.equal(r.bandWidth, 2); assert.equal(r.measuredPixels, 49); assert.equal(r.hiddenPixels, 40);
  assert.equal(at(r, 2, 2), 0); assert.equal(at(r, 1, 3), 1);
  assert.equal(fromSection(s, 1).hiddenPixels, 24);
  assert.equal(fromSection(s, 0).hiddenPixels, 0);
  assert.equal(fromSection(s, 99).hiddenPixels, 49);
});

test('an enclosed missing hole is not an exterior seed or a hidden measured pixel', () => {
  const s = solid(9, 9); s.rasters.a.values[4 * 9 + 4] = NaN;
  const r = unchanged(s, () => fromSection(s, 2));
  assert.equal(r.measuredPixels, 80); assert.equal(r.hiddenPixels, 56);
  assert.equal(at(r, 4, 4), 0); assert.equal(at(r, 4, 3), 0); assert.equal(at(r, 3, 4), 0);
});

test('diagonal-only missing connections are not exterior, but four-connected openings are', () => {
  const s = solid(7, 7);
  for (let i = 0; i < 4; i++) s.rasters.a.values[i * 7 + i] = NaN;
  const diagonal = fromSection(s, 1);
  assert.equal(diagonal.hiddenPixels, 23); assert.equal(at(diagonal, 3, 4), 0);
  for (let i = 1; i <= 3; i++) s.rasters.a.values[i * 7 + i - 1] = NaN;
  const opened = fromSection(s, 1);
  assert.equal(at(opened, 3, 4), 1, 'external flood follows the opened four-neighbor channel');
});

test('concave and disconnected footprints match independently computed exterior distances', () => {
  for (const rows of [
    ['.......', '.#####.', '.#.....', '.####..', '....#..', '.......'],
    ['##.....', '###....', '..#..##', '.....##', '.......'],
    ['#########', '#.......#', '#.#####.#', '#.#####.#', '#.......#', '#########']
  ]) for (const width of [0, 1, 2, 3]) {
    assert.deepEqual(Array.from(fromSection(section(rows), width).hiddenMask), oracle(rows, width));
  }
});

test('finite raw union includes zero and negative values, independent of selected or normalized channels', () => {
  const s = solid(7, 7);
  s.rasters.a.values[3 * 7 + 3] = NaN;
  s.rasters.standard = { W: 7, H: 7, values: new Float64Array(49).fill(NaN) };
  s.rasters.standard.values[3 * 7 + 3] = 0;
  s.rasters.a.values[0] = -2;
  s.channels = { a: { normalized: new Float64Array(49).fill(NaN) } };
  s.project = { roi: { roi_items: {} } }; s.selectedChannels = []; s.threshold = 1000;
  const r = unchanged(s, () => fromSection(s, 2));
  assert.equal(r.measuredPixels, 49); assert.equal(r.hiddenPixels, 40);
  assert.equal(at(r, 3, 3), 0, 'zero-valued internal standard remains acquired');
  s.channels = {}; s.threshold = 0; s.project.roi.roi_items = { x: [[0, 0]] };
  assert.deepEqual(Array.from(fromSection(s, 2).hiddenMask), Array.from(r.hiddenMask));
});

test('infinite values are unmeasured and empty or thin acquisitions are supported', () => {
  const s = section(['....', '....']); s.rasters.a.values[0] = Infinity; s.rasters.a.values[1] = -Infinity;
  const empty = fromSection(s); assert.equal(empty.status, 'available');
  assert.equal(empty.measuredPixels, 0); assert.equal(empty.hiddenPixels, 0);
  for (const [W, H] of [[1, 1], [1, 8], [8, 1]]) {
    const r = fromSection(solid(W, H)); assert.equal(r.hiddenPixels, W * H);
  }
});

test('invalid dimensions, released sections and malformed contributors fail without a partial mask', () => {
  for (const s of [null, {}, { W: 0, H: 3 }, { W: 2.5, H: 3 }, { W: 16777217, H: 1 }])
    assert.equal(fromSection(s).reason, 'invalid-grid');
  const s = solid(3, 3); s.released = true; assert.equal(fromSection(s).reason, 'released-section');
  delete s.released; s.rasters.b = { W: 2, H: 3, values: new Float64Array(6) };
  let r = fromSection(s); assert.equal(r.reason, 'coordinate-mismatch'); assert.equal(r.hiddenMask.length, 0);
  s.rasters.b = { W: 3, H: 3, values: new Float64Array(8) };
  assert.equal(fromSection(s).reason, 'coordinate-mismatch');
  s.rasters = {}; assert.equal(fromSection(s).reason, 'missing-raw-rasters');
  for (const width of [-1, 0.5, NaN, Infinity, '2']) assert.equal(fromSection(solid(3, 3), width).reason, 'invalid-band-width');
});

test('unsupported value containers and nonnumeric entries invalidate the complete union', () => {
  const invalidValues = ['x'.repeat(49), { length: 49 }, new DataView(new ArrayBuffer(49 * 8)),
    new BigInt64Array(49), new BigUint64Array(49), new Array(49),
    Array(49).fill('1'), Array(49).fill(null), [...Array(48).fill(0), 1n]];
  for (const values of invalidValues) {
    const s = solid(7, 7); s.rasters.b = { W: 7, H: 7, values };
    const result = fromSection(s);
    assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'coordinate-mismatch');
    assert.equal(result.hiddenMask.length, 0, 'never show a partial union of the remaining valid raster');
  }
});

test('regular numeric arrays accept measured zero and missing NaN or infinite samples', () => {
  const s = solid(7, 7);
  s.rasters.a.values = Array.from(s.rasters.a.values);
  s.rasters.a.values[0] = 0; s.rasters.a.values[3 * 7 + 3] = NaN;
  s.rasters.a.values[2 * 7 + 3] = Infinity; s.rasters.a.values[4 * 7 + 3] = -Infinity;
  const result = fromSection(s, 2);
  assert.equal(result.status, 'available'); assert.equal(result.measuredPixels, 46);
  assert.equal(result.hiddenPixels, 40); assert.equal(at(result, 3, 3), 0);
});

test('width/height aliases are accepted only when they agree with W/H', () => {
  const s = solid(7, 7); s.width = 7; s.height = 7;
  assert.equal(fromSection(s).hiddenPixels, 40);
  delete s.W; delete s.H;
  assert.equal(fromSection(s).hiddenPixels, 40);
  s.W = 7; s.width = 8;
  assert.equal(fromSection(s).reason, 'coordinate-mismatch');
});

test('coordinate aliases, dimensions and fingerprints cannot silently create a partial union', () => {
  for (const bad of [{ xs: [10, 11, 12] }, { ys: [2, 1, 0] }, { coordinateFingerprint: 'other' },
    { xs: [0, 1] }, { ys: [0, NaN, 2] }, { W: 4 }]) {
    const s = solid(3, 3);
    s.project = { grid: { W: 3, H: 3, xs: [0, 1, 2], ys: [0, 1, 2], coordinateFingerprint: 'original' } };
    s.rasters.b = { W: 3, H: 3, values: new Float64Array(9), ...bad };
    assert.equal(fromSection(s).reason, 'coordinate-mismatch');
  }
  const s = solid(3, 3);
  s.project = { molecules: [{ key: 'a', grid: { xs: [0, 1, 2] } }] };
  s.rasters.a.xCoordinates = new Float64Array([0, 1, 2]);
  assert.equal(fromSection(s).status, 'available');
  s.rasters.a.xs = [2, 1, 0];
  assert.equal(fromSection(s).reason, 'coordinate-mismatch');
});

test('deterministic small masks agree with the independent padded-distance oracle', () => {
  let seed = 3721;
  for (let trial = 0; trial < 40; trial++) {
    const W = 3 + trial % 5, H = 3 + trial % 4;
    const rows = Array.from({ length: H }, () => Array.from({ length: W }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296 < 0.76 ? '#' : '.';
    }).join(''));
    for (const width of [1, 2, 3]) {
      const r = fromSection(section(rows), width), expected = oracle(rows, width);
      assert.deepEqual(Array.from(r.hiddenMask), expected, `mask ${trial}, width ${width}`);
      assert.equal(r.hiddenPixels, expected.reduce((n, v) => n + v, 0));
    }
  }
});
