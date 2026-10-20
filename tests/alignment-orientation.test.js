'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = { window: {} };
for (const file of ['align.js', 'alignment-orientation.js']) {
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), context);
}
const A = context.window.Align, O = context.window.AlignmentOrientation;
const plain = value => JSON.parse(JSON.stringify(value));
function near(a, b, e = 1e-9) { assert.ok(Math.abs(a - b) <= e, `${a} != ${b}`); }
function nearMatrix(a, b, e = 1e-9) { a.forEach((r, i) => r.forEach((v, j) => near(v, b[i][j], e))); }
const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const points = [[10.5, 10.5], [90.5, 12.5], [89.5, 65.5], [15.5, 66.5], [42.5, 37.5]];
function frames(overrides = {}) {
  return O.createFrame({ heWidth: 100, heHeight: 80, msiWidth: 100, msiHeight: 80, ...overrides });
}
function fitMatrix(degrees = 0, scale = 1, tx = 3, ty = -2) {
  const a = degrees * Math.PI / 180;
  return [[scale * Math.cos(a), -scale * Math.sin(a), tx],
    [scale * Math.sin(a), scale * Math.cos(a), ty], [0, 0, 1]];
}
function landmarks(T, source = points) {
  return { he: source.map(p => p.slice()), msi: source.map(p => O.apply(T, ...p)) };
}
function mask(w = 100, h = 80, predicate = (x, y) =>
  ((x - 43) ** 2 / 32 ** 2 + (y - 37) ** 2 / 26 ** 2 < 1) && !(x > 48 && y < 29)) {
  const values = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) values[y * w + x] = +predicate(x + 0.5, y + 0.5);
  return { mask: values, w, h, sx: 1, sy: 1 };
}
function warped(source, T, w = source.w, h = source.h) {
  const inverse = O.invert(T);
  return mask(w, h, (x, y) => {
    const p = O.apply(inverse, x, y), i = Math.floor(p[0]), j = Math.floor(p[1]);
    return i >= 0 && j >= 0 && i < source.w && j < source.h && source.mask[j * source.w + i];
  });
}

test('all eight manually chosen directions preserve rectangular image bounds and raw points', () => {
  const originals = frames();
  const unique = new Set();
  for (const mirrored of [false, true]) for (let turns = 0; turns < 4; turns++) {
    let he = originals.he;
    if (mirrored) he = O.orient(he, 'mirror-x');
    for (let k = 0; k < turns; k++) he = O.orient(he, 'rotate-right');
    unique.add(JSON.stringify(he.matrix));
    near(he.width, turns % 2 ? 80 : 100); near(he.height, turns % 2 ? 100 : 80);
    const centre = O.fromRaw(he, [50, 40]);
    near(centre[0], he.width / 2); near(centre[1], he.height / 2);
    for (const point of [[0, 0], [100, 80], ...points]) {
      const restored = O.toRaw(he, O.fromRaw(he, point));
      near(restored[0], point[0]); near(restored[1], point[1]);
    }
  }
  assert.equal(unique.size, 8);
  nearMatrix(originals.he.matrix, identity);
  nearMatrix(O.orient(O.orient(originals.he, 'mirror-y'), 'mirror-y').matrix, identity);
});

test('arbitrary rotations use raw corners, avoid repeated blank padding and preserve pixel centres', () => {
  const base = frames().he;
  const rotated = O.orient(base, { type: 'rotate', degrees: 27 });
  const restored = O.orient(rotated, { type: 'rotate', degrees: -27 });
  near(restored.width, 100); near(restored.height, 80); nearMatrix(restored.matrix, identity);
  const flipped = O.orient(base, 'mirror-x');
  assert.deepEqual(plain(O.fromRaw(flipped, [0.5, 0.5])), [99.5, 0.5]);
  assert.deepEqual(plain(O.fromRaw(flipped, [99.5, 79.5])), [0.5, 79.5]);
  assert.throws(() => O.orient(base, { type: 'rotate', degrees: NaN }), /角度/);
});

