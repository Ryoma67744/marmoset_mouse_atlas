'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');
const ANALYTES = ['GABA-DPP', 'Histamine-DPP', 'Dopamine-DPP', 'Norepinephrine-DPP', 'Serotonin-DPP', 'Serotonin-d4-DPP'];

async function seedSeries(h) {
  await seedViewerProject(h.page, h.baseURL, { id: 'marmoset-one' });
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};'
  }));
  await h.page.evaluate(async analytes => {
    const legacy = await ProjectStorage.getProject('marmoset-one');
    legacy.displayName = 'Cor_1_1'; legacy.grid.umPerPxX = 150; legacy.grid.umPerPxY = 150;
    await ProjectStorage.putProject(legacy);
    // Multiple legacy sections expose the camera error caused by fitting
    // against the previous mouse series' pixel-unit spacing.
    await ProjectStorage.putProject({ ...legacy, id: 'marmoset-two', displayName: 'Cor_1_2' });
    for (let number = 48; number >= 1; number--) {
      const project = {
        id: `mouse-${number}`, displayName: `Mouse_${String(number).padStart(3, '0')}`, plane: 'coronal',
        atlas: { species: 'mouse', seriesId: 'mouse_tissue_1set', seriesName: 'tissue_1set',
          specimenId: 'tissue_1set', sectionNumber: number, sourceCandidateId: number === 15 ? 'C025' : `candidate-${number}`,
          coordinateMode: 'pixel', physicalSectionSpacing: null, displaySpacing: 2 },
        grid: { W: 12, H: 8, umPerPxX: null, umPerPxY: null }, images: {}, molecules: [],
        rotation: { all: 0, msi: 0, he: 0 }, valueDisplay: { mode: 'raw' },
        stack3d: { coordinateMode: 'pixel', offsetXPx: number === 15 ? -.020565 : 0,
          offsetYPx: number === 15 ? .678034 : 0, rotationDeg: number === 15 ? -91.393457 : 0 }
      };
      for (let channel = 0; channel < analytes.length; channel++) {
        const values = Float32Array.from({ length: 96 }, (_, i) => i < 12 || i >= 84 ? NaN : (i + 1) * (channel + 1) * number);
        project.molecules.push({ key: `MSI_${analytes[channel]}`, name: analytes[channel], analyteId: analytes[channel],
          blobId: await ProjectStorage.putValueRaster(values), stats: MSIRaster.deriveBakeStats(values) });
      }
      await ProjectStorage.putProject(project);
    }
  }, ANALYTES);
}
async function ready(page, count, series) {
  await page.waitForFunction(({ count, series }) => window.__stack3dReady &&
    Atlas3D.seriesId === series && Atlas3D.sections.length === count && Atlas3D.renderer?.getStats().renderCount > 0 &&
    !document.querySelector('#series-select').disabled, { count, series });
}
function assertCameraClose(actual, expected, message) {
  for (const key of ['position', 'target', 'up']) {
    actual[key].forEach((value, index) => assert.ok(Math.abs(value - expected[key][index]) < 1e-8, `${message}: ${key}[${index}]`));
  }
  assert.ok(Math.abs(actual.zoom - expected.zoom) < 1e-8, `${message}: zoom`);
}
async function uncheckAndSwitchBeforeRepaint(page, analyte, series) {
  // Put a repaint and a series change in the same event-loop turn. The old
  // frame/preview must not overwrite the incoming series' saved view.
  await page.evaluate(({ analyte, series }) => {
    if (!window.__seriesInventoryDelay) {
      window.__seriesInventoryDelay = true;
      const listProjects = ProjectStorage.listProjects;
      ProjectStorage.listProjects = async (...args) => {
        // Model a slow local inventory read, leaving an old animation frame
        // time to run while the incoming series is still loading.
        await new Promise(resolve => setTimeout(resolve, 180));
        return listProjects(...args);
      };
    }
    const input = [...document.querySelectorAll('input[name="channel"]')].find(input => input.value === analyte);
    input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true }));
    const select = document.querySelector('#series-select');
    select.value = series; select.dispatchEvent(new Event('change', { bubbles: true }));
  }, { analyte, series });
}

