'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');

async function load(h, { helper = true, overlay = true } = {}) {
  await h.page.goto(h.baseURL + '/__test_seed');
  const files = ['lib/section-display.js', 'lib/stack3d.js', 'stack3d/vendor/three-orbit.min.js', 'stack3d/roi.js'];
  if (helper) files.push('lib/section-outline.js');
  if (overlay) files.push('stack3d/section-outline.js');
  files.push('stack3d/renderer.js');
  for (const file of files) await h.page.addScriptTag({ url: h.baseURL + '/' + file });
  await h.page.evaluate(() => {
    window.outlineFixture = ({ id = 'outline-1', mode = 'pixel', zIndex = 0, empty = false } = {}) => {
      const values = Float32Array.from({ length: 24 }, (_, i) => {
        const x = i % 6, y = Math.floor(i / 6);
        return !empty && x >= 1 && x <= 4 && y >= 1 && y <= 2 ? 0 : NaN;
      });
      const p = {
        id, displayName: id, plane: 'coronal',
        atlas: { species: 'mouse', seriesId: 'outline-test', seriesName: 'Outline test',
          sectionNumber: zIndex + 1, coordinateMode: mode, displaySpacing: 2 },
        grid: { W: 6, H: 4, umPerPxX: mode === 'pixel' ? null : 200, umPerPxY: mode === 'pixel' ? null : 350 },
        images: {}, molecules: [{ key: 'MSI_DA', name: 'DA' }], rotation: { all: 0, msi: 0, he: 90 },
        roi: { roi_items: {}, roi_names: {} }
      };
      return { id, name: id, project: p, zIndex, rasters: { MSI_DA: { W: 6, H: 4, values } },
        channels: { DA: { key: 'MSI_DA', raw: values, normalized: Float32Array.from(values, () => NaN) } }, ...Stack3D.geometry(p) };
    };
    window.outlineHost = () => {
      const host = document.createElement('div'); host.style.cssText = 'width:800px;height:500px';
      document.body.append(host); return host;
    };
    window.readCapture = async renderer => {
      const image = new Image(); image.src = renderer.capturePNG(); await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0, blue = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100) red++;
        if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] > 100) blue++;
      }
      return { red, blue };
    };
  });
}