test('physical frames use each pitch axis, never an average or one-sided guessed pitch', () => {
  const f = frames({ hePitch: { x: 2, y: 3 }, msiPitch: { x: 10, y: 20 } });
  assert.equal(f.physical, true); near(f.unitPitch, 10);
  nearMatrix(f.he.matrix, [[0.2, 0, 0], [0, 0.3, 0], [0, 0, 1]]);
  nearMatrix(f.msi.matrix, [[1, 0, 0], [0, 2, 0], [0, 0, 1]]);
  const T = O.toCanonical(identity, f);
  nearMatrix(T, [[0.2, 0, 0], [0, 0.15, 0], [0, 0, 1]]);
  for (const partial of [
    { hePitch: { x: 2, y: 3 } },
    { hePitch: { x: 2, y: 3 }, msiPitch: { x: 10, y: 0 } },
  ]) {
    const raw = frames(partial);
    assert.equal(raw.physical, false); nearMatrix(raw.he.matrix, identity); nearMatrix(raw.msi.matrix, identity);
  }
});

test('landmark fitting applies the manual direction before nonreflected similarity', () => {
  const base = frames();
  for (const flip of [false, true]) for (let n = 0; n < 4; n++) {
    let he = base.he;
    if (flip) he = O.orient(he, 'mirror-x');
    for (let i = 0; i < n; i++) he = O.orient(he, 'rotate-right');
    const f = { he, msi: base.msi }, F = fitMatrix(7, 0.72);
    const T = O.toCanonical(F, f), lm = landmarks(T), before = JSON.stringify(lm);
    const result = O.solve(lm, { ...f, model: 'similarity' });
    nearMatrix(result.T, T); nearMatrix(result.F, F); near(result.rotationDeg, 7);
    near(result.residuals.rmse_px, 0); assert.equal(result.n, 5);
    assert.equal(JSON.stringify(lm), before);
  }
});

test('anisotropic physical similarity fits raw coordinates and returns axis-correct residual units', () => {
  const f = frames({ hePitch: { x: 2, y: 3 }, msiPitch: { x: 10, y: 20 } });
  f.he = O.orient(f.he, 'rotate-right');
  const T = O.toCanonical(fitMatrix(-9, 1.04), f);
  const result = O.solve(landmarks(T), f);
  nearMatrix(result.T, T); near(result.residuals.rmse_px, 0); near(result.residuals.rmse_um, 0);
  assert.equal(result.state.model, 'affine', 'raw pixel matrix is affine although the physical fit is similarity');
});

test('similarity needs three distributed pairs; affine requires four; excluded pairs do not enter fits', () => {
  const f = frames(), T = fitMatrix(0, 0.8), lm = landmarks(T);
  assert.throws(() => O.solve(landmarks(T, points.slice(0, 2)), f), /3 組/);
  assert.throws(() => O.solve(landmarks(T, points.slice(0, 3)), { ...f, model: 'affine' }), /4 組/);
  assert.throws(() => O.solve(landmarks(T, [[1, 1], [2, 2], [3, 3]]), f), /直線/);
  assert.throws(() => O.solve(landmarks(T, [points[0], points[0], points[1]]), f), /重複/);
  lm.msi[4] = [1000, -999]; lm.excluded = [4];
  nearMatrix(O.solve(lm, { ...f, model: 'affine' }).T, T);
  const affine = [[1.02, 0.09, 3], [-0.02, 0.96, -4], [0, 0, 1]];
  nearMatrix(O.solve(landmarks(affine), { ...f, model: 'affine' }).T, affine);
});