test('mouse series keeps all 48 rigid poses and six channels separate from legacy marmoset state', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seedSeries(h);
    const original = await page.evaluate(() => ProjectStorage.listProjects());
    await page.goto(h.baseURL + '/stack3d/index.html?series=mouse_tissue_1set');
    await ready(page, 48, 'mouse_tissue_1set');
    assert.deepEqual(await page.locator('input[name="channel"]').evaluateAll(inputs => inputs.map(input => input.value)), ANALYTES);
    assert.deepEqual(await page.evaluate(() => Atlas3D.sections.map(s => s.project.atlas.sectionNumber)), Array.from({ length: 48 }, (_, i) => i + 1));
    const stats = await page.evaluate(() => Atlas3D.renderer.getStats());
    assert.equal(stats.coordinateMode, 'pixel'); assert.equal(stats.spacing, 2); assert.equal(stats.sectionCount, 48);
    assert.equal(stats.placements[0].position[2], -47); assert.equal(stats.placements[47].position[2], 47);
    for (let i = 1; i < 48; i++) assert.equal(stats.placements[i].position[2] - stats.placements[i - 1].position[2], 2);
    assert.ok(Math.abs(stats.placements[14].rotationDeg + 91.393457) < 1e-8);
    assert.deepEqual(stats.placements[14].position.slice(0, 2), [-.020565, .678034]);
    assert.equal(await page.locator('#brain-visible').isDisabled(), true);
    assert.equal(await page.locator('#analysis-panel').isVisible(), true);
    assert.equal(await page.locator('#analysis-unavailable').count(), 0);
    assert.equal(await page.locator('#placement-details').isVisible(), false);
    assert.equal(await page.locator('#batch-calculate').isDisabled(), true);
    assert.match(await page.locator('#direction-label').innerText(), /切片番号 1 → 48/);
    assert.match(await page.locator('#spacing-value').innerText(), /2.0 px/);
    await page.locator('input[name="channel"][value="GABA-DPP"]').uncheck();
    await page.waitForFunction(() => Atlas3D.options().channels.length === 5);
    await page.locator('input.section-visible[data-section-id="mouse-2"]').uncheck();
    const mouseCamera = await page.evaluate(() => Atlas3D.renderer.getView());
    await page.locator('#series-select').selectOption('legacy_marmoset');
    await ready(page, 2, 'legacy_marmoset');
    const firstMarmosetFit = await page.evaluate(() => {
      const actual = Atlas3D.renderer.getView();
      Atlas3D.renderer.resetView();
      return { actual, fitted: Atlas3D.renderer.getView() };
    });
    assertCameraClose(firstMarmosetFit.actual, firstMarmosetFit.fitted, 'first visit fits the incoming series at its final spacing');
    const marmosetCamera = await page.evaluate(() => {
      const view = Atlas3D.renderer.getView();
      view.position = view.position.map((value, index) => value + [2.4, -1.2, .7][index]);
      view.target = [.2, -.1, 0]; view.zoom = 1.4;
      Atlas3D.renderer.setView(view);
      return Atlas3D.renderer.getView();
    });
    assert.deepEqual(await page.locator('input[name="channel"]').evaluateAll(inputs => inputs.map(input => input.value)), ['DA', 'NE', '5-HT']);
    assert.equal(await page.locator('#brain-visible').isDisabled(), false);
    assert.equal(await page.locator('#analysis-panel').isVisible(), true);
    await uncheckAndSwitchBeforeRepaint(page, 'DA', 'mouse_tissue_1set');
    await ready(page, 48, 'mouse_tissue_1set');
    assert.equal(await page.locator('input[name="channel"][value="GABA-DPP"]').isChecked(), false);
    assert.equal(await page.locator('input.section-visible[data-section-id="mouse-2"]').isChecked(), false);
    assert.equal(await page.locator('input[name="channel"]:checked').count(), 5);
    assertCameraClose(await page.evaluate(() => Atlas3D.renderer.getView()), mouseCamera, 'saved mouse camera survives the first roundtrip');
    for (let attempt = 0; attempt < 3; attempt++) {
      await uncheckAndSwitchBeforeRepaint(page, 'GABA-DPP', 'legacy_marmoset');
      await ready(page, 2, 'legacy_marmoset');
      assertCameraClose(await page.evaluate(() => Atlas3D.renderer.getView()), marmosetCamera, 'custom marmoset camera survives a series roundtrip');
      assert.equal(await page.locator('input[name="channel"][value="DA"]').isChecked(), false);
      await uncheckAndSwitchBeforeRepaint(page, 'DA', 'mouse_tissue_1set');
      await ready(page, 48, 'mouse_tissue_1set');
      assert.equal(await page.locator('input[name="channel"][value="GABA-DPP"]').isChecked(), false);
      assert.equal(await page.locator('input.section-visible[data-section-id="mouse-2"]').isChecked(), false);
    }
    await page.reload(); await ready(page, 48, 'mouse_tissue_1set');
    assert.equal(await page.locator('input[name="channel"][value="GABA-DPP"]').isChecked(), false);
    assert.deepEqual(await page.evaluate(() => ProjectStorage.listProjects()), original, 'view changes must not rewrite source projects or saved transforms');
    await page.evaluate(async () => {
      const duplicate = await ProjectStorage.getProject('mouse-1');
      duplicate.id = 'mouse-duplicate'; duplicate.displayName = 'Mouse duplicate number 1';
      await ProjectStorage.putProject(duplicate);
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#scene-message strong')?.textContent === '切片番号が重複しています');
    assert.equal(await page.locator('#series-select').isEnabled(), true, 'an invalid series must not trap the user');
    await page.locator('#series-select').selectOption('legacy_marmoset');
    await ready(page, 2, 'legacy_marmoset');
    assert.equal(await page.locator('input[name="channel"][value="DA"]').isChecked(), false);
    assert.equal(await page.evaluate(() => Atlas3D.sections[0].id), 'marmoset-one', 'duplicate mouse numbers must not block a different series');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
