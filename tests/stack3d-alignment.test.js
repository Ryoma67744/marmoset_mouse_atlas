'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function app() {
  const c = { console, Uint8Array }; c.window = c; vm.createContext(c);
  for (const name of ['msi.js', 'section-display.js', 'stack3d.js', 'stack3d-alignment.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', name), 'utf8'), c, { filename: name });
  return c;
}
const plain = value => JSON.parse(JSON.stringify(value));
const near = (actual, expected, eps = 1e-10) => assert.ok(Math.abs(actual - expected) < eps, `${actual} should equal ${expected}`);
function rectangle(x0, y0, x1 = x0, y1 = y0) {
  return { poly_msi: [[x0 - 0.4, y0 - 0.4], [x1 + 0.4, y0 - 0.4], [x1 + 0.4, y1 + 0.4], [x0 - 0.4, y1 + 0.4]] };
}
function section(c, overrides = {}) {
  const project = { grid: { W: 14, H: 14, umPerPxX: 100, umPerPxY: 230 },
    rotation: { all: 217, msi: 11 }, stack3d: { offsetXUm: 570, offsetYUm: -420, rotationDeg: 14 },
    roi: { roi_names: { a: 'A', b: 'B', c: 'C' }, roi_show_flags: {},
      roi_items: { a: [rectangle(2, 2)], b: [rectangle(9, 3)], c: [rectangle(4, 10)] } } };
  return { project, ...c.Stack3D.geometry(project), ...overrides };
}
function world(d, x, y) {
  const localX = (x + 0.5 - d.W / 2) * d.umPerPxX / 1000;
  const localY = -(y + 0.5 - d.H / 2) * d.umPerPxY / 1000;
  const angle = -(d.angleDeg + d.rotationDeg) * Math.PI / 180;
  return [Math.cos(angle) * localX - Math.sin(angle) * localY + d.offsetXUm / 1000,
    Math.sin(angle) * localX + Math.cos(angle) * localY - d.offsetYUm / 1000];
}
function deepFreeze(object) {
  if (object && typeof object === 'object' && !Object.isFrozen(object)) {
    for (const value of Object.values(object)) deepFreeze(value);
    Object.freeze(object);
  }
  return object;
}

test('neighbor ROI fitting recovers a known rigid transform with anisotropic pitch and saved placement', () => {
  const c = app(), current = section(c), theta = 23 * Math.PI / 180, tx = 0.31, ty = -0.42;
  const oldCenter = [current.offsetXUm / 1000, -current.offsetYUm / 1000];
  const center = [Math.cos(theta) * oldCenter[0] - Math.sin(theta) * oldCenter[1] + tx,
    Math.sin(theta) * oldCenter[0] + Math.cos(theta) * oldCenter[1] + ty];
  const targetPlacement = { offsetXUm: center[0] * 1000, offsetYUm: -center[1] * 1000, rotationDeg: current.rotationDeg - 23 };
  const previous = section(c, targetPlacement), next = section(c, targetPlacement);
  // A genuine linear neighbor trend must cancel in the target midpoint.
  previous.offsetXUm -= 80; previous.offsetYUm -= 30;
  next.offsetXUm += 80; next.offsetYUm += 30;
  const description = c.Stack3DAlignment.describe(previous, current, next);
  assert.equal(description.available, true);
  for (const [name, x, y] of [['A', 2, 2], ['B', 9, 3], ['C', 4, 10]]) {
    const row = description.rows.find(row => row.name === name), expected = world(current, x, y);
    row.current.forEach((value, i) => near(value, expected[i]));
  }
  const fit = c.Stack3DAlignment.fit(current, description.rows, ['A', 'B', 'C']);
  assert.equal(fit.roiCount, 3);
  for (const key of Object.keys(targetPlacement)) near(fit.placement[key], targetPlacement[key]);
  near(fit.angleDeltaDeg, -23); near(fit.rmsAfterMm, 0); assert.ok(fit.rmsBeforeMm > 0.3);
  fit.translationMm.forEach((value, axis) => near(value, center[axis] - oldCenter[axis]));
  const applied = { ...current, ...fit.placement };
  for (const [name, x, y] of [['A', 2, 2], ['B', 9, 3], ['C', 4, 10]]) {
    const expected = description.rows.find(row => row.name === name).target;
    world(applied, x, y).forEach((value, i) => near(value, expected[i]));
  }
});

