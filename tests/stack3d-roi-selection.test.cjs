'use strict';
// Synthetic measured pixels only; the harness has no access to user projects.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');

async function seed(h, { emptyMouse = false, legacySelection = false } = {}) {
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};'
  }));
  await h.page.goto(h.baseURL + '/__test_seed');
  await h.page.evaluate(async ({ emptyMouse, legacySelection }) => {
    const column = x => ({ poly_msi: [[x - .5, -.5], [x + .5, -.5], [x + .5, 6.5], [x - .5, 6.5]] });
    for (const mouse of [false, true]) {
      const p = { id: mouse ? 'mouse-roi' : 'legacy-roi', displayName: mouse ? 'Mouse 1' : 'Cor_1_1', plane: 'coronal',
        grid: { W: 9, H: 7, umPerPxX: mouse ? null : 150, umPerPxY: mouse ? null : 150 },
        images: {}, molecules: [], rotation: { all: 0, msi: 0, he: 0 },
        roi: mouse && emptyMouse ? {} : { roi_items: {
          visible: [column(2), { poly_msi: [[1.5, 1.5], [2.5, 1.5], [2.5, 3.5], [1.5, 3.5]] }],
          hiddenSameName: [column(3)], hiddenOther: [column(4)] },
          roi_names: { visible: 'A', hiddenSameName: 'A', hiddenOther: 'Hidden' },
          roi_show_flags: { hiddenSameName: false, hiddenOther: false } } };
      if (mouse) p.atlas = { seriesId: 'mouse_tissue_1set', seriesName: 'tissue_1set', species: 'mouse',
        coordinateMode: 'pixel', sectionNumber: 1, displaySpacing: 2 };
      const names = mouse ? ['GABA-DPP', 'Histamine-DPP', 'Dopamine-DPP', 'Norepinephrine-DPP', 'Serotonin-DPP', 'Serotonin-d4-DPP'] : ['DA', 'NE', '5-HT'];
      const rasters = {};
      for (const [index, name] of names.entries()) {
        const values = Float32Array.from({ length: 63 }, (_, i) => i === 33 ? NaN : (index + 1) * (i + 1));
        if (name === 'Serotonin-d4-DPP') { values[23] = 0; values[32] = 0; }
        const key = 'MSI_' + name;
        p.molecules.push({ key, name, analyteId: name, blobId: await ProjectStorage.putValueRaster(values), stats: MSIRaster.deriveBakeStats(values) });
        rasters[key] = { W: 9, H: 7, values };
      }
      if (mouse) p.normalization = Normalization.createPixelRatioProfile(p, rasters, {
        id: 'synthetic-roi-ratio', revision: 1, standardKey: 'MSI_Serotonin-d4-DPP',
        targetKeys: p.molecules.slice(0, 5).map(m => m.key), standardApplication: { method: 'uniform_spray', confirmed: true }
      });
      await ProjectStorage.putProject(p);
    }
    if (legacySelection) sessionStorage.setItem('atlas-stack3d-view-v1', JSON.stringify({
      ids: ['legacy-roi'], roi: { regions: ['A'] }, options: { mode: 'raw' }
    }));
  }, { emptyMouse, legacySelection });
}

async function ready(page, series) {
  await page.waitForFunction(series => window.__stack3dReady && Atlas3D.seriesId === series && Atlas3D.sections.length === 1 &&
    !document.querySelector('#series-select').disabled && Atlas3D.renderer?.getStats().renderCount > 0, series);
}
async function waitPixels(page, expected) {
  await page.waitForFunction(expected => {
    const c = Atlas3D.rendered[0]?.canvas;
    if (!c) return false;
    return expected.every(([x, y, visible]) => (c.getContext('2d').getImageData(x, y, 1, 1).data[3] > 0) === visible);
  }, expected);
}
async function snapshot(page) {
  return page.evaluate(async () => {
    const projects = await ProjectStorage.listProjects(), raw = [];
    for (const p of projects) for (const m of p.molecules) {
      const values = await ProjectStorage.getValueRaster(m.blobId);
      raw.push([p.id, m.key, Array.from(new Uint8Array(values.buffer, values.byteOffset, values.byteLength))]);
    }
    return { projects, raw };
  });
}
async function waitPreview(page, expected) {
  await page.waitForFunction(expected => {
    const canvas = document.querySelector('#section-preview canvas'), section = Atlas3D.sections[0];
    if (!canvas || !section || document.querySelector('#section-preview').dataset.previewKind !== 'MSI') return false;
    const angle = section.angleDeg * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const scale = canvas.width / (Math.abs(section.W * c) + Math.abs(section.H * s));
    return expected.every(([x, y, visible]) => {
      const dx = x + .5 - section.W / 2, dy = y + .5 - section.H / 2;
      const px = Math.floor(canvas.width / 2 + (c * dx - s * dy) * scale);
      const py = Math.floor(canvas.height / 2 + (s * dx + c * dy) * scale);
      return (canvas.getContext('2d').getImageData(px, py, 1, 1).data[3] > 0) === visible;
    });
  }, expected);
}

