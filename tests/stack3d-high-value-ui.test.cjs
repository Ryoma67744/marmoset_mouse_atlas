'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

const SERIES = 'mouse_tissue_1set', PROJECT = 'synthetic-high-value-mouse';
const ANALYTES = ['GABA-DPP', 'Histamine-DPP', 'Dopamine-DPP', 'Norepinephrine-DPP', 'Serotonin-DPP', 'Serotonin-d4-DPP'];
const POINTS = [[2, 15], [8, 15], [15, 15]]; // Full 31×31 footprint: depths 3, 9 and 16.

async function seed(h) {
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};'
  }));
  await seedViewerProject(h.page, h.baseURL, { id: 'synthetic-high-value-legacy' });
  await h.page.evaluate(async ({ analytes, id, series, points }) => {
    const legacy = await ProjectStorage.getProject('synthetic-high-value-legacy');
    legacy.displayName = 'Cor_1_1'; legacy.grid.umPerPxX = 150; legacy.grid.umPerPxY = 150;
    await ProjectStorage.putProject(legacy);
    const project = {
      id, displayName: 'Synthetic high-value controls', plane: 'coronal',
      atlas: { species: 'mouse', seriesId: series, seriesName: 'Synthetic mouse', specimenId: 'synthetic',
        sectionNumber: 1, sourceCandidateId: 'C001', coordinateMode: 'pixel', displaySpacing: 2 },
      grid: { W: 31, H: 31 }, images: {}, molecules: [], rotation: { all: 0, msi: 0, he: 0 },
      stack3d: { coordinateMode: 'pixel', offsetXPx: 0, offsetYPx: 0, rotationDeg: 0 },
      valueDisplay: { mode: 'normalized', scale: 'common' },
      roi: { roi_items: { all: [{ poly_msi: [[-.5, -.5], [30.5, -.5], [30.5, 30.5], [-.5, 30.5]] }] },
        roi_names: { all: 'Synthetic full ROI' }, palette: { all: [255, 0, 0] }, roi_show_flags: { all: false } }
    };
    const rasters = {};
    for (let m = 0; m < analytes.length; m++) {
      const key = 'MSI_' + analytes[m];
      // Repeated 1..5 neighbors have nonzero MAD. Only three GABA pixels
      // are high, so pooled P95/P99 remain in the 1..5 background.
      const values = Float32Array.from({ length: 31 * 31 }, (_, i) => m === 5 ? 1 : 1 + i % 5);
      if (m === 0) for (const [x, y] of points) values[y * 31 + x] = 1000;
      project.molecules.push({ key, name: analytes[m], analyteId: analytes[m],
        blobId: await ProjectStorage.putValueRaster(values), stats: MSIRaster.deriveBakeStats(values) });
      rasters[key] = { W: 31, H: 31, values };
    }
    project.visibleLayers = project.molecules.map(m => m.key);
    project.normalization = Normalization.createPixelRatioProfile(project, rasters, {
      id: 'synthetic-high-value-profile', revision: 1, standardKey: project.molecules[5].key,
      targetKeys: project.molecules.slice(0, 5).map(m => m.key),
      standardApplication: { method: 'uniform_spray', confirmed: true, source: 'synthetic-test' }
    });
    await ProjectStorage.putProject(project);
    // An old session without highValueFilter should adopt ON / 8, while
    // preserving its deliberately selected molecule.
    sessionStorage.setItem('atlas-stack3d-view-v1:' + series, JSON.stringify({
      ids: [id], selectedId: id, mouseRatioDisplayVersion: 1,
      options: { mode: 'normalized', channels: [analytes[0]] }
    }));
  }, { analytes: ANALYTES, id: PROJECT, series: SERIES, points: POINTS });
}

async function sourceSnapshot(page) {
  return page.evaluate(async () => {
    const projects = (await ProjectStorage.listProjects()).sort((a, b) => a.id.localeCompare(b.id));
    return Promise.all(projects.map(async project => ({ project,
      values: await Promise.all(project.molecules.map(async m => [m.blobId, Array.from(await ProjectStorage.getValueRaster(m.blobId))]))
    })));
  });
}

async function ready(page, series = SERIES) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(series => window.__stack3dReady && Atlas3D.seriesId === series &&
    !document.querySelector('#series-select').disabled && !document.querySelector('#render-state').textContent.includes('更新中') &&
    document.querySelector('#section-preview canvas') && document.querySelector('#analysis-panel').getAttribute('aria-busy') === 'false',
  series, { timeout: 5000 });
}

async function textureVisibility(page) {
  return page.evaluate(points => {
    const canvas = Atlas3D.rendered[0].canvas, ctx = canvas.getContext('2d');
    return points.map(([x, y]) => ctx.getImageData(x, y, 1, 1).data[3] > 0);
  }, POINTS);
}

