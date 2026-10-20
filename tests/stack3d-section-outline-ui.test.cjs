'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');

async function seed(h, { mouseCount = 48, fullGrid = false } = {}) {
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};'
  }));
  await h.page.goto(h.baseURL + '/__test_seed');
  await h.page.evaluate(async ({ mouseCount, fullGrid }) => {
    const W = 16, H = 12;
    for (let number = 0; number <= mouseCount; number++) {
      const mouse = number > 0;
      const project = {
        id: mouse ? `outline-mouse-${number}` : 'outline-marmoset', displayName: mouse ? `Mouse ${number}` : 'Cor_1_1',
        plane: 'coronal', grid: { W, H, umPerPxX: mouse ? null : 120, umPerPxY: mouse ? null : 150 },
        images: {}, molecules: [], rotation: { all: 0, msi: 0, he: 0 }, valueDisplay: { mode: 'raw' },
        roi: { roi_items: { middle: [{ poly_msi: [[6, 4], [10, 4], [10, 8], [6, 8]] }] },
          roi_names: { middle: 'Middle' }, roi_show_flags: { middle: true } },
        ...(mouse ? {
          atlas: { species: 'mouse', seriesId: 'mouse_outline_test', seriesName: 'Mouse outline test',
            sectionNumber: number, coordinateMode: 'pixel', displaySpacing: 2 },
          stack3d: { coordinateMode: 'pixel', offsetXPx: number / 10, offsetYPx: -number / 20, rotationDeg: number }
        } : {})
      };
      for (const [channel, name] of (mouse ? ['Dopamine-DPP', 'Serotonin-DPP'] : ['DA', '5-HT']).entries()) {
        const values = Float32Array.from({ length: W * H }, (_, i) => {
          const x = i % W, y = Math.floor(i / W);
          if (!fullGrid && ((x - 7.5) ** 2 / 42 + (y - 5.5) ** 2 / 20 > 1)) return NaN;
          // Zero-valued measured pixels are deliberately included.
          return i % 7 === 0 ? 0 : (i + 1) * (channel + 1) * (number + 1);
        });
        project.molecules.push({ key: `MSI_${name}`, name, analyteId: name,
          blobId: await ProjectStorage.putValueRaster(values), stats: MSIRaster.deriveBakeStats(values) });
      }
      await ProjectStorage.putProject(project);
    }
  }, { mouseCount, fullGrid });
}
async function ready(page, series, count) {
  try {
    await page.waitForFunction(({ series, count }) => window.__stack3dReady && Atlas3D.seriesId === series &&
      Atlas3D.sections.length === count && Atlas3D.renderer?.getStats().renderCount > 0 &&
      !document.querySelector('#series-select').disabled, { series, count });
  } catch (error) {
    const detail = await page.evaluate(() => ({
      ready: window.__stack3dReady, series: window.Atlas3D?.seriesId, count: window.Atlas3D?.sections.length,
      notice: document.querySelector('#notice')?.textContent, renderError: document.querySelector('#render-error-text')?.textContent,
      stats: window.Atlas3D?.renderer?.getStats()
    }));
    throw new Error(error.message + '\n' + JSON.stringify(detail));
  }
}
async function input(page, id, value) {
  await page.locator('#' + id).evaluate((element, value) => {
    element.value = value; element.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(value));
}
async function stats(page) { return page.evaluate(() => Atlas3D.renderer.getStats().sectionOutlines); }
async function sourceSnapshot(page) {
  return page.evaluate(async () => {
    const projects = await ProjectStorage.listProjects(), bytes = {};
    for (const project of projects) for (const molecule of project.molecules) {
      const values = await ProjectStorage.getValueRaster(molecule.blobId);
      bytes[molecule.blobId] = Array.from(new Uint8Array(values.buffer));
    }
    return { projects, bytes };
  });
}

test('section outlines have independent controls, follow slice visibility, and restore per-series session settings without changing data', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h);
    const original = await sourceSnapshot(page);
    await page.goto(h.baseURL + '/stack3d/index.html?series=mouse_outline_test');
    await ready(page, 'mouse_outline_test', 48);
    const initial = await stats(page);
    assert.equal(initial.availableCount, 48);
    assert.equal(initial.visibleCount, 48);
    assert.equal(initial.visible, true);
    assert.equal(initial.color, '#ff3b30');
    assert.equal(initial.opacity, 0.8);
    assert.match(await page.locator('#section-outline-status').textContent(), /取得 48 \/ 48切片 · 表示 48切片/);
    assert.match(await page.locator('#section-outline-help').textContent(), /分子・閾値・ROI選択には依存しません/);
    const originalGeometry = initial.sections.map(({ id, contours, pixelCount, position, rotationDeg }) => ({ id, contours, pixelCount, position, rotationDeg }));

    await page.locator('#section-outline-visible').uncheck();
    assert.equal((await stats(page)).visibleCount, 0);
    assert.equal(await page.locator('#section-outline-color').isDisabled(), true);
    assert.equal(await page.locator('#section-outline-opacity').isDisabled(), true);
    await page.locator('#section-outline-visible').check();
    await input(page, 'section-outline-color', '#00dd88');
    await input(page, 'section-outline-opacity', 0.42);
    assert.equal((await stats(page)).color, '#00dd88');
    assert.equal((await stats(page)).opacity, 0.42);
    assert.equal(await page.locator('#section-outline-opacity-value').textContent(), '42%');

    // Display-only filters cannot recompute or hide the complete section edge.
    await page.locator('input[name=channel]').evaluateAll(inputs => inputs.forEach(element => {
      element.checked = false; element.dispatchEvent(new Event('change', { bubbles: true }));
    }));
    await input(page, 'threshold', 0.9);
    await page.locator('#roi-clear-all').click();
    await page.locator('#roi-visible').uncheck();
    await page.waitForFunction(() => !document.querySelector('#save-image').disabled);
    const filtered = await stats(page);
    assert.equal(filtered.visibleCount, 48);
    assert.deepEqual(filtered.sections.map(({ id, contours, pixelCount, position, rotationDeg }) => ({ id, contours, pixelCount, position, rotationDeg })), originalGeometry);

    await page.locator('#range-end').fill('3'); await page.locator('#range-end').press('Tab');
    await page.waitForFunction(() => Atlas3D.renderer.getStats().sectionOutlines.visibleCount === 3);
    await page.locator('.section-visible[data-section-id="outline-mouse-2"]').uncheck();
    assert.equal((await stats(page)).visibleCount, 2);
    assert.match(await page.locator('#section-outline-status').textContent(), /表示 2切片/);
    await page.locator('#section-outline-visible').uncheck();

    await page.locator('#series-select').selectOption('legacy_marmoset'); await ready(page, 'legacy_marmoset', 1);
    assert.equal(await page.locator('#section-outline-visible').isChecked(), true);
    assert.equal(await page.locator('#section-outline-color').inputValue(), '#ff3b30');
    assert.equal(await page.locator('#section-outline-opacity').inputValue(), '0.8');
    assert.equal((await stats(page)).availableCount, 1);
    await input(page, 'section-outline-color', '#3366ff');
    await input(page, 'section-outline-opacity', 0.65);
    await page.locator('#series-select').selectOption('mouse_outline_test'); await ready(page, 'mouse_outline_test', 48);
    assert.equal(await page.locator('#section-outline-visible').isChecked(), false);
    assert.equal(await page.locator('#section-outline-color').inputValue(), '#00dd88');
    assert.equal(await page.locator('#section-outline-opacity').inputValue(), '0.42');
    assert.equal((await stats(page)).visibleCount, 0);
    await page.reload(); await ready(page, 'mouse_outline_test', 48);
    assert.equal(await page.locator('#section-outline-visible').isChecked(), false);
    assert.equal((await stats(page)).color, '#00dd88');
    assert.equal((await stats(page)).opacity, 0.42);
    const persisted = await page.evaluate(() => JSON.parse(sessionStorage.getItem('atlas-stack3d-view-v1:mouse_outline_test')).sectionOutlines);
    assert.deepEqual(persisted, { visible: false, color: '#00dd88', opacity: 0.42 });
    await page.locator('#series-select').selectOption('legacy_marmoset'); await ready(page, 'legacy_marmoset', 1);
    assert.equal((await stats(page)).color, '#3366ff');
    assert.equal((await stats(page)).opacity, 0.65);
    assert.deepEqual(await sourceSnapshot(page), original, 'outline controls must not alter source rasters, metadata, ROI or placements');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('a fully measured rectangular grid reports an unknown edge instead of fabricating a tissue outline', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h, { mouseCount: 1, fullGrid: true });
    await page.goto(h.baseURL + '/stack3d/index.html?series=mouse_outline_test');
    await ready(page, 'mouse_outline_test', 1);
    const result = await stats(page);
    assert.equal(result.availableCount, 0);
    assert.equal(result.visibleCount, 0);
    assert.equal(result.sections[0].contours, 0);
    assert.match(await page.locator('#section-outline-status').textContent(), /外周を取得できません/);
    await page.locator('#section-outline-visible').uncheck();
    await page.locator('#section-outline-visible').check();
    await input(page, 'section-outline-color', '#112233');
    assert.equal((await stats(page)).visibleCount, 0);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
