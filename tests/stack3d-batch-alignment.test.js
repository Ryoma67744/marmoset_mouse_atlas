'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function app() {
  const c = { console, Uint8Array, setTimeout }; c.window = c; vm.createContext(c);
  for (const name of ['msi.js', 'section-display.js', 'stack3d.js', 'stack3d-alignment.js', 'stack3d-batch-alignment.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', name), 'utf8'), c, { filename: name });
  return c;
}
const plain = value => JSON.parse(JSON.stringify(value));
const near = (actual, expected, eps = 1e-7) => assert.ok(Math.abs(actual - expected) < eps, `${actual} should equal ${expected}`);
function rectangle(x, y) {
  return { poly_msi: [[x - 0.4, y - 0.4], [x + 0.4, y - 0.4], [x + 0.4, y + 0.4], [x - 0.4, y + 0.4]] };
}
function section(c, index, placement = {}) {
  const project = { id: `id-${index}`, name: `Cor_1_${index + 1}`, grid: { W: 14, H: 14, umPerPxX: 100, umPerPxY: 230 },
    rotation: { all: 217, msi: 11 }, stack3d: { offsetXUm: 0, offsetYUm: 0, rotationDeg: 14, ...placement },
    normalization: { method: 'd4', coefficient: 1.27 }, molecules: { DA: { values: [1, 2, 8, 0] } },
    roi: { roi_names: { a: 'A', b: 'B', c: 'C' }, roi_show_flags: {},
      roi_items: { a: [rectangle(2, 2)], b: [rectangle(9, 3)], c: [rectangle(4, 10)] } } };
  return { id: project.id, name: project.name, project, ...c.Stack3D.geometry(project) };
}
function deepFreeze(object) {
  if (object && typeof object === 'object' && !Object.isFrozen(object)) {
    for (const value of Object.values(object)) deepFreeze(value); Object.freeze(object);
  }
  return object;
}

test('joint proposals reduce alternating jitter without adding translation or ordinal linear drift', async () => {
  const c = app(), sections = Array.from({ length: 9 }, (_, i) => section(c, i, {
    offsetXUm: 100 * i, offsetYUm: 40 * i + (i % 2 ? 1000 : -1000)
  }));
  const result = await c.Stack3DBatchAlignment.solve(sections);
  assert.equal(result.available, true); assert.equal(result.converged, true); assert.equal(result.lambda, 1);
  assert.equal(result.tripletCount, 7); assert.equal(result.roiCount, 21);
  assert.ok(result.rmsAfterMm < result.rmsBeforeMm * 0.35);
  assert.ok(result.rows.every(row => row.status === 'adjusted'));
  const dx = result.rows.map((row, i) => row.placement.offsetXUm - sections[i].offsetXUm);
  const dy = result.rows.map((row, i) => row.placement.offsetYUm - sections[i].offsetYUm);
  near(dx.reduce((a, b) => a + b, 0), 0, 1e-5); near(dy.reduce((a, b) => a + b, 0), 0, 1e-5);
  near(dx.reduce((a, b, i) => a + i * b, 0), 0, 1e-5); near(dy.reduce((a, b, i) => a + i * b, 0), 0, 1e-5);
  result.rows.forEach(row => { assert.equal(row.roiCount, 3); near(row.placement.rotationDeg, 14); });
});

test('already aligned and linearly varying ROI trajectories retain exact original placements', async () => {
  const c = app();
  for (const slope of [0, 137]) {
    const sections = Array.from({ length: 6 }, (_, i) => section(c, i, { offsetXUm: 570 + i * slope, offsetYUm: -420 - i * slope / 2 }));
    const result = await c.Stack3DBatchAlignment.solve(sections);
    assert.equal(result.available, true); near(result.rmsBeforeMm, 0); near(result.rmsAfterMm, 0);
    result.rows.forEach((row, i) => { assert.equal(row.status, 'unchanged'); assert.deepEqual(plain(row.placement), plain(sections[i].project.stack3d)); });
  }
});

