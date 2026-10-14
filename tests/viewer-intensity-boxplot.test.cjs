'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

async function open(h, id) {
  await seedViewerProject(h.page, h.baseURL, { id });
  await h.page.goto(h.baseURL + '/viewer/index.html?project=' + id);
  await h.page.waitForFunction(() => typeof viewerReady !== 'undefined' && viewerReady);
  await h.page.evaluate(() => {
    window.boxDraws = {};
    const original = IntensityBoxPlot.draw;
    IntensityBoxPlot.draw = (canvas, options) => {
      const result = original(canvas, options);
      boxDraws[canvas.closest('[data-channel]').dataset.channel] = { options, result };
      return result;
    };
    document.getElementById('graph-select-1').value = 'MSI_5-HT';
    document.getElementById('graph-select-2').value = 'none';
    document.getElementById('graph-select-3').value = 'none';
  });
  await h.page.locator('.roi-item[data-roi-key="all"]').click();
}
const plotted = page => page.evaluate(() => boxDraws['MSI_5-HT'].options.rois.map(roi => ({ key: roi.key, d: roi.distribution })));

test('Intensity Box Plot uses full raw/normalized ROI distribution and follows geometry without modifying raw data', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), { page } = h;
  try {
    await open(h, 'box-distribution');
    const original = await page.evaluate(() => Array.from(valueRasters['MSI_5-HT'].values));
    let [{ d }] = await plotted(page);
    assert.equal(d.median, 13.5);
    assert.equal(d.q1, 1.375);
    assert.equal(d.q3, 31.25);
    assert.equal(d.whiskerLow, 0);
    assert.equal(d.whiskerHigh, 39.65);
    assert.equal(d.upperTailCount, 1);
    await page.locator('#value-raw').click();
    [{ d }] = await plotted(page);
    assert.equal(d.median, 27);
    assert.equal(d.whiskerHigh, 79.3);
    assert.deepEqual(d.points.map(p => p.value), original);
    assert.equal(d.points.filter(p => p.upperTail).length, 1);
    const rawDistribution = d;
    // A second polygon inside the same ROI must not count overlapping pixels twice.
    await page.evaluate(() => {
      atlasData.roi.roi_items.all.push(structuredClone(atlasData.roi.roi_items.all[0]));
      displayGraphForRoi('all');
    });
    assert.deepEqual((await plotted(page))[0].d, rawDistribution);
    // Color clipping, rotation, and Otsu are presentation-only.
    await page.evaluate(() => {
      imageSettings['MSI_5-HT'].vmax = 1;
      rotationState.all = 90;
      otsuState.applied = true;
      displayGraphForRoi('all');
    });
    assert.deepEqual((await plotted(page))[0].d, rawDistribution);
    await page.evaluate(() => {
      atlasData.roi.roi_items.all = [{ poly_msi: [[0,0],[1,0],[1,1],[0,1]] }];
      displayGraphForRoi('all');
    });
    [{ d }] = await plotted(page);
    assert.equal(d.n, 1); assert.equal(d.min, 0); assert.equal(d.max, 0);
    assert.equal(d.median, 0); assert.equal(d.upperTailCount, 0);
    assert.match(await page.locator('[data-field="median"]').innerText(), /^0 \[0–0\]/);
    assert.deepEqual(await page.evaluate(() => Array.from(valueRasters['MSI_5-HT'].values)), original);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Intensity Box Plot keeps selection, scroll and keyboard focus, redraws after collapsing, and shows visible ROIs only', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), { page } = h;
  try {
    await open(h, 'box-interaction');
    await page.evaluate(() => {
      for (let i = 0; i < 10; i++) {
        const key = 'region-' + i;
        atlasData.roi.roi_items[key] = structuredClone(atlasData.roi.roi_items.all);
        atlasData.roi.roi_names[key] = 'Long region name ' + i + ' with complete anatomical description';
      }
      populateRoiList(); displayGraphForRoi('all');
      window.summarizeCalls = 0;
      const original = RoiDistribution.summarize;
      RoiDistribution.summarize = (...args) => { summarizeCalls++; return original(...args); };
    });
    assert.equal((await plotted(page)).length, 11);
    await page.locator('.analysis-plot').evaluate(el => { el.scrollLeft = el.scrollWidth; });
    const scroll = await page.locator('.analysis-plot').evaluate(el => el.scrollLeft);
    assert.ok(scroll > 0);
    await page.evaluate(() => {
      const canvas = document.getElementById('graph-canvas'), rect = canvas.getBoundingClientRect();
      const group = boxDraws['MSI_5-HT'].result.groups.at(-1);
      canvas.onclick({ clientX: rect.left + group.center, clientY: rect.top + 100 });
    });
    assert.equal(await page.locator('.roi-item.active').getAttribute('data-roi-key'), 'region-9');
    assert.equal(await page.locator('.analysis-plot').evaluate(el => el.scrollLeft), scroll);
    const button = page.locator('.analysis-table tr[data-roi-key="region-8"] button');
    await button.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('.roi-item.active').getAttribute('data-roi-key'), 'region-8');
    assert.equal(await page.evaluate(() => document.activeElement.closest('tr')?.dataset.roiKey), 'region-8');
    assert.equal(await page.evaluate(() => summarizeCalls), 0, 'selection must reuse statistics');
    // Hide all but one without changing numerical values; the next render excludes them.
    await page.evaluate(() => {
      for (const key of Object.keys(atlasData.roi.roi_items)) atlasData.roi.roi_show_flags[key] = key === 'all';
      populateRoiList(); displayGraphForRoi('all');
    });
    assert.deepEqual((await plotted(page)).map(roi => roi.key), ['all']);
    const width = await page.locator('#graph-canvas').evaluate(el => el.style.width);
    await page.locator('#toggle-analysis-graph').click();
    await page.waitForFunction(() => document.getElementById('graph-container').clientWidth === 0);
    await page.locator('.roi-item[data-roi-key="all"]').click();
    await page.locator('#toggle-analysis-graph').click();
    await page.waitForFunction(expected => document.getElementById('graph-canvas').style.width === expected, width);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.waitForFunction(() => parseFloat(document.getElementById('graph-canvas').style.width) === document.getElementById('graph-container').clientWidth - 2);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Intensity Box Plot suppresses both box and cloud when corrected ROI coverage fails', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), { page } = h;
  try {
    const id = await seedViewerProject(page, h.baseURL, { id: 'box-coverage' });
    await page.evaluate(async id => {
      const project = await ProjectStorage.getProject(id);
      const rasters = await Normalization.loadRasters(project, { storage: ProjectStorage });
      const standard = rasters['MSI_D4-5-HT'];
      standard.values[1] = 0; standard.values[2] = 0; standard.values[3] = 0;
      const molecule = project.molecules.find(m => m.key === 'MSI_D4-5-HT');
      molecule.blobId = await ProjectStorage.putValueRaster(standard.values);
      project.normalization = Normalization.createProfiles([{ project, rasters, mapping: Normalization.suggestMapping(project.molecules) }], {
        id: 'low-coverage', revision: 1, batchId: 'batch', prepId: 'prep', quality: 'provisional', coordinateMatchConfirmed: true, comparabilityConfirmed: true,
        qc: { minD4: 0, saturationD4: 1000, minCoverage: 0.8 }, reference: { kind: 'whole_tissue', projectIds: [id], roiNames: [] }
      }).profiles[0].normalization;
      await ProjectStorage.putProject(project);
    }, id);
    await page.goto(h.baseURL + '/viewer/index.html?project=' + id);
    await page.waitForFunction(() => typeof viewerReady !== 'undefined' && viewerReady);
    await page.evaluate(() => {
      document.getElementById('graph-select-1').value = 'MSI_5-HT';
      document.getElementById('graph-select-2').value = 'none'; document.getElementById('graph-select-3').value = 'none';
      const original = IntensityBoxPlot.draw;
      IntensityBoxPlot.draw = (canvas, options) => { window.coveragePlot = options.rois[0].distribution; return original(canvas, options); };
    });
    await page.locator('.roi-item[data-roi-key="all"]').click();
    assert.equal(await page.evaluate(() => coveragePlot), null);
    assert.equal(await page.locator('[data-field="median"]').innerText(), '算出不可');
    assert.equal(await page.locator('[data-field="mean"]').innerText(), '算出不可');
    assert.match(await page.locator('[data-field="count"]').innerText(), /5 \/ 8 \/ 8/);
    assert.match(await page.locator('[data-field="status"]').innerText(), /UNAVAILABLE/);
    await page.locator('#value-raw').click();
    assert.equal(await page.evaluate(() => coveragePlot.n), 8);
    assert.equal(await page.evaluate(() => coveragePlot.median), 27);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});