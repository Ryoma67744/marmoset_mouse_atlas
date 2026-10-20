'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/align.js'), 'utf8'), context);
const Align = context.window.Align;
const plain = value => JSON.parse(JSON.stringify(value));
const source = [[0, 0], [120, 5], [110, 85], [12, 100], [35, 32], [80, 61]];
function near(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected} within ${epsilon}`);
}
function nearMatrix(actual, expected, epsilon = 1e-9) {
  actual.forEach((row, i) => row.forEach((value, j) => near(value, expected[i][j], epsilon)));
}
function landmarks(T, he = source) {
  return { he: he.map(p => p.slice()), msi: he.map(p => Align.applyAffinePoint(T, ...p)) };
}

test('affine QR recovers rotation, reflection, nonuniform scale, shear and translation', () => {
  for (const T of [
    [[1.2, 0.2, 7], [0, 0.8, 9], [0, 0, 1]],
    [[0, -0.02, 41], [0.035, 0.01, -2], [0, 0, 1]],
    [[-0.025, 0.008, 50], [0.003, 0.041, 10], [0, 0, 1]],
  ]) {
    const points = landmarks(T), before = JSON.stringify(points);
    const fit = Align.solveAffineFromLandmarks(points);
    nearMatrix(fit.T, T);
    assert.equal(fit.n, 6);
    assert.equal(fit.state.model, 'affine');
    near(fit.residuals.rmse_px, 0);
    assert.equal(JSON.stringify(points), before, 'fitting does not change the point source');
    for (const check of [[3, 70], [60, 45], [95, 1]]) {
      Align.applyAffinePoint(fit.T, ...check).forEach((v, j) => near(v, Align.applyAffinePoint(T, ...check)[j]));
    }
  }
});

test('normalized affine fit remains accurate with large coordinate origins', () => {
  const he = source.map(p => [p[0] + 1e8, p[1] - 2e8]);
  const T = [[0.025, 0.008, -9000], [-0.006, 0.019, 5000], [0, 0, 1]];
  const points = landmarks(T, he), fit = Align.solveAffineFromLandmarks(points);
  for (const check of [[1e8 + 40, -2e8 + 70], [1e8 - 20, -2e8 + 40]]) {
    Align.applyAffinePoint(fit.T, ...check).forEach((v, j) => near(v, Align.applyAffinePoint(T, ...check)[j], 2e-8));
  }
  assert.ok(fit.residuals.rmse_px < 2e-8);
});

test('noisy affine fit minimizes all included point residuals without silently dropping points', () => {
  const points = landmarks([[1.1, 0.12, 4], [0.07, 0.84, 7], [0, 0, 1]]);
  points.msi[1][0] += 4; points.msi[4][1] -= 3;
  const fit = Align.solveAffineFromLandmarks(points);
  assert.ok(fit.residuals.rmse_px > 0.5);
  assert.equal(fit.n, points.he.length);
  // Least-squares residuals are orthogonal to x, y and the translation column.
  for (const axis of ['dx', 'dy']) {
    for (const column of [null, 0, 1]) {
      const sum = fit.residuals.perPoint.reduce((s, p) => s + p[axis] * (column === null ? 1 : points.he[p.i][column]), 0);
      near(sum, 0, 1e-8);
    }
  }
});

test('affine rejects insufficient, unequal, duplicate, nonfinite and nearly collinear included points', () => {
  assert.throws(() => Align.solveAffineFromLandmarks({ he: source.slice(0, 2), msi: source.slice(0, 2) }), /3 組/);
  assert.throws(() => Align.solveAffineFromLandmarks({ he: source, msi: source.slice(1) }), /点数/);
  for (const points of [
    [[0, 0], [0, 0], [1, 3]],
    [[0, 0], [1, NaN], [1, 3]],
    [[0, 0], [Infinity, 1], [1, 3]],
    [[0, 0], [1, 1], [2, 2]],
    [[0, 0], [1, 1 + 1e-7], [2, 2], [3, 3]],
  ]) {
    assert.throws(() => Align.solveAffineFromLandmarks({ he: points, msi: points }), /対応点/);
  }
  assert.throws(() => Align.solveAffineFromLandmarks({ he: source, msi: source.map((_, i) => [i, i]) }), /直線/);
  assert.throws(() => Align.solveAffineFromLandmarks({ he: source, msi: source, excluded: [100] }), /除外/);
});

test('explicit exclusions preserve point identity and are omitted only from fitting and aggregate QC', () => {
  const T = [[1.2, 0.2, 7], [0, 0.8, 9], [0, 0, 1]];
  const points = landmarks(T);
  points.msi[2] = [999, 999];
  points.excluded = [2];
  const fit = Align.solveAffineFromLandmarks(points);
  nearMatrix(fit.T, T);
  assert.equal(fit.n, 5);
  assert.equal(fit.residuals.n, 5);
  assert.equal(fit.residuals.total, 6);
  assert.equal(fit.residuals.perPoint[2].i, 2);
  assert.equal(fit.residuals.perPoint[2].included, false);
  assert.ok(fit.residuals.perPoint[2].d > 100);
  near(fit.residuals.rmse_px, 0);
  assert.notEqual(fit.residuals.maxIndex, 2);
  assert.deepEqual(points.excluded, [2], 'no point is automatically excluded');
});

test('similarity evaluates both reflection signs independently of a stale UI flip', () => {
  for (const flip_lr of [false, true]) {
    const truth = { ...Align.defaultAlignState(), scale_pct: 2.3, rotate_deg: 17, offx: 40, offy: 8, flip_lr };
    const T = Align.buildHeToMsiAffine(truth), points = landmarks(T);
    const fits = Align.solveSimilarityCandidates(points);
    assert.equal(fits.length, 2);
    assert.equal(fits[0].reflected, flip_lr);
    nearMatrix(fits[0].T, T);
    near(fits[0].residuals.rmse_px, 0);
    assert.ok(fits[1].residuals.rmse_px > 0.5);
  }
  const square = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const fit = Align.solveSimilarityCandidates({ he: square, msi: square });
  assert.equal(fit.length, 1, 'zero-scale reflection is not offered as an applicable transform');
  assert.throws(() => Align.solveAlignFromLandmarks({ he: source, msi: source.slice(1) }, false, false), /点数/);
});

test('similarity limitations remain visible when affine deformation is needed', () => {
  const points = landmarks([[1.2, 0.2, 7], [0, 0.8, 9], [0, 0, 1]]);
  assert.ok(Align.solveSimilarityCandidates(points)[0].residuals.rmse_px > 5);
  near(Align.solveAffineFromLandmarks(points).residuals.rmse_px, 0);
});

test('residual vectors, excluded points, largest ID and anisotropic physical pitch agree numerically', () => {
  const points = { he: [[0, 0], [2, 0], [0, 2]], msi: [[-3, -4], [2, -2], [-100, 2]], excluded: [2] };
  const T = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const result = Align.computeLandmarkResiduals(points, T, { x: 2, y: 3 });
  near(result.perPoint[0].dx, 3); near(result.perPoint[0].dy, 4);
  near(result.perPoint[0].d, 5); near(result.perPoint[0].dUm, Math.sqrt(180));
  assert.deepEqual(plain(result.perPoint[0].transformed), [0, 0]);
  assert.deepEqual(plain(result.perPoint[0].target), [-3, -4]);
  near(result.rmse_px, Math.sqrt(14.5));
  near(result.rmse_um, Math.sqrt(108));
  assert.equal(result.maxIndex, 0);
  assert.equal(result.max_px, 5);
  assert.ok(Number.isNaN(Align.computeLandmarkResiduals(points, T, { x: 2 }).rmse_um));
});

test('affine parameter decomposition round-trips reflection and both scales/shear', () => {
  for (const flip_lr of [false, true]) for (const flip_ud of [false, true]) {
    const st = { model: 'affine', scale_x_pct: 2.4, scale_y_pct: 3.7, shear: -0.32,
      rotate_deg: 127, offx: -5.1234567890123, offy: 12, flip_lr, flip_ud };
    const T = Align.buildHeToMsiAffine(st), original = JSON.stringify(T);
    const state = Align.decomposeAffine(T);
    assert.equal(state.model, 'affine');
    nearMatrix(Align.buildHeToMsiAffine(state), T);
    assert.equal(JSON.stringify(T), original, 'decomposition never rounds the authoritative matrix');
    const inverse = Align.invertAffine(T);
    const transformed = Align.applyAffinePoint(T, 134, 72);
    Align.applyAffinePoint(inverse, ...transformed).forEach((v, j) => near(v, [134, 72][j]));
  }
  const similarity = Align.buildHeToMsiAffine({ ...Align.defaultAlignState(), scale_pct: 0.00001, rotate_deg: 23 });
  assert.equal(Align.decomposeAffine(similarity).model, 'similarity');
  assert.ok(Align.invertAffine(similarity), 'valid very small physical pixel-scale ratios stay invertible');
});

test('invalid and singular parameters cannot build a saved transform', () => {
  for (const value of ['', '-', NaN, Infinity, 0, -2]) {
    assert.throws(() => Align.buildHeToMsiAffine({ ...Align.defaultAlignState(), scale_pct: value }), /パラメータ/);
  }
  for (const T of [null, [[1, 0, 0], [0, 0, 0], [0, 0, 1]],
    [[1, 0, 0], [0, 1, Infinity], [0, 0, 1]], [[1, 0, 0], [0, 1, 0], [0.1, 0, 1]]]) {
    assert.equal(Align.validateAffine(T), false);
    assert.throws(() => Align.decomposeAffine(T), /行列/);
    assert.equal(Align.invertAffine(T), null);
  }
});

test('legacy similarity blending never silently projects an affine candidate', () => {
  const similarity = Align.defaultAlignState();
  const affine = Align.decomposeAffine([[1.2, 0.2, 7], [0, 0.8, 9], [0, 0, 1]]);
  assert.equal(Align.blendAlignStates(affine, 1, similarity, 1), null);
  assert.equal(Align.blendAlignStates(similarity, 1, affine, 1), null);
  assert.equal(Align.blendAlignStates(affine, 1, affine, 1), null);
  assert.ok(Align.blendAlignStates(similarity, 1, similarity, 1));
});

test('standalone ZIP matrix decomposition retains shear without requiring Align loaded', () => {
  const zipContext = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/zipio.js'), 'utf8'), zipContext);
  for (const T of [
    [[1.2, 0.2, 7], [0, 0.8, 9], [0, 0, 1]],
    [[-0.025, 0.008, 50], [0.003, 0.041, 10], [0, 0, 1]],
  ]) {
    const state = zipContext.window.ZipIO.stateFromT(T);
    assert.equal(state.model, 'affine');
    nearMatrix(Align.buildHeToMsiAffine(state), T);
    assert.deepEqual(plain(state), plain(Align.decomposeAffine(T)));
  }
});