test('old same-name hidden ROI selection stays exact while unassigned pixels are restored independently', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h, { legacySelection: true }); const before = await snapshot(page);
    await page.goto(h.baseURL + '/stack3d/index.html?series=legacy_marmoset'); await ready(page, 'legacy_marmoset');
    const ranges = await page.evaluate(() => Atlas3D.rendered[0].ranges);
    await waitPixels(page, [[2, 3, true], [3, 3, false], [4, 3, false], [5, 3, false]]);
    assert.equal(await page.locator('input[name="roi-region"][value="A"]').evaluate(input => input.indeterminate), true);
    assert.equal(await page.locator('input[name="roi-region"][value="Hidden"]').count(), 1, 'saved hidden annotations are selectable MSI regions');
    await page.locator('#roi-unassigned').check();
    await waitPixels(page, [[2, 3, true], [3, 3, false], [4, 3, false], [5, 3, true]]);
    await page.reload(); await ready(page, 'legacy_marmoset');
    assert.equal(await page.locator('#roi-unassigned').isChecked(), true);
    assert.deepEqual(await page.evaluate(() => Atlas3D.options().roiLegacyVisibleOnlyNames), ['A']);
    await waitPixels(page, [[3, 3, false], [4, 3, false], [5, 3, true]]);
    await page.locator('input[name="roi-region"][value="A"]').uncheck();
    await page.locator('input[name="roi-region"][value="A"]').check();
    await waitPixels(page, [[2, 3, true], [3, 3, true], [4, 3, false], [5, 3, true]]);
    assert.deepEqual(await page.evaluate(() => Atlas3D.options().roiLegacyVisibleOnlyNames), []);
    assert.equal(await page.evaluate(() => Atlas3D.renderer.getStats().roi[0].contours), 2, 'source-hidden contours stay hidden');
    await page.locator('input[name="roi-region"][value="Hidden"]').check();
    await waitPixels(page, [[4, 3, true]]);
    assert.equal(await page.evaluate(() => Atlas3D.renderer.getStats().roi[0].contours), 2);
    await page.locator('#roi-clear-all').click();
    await page.waitForFunction(() => Atlas3D.rendered[0].status.visiblePixels === 0);
    await page.locator('#roi-unassigned').check();
    const outsideOnly = [[2, 3, false], [3, 3, false], [4, 3, false], [5, 3, true]];
    await waitPixels(page, outsideOnly); await waitPreview(page, outsideOnly);
    assert.equal(await page.evaluate(() => Atlas3D.renderer.getStats().roi[0].contours), 0);
    await page.locator('#roi-select-all').click();
    await waitPixels(page, [[2, 3, true], [3, 3, true], [4, 3, true], [5, 3, true]]);
    assert.equal(await page.locator('#roi-unassigned').isChecked(), true);
    assert.deepEqual(await page.evaluate(() => Atlas3D.rendered[0].ranges), ranges);
    assert.deepEqual(await snapshot(page), before); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('zero-ROI mouse can recover after clear and retains its independent state across species switches', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h, { emptyMouse: true });
    await page.goto(h.baseURL + '/stack3d/index.html?series=legacy_marmoset'); await ready(page, 'legacy_marmoset');
    await page.locator('#roi-clear-all').click(); await page.locator('input[name="roi-region"][value="A"]').check();
    await page.locator('#series-select').selectOption('mouse_tissue_1set'); await ready(page, 'mouse_tissue_1set');
    assert.equal(await page.locator('input[name="roi-region"]').count(), 0);
    assert.equal(await page.locator('#roi-unassigned').isEnabled(), true);
    await page.locator('#roi-clear-all').click(); await page.waitForFunction(() => Atlas3D.rendered[0].status.visiblePixels === 0);
    await page.locator('#roi-unassigned').check(); await page.waitForFunction(() => Atlas3D.rendered[0].status.visiblePixels === 14);
    await page.locator('#series-select').selectOption('legacy_marmoset'); await ready(page, 'legacy_marmoset');
    assert.deepEqual(await page.evaluate(() => Atlas3D.options().roiRegions), ['A']);
    assert.equal(await page.locator('#roi-unassigned').isChecked(), false);
    await page.locator('#series-select').selectOption('mouse_tissue_1set'); await ready(page, 'mouse_tissue_1set');
    assert.deepEqual(await page.evaluate(() => Atlas3D.options().roiRegions), []);
    assert.equal(await page.locator('#roi-unassigned').isChecked(), true);
    await page.reload(); await ready(page, 'mouse_tissue_1set');
    assert.equal(await page.evaluate(() => Atlas3D.rendered[0].status.visiblePixels), 14);
    await page.locator('#roi-clear-all').click(); await page.locator('#roi-select-all').click();
    await page.waitForFunction(() => Atlas3D.rendered[0].status.visiblePixels === 14);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('unassigned mouse display preserves d4 invalid pixels, outer two-pixel masking, P99 and source values', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); const before = await snapshot(page);
    await page.goto(h.baseURL + '/stack3d/index.html?series=mouse_tissue_1set'); await ready(page, 'mouse_tissue_1set');
    const baseline = await page.evaluate(() => ({ status: Atlas3D.rendered[0].status,
      gray: Array.from(Atlas3D.rendered[0].canvas.getContext('2d').getImageData(5, 3, 1, 1).data),
      values: Object.fromEntries(Object.entries(Atlas3D.sections[0].channels).map(([key, channel]) => [key, channel.normalized ? Array.from(channel.normalized) : null])) }));
    assert.equal(baseline.status.visiblePixels, 14); assert.equal(baseline.status.edgeHiddenPixels, 48);
    assert.equal(baseline.status.invalidPixels, 2);
    await page.locator('#roi-clear-all').click(); await page.locator('#roi-unassigned').check();
    await page.waitForFunction(() => Atlas3D.rendered[0].status.visiblePixels === 5);
    await waitPreview(page, [[2, 3, false], [3, 3, false], [4, 3, false], [5, 3, true], [6, 3, false]]);
    const state = await page.evaluate(() => {
      const canvas = Atlas3D.rendered[0].canvas;
      return { status: Atlas3D.rendered[0].status,
        gray: Array.from(canvas.getContext('2d').getImageData(5, 3, 1, 1).data),
        edge: canvas.getContext('2d').getImageData(5, 1, 1, 1).data[3] };
    });
    assert.deepEqual(state.gray, baseline.gray, 'invalid-pixel appearance is unchanged');
    assert.equal(state.gray[0], state.gray[1]); assert.equal(state.gray[1], state.gray[2]); assert.ok(state.gray[3] > 0);
    assert.equal(state.edge, 0);
    assert.equal(state.status.edgeHiddenPixels, 48); assert.equal(state.status.invalidPixels, 2);
    assert.deepEqual(state.status.ranges, baseline.status.ranges);
    await page.locator('#roi-select-all').click(); await page.waitForFunction(() => Atlas3D.rendered[0].status.visiblePixels === 14);
    assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.entries(Atlas3D.sections[0].channels).map(([key, channel]) => [key, channel.normalized ? Array.from(channel.normalized) : null]))), baseline.values);
    // Complete annotation leaves no unassigned pixels; missing acquisition
    // samples and overlapping polygons never become visible background.
    const full = await page.evaluate(() => {
      const section = Atlas3D.sections[0], covered = { ...section, project: { ...section.project,
        roi: { roi_items: { whole: [{ poly_msi: [[-.5, -.5], [8.5, -.5], [8.5, 6.5], [-.5, 6.5]] }] } } } };
      const result = Stack3D.renderSection(covered, { ...Atlas3D.options(), rangeMode: 'individual', roiRegions: [], roiIncludeUnassigned: true });
      const count = result.status.visiblePixels;
      result.canvas.width = 0; result.previewCanvas.width = 0; return count;
    });
    assert.equal(full, 0);
    assert.deepEqual(await snapshot(page), before); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
