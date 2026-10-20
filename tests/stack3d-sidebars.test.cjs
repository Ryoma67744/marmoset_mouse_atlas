'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');
const { seedAnalysisStack, readyAnalysisStack, scientificSnapshot } = require('./stack3d-analysis-fixture.cjs');

async function paint(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
const size = (page, selector) => page.locator(selector).evaluate(node => {
  const rect = node.getBoundingClientRect(); return { width: rect.width, height: rect.height };
});
async function sidebarState(page, expected) {
  await paint(page);
  assert.deepEqual(await page.evaluate(() => Atlas3DSidebars.getState()), expected);
  for (const name of ['controls', 'section']) {
    assert.equal(await page.locator('#' + name + '-body').isVisible(), !expected[name]);
    assert.equal(await page.locator('#' + name + '-body').evaluate(node => node.inert), expected[name]);
    assert.equal(await page.locator('#' + name + '-toggle').getAttribute('aria-expanded'), String(!expected[name]));
    assert.equal(await page.locator('#' + name + '-toggle').isVisible(), true);
  }
}

test('independent sidebars preserve preview width, camera, selection and scientific data through analysis focus', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await seedAnalysisStack(h, { count: 5 });
    const source = await scientificSnapshot(page);
    await page.goto(h.baseURL + '/stack3d/index.html'); await readyAnalysisStack(page, 5);
    const before = await page.evaluate(() => ({ camera: Atlas3D.renderer.getView(), selected: Atlas3D.selected,
      result: JSON.stringify(Atlas3D.analysis.getState().result), generation: Atlas3D.analysis.getState().generation }));
    const preview = await size(page, '#section-preview');
    await page.locator('#section-resizer').focus(); await page.keyboard.press('Shift+ArrowLeft'); await paint(page);
    const expanded = await size(page, '#section-panel'), scene = await size(page, '.scene-panel');
    assert.deepEqual(await size(page, '#section-preview'), preview);
    await page.locator('#controls-toggle').click(); await sidebarState(page, { controls: true, section: false });
    assert.equal((await size(page, '#controls-panel')).width, 44);
    assert.ok((await size(page, '.scene-panel')).width > scene.width + 200);
    await page.locator('#section-toggle').click(); await sidebarState(page, { controls: true, section: true });
    assert.equal((await size(page, '#section-panel')).width, 44);
    assert.equal(await page.locator('#section-resizer').isVisible(), false);
    assert.equal(await page.locator('#section-resizer').getAttribute('tabindex'), '-1');
    assert.ok((await size(page, '.scene-panel')).width > scene.width + 500);
    await page.locator('#analysis-focus').click(); await paint(page);
    assert.equal(await page.locator('#controls-toggle').isVisible(), false);
    assert.equal(await page.locator('#section-toggle').isVisible(), false);
    await page.keyboard.press('Escape'); await sidebarState(page, { controls: true, section: true });
    // Restoring one side must not expand the other one.
    await page.locator('#controls-toggle').click(); await sidebarState(page, { controls: false, section: true });
    await page.locator('#section-toggle').focus(); await page.keyboard.press('Enter');
    await sidebarState(page, { controls: false, section: false });
    assert.deepEqual(await size(page, '#section-panel'), expanded);
    assert.deepEqual(await size(page, '#section-preview'), preview);
    assert.equal(await page.locator('#section-resizer').isVisible(), true);
    assert.equal(await page.locator('#section-resizer').getAttribute('tabindex'), '0');
    const after = await page.evaluate(() => ({ camera: Atlas3D.renderer.getView(), selected: Atlas3D.selected,
      result: JSON.stringify(Atlas3D.analysis.getState().result), generation: Atlas3D.analysis.getState().generation }));
    for (const key of ['position', 'target', 'up']) before.camera[key].forEach((value, i) => assert.ok(Math.abs(value - after.camera[key][i]) < 1e-8));
    assert.equal(after.camera.zoom, before.camera.zoom);
    assert.deepEqual({ ...after, camera: null }, { ...before, camera: null });
    assert.deepEqual(await scientificSnapshot(page), source); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('sidebar preferences survive reload and desktop/mobile transitions without page overflow or hidden keyboard targets', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seedAnalysisStack(h, { count: 5 });
    await page.goto(h.baseURL + '/stack3d/index.html'); await readyAnalysisStack(page, 5);
    await page.locator('#controls-toggle').click(); await page.locator('#section-toggle').click();
    await page.reload(); await readyAnalysisStack(page, 5);
    await sidebarState(page, { controls: true, section: true });
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 761, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); await sidebarState(page, { controls: true, section: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), viewport.width);
      assert.equal(await page.locator('#section-resizer').isVisible(), false);
      await page.locator('#controls-toggle').focus(); await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('#controls-body,#section-body')), false);
    }
    await page.locator('#controls-toggle').click(); await page.locator('#section-toggle').click();
    await sidebarState(page, { controls: false, section: false });
    assert.equal(await page.locator('#section-resizer').isVisible(), false, 'no width handle on mobile');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await page.setViewportSize({ width: 1366, height: 900 }); await paint(page);
    assert.equal(await page.locator('#section-resizer').isVisible(), true);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('sidebar preferences stay shared when switching between marmoset and pixel-coordinate mouse', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seedAnalysisStack(h, { count: 5 });
    await page.evaluate(async () => {
      const values = Float32Array.from({ length: 96 }, (_, i) => i + 1);
      await ProjectStorage.putProject({
        id: 'sidebar-mouse', displayName: 'Mouse_001', plane: 'coronal', images: {},
        atlas: { species: 'mouse', seriesId: 'sidebar-mouse', seriesName: 'Sidebar mouse', sectionNumber: 1,
          coordinateMode: 'pixel', displaySpacing: 2 },
        grid: { W: 12, H: 8, umPerPxX: null, umPerPxY: null },
        valueDisplay: { mode: 'raw' }, rotation: { all: 0, msi: 0, he: 0 },
        molecules: [{ key: 'MSI_Dopamine-DPP', name: 'Dopamine-DPP', analyteId: 'Dopamine-DPP',
          blobId: await ProjectStorage.putValueRaster(values), stats: MSIRaster.deriveBakeStats(values) }]
      });
    });
    await page.goto(h.baseURL + '/stack3d/index.html'); await readyAnalysisStack(page, 5);
    await page.locator('#section-toggle').click();
    for (const series of ['sidebar-mouse', 'legacy_marmoset']) {
      await page.locator('#series-select').selectOption(series);
      await page.waitForFunction(series => window.__stack3dReady && Atlas3D.seriesId === series && !document.querySelector('#series-select').disabled, series);
      await sidebarState(page, { controls: false, section: true });
    }
    await page.locator('#controls-toggle').click(); await page.reload(); await readyAnalysisStack(page, 5);
    await sidebarState(page, { controls: true, section: true });
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