async function previewVisibility(page, selector) {
  return page.locator(selector).evaluate((canvas, points) => {
    const ctx = canvas.getContext('2d');
    return points.map(([x, y]) => ctx.getImageData(Math.floor((x + .5) * canvas.width / 31),
      Math.floor((y + .5) * canvas.height / 31), 1, 1).data[3] > 0);
  }, POINTS);
}

test('protected high values persist as Mouse presentation settings and leave source/analysis intact', { timeout: 30000 }, async () => {
  const h = await startBrowserHarness(), { page } = h;
  try {
    await seed(h);
    const sourceBefore = await sourceSnapshot(page);
    await page.goto(h.baseURL + '/stack3d/index.html?series=' + SERIES);
    await ready(page);
    assert.equal(await page.locator('#high-value-filter').isChecked(), true);
    assert.equal(await page.locator('#protection-distance').inputValue(), '8');
    assert.deepEqual(await textureVisibility(page), [false, true, true]);
    assert.deepEqual(await previewVisibility(page, '#section-preview canvas'), [false, true, true]);
    const analysisBefore = await page.evaluate(() => JSON.stringify(Atlas3D.analysis.getState().result));
    const rangeBefore = await page.evaluate(() => Atlas3D.rendered[0].ranges['GABA-DPP']);

    // Native range keyboard input exercises the same input event as dragging.
    await page.locator('#protection-distance').focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    await ready(page);
    assert.equal(await page.locator('#protection-distance').inputValue(), '12');
    assert.deepEqual(await textureVisibility(page), [false, false, true]);
    assert.deepEqual(await previewVisibility(page, '#section-preview canvas'), [false, false, true]);
    await page.locator('#enlarge-preview').click();
    await page.waitForSelector('#detail-preview canvas', { timeout: 5000 });
    assert.deepEqual(await previewVisibility(page, '#detail-preview canvas'), [false, false, true]);
    await page.locator('#close-preview').click();
    await page.reload(); await ready(page);
    assert.equal(await page.locator('#protection-distance').inputValue(), '12');
    assert.deepEqual(await textureVisibility(page), [false, false, true]);
    assert.deepEqual(await page.evaluate(() => Atlas3D.rendered[0].ranges['GABA-DPP']), rangeBefore);

    await page.locator('#high-value-filter').uncheck(); await ready(page);
    assert.deepEqual(await textureVisibility(page), [true, true, true]);
    assert.deepEqual(await previewVisibility(page, '#section-preview canvas'), [true, true, true]);
    assert.equal(await page.evaluate(() => JSON.stringify(Atlas3D.analysis.getState().result)), analysisBefore,
      'display filtering never changes ROI distributions, including hidden values');
    await page.reload(); await ready(page);
    assert.equal(await page.locator('#high-value-filter').isChecked(), false);
    assert.equal(await page.locator('#protection-distance').inputValue(), '12');
    assert.equal(await page.locator('#protection-distance').isDisabled(), true);
    assert.deepEqual(await textureVisibility(page), [true, true, true]);

    await page.locator('#series-select').selectOption('legacy_marmoset'); await ready(page, 'legacy_marmoset');
    assert.equal(await page.locator('#high-value-controls').isVisible(), false);
    assert.equal(await page.evaluate(() => 'highValueFilter' in Atlas3D.options()), false);
    assert.equal(await page.evaluate(() => Atlas3D.options().outerEdgeWidth), 0);
    const marmoset = await page.evaluate(() => {
      const current = Atlas3D.rendered[0], unfiltered = Stack3D.renderSection(Atlas3D.sections[0], {
        ...Atlas3D.options(), commonRanges: current.ranges
      });
      const pixels = canvas => Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data);
      const result = { actual: pixels(current.canvas), unfiltered: pixels(unfiltered.canvas) };
      unfiltered.canvas.width = unfiltered.previewCanvas.width = 0; return result;
    });
    assert.deepEqual(marmoset.actual, marmoset.unfiltered, 'Marmoset retains its prior rendering');
    await page.locator('#series-select').selectOption(SERIES); await ready(page);
    assert.equal(await page.locator('#high-value-filter').isChecked(), false);
    assert.equal(await page.locator('#protection-distance').inputValue(), '12');
    assert.deepEqual(await textureVisibility(page), [true, true, true]);
    const stored = await page.evaluate(series => JSON.parse(sessionStorage.getItem('atlas-stack3d-view-v1:' + series)), SERIES);
    assert.deepEqual(stored.options.highValueFilter, { enabled: false, protectDepth: 12 });
    assert.equal('signalMasks' in stored.options, false, 'pixel masks are not persisted');
    assert.deepEqual(await sourceSnapshot(page), sourceBefore);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