test('identity candidates preserve immutable inputs and never inspect MSI values or display state', () => {
  const c = app(), current = section(c), before = plain(current);
  Object.defineProperty(current, 'channels', { get() { throw new Error('MSI values must not be read'); } });
  deepFreeze(current);
  const description = c.Stack3DAlignment.describe(current, current, current);
  deepFreeze(description);
  const fit = c.Stack3DAlignment.fit(current, description.rows, new Set(['A', 'B', 'C']));
  near(fit.rmsBeforeMm, 0); near(fit.rmsAfterMm, 0); near(fit.angleDeltaDeg, 0);
  for (const key of ['offsetXUm', 'offsetYUm', 'rotationDeg']) near(fit.placement[key], current[key]);
  assert.deepEqual(plain(current), before);
  fit.rows[0].current[0] += 1;
  assert.notEqual(fit.rows[0].current[0], description.rows[0].current[0], 'returned coordinates are separate arrays');
});

test('duplicate exact names union visible masks without double counting and use rendered pixel centers', () => {
  const c = app(), d = section(c, { angleDeg: 0, rotationDeg: 0, offsetXUm: 0, offsetYUm: 0 });
  d.project.roi.roi_names = { a: ' e\u0301 ', b: 'é', hidden: 'é' };
  d.project.roi.roi_items = { a: [rectangle(1, 2, 2, 2)], b: [rectangle(2, 2, 3, 2)], hidden: [rectangle(11, 11)] };
  d.project.roi.roi_show_flags.hidden = false;
  const result = c.Stack3DAlignment.describe(d, d, d);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].name, 'é');
  const expected = world(d, 2, 2);
  result.rows[0].current.forEach((value, i) => near(value, expected[i]));
  assert.equal(result.rows[0].areaRatio, 1); assert.equal(result.rows[0].edge, false);
  assert.equal(result.rows[0].defaultSelected, true);
});

test('matching requires visible exact names in all three sections and endpoints are unavailable', () => {
  const c = app(), previous = section(c), current = section(c), next = section(c);
  previous.project.roi.roi_show_flags.a = false;
  next.project.roi.roi_names.b = 'b';
  next.project.roi.roi_items.c = [];
  const result = c.Stack3DAlignment.describe(previous, current, next);
  assert.equal(result.available, false); assert.equal(result.rows.length, 0);
  assert.match(result.reason, /3領域未満/);
  for (const args of [[null, current, next], [previous, current, null]]) {
    const endpoint = c.Stack3DAlignment.describe(...args);
    assert.equal(endpoint.available, false); assert.match(endpoint.reason, /前後両方/);
  }
});

test('area variation and clipped edge masks remain inspectable but are unchecked by default', () => {
  const c = app(), previous = section(c), current = section(c), next = section(c);
  current.project.roi.roi_items.a = [rectangle(1, 1, 3, 3)];
  next.project.roi.roi_items.b = [rectangle(13, 3)];
  const result = c.Stack3DAlignment.describe(previous, current, next);
  assert.equal(result.available, true); assert.equal(result.rows.length, 3);
  const a = result.rows.find(row => row.name === 'A'), b = result.rows.find(row => row.name === 'B');
  near(a.areaRatio, 9); assert.equal(a.defaultSelected, false); assert.equal(a.edge, false);
  assert.equal(b.edge, true); assert.equal(b.defaultSelected, false);
  assert.equal(result.rows.find(row => row.name === 'C').defaultSelected, true);
  assert.equal(result.warnings.length, 2);
  // Same raster counts do not imply the same physical ROI area.
  current.project.roi.roi_items.a = [rectangle(2, 2)]; current.umPerPxX *= 3;
  near(c.Stack3DAlignment.describe(previous, current, next).rows.find(row => row.name === 'A').areaRatio, 3);
});

