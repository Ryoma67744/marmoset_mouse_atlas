'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

const registrationOrder = ['empty', 'steady', 'skewed', 'steady-tie'];
const steadyFirst = ['steady', 'steady-tie', 'skewed', 'empty'];
const skewedFirst = ['skewed', 'steady', 'steady-tie', 'empty'];

async function openSortingProject(h, id) {
  await seedViewerProject(h.page, h.baseURL, { id });
  await h.page.evaluate(async id => {
    const project = await ProjectStorage.getProject(id);
    const first = [{ poly_msi: [[0, 0], [4, 0], [4, 1], [0, 1]] }];
    const second = [{ poly_msi: [[0, 1], [4, 1], [4, 2], [0, 2]] }];
    project.roi = {
      roi_items: { empty: [], steady: first, skewed: second, 'steady-tie': structuredClone(first) },
      roi_names: { empty: 'Empty ROI', steady: 'Steady region', skewed: 'Skewed region', 'steady-tie': 'Equal steady region' },
      palette: {}, roi_show_flags: {},
    };
    const rasters = await Normalization.loadRasters(project, { storage: ProjectStorage });
    for (const [key, source] of [
      ['MSI_5-HT', [10, 10, 10, 10, 1, 1, 1, 100]],
      ['MSI_DA', [1, 1, 1, 100, 10, 10, 10, 10]],
    ]) {
      rasters[key].values = new Float32Array(source);
      const molecule = project.molecules.find(item => item.key === key);
      molecule.blobId = await ProjectStorage.putValueRaster(rasters[key].values);
      molecule.stats = MSIRaster.deriveBakeStats(rasters[key].values);
    }
    project.normalization = Normalization.createProfiles([{ project, rasters, mapping: Normalization.suggestMapping(project.molecules) }], {
      id: 'sorting-profile', revision: 1, batchId: 'batch', prepId: 'prep', quality: 'provisional',
      coordinateMatchConfirmed: true, comparabilityConfirmed: true,
      qc: { minD4: 0, saturationD4: 1000, minCoverage: 0.8 },
      reference: { kind: 'whole_tissue', projectIds: [id], roiNames: [] },
    }).profiles[0].normalization;
    await ProjectStorage.putProject(project);
  }, id);
  await h.page.goto(h.baseURL + '/viewer/index.html?project=' + id);
  await h.page.waitForFunction(() => typeof viewerReady !== 'undefined' && viewerReady);
  await capturePlots(h.page);
}

async function capturePlots(page) {
  await page.evaluate(() => {
    window.sortingPlots = {};
    const original = IntensityBoxPlot.draw;
    IntensityBoxPlot.draw = (canvas, options) => {
      const result = original(canvas, options);
      sortingPlots[canvas.closest('[data-channel]').dataset.channel] = { options, result };
      return result;
    };
    document.getElementById('graph-select-1').value = 'MSI_5-HT';
    document.getElementById('graph-select-2').value = 'MSI_DA';
    document.getElementById('graph-select-3').value = 'none';
  });
  await page.locator('.roi-item[data-roi-key="steady"]').click();
}

async function assertOrder(page, ht, da) {
  for (const [channel, expected] of [['MSI_5-HT', ht], ['MSI_DA', da]]) {
    const actual = await page.evaluate(channel => ({
      plot: sortingPlots[channel].options.rois.map(roi => roi.key),
      table: Array.from(document.querySelector(`.analysis-section[data-channel="${channel}"]`).querySelectorAll('tr[data-roi-key]'), row => row.dataset.roiKey),
    }), channel);
    assert.deepEqual(actual, { plot: expected, table: expected }, channel);
  }
}

const sourceSnapshot = page => page.evaluate(() => ({
  roi: structuredClone(atlasData.roi),
  normalization: structuredClone(currentProject.normalization),
  bits: Object.fromEntries(Object.entries(valueRasters).map(([key, raster]) => [key, Array.from(new Uint32Array(raster.values.buffer))])),
}));

