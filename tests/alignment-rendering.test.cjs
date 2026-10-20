'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

// Negative determinant, unequal axis scales, and shear. Deliberately not a
// similarity, and more precise than the modal's formatted parameter fields.
const T = [[-0.4112345678901234, 0.0752718281828459, 45.123456789012345],
  [0.0351415926535898, 0.3614142135623731, 5.234567890123456], [0, 0, 1]];
const near = (actual, expected, epsilon = 1e-5) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);

test('saved affine reaches Viewer and both Stack3D HE renderers intact in each orientation mode', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    const id = 'affine-rendering';
    await seedViewerProject(page, h.baseURL, { id });
    await page.evaluate(async ({ id, T }) => {
      const p = await ProjectStorage.getProject(id);
      delete p.normalization;
      p.grid = { W: 64, H: 48, umPerPxX: 20, umPerPxY: 30 };
      p.world_coords = { T_he_to_msi: T, msi_um_per_px: { x: 20, y: 30 } };
      p.rotation = { all: 17, he: 11, msi: -7 };
      p.valueDisplay = { mode: 'raw', scale: 'individual' };
      const values = Float32Array.from({ length: 64 * 48 }, (_, i) => 1 + i);
      p.molecules = [{ key: 'MSI_5-HT', name: '5-HT', blobId: await ProjectStorage.putValueRaster(values),
        stats: MSIRaster.deriveBakeStats(values) }];
      p.visibleLayers = ['HE_Stain', 'MSI_5-HT'];
      const image = document.createElement('canvas'); image.width = 100; image.height = 80;
      const ctx = image.getContext('2d'); ctx.fillStyle = '#d65397'; ctx.fillRect(0, 0, 100, 80);
      ctx.fillStyle = '#762472'; ctx.fillRect(4, 9, 20, 44);
      const blob = await new Promise(resolve => image.toBlob(resolve));
      p.images = { HE_Stain: { blobId: await ProjectStorage.putBlob({ blob }), filename: 'synthetic-affine.png' } };
      p.alignment = { HE_Stain: { scale_pct: 1, flip_lr: false, rotate_deg: 90, offx: 0, offy: 0 } };
      await ProjectStorage.putProject(p);
    }, { id, T });
    await page.goto(h.baseURL + '/viewer/index.html?project=' + id);
    await page.waitForFunction(id => typeof currentProject !== 'undefined' && currentProject?.id === id &&
      viewerReady && imageSources.HE_Stain?.naturalWidth === 100, id);
    await page.addScriptTag({ url: h.baseURL + '/lib/section-display.js' });
    await page.addScriptTag({ url: h.baseURL + '/lib/stack3d.js' });
    const results = await page.evaluate(async T => {
      const original = CanvasRenderingContext2D.prototype.transform;
      const records = [];
      let phase;
      CanvasRenderingContext2D.prototype.transform = function (...args) {
        const before = this.getTransform();
        original.apply(this, args);
        // Record only the HE-specific affine call, not the MSI orientation.
        if (args.every((v, i) => v === [T[0][0], T[1][0], T[0][1], T[1][1], T[0][2], T[1][2]][i])) {
          const after = this.getTransform();
          const local = before.inverse().multiply(after);
          records.push({ phase, args, before: [before.a, before.b, before.c, before.d, before.e, before.f],
            width: this.canvas.width, height: this.canvas.height,
            basis: [[0, 0], [1, 0], [0, 1], [63, 41]].map(([x, y]) => {
              const point = local.transformPoint({ x, y }); return [point.x, point.y];
            }) });
        }
      };
      const projectBefore = JSON.stringify(await ProjectStorage.getProject(currentProject.id));
      try {
        for (const mode of ['physical', 'pixel']) {
          const p = JSON.parse(projectBefore);
          if (mode === 'pixel') p.atlas = { seriesId: 'synthetic_mouse', species: 'mouse', coordinateMode: 'pixel', sectionNumber: 1 };
          const section = { project: p, ...Stack3D.geometry(p), _images: new Map([['HE_Stain', imageSources.HE_Stain]]) };
          // Match the active Viewer series while leaving its saved record alone.
          currentProject.atlas = p.atlas;
          phase = mode + ':viewer'; renderCompositeImage();
          phase = mode + ':plane'; await Stack3D.renderHePlane(section, { maxSize: 512 });
          phase = mode + ':preview'; await Stack3D.renderHePreview(section, { maxSize: 512 });
        }
        return { records, savedUnchanged: JSON.stringify(await ProjectStorage.getProject(currentProject.id)) === projectBefore,
          matrix: atlasData.world_coords.T_he_to_msi };
      } finally { CanvasRenderingContext2D.prototype.transform = original; }
    }, T);
    assert.equal(results.savedUnchanged, true);
    assert.deepEqual(results.matrix, T);
    assert.equal(results.records.length, 6, 'every HE renderer must apply the authoritative matrix once in each mode');
    const expectedArgs = [T[0][0], T[1][0], T[0][1], T[1][1], T[0][2], T[1][2]];
    for (const r of results.records) {
      assert.deepEqual(r.args, expectedArgs, r.phase + ' must keep full saved coefficients');
      [[0, 0], [1, 0], [0, 1], [63, 41]].forEach(([x, y], i) => {
        // Browser canvas CTMs may round to float32 internally. Exact source
        // coefficients are checked above; basis positions use subpixel tolerance.
        near(r.basis[i][0], T[0][0] * x + T[0][1] * y + T[0][2], 1e-4);
        near(r.basis[i][1], T[1][0] * x + T[1][1] * y + T[1][2], 1e-4);
      });
      const [a, b, c, d] = r.before;
      if (r.phase.endsWith(':plane')) {
        near(a, r.width / 64); near(d, r.height / 48); near(b, 0); near(c, 0);
      } else if (r.phase.endsWith(':viewer')) {
        const angle = (11 - 90) * Math.PI / 180;
        near(a, Math.cos(angle) * r.height / 64); near(b, Math.sin(angle) * r.height / 64);
        near(c, -Math.sin(angle) * r.width / 48); near(d, Math.cos(angle) * r.width / 48);
      } else {
        const pixel = r.phase.startsWith('pixel:');
        const angle = (17 + 11 - (pixel ? 0 : 180)) * Math.PI / 180;
        const sx = Math.hypot(a, b), sy = Math.hypot(c, d);
        near(a / sx, Math.cos(angle)); near(b / sx, Math.sin(angle));
        near(c / sy, -Math.sin(angle)); near(d / sy, Math.cos(angle));
        near(sy / sx, pixel ? 1 : 30 / 20, 1e-7);
      }
    }
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