test('section outer edge follows raw pixel bounds, anisotropic physical pitch and every MSI placement', async () => {
  const h = await startBrowserHarness();
  try {
    await load(h);
    const result = await h.page.evaluate(() => {
      const overlays = [], create = Stack3DSectionOutline.create;
      Stack3DSectionOutline.create = (...args) => { const overlay = create(...args); overlays.push(overlay); return overlay; };
      const host = outlineHost(), errors = [];
      const renderer = Stack3DRenderer.createRenderer(host, { onError: error => errors.push(error.message) });
      const first = outlineFixture({ mode: 'physical', zIndex: 1 });
      const second = outlineFixture({ id: 'outline-2', mode: 'physical', zIndex: 4 });
      renderer.setSections([first, second]); renderer.setSpacing(1.5);
      renderer.setPlacement(first.id, { offsetXUm: 500, offsetYUm: -750, rotationDeg: 30 });
      const stats = renderer.getStats(), overlay = overlays[0];
      const local = Array.from(overlay.group.children[0].geometry.attributes.position.array);
      overlay.group.updateMatrixWorld();
      const world = [];
      for (let i = 0; i < local.length; i += 3) world.push(new AtlasThree.Vector3(...local.slice(i, i + 3)).applyMatrix4(overlay.group.matrixWorld).toArray());
      const properties = overlay.group.children.map(line => ({ type: line.type, depthTest: line.material.depthTest,
        depthWrite: line.material.depthWrite, renderOrder: line.renderOrder, linewidth: line.material.linewidth }));
      renderer.setPlacement(first.id, { rotationDeg: -25 }); renderer.setSpacing(2);
      const moved = renderer.getStats();
      renderer.dispose(); host.remove();
      return { local, world, stats, moved, properties, errors };
    });
    assert.equal(result.stats.sectionOutlines.availableCount, 2, 'measured zero intensities still have an outline');
    assert.equal(result.stats.sectionOutlines.visibleCount, 2);
    const localX = result.local.filter((_, i) => i % 3 === 0), localY = result.local.filter((_, i) => i % 3 === 1);
    assert.ok(Math.abs(Math.min(...localX) + 0.4) < 1e-7);
    assert.ok(Math.abs(Math.max(...localX) - 0.4) < 1e-7);
    assert.ok(Math.abs(Math.min(...localY) + 0.35) < 1e-7);
    assert.ok(Math.abs(Math.max(...localY) - 0.35) < 1e-7);
    assert.deepEqual(result.stats.sectionOutlines.sections.map(s => s.position), result.stats.placements.map(s => s.position));
    result.stats.sectionOutlines.sections.forEach((s, i) => assert.ok(Math.abs(s.rotationDeg - result.stats.placements[i].rotationDeg) < 1e-10));
    const angle = result.stats.placements[0].rotationDeg * Math.PI / 180;
    for (let i = 0; i < result.world.length; i++) {
      const [x, y] = result.local.slice(i * 3, i * 3 + 2), [wx, wy, wz] = result.world[i];
      assert.ok(Math.abs(wx - (x * Math.cos(angle) - y * Math.sin(angle) + 0.5)) < 1e-10);
      assert.ok(Math.abs(wy - (x * Math.sin(angle) + y * Math.cos(angle) + 0.75)) < 1e-10);
      assert.equal(wz, -2.25);
    }
    assert.deepEqual(result.moved.sectionOutlines.sections.map(s => s.position), result.moved.placements.map(s => s.position));
    assert.deepEqual(result.moved.sectionOutlines.sections.map(s => s.position[2]), [-3, 3]);
    result.properties.forEach(p => {
      assert.equal(p.type, 'LineLoop'); assert.equal(p.depthTest, false); assert.equal(p.depthWrite, false);
      assert.ok(p.renderOrder < 900000); assert.equal(p.linewidth, 1);
    });
    assert.deepEqual(result.errors, []); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('red outlines render independently of molecular pixels, opacity and ROI controls without changing picking', async () => {
  const h = await startBrowserHarness();
  try {
    await load(h);
    const result = await h.page.evaluate(async () => {
      const host = outlineHost(), errors = [], picks = [];
      const renderer = Stack3DRenderer.createRenderer(host, { onError: error => errors.push(error.message), onSelect: index => picks.push(index) });
      const section = outlineFixture();
      renderer.setSections([section]); renderer.select(-1); renderer.setRoiOverlay({ visible: false, labelsVisible: false });
      renderer.setView({ position: [0, 0, 13], target: [0, 0, 0], up: [0, 1, 0], zoom: 1 });
      const initial = renderer.getStats(), red = await readCapture(renderer);
      renderer.setSectionOutlines({ visible: false }); const off = await readCapture(renderer);
      renderer.setSectionOutlines({ visible: true }); renderer.setOpacity(0);
      const zeroOpacity = await readCapture(renderer);
      const empty = document.createElement('canvas'); empty.width = 6; empty.height = 4;
      renderer.updateTextures({ [section.id]: empty }); const emptyTexture = await readCapture(renderer);
      renderer.updateTextures({ [section.id]: null }); const removedTexture = await readCapture(renderer);
      // Outlines are deliberately excluded from scientific plane selection.
      const canvas = host.querySelector('canvas'), rect = canvas.getBoundingClientRect();
      for (const type of ['pointerdown', 'pointerup']) canvas.dispatchEvent(new PointerEvent(type, {
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, pointerId: 1, button: 0, bubbles: true
      }));
      renderer.setSectionOutlines({ color: '#0000ff' }); const blue = await readCapture(renderer);
      renderer.setSectionOutlines({ opacity: 0 }); const invisible = await readCapture(renderer), final = renderer.getStats();
      renderer.dispose(); host.remove();
      return { initial, red, off, zeroOpacity, emptyTexture, removedTexture, blue, invisible, final, picks, errors };
    });
    assert.equal(result.initial.visibleCount, 0, 'existing MSI visibility statistics retain their meaning');
    assert.equal(result.initial.visibleSectionCount, 0);
    assert.equal(result.initial.sectionOutlines.visibleCount, 1);
    assert.ok(result.red.red > 100, 'PNG contains the red outer edge');
    assert.equal(result.off.red, 0);
    assert.equal(result.zeroOpacity.red, result.red.red);
    assert.equal(result.emptyTexture.red, result.red.red);
    assert.equal(result.removedTexture.red, result.red.red);
    assert.equal(result.blue.red, 0); assert.ok(result.blue.blue > 100);
    assert.equal(result.invisible.blue, result.off.blue, 'zero outline opacity restores the background including the pixel-coordinate badge');
    assert.equal(result.final.sectionOutlines.visibleCount, 0);
    assert.deepEqual(result.picks, []); assert.deepEqual(result.errors, []); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('outlines obey section range and visibility while rebuilt and removed geometry is disposed', async () => {
  const h = await startBrowserHarness();
  try {
    await load(h);
    const result = await h.page.evaluate(() => {
      const overlays = [], disposed = [], create = Stack3DSectionOutline.create;
      Stack3DSectionOutline.create = (...args) => {
        const overlay = create(...args), counts = { geometry: 0, material: 0, lines: overlay.group.children.length };
        for (const line of overlay.group.children) {
          line.geometry.addEventListener('dispose', () => counts.geometry++);
          line.material.addEventListener('dispose', () => counts.material++);
        }
        overlays.push(overlay); disposed.push(counts); return overlay;
      };
      const host = outlineHost(), renderer = Stack3DRenderer.createRenderer(host);
      const sections = [outlineFixture(), outlineFixture({ id: 'outline-2', zIndex: 2 }), outlineFixture({ id: 'empty', zIndex: 3, empty: true })];
      renderer.setSections(sections); renderer.setSpacing(2);
      const initial = renderer.getStats();
      renderer.setHiddenSections(['outline-1']); const hidden = renderer.getStats();
      renderer.setRange(0, 0); const outsideRange = renderer.getStats();
      renderer.setHiddenSections([]); const rangeOnly = renderer.getStats();
      renderer.setSections([sections[1]]); renderer.capturePNG(); const rebuilt = renderer.getStats();
      const disposedBeforeShutdown = disposed.map(counts => ({ ...counts }));
      renderer.dispose(); renderer.dispose(); host.remove();
      return { initial, hidden, outsideRange, rangeOnly, rebuilt, disposedBeforeShutdown, disposed,
        finalStats: renderer.getStats(), allHidden: overlays.every(o => !o.group.visible) };
    });
    assert.equal(result.initial.sectionOutlines.availableCount, 2);
    assert.equal(result.initial.sectionOutlines.sections[2].status, 'unavailable');
    assert.equal(result.initial.sectionOutlines.sections[2].contours, 0, 'missing footprint has no invented rectangular border');
    assert.equal(result.hidden.sectionOutlines.visibleCount, 1);
    assert.deepEqual(result.hidden.placements, result.initial.placements);
    assert.equal(result.outsideRange.sectionOutlines.visibleCount, 0);
    assert.equal(result.rangeOnly.sectionOutlines.visibleCount, 1);
    assert.equal(result.rebuilt.sectionOutlines.availableCount, 1);
    for (const item of result.disposedBeforeShutdown.slice(0, 3)) {
      assert.equal(item.geometry, item.lines); assert.equal(item.material, item.lines);
    }
    for (const item of result.disposed) {
      assert.equal(item.geometry, item.lines); assert.equal(item.material, item.lines);
    }
    assert.equal(result.allHidden, true);
    assert.equal(result.finalStats.sectionOutlines.sections.length, 0);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('older renderer fixtures without the outline script continue to work', async () => {
  const h = await startBrowserHarness();
  try {
    await load(h, { helper: false, overlay: false });
    const result = await h.page.evaluate(() => {
      const host = outlineHost(), renderer = Stack3DRenderer.createRenderer(host);
      renderer.setSections([outlineFixture()]); renderer.setSectionOutlines({ visible: true });
      const stats = renderer.getStats(); renderer.capturePNG(); renderer.dispose(); host.remove(); return stats;
    });
    assert.equal(result.sectionOutlines.availableCount, 0);
    assert.equal(result.sectionOutlines.sections[0].reason, 'outline-module-unavailable');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