const statsSnapshot = page => page.evaluate(() => Object.fromEntries(
  Array.from(document.querySelectorAll('.analysis-section'), section => [section.dataset.channel, Object.fromEntries(
    Array.from(section.querySelectorAll('tr[data-roi-key]'), row => [row.dataset.roiKey,
      Array.from(row.querySelectorAll('[data-field]'), cell => cell.textContent)]))])));

test('2D graph ordering ranks each molecule by full ROI mean or median, keeps unavailable rows last, and leaves statistics intact', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), { page } = h;
  try {
    await openSortingProject(h, 'viewer-analysis-order');
    const sort = page.getByLabel('並び順', { exact: true });
    assert.equal(await sort.inputValue(), 'registration');
    await assertOrder(page, registrationOrder, registrationOrder);
    const before = await sourceSnapshot(page);
    for (const mode of ['normalized', 'raw', 'normalized']) {
      await page.locator('#value-' + mode).click();
      const values = await statsSnapshot(page);
      await sort.selectOption('median');
      await assertOrder(page, steadyFirst, skewedFirst);
      await sort.selectOption('mean');
      await assertOrder(page, skewedFirst, steadyFirst);
      assert.deepEqual(await statsSnapshot(page), values, mode + ' statistics must not change when reordered');
      const skewedMean = await page.locator('.analysis-section[data-channel="MSI_5-HT"] tr[data-roi-key="skewed"] [data-field="mean"]').innerText();
      assert.equal(Number(skewedMean.split(' ± ')[0]), mode === 'raw' ? 25.75 : 12.875);
      await sort.selectOption('registration');
      await assertOrder(page, registrationOrder, registrationOrder);
    }
    assert.deepEqual(await sourceSnapshot(page), before);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('2D sorting preserves ROI selection identity and keyboard focus, filters hidden regions, and restores the display preference', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), { page } = h;
  try {
    await openSortingProject(h, 'viewer-analysis-order-interaction');
    await page.locator('#graph-sort').selectOption('mean');
    assert.equal(await page.locator('.roi-item.active').getAttribute('data-roi-key'), 'steady');
    await page.evaluate(() => {
      const canvas = document.querySelector('.analysis-section[data-channel="MSI_5-HT"] canvas');
      const rect = canvas.getBoundingClientRect(), group = sortingPlots['MSI_5-HT'].result.groups[0];
      canvas.onclick({ clientX: rect.left + group.center, clientY: rect.top + 100 });
    });
    assert.equal(await page.locator('.roi-item.active').getAttribute('data-roi-key'), 'skewed');
    await page.locator('.analysis-section[data-channel="MSI_DA"] tr[data-roi-key="steady-tie"] button').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.roi-item.active').getAttribute('data-roi-key'), 'steady-tie');
    assert.equal(await page.evaluate(() => document.activeElement.closest('tr')?.dataset.roiKey), 'steady-tie');
    assert.equal(await page.locator('.analysis-table tr[data-roi-key="steady-tie"][data-selected="true"]').count(), 2);
    await page.locator('.roi-item[data-roi-key="skewed"] input[type="checkbox"]').uncheck();
    await assertOrder(page, ['steady', 'steady-tie', 'empty'], ['steady', 'steady-tie', 'empty']);
    await page.waitForFunction(() => !saveTimer && !viewerSaving);
    await page.reload();
    await page.waitForFunction(() => typeof viewerReady !== 'undefined' && viewerReady);
    assert.equal(await page.locator('#graph-sort').inputValue(), 'mean');
    await capturePlots(page);
    await assertOrder(page, ['steady', 'steady-tie', 'empty'], ['steady', 'steady-tie', 'empty']);
    await page.evaluate(() => sessionStorage.setItem('marmoset:viewerAnalysisSort', 'unknown-future-sort'));
    await page.reload();
    await page.waitForFunction(() => typeof viewerReady !== 'undefined' && viewerReady);
    assert.equal(await page.locator('#graph-sort').inputValue(), 'registration');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