test('end sections join the simultaneous solve only through a supported complete triple', async () => {
  const c = app(), sections = [section(c, 0), section(c, 1, { offsetYUm: 1000 }), section(c, 2)];
  const result = await c.Stack3DBatchAlignment.solve(sections);
  assert.equal(result.available, true); assert.equal(result.tripletCount, 1);
  assert.ok(result.rows.every(row => row.status === 'adjusted'));
  near(result.rows[0].placement.offsetYUm, 200, 1e-5);
  near(result.rows[1].placement.offsetYUm, 600, 1e-5);
  near(result.rows[2].placement.offsetYUm, 200, 1e-5);
  assert.equal((await c.Stack3DBatchAlignment.solve(sections.slice(0, 2))).available, false);
});

test('unsupported slices stay unchanged and do not bridge independent supported blocks', async () => {
  const c = app(), sections = Array.from({ length: 7 }, (_, i) => section(c, i, {
    offsetXUm: i < 3 ? 0 : 10000, offsetYUm: i === 1 || i === 5 ? 800 : 0
  }));
  sections[3].project.roi.roi_show_flags = { a: false, b: false, c: false };
  const result = await c.Stack3DBatchAlignment.solve(sections);
  assert.equal(result.available, true); assert.equal(result.tripletCount, 2);
  assert.equal(result.rows[3].status, 'unsupported'); assert.equal(result.rows[3].rmsAfterMm, null);
  assert.deepEqual(plain(result.rows[3].placement), plain(sections[3].project.stack3d));
  for (const start of [0, 4]) {
    const separate = await c.Stack3DBatchAlignment.solve(sections.slice(start, start + 3));
    separate.rows.forEach((row, i) => Object.keys(row.placement).forEach(key => near(row.placement[key], result.rows[start + i].placement[key])));
  }
});

test('rotation candidates preserve anisotropic physical distances, handedness and nonzero base placement', async () => {
  const c = app(), sections = Array.from({ length: 7 }, (_, i) => section(c, i, {
    offsetXUm: 700 + 10 * i, offsetYUm: -320 + 20 * i, rotationDeg: 14 + (i % 2 ? 12 : -12)
  }));
  const result = await c.Stack3DBatchAlignment.solve(sections);
  assert.equal(result.available, true); assert.ok(result.rmsAfterMm < result.rmsBeforeMm * 0.5);
  const area = p => (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0]);
  result.rows.forEach((row, i) => {
    const before = Array.from(c.Stack3DAlignment.centroids(sections[i]).values(), value => value.point);
    const after = Array.from(c.Stack3DAlignment.centroids({ ...sections[i], ...row.placement }).values(), value => value.point);
    near(area(before), area(after));
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++)
        near(Math.hypot(before[a][0] - before[b][0], before[a][1] - before[b][1]), Math.hypot(after[a][0] - after[b][0], after[a][1] - after[b][1]));
  });
  // Independently rebuild centroids using the saved renderer convention. This
  // detects wrong Y/rotation signs even if the optimizer's own RMS decreases.
  const fitted = result.rows.map((row, i) => c.Stack3DAlignment.centroids({ ...sections[i], ...row.placement }));
  let squared = 0;
  for (let i = 1; i < sections.length - 1; i++) {
    let local = 0;
    for (const name of ['A', 'B', 'C']) {
      const p = fitted[i - 1].get(name).point, q = fitted[i].get(name).point, r = fitted[i + 1].get(name).point;
      local += (q[0] - (p[0] + r[0]) / 2) ** 2 + (q[1] - (p[1] + r[1]) / 2) ** 2;
    }
    squared += local / 3;
  }
  near(Math.sqrt(squared / (sections.length - 2)), result.rmsAfterMm);
});

