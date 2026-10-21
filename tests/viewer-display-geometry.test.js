'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../lib/viewer-display-geometry.js');
const G = global.ViewerDisplayGeometry;
const near = (a, b, epsilon = 1e-8) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

test('display expansion retains all HE/MSI corners without changing their fixed-frame placement', () => {
  for (const [w, h] of [[34, 55], [160, 80], [80, 160], [80, 80]]) {
    for (const he of [0, -90, 90, 180, 23.75]) {
      const input = { msiSize: { w, h }, rotation: { he, msi: -17 }, T: identity,
        layers: [{ key: 'msi', kind: 'msi', w, h }, { key: 'he', kind: 'he', w, h }] };
      const before = JSON.stringify(input), geometry = G.build(input);
      assert.equal(JSON.stringify(input), before);
      for (const key of ['msi', 'he']) {
        const matrix = geometry.layerMatrices[key];
        for (const [x, y] of G.corners(matrix, w, h)) {
          assert.ok(x >= -1e-8 && x <= geometry.width + 1e-8, `${w}x${h}, ${he}: x ${x}`);
          assert.ok(y >= -1e-8 && y <= geometry.height + 1e-8, `${w}x${h}, ${he}: y ${y}`);
        }
        const original = geometry.baseLayerMatrices[key], restored = G.multiply(G.inverse(geometry.displayTransform), matrix);
        restored.forEach((value, i) => near(value, original[i]));
      }
    }
  }
});

test('translation, reflection and shear expand the view while ROI inverse keeps raw MSI points', () => {
  const input = { msiSize: { w: 64, h: 48 }, rotation: { he: 11, msi: -7 },
    T: [[-0.41, 0.075, 145], [0.035, 0.36, -95], [0, 0, 1]],
    layers: [{ key: 'msi', kind: 'msi', w: 64, h: 48 }, { key: 'he', kind: 'he', w: 100, h: 80 }],
    roiPoints: [[-2, 40], [70, 54]] };
  const geometry = G.build(input), inverse = G.inverse(geometry.msiMatrix);
  for (const point of [[0, 0], [12.25, 35.75], [64, 48], ...input.roiPoints]) {
    const canvas = G.point(geometry.msiMatrix, ...point), raw = G.point(inverse, ...canvas);
    raw.forEach((value, i) => near(value, point[i], 1e-6));
    assert.ok(canvas[0] >= 0 && canvas[0] <= geometry.width && canvas[1] >= 0 && canvas[1] <= geometry.height);
  }
});

test('arbitrary whole-view rotations fit, and resolution limits rescale rather than crop', () => {
  for (const degrees of [-90, 0, 20, 20.375, 180]) {
    const fit = G.fit(440, 700, degrees, 900, 350);
    assert.ok(fit.rotatedWidth <= 900 + 1e-8 && fit.rotatedHeight <= 350 + 1e-8);
    near(fit.width / fit.height, 440 / 700);
  }
  const geometry = G.build({ msiSize: { w: 100, h: 40 }, T: [[1, 0, -100000], [0, 1, 50000], [0, 0, 1]],
    layers: [{ key: 'he', kind: 'he', w: 10000, h: 8000 }] });
  assert.equal(geometry.resolutionLimited, true);
  assert.ok(geometry.width <= 8192 && geometry.height <= 8192 && geometry.width * geometry.height <= 16777216);
  for (const [x, y] of G.corners(geometry.layerMatrices.he, 10000, 8000)) {
    assert.ok(x >= -1e-7 && y >= -1e-7 && x <= geometry.width + 1e-7 && y <= geometry.height + 1e-7);
  }
});

test('quarter-turn dimensions are exact and legacy fallback orientation remains unchanged', () => {
  assert.deepEqual(G.rotatedSize(34, 55, 90), { w: 55, h: 34 });
  const geometry = G.build({ msiSize: { w: 34, h: 55 }, layers: [{ key: 'he', kind: 'he', w: 898, h: 600 }] });
  assert.equal(geometry.width, 55 * 8); assert.equal(geometry.height, 34 * 8);
  assert.deepEqual(geometry.baseLayerMatrices.he, [55 / 898, 0, 0, 34 / 600, 0, 0]);
});