test('reflection and 180-degree correspondence mistakes are rejected instead of collapsed or flipped', () => {
  const f = frames();
  for (const model of ['similarity', 'affine']) {
    assert.throws(() => O.solve(landmarks([[-1, 0, 100], [0, 1, 0], [0, 0, 1]]), { ...f, model }), /反転/);
    assert.throws(() => O.solve(landmarks(fitMatrix(180)), { ...f, model }), /角度補正/);
    assert.throws(() => O.solve(landmarks(fitMatrix(16)), { ...f, model }), /角度補正/);
    near(O.solve(landmarks(fitMatrix(15)), { ...f, model }).rotationDeg, 15);
  }
  assert.equal(O.check(fitMatrix(180), f).valid, false);
  assert.equal(O.check(identity, { ...f, maxRotationDeg: 180 }).valid, false);
});

test('repeated fits and checks keep the original manual direction as the angular anchor', () => {
  const f = frames();
  for (let i = 0; i < 6; i++) {
    const result = O.solve(landmarks(fitMatrix(12)), f);
    near(result.rotationDeg, 12);
    assert.equal(O.check(fitMatrix(24), { ...f, previousT: result.T }).valid, false);
  }
  f.he = O.orient(f.he, { type: 'rotate', degrees: 20 });
  const T = O.toCanonical(fitMatrix(12), f);
  near(O.solve(landmarks(T), f).rotationDeg, 12, 1e-8);
});

test('proper polar rotation checks full affine rather than only its first column', () => {
  const f = frames(), F = [[1, 0.7, 0], [0.7, 1, 0], [0, 0, 1]];
  const checked = O.check(F, f);
  assert.equal(checked.valid, true); near(checked.rotationDeg, 0);
  assert.ok(A.decomposeAffine(F).rotate_deg > 15, 'QR differs from the actual polar rotation');
  const rotated = O.multiply(fitMatrix(30, 1, 0, 0), F);
  assert.equal(O.check(rotated, f).valid, false);
});

test('new fits reject extreme residual anisotropy without averaging known physical pitch', () => {
  const f = frames();
  assert.equal(O.check([[99, 0, 0], [0, 1, 0], [0, 0, 1]], f).valid, true);
  assert.match(O.check([[101, 0, 0], [0, 1, 0], [0, 0, 1]], f).reason, /縦横.*せん断/);
  assert.throws(() => O.solve(landmarks([[101, 0, 0], [0, 1, 0], [0, 0, 1]]),
    { ...f, model: 'affine' }), /縦横.*せん断/);
  const physical = frames({ hePitch: { x: 1000, y: 1 }, msiPitch: { x: 10, y: 20 } });
  const raw = O.toCanonical(identity, physical);
  assert.ok(O.conditionNumber(raw) > 100);
  assert.equal(O.check(raw, physical).valid, true, 'the guard applies after correcting known anisotropic pitch');
});

test('silhouette aligns translation and scale with zero rotation and finite evaluation budget', () => {
  const f = frames(), source = mask(), truth = fitMatrix(0, 0.8, 12, 4), target = warped(source, truth);
  const fitted = O.silhouette(source, target, { ...f, initialT: identity, maxEvaluations: 240 });
  near(fitted.rotationDeg, 0); assert.ok(fitted.dice > 0.97); assert.ok(fitted.improved);
  assert.ok(fitted.evals <= 240); assert.ok(O.check(fitted.T, { ...f, maxRotationDeg: 0 }).valid);
  const limited = O.silhouette(source, target, { ...f, initialT: identity, maxEvaluations: 2 });
  assert.equal(limited.evals, 2); assert.ok(limited.budgetExhausted);
});

test('symmetrical and adversarial silhouettes never search reflection or half turns', () => {
  const f = frames();
  for (const source of [mask(), mask(100, 80, (x, y) => ((x - 50) / 30) ** 2 + ((y - 40) / 20) ** 2 < 1)]) {
    for (const transform of [
      [[-1, 0, 100], [0, 1, 0], [0, 0, 1]],
      [[-1, 0, 100], [0, -1, 80], [0, 0, 1]],
    ]) {
      const target = warped(source, transform);
      const result = O.silhouette(source, target, { ...f, initialT: transform });
      near(result.rotationDeg, 0);
      assert.equal(O.check(result.T, { ...f, maxRotationDeg: 0 }).valid, true);
      assert.ok(result.F[0][0] > 0 && result.F[1][1] > 0);
      assert.equal(result.improved, false, 'an existing wrong-direction perfect Dice is not silently replaced');
    }
  }
});