test('ROI membership follows the existing integer-coordinate mask even for subpixel boundaries', () => {
  const c = app(), d = section(c);
  d.project.roi.roi_items.a = [{ poly_msi: [[1.1, 1.1], [2.1, 1.1], [2.1, 2.1], [1.1, 2.1]] }];
  const row = c.Stack3DAlignment.describe(d, d, d).rows.find(row => row.name === 'A');
  const expected = world(d, 2, 2); // Membership at integer (2,2), rendered center (2.5,2.5).
  row.current.forEach((value, i) => near(value, expected[i]));
  d.project.roi.roi_items.a.push({ poly_msi: [[1, 1], [NaN, 3], [2, 4]] });
  assert.deepEqual(plain(c.Stack3DAlignment.describe(d, d, d).rows.find(row => row.name === 'A')), plain(row));
});

test('candidate fit rejects insufficient names, collapsed geometry and indeterminate covariance', () => {
  const c = app(), d = section(c), description = c.Stack3DAlignment.describe(d, d, d);
  assert.throws(() => c.Stack3DAlignment.fit(d, description.rows, ['A', 'A', 'B']), /3領域以上/);
  assert.throws(() => c.Stack3DAlignment.fit(d, [...description.rows, description.rows[0]], ['A', 'B', 'C']), /重複/);
  const names = ['A', 'B', 'C'];
  for (const collapse of ['current', 'target']) {
    const rows = plain(description.rows); rows.forEach(row => { row[collapse] = [1, 1]; });
    assert.throws(() => c.Stack3DAlignment.fit(d, rows, names), /安定して計算できません/);
  }
  const rows = [[1, 0], [0, 1], [-1, 0], [0, -1]].map((point, i) => ({ name: String(i), current: point, target: [-point[0], point[1]] }));
  assert.throws(() => c.Stack3DAlignment.fit(d, rows, rows.map(row => row.name)), /安定して計算できません/);
  const invalid = plain(description.rows); invalid[0].target[0] = Infinity;
  assert.throws(() => c.Stack3DAlignment.fit(d, invalid, names), /座標が不正/);
});

test('proper rigid fit preserves pair distances and signed area for scale and reflection targets', () => {
  const c = app(), d = section(c), source = [[0, 0], [3, 0], [0, 1]];
  const signedArea = points => (points[1][0] - points[0][0]) * (points[2][1] - points[0][1]) -
    (points[1][1] - points[0][1]) * (points[2][0] - points[0][0]);
  for (const transform of [point => point.map(value => value * 2), point => [-point[0], point[1]]]) {
    const rows = source.map((point, i) => ({ name: String(i), current: point.slice(), target: transform(point) }));
    const fit = c.Stack3DAlignment.fit(d, rows, rows.map(row => row.name));
    assert.ok(fit.rmsAfterMm > 0.1, 'non-rigid target must retain residual mismatch');
    assert.ok(fit.rmsAfterMm <= fit.rmsBeforeMm + 1e-12);
    const fitted = fit.rows.map(row => row.fitted);
    near(signedArea(fitted), signedArea(source));
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++)
      near(Math.hypot(fitted[i][0] - fitted[j][0], fitted[i][1] - fitted[j][1]),
        Math.hypot(source[i][0] - source[j][0], source[i][1] - source[j][1]));
  }
});

test('each ROI receives one equal weight regardless of area and unchecked names are excluded', () => {
  const c = app(), d = section(c), rows = [
    { name: 'A', current: [0, 0], target: [2, 0], areaRatio: 100 },
    { name: 'B', current: [2, 0], target: [2, 0], areaRatio: 1 },
    { name: 'C', current: [1, 1], target: [1, 1], areaRatio: 1 },
    { name: 'excluded', current: [100, 100], target: [-100, -100] }
  ];
  const fit = c.Stack3DAlignment.fit(d, rows, ['A', 'B', 'C']);
  assert.equal(fit.roiCount, 3);
  const meanFitted = [0, 1].map(axis => fit.rows.reduce((sum, row) => sum + row.fitted[axis] / 3, 0));
  near(meanFitted[0], 5 / 3); near(meanFitted[1], 1 / 3);
});

test('invalid geometry produces an inspectable unavailable result without calculating a candidate', () => {
  const c = app(), d = section(c), bad = { ...d, umPerPxX: 0 };
  const result = c.Stack3DAlignment.describe(d, bad, d);
  assert.equal(result.available, false); assert.match(result.reason, /画素サイズ/);
  assert.throws(() => c.Stack3DAlignment.fit(bad, [], []), /画素サイズ/);
});
