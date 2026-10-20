'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');

test('pixel textures, ROI coordinates and rigid placement agree without physical calibration', async () => {
  const h = await startBrowserHarness();
  try {
    await h.page.goto(h.baseURL + '/__test_seed');
    for (const file of ['lib/section-display.js', 'lib/stack3d.js', 'stack3d/vendor/three-orbit.min.js', 'stack3d/roi.js', 'stack3d/renderer.js']) {
      await h.page.addScriptTag({ url: h.baseURL + '/' + file });
    }
    const result = await h.page.evaluate(() => {
      const p = {
        id: 'mouse-11', displayName: 'Mouse 11', plane: 'coronal',
        atlas: { species: 'mouse', seriesId: 'mouse-test', seriesName: 'Mouse test', sectionNumber: 11, coordinateMode: 'pixel', displaySpacing: 2 },
        grid: { W: 4, H: 3, umPerPxX: null, umPerPxY: null }, images: {}, molecules: [],
        rotation: { all: 0, msi: 0, he: 0 },
        stack3d: { coordinateMode: 'pixel', offsetXPx: 2, offsetYPx: -3, rotationDeg: 90 },
        roi: { roi_items: { corner: [{ poly_msi: [[0, 0], [1, 0], [0, 1]] }] }, roi_names: { corner: 'Corner' } }
      };
      const d = { id: p.id, name: p.displayName, project: p, zIndex: 10, ...Stack3D.geometry(p) };
      const source = document.createElement('canvas'); source.width = 4; source.height = 3;
      const ctx = source.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = '#00ff00'; ctx.fillRect(3, 2, 1, 1);
      const oriented = Stack3D.orientCanvas(d, source);
      const pixels = canvas => Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data);
      const overlay = Stack3DRoi.create(AtlasThree, document, d);
      const roiPoints = Array.from(overlay.group.children[0].geometry.attributes.position.array);
      overlay.dispose();
      const host = document.createElement('div'); host.style.cssText = 'width:800px;height:500px'; document.body.append(host);
      const errors = [], renderer = Stack3DRenderer.createRenderer(host, { onError: error => errors.push(error.message) });
      const last = { ...d, id: 'mouse-48', project: { ...p, id: 'mouse-48', atlas: { ...p.atlas, sectionNumber: 48 } }, zIndex: 47 };
      renderer.setSections([{ ...d, textureCanvas: source }, { ...last, textureCanvas: source }]); renderer.setSpacing(2);
      renderer.setBrainContext({ visible: true });
      const initial = renderer.getStats();
      renderer.setHiddenSections(['mouse-11']);
      const afterHide = renderer.getStats();
      renderer.setPlacement('mouse-48', { offsetXPx: -5, offsetYPx: 7, rotationDeg: -20 });
      const afterMove = renderer.getStats();
      const png = renderer.capturePNG();
      let mixedRejected = false;
      try {
        renderer.setSections([d, { id: 'legacy', name: 'Cor_1_1', widthMm: 1, heightMm: 1 }]);
      } catch (_) { mixedRejected = true; }
      const output = { unchangedOrientation: JSON.stringify(pixels(source)) === JSON.stringify(pixels(oriented)),
        dimensions: [oriented.width, oriented.height], roiPoints, initial, afterHide, afterMove,
        png: png.startsWith('data:image/png;base64,'), mixedRejected, errors,
        sourcePhysicalPitch: [p.grid.umPerPxX, p.grid.umPerPxY] };
      renderer.dispose(); host.remove(); return output;
    });
    assert.equal(result.unchangedOrientation, true);
    assert.deepEqual(result.dimensions, [4, 3]);
    assert.deepEqual(result.roiPoints, [-2, 1.5, 0, -1, 1.5, 0, -2, 0.5, 0]);
    assert.deepEqual(result.sourcePhysicalPitch, [null, null]);
    assert.equal(result.initial.coordinateMode, 'pixel');
    assert.equal(result.initial.brainVisible, false);
    assert.equal(result.initial.brainObjectCount, 0);
    assert.deepEqual(result.initial.placements.map(p => p.position), [[2, -3, -37], [2, -3, 37]],
      'number 11 and number 48 retain their 37 ordinal intervals');
    assert.deepEqual(result.initial.placements.map(p => p.rotationDeg), [90, 90]);
    assert.deepEqual(result.initial.placements.map(p => [p.width, p.height]), [[4, 3], [4, 3]]);
    assert.deepEqual(result.afterHide.placements, result.initial.placements, 'hiding a slice cannot compact the stack');
    assert.deepEqual(result.afterMove.placements[1].position, [-5, 7, 37]);
    assert.ok(Math.abs(result.afterMove.placements[1].rotationDeg + 20) < 1e-10);
    assert.equal(result.png, true);
    assert.equal(result.mixedRejected, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