test('silhouette honours manual reflection and a quarter turn, with optional rotation bounded at every call', () => {
  const base = frames(), source = mask();
  const he = O.orient(O.orient(base.he, 'mirror-y'), 'rotate-right'), f = { he, msi: base.msi };
  const truth = O.toCanonical(fitMatrix(8, 0.8, 10, 0), f), target = warped(source, truth);
  let current = identity;
  for (let i = 0; i < 3; i++) {
    const result = O.silhouette(source, target, { ...f, initialT: current, allowRotation: true });
    assert.ok(Math.abs(result.rotationDeg) <= 15);
    assert.ok(O.check(result.T, f).valid); assert.ok(result.dice > 0.94);
    current = result.T;
  }
});

test('physical silhouette locks one scale in working space while respecting both pitch axes', () => {
  const f = frames({ hePitch: { x: 10, y: 20 }, msiPitch: { x: 10, y: 20 } }), source = mask();
  const target = warped(source, [[1, 0, 3], [0, 1, -2], [0, 0, 1]]);
  const result = O.silhouette(source, target, f);
  assert.equal(result.scaleLocked, true); nearMatrix(result.F.map((r, i) =>
    r.map((v, j) => j === 2 && i < 2 ? 0 : v)), identity);
  assert.ok(result.dice > 0.99);
});

test('silhouette keeps existing result when no improvement, and rejects unusable masks and budgets', () => {
  const f = frames(), source = mask();
  const result = O.silhouette(source, source, { ...f, initialT: identity });
  assert.equal(result.improved, false); near(result.initialDice, 1); near(result.dice, 1);
  for (const budget of [1, Infinity, 2.5, 2001]) {
    assert.throws(() => O.silhouette(source, source, { ...f, maxEvaluations: budget }), /上限/);
  }
  assert.throws(() => O.silhouette(mask(100, 80, () => false), source, f), /輪郭/);
  assert.throws(() => O.silhouette(mask(100, 80, () => true), source, f), /輪郭/);
  assert.throws(() => O.silhouette({ ...source, sx: 2 }, source, f), /大きさ/);
});

test('direction serialization round trips without rebuilding canonical transforms and detects stale source geometry', () => {
  const fresh = frames({ hePitch: { x: 3, y: 5 }, msiPitch: { x: 10, y: 12 } });
  const f = { ...fresh, he: O.orient(fresh.he, { type: 'rotate', degrees: 13 }) };
  const saved = O.serialize(f), restored = O.restore(JSON.parse(JSON.stringify(saved)), fresh);
  assert.deepEqual(plain(restored), plain(saved));
  const T = [[0.05, 0.011, 19], [-0.004, 0.08, 12], [0, 0, 1]], before = JSON.stringify(T);
  O.restore(saved); assert.equal(JSON.stringify(T), before, 'restore does not decompose or modify saved T');
  assert.throws(() => O.restore(saved, frames()), /画像情報/);
  const tampered = plain(saved); tampered.he.matrix[0][0] *= 1.2;
  assert.throws(() => O.restore(tampered), /倍率|表示範囲/);
});

test('saved direction cannot rotate or reflect the fixed MSI reference', () => {
  const fresh = frames();
  for (const operation of ['mirror-x', 'mirror-y', 'rotate-right', { type: 'rotate', degrees: 7 }]) {
    const changed = { ...fresh, msi: O.orient(fresh.msi, operation) };
    assert.throws(() => O.restore(changed, fresh), /MSI.*固定/);
    assert.equal(O.check(identity, changed).valid, false);
    assert.throws(() => O.solve(landmarks(identity), changed), /MSI.*固定/);
  }
  const corrupt = plain(fresh);
  corrupt.he.physical = true;
  assert.throws(() => O.restore(corrupt), /物理画素/);
});
