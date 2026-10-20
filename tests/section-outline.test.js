'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = { Uint8Array }; context.window = context; vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/section-outline.js'), 'utf8'), context);
const outline = section => JSON.parse(JSON.stringify(context.Stack3DOutline.fromSection(section)));
function section(rows, value = 1) {
  const W = rows[0].length, H = rows.length;
  return { W, H, rasters: { a: { W, H, values: Float32Array.from(rows.join(''), v => v === '#' ? value : NaN) } } };
}
function area(points) {
  return points.reduce((sum, a, i) => {
    const b = points[(i + 1) % points.length];
    return sum + a[0] * b[1] - b[0] * a[1];
  }, 0) / 2;
}
function validate(result, W, H) {
  assert.equal(result.status, 'available');
  for (const points of result.contours) {
    assert.ok(points.length >= 4);
    assert.notDeepEqual(points[0], points.at(-1), 'loops are unclosed');
    assert.ok(area(points) > 0);
    for (let i = 0; i < points.length; i++) {
      const [x, y] = points[i], [nx, ny] = points[(i + 1) % points.length];
      assert.ok(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x <= W && y <= H);
      assert.ok((x === nx) !== (y === ny), 'exact horizontal/vertical pixel edges');
    }
  }
}
test('a nonconvex footprint retains its concavity with exact raw pixel-edge bounds', () => {
  const s = section(['#...', '#...', '###.', '....']), result = outline(s);
  validate(result, s.W, s.H);
  assert.equal(result.pixelCount, 5);
  assert.equal(result.source, 'measured-footprint');
  assert.equal(result.contours.length, 1);
  assert.equal(area(result.contours[0]), 5, 'no hull over the concavity');
  assert.deepEqual(result.contours[0], [[0, 0], [1, 0], [1, 2], [3, 2], [3, 3], [0, 3]]);
});
test('interior holes are omitted from lines but raw samples and footprint count are unchanged', () => {
  const s = section(['.....', '.###.', '.#.#.', '.###.', '.....']);
  const before = Buffer.from(s.rasters.a.values.buffer).toString('hex'), result = outline(s);
  validate(result, s.W, s.H);
  assert.equal(result.contours.length, 1);
  assert.equal(result.pixelCount, 8);
  assert.equal(area(result.contours[0]), 9);
  assert.equal(Buffer.from(s.rasters.a.values.buffer).toString('hex'), before);
});
test('disconnected and diagonal-touching components are all retained without joining gaps', () => {
  const s = section(['#....#.', '.#...#.', '.......']), result = outline(s);
  validate(result, s.W, s.H);
  assert.equal(result.contours.length, 3);
  assert.deepEqual(result.contours.map(area), [1, 2, 1]);
  assert.equal(result.pixelCount, 4);
});
test('finite raw union includes measured zero, negative values and an unselected labelled channel', () => {
  const s = section(['#..', '...', '...'], 0);
  s.rasters.b = { W: 3, H: 3, values: Float64Array.from([NaN, -2, Infinity, NaN, NaN, NaN, -Infinity, NaN, NaN]) };
  s.rasters.standard = { W: 3, H: 3, values: Float32Array.from([NaN, NaN, NaN, 0, NaN, NaN, NaN, NaN, NaN]) };
  s.channels = { a: { raw: s.rasters.a.values, normalized: new Float32Array(9).fill(NaN) } };
  const first = outline(s);
  validate(first, s.W, s.H);
  assert.equal(first.pixelCount, 3);
  assert.equal(area(first.contours[0]), 3);
  s.channels = {};
  s.selectedChannels = []; s.mode = 'normalized'; s.threshold = 1000;
  s.project = { roi: { roi_items: {} }, visibleLayers: [], otsu: { applied: true, manualThreshold: 99 } };
  assert.deepEqual(outline(s), first, 'display state must not change acquired coverage');
});
test('same-sized shifted or reversed coordinates invalidate the complete footprint instead of showing a partial union', () => {
  for (const bad of [{ xs: [10, 11, 12] }, { ys: [2, 1, 0] }, { coordinateFingerprint: 'other-grid' }]) {
    const s = section(['#..', '...', '...']);
    s.project = { grid: { W: 3, H: 3, xs: [0, 1, 2], ys: [0, 1, 2], coordinateFingerprint: 'raw-grid' } };
    s.rasters.b = { W: 3, H: 3, values: Float32Array.from([NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, 1]), ...bad };
    const result = outline(s);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'coordinate-mismatch');
    assert.deepEqual(result.contours, []);
  }
});
test('matching coordinate aliases and typed arrays agree without inventing metadata on legacy channels', () => {
  const s = section(['#..', '...', '...']);
  const original = outline(s);
  s.project = { grid: { W: 3, H: 3, xCoordinates: new Float64Array([100, 150, 200]), ys: [4, 3, 2] },
    molecules: [{ key: 'a', grid: { xs: [100, 150, 200], yCoordinates: new Float32Array([4, 3, 2]) } }] };
  s.rasters.a.xs = new Float32Array([100, 150, 200]);
  s.rasters.a.yCoordinates = [4, 3, 2];
  s.rasters.b = { W: 3, H: 3, values: new Float32Array(9).fill(NaN) };
  assert.deepEqual(outline(s), original);
  assert.equal(s.rasters.b.xs, undefined, 'no inferred calibration is written');
  assert.equal(s.project.grid.umPerPxX, undefined);
});
test('contributors must agree with each other and with molecular definitions when section coordinates are absent', () => {
  const s = section(['#..', '...', '...']);
  s.rasters.a.xs = [0, 1, 2];
  s.rasters.b = { W: 3, H: 3, xCoordinates: [3, 4, 5], values: new Float32Array(9).fill(NaN) };
  assert.equal(outline(s).reason, 'coordinate-mismatch');
  delete s.rasters.b;
  s.project = { molecules: [{ key: 'a', grid: { xs: [10, 11, 12] } }] };
  assert.equal(outline(s).reason, 'coordinate-mismatch');
  s.project.molecules[0].grid = { W: 4, H: 3 };
  assert.equal(outline(s).reason, 'coordinate-mismatch');
});
test('conflicting aliases, malformed coordinate arrays and explicit fingerprints are not silently accepted', () => {
  const s = section(['#..', '...', '...']);
  s.rasters.a.xs = [0, 1, 2]; s.rasters.a.xCoordinates = [2, 1, 0];
  assert.equal(outline(s).reason, 'coordinate-mismatch');
  delete s.rasters.a.xCoordinates;
  s.rasters.a.ys = new Float64Array([0, 1]);
  assert.equal(outline(s).reason, 'coordinate-mismatch');
  s.rasters.a.ys = [0, NaN, 2];
  assert.equal(outline(s).reason, 'coordinate-mismatch');
  delete s.rasters.a.ys;
  s.project = { molecules: [{ key: 'a', grid: { coordinateFingerprint: 'A' } }] };
  s.rasters.a.coordinateFingerprint = 'B';
  assert.equal(outline(s).reason, 'coordinate-mismatch');
  s.rasters.a.coordinateFingerprint = 'A';
  assert.equal(outline(s).status, 'available');
});
test('empty, absent, wrong-sized, released and unsegmented full-grid rasters have honest unavailable reasons', () => {
  assert.equal(outline(section(['..', '..'])).reason, 'no-measured-pixels');
  assert.equal(outline({ W: 2, H: 2, rasters: {} }).reason, 'missing-raw-rasters');
  assert.equal(outline({ W: 2, H: 2, rasters: { a: { W: 1, H: 4, values: new Float32Array(4) } } }).reason, 'missing-raw-rasters');
  assert.equal(outline({ W: 2, H: 2, rasters: { a: { W: 2, H: 2, values: new Float32Array(3) } } }).reason, 'missing-raw-rasters');
  assert.equal(outline({ ...section(['#.', '..']), released: true }).reason, 'released-section');
  assert.equal(outline({ W: 0, H: 2 }).reason, 'invalid-grid');
  assert.equal(outline({ W: 1.5, H: 2 }).reason, 'invalid-grid');
  assert.equal(outline({ W: 16777217, H: 1 }).reason, 'invalid-grid');
  assert.deepEqual(outline(section(['##', '##'], 0)), {
    status: 'unavailable', contours: [], source: 'measured-footprint', reason: 'full-grid-coverage', pixelCount: 4,
  });
});
test('boundaries at the final row and column use W and H, with no half-pixel shift or padding offset', () => {
  const s = section(['...', '..#']), result = outline(s);
  validate(result, 3, 2);
  assert.deepEqual(result.contours, [[[2, 1], [3, 1], [3, 2], [2, 2]]]);
});
test('recomputation observes modified raw support instead of reusing a stale cache', () => {
  const s = section(['#..', '...', '...']), first = outline(s);
  s.rasters.a.values[8] = 0;
  const next = outline(s);
  assert.equal(first.pixelCount, 1);
  assert.equal(next.pixelCount, 2);
  assert.equal(next.contours.length, 2);
  next.contours[0][0][0] = 1000;
  assert.notEqual(outline(s).contours[0][0][0], 1000, 'results own their coordinates');
});
test('an island inside an acquisition hole remains a separate component while the hole line is omitted', () => {
  const s = section(['.......', '.#####.', '.#...#.', '.#.#.#.', '.#...#.', '.#####.', '.......']);
  const result = outline(s);
  validate(result, s.W, s.H);
  assert.equal(result.contours.length, 2);
  assert.deepEqual(result.contours.map(area), [25, 1]);
  assert.equal(result.pixelCount, 17);
});
test('every nontrivial 3 by 3 footprint closes valid exterior loops without altering input', () => {
  for (let code = 1; code < 511; code++) {
    const rows = Array.from({ length: 3 }, (_, y) => Array.from({ length: 3 }, (_, x) => code & (1 << (y * 3 + x)) ? '#' : '.').join(''));
    const s = section(rows), result = outline(s);
    validate(result, 3, 3);
    assert.equal(result.pixelCount, rows.join('').replaceAll('.', '').length);
    assert.ok(result.contours.reduce((sum, p) => sum + area(p), 0) >= result.pixelCount);
  }
});
test('excessively fragmented grids stop before allocating unbounded boundary geometry', () => {
  const W = 400, H = 400, values = new Float32Array(W * H);
  for (let i = 0; i < values.length; i++) values[i] = (i % W + Math.floor(i / W)) % 2 ? 0 : NaN;
  const result = outline({ W, H, rasters: { a: { W, H, values } } });
  assert.equal(result.reason, 'boundary-too-complex');
  assert.equal(result.pixelCount, W * H / 2);
  assert.deepEqual(result.contours, []);
});