test('a common world translation or rotation does not change the relative correction proposal', async () => {
  const c = app(), sections = Array.from({ length: 5 }, (_, i) => section(c, i, {
    offsetXUm: 200 * i, offsetYUm: i % 2 ? 800 : -500, rotationDeg: 14 + (i % 2 ? 10 : -10)
  }));
  const theta = 37 * Math.PI / 180, co = Math.cos(theta), si = Math.sin(theta), tx = 5700, ty = -3200;
  const transform = p => ({ offsetXUm: co * p.offsetXUm + si * p.offsetYUm + tx,
    offsetYUm: -si * p.offsetXUm + co * p.offsetYUm - ty, rotationDeg: p.rotationDeg - 37 });
  const transformed = sections.map(d => ({ ...d, ...transform(d) }));
  const original = await c.Stack3DBatchAlignment.solve(sections), moved = await c.Stack3DBatchAlignment.solve(transformed);
  assert.equal(original.available, true); assert.equal(moved.available, true); near(original.rmsAfterMm, moved.rmsAfterMm);
  original.rows.forEach((row, i) => Object.entries(transform(row.placement)).forEach(([key, value]) => near(moved.rows[i].placement[key], value, 1e-4)));
});

test('masked edges, large area changes and nonmatching names cannot generate a batch proposal', async () => {
  const c = app();
  for (const kind of ['edge', 'area', 'hidden', 'name']) {
    const sections = Array.from({ length: 3 }, (_, i) => section(c, i));
    if (kind === 'edge') sections[1].project.roi.roi_items.a = [rectangle(0, 2)];
    if (kind === 'area') sections[1].project.roi.roi_items.a = [{ poly_msi: [[0.6, 0.6], [3.4, 0.6], [3.4, 3.4], [0.6, 3.4]] }];
    if (kind === 'hidden') sections[1].project.roi.roi_show_flags.a = false;
    if (kind === 'name') sections[1].project.roi.roi_names.a = 'different';
    const result = await c.Stack3DBatchAlignment.solve(sections);
    assert.equal(result.available, false, kind); assert.ok(result.rows.every(row => row.status === 'unsupported'));
  }
});

test('three coincident ROI centroids do not supply rotational evidence', async () => {
  const c = app(), sections = Array.from({ length: 3 }, (_, i) => section(c, i));
  sections.forEach(d => { d.project.roi.roi_items.b = [rectangle(2, 2)]; d.project.roi.roi_items.c = [rectangle(2, 2)]; });
  const result = await c.Stack3DBatchAlignment.solve(sections);
  assert.equal(result.available, false); assert.match(result.warnings.join(' '), /広がりが不足/);
});

test('proposals do not mutate immutable projects, measurement arrays, D4 normalization or geometry', async () => {
  const c = app(), sections = Array.from({ length: 5 }, (_, i) => section(c, i, { offsetYUm: i === 2 ? 900 : 0 }));
  const before = plain(sections); deepFreeze(sections);
  const result = await c.Stack3DBatchAlignment.solve(sections);
  assert.equal(result.available, true); assert.deepEqual(plain(sections), before);
  result.rows[0].placement.offsetXUm += 5000;
  assert.deepEqual(plain(sections), before);
});

test('batch work yields progress and honors cancellation during centroid calculation and fitting', async () => {
  const c = app(), sections = Array.from({ length: 7 }, (_, i) => section(c, i, { offsetYUm: i % 2 ? 800 : -800 }));
  for (const phase of ['centroids', 'fit']) {
    let stop = false, callbacks = 0;
    await assert.rejects(c.Stack3DBatchAlignment.solve(sections, {
      onProgress: p => { callbacks++; if (p.phase === phase) stop = true; }, isCancelled: () => stop
    }), error => error.name === 'AbortError');
    assert.ok(callbacks > 0);
  }
});

test('invalid IDs and nonfinite placements reject without modifying input or producing candidates', async () => {
  const c = app(), d = section(c, 0);
  await assert.rejects(c.Stack3DBatchAlignment.solve([d, d, d]), /不正・重複/);
  const invalid = section(c, 1); invalid.offsetYUm = Infinity;
  await assert.rejects(c.Stack3DBatchAlignment.solve([d, invalid, section(c, 2)]), /不正・重複/);
});
