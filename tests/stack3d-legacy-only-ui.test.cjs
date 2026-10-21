'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');
const IDS = ['legacy-only-1', 'legacy-only-2', 'legacy-only-3'];

async function seed(h) {
  for (const id of IDS) await seedViewerProject(h.page, h.baseURL, { id });
  await h.page.evaluate(async ids => {
    for (const [i, id] of ids.entries()) {
      const project = await ProjectStorage.getProject(id);
      project.displayName = `Cor_3_${i + 1}`;
      project.grid.umPerPxX = 100; project.grid.umPerPxY = 150;
      project.rotation = { all: 180 + i * 10, msi: 5, he: 0 };
      project.stack3d = { schemaVersion: 1, offsetXUm: 300 + i * 50, offsetYUm: 200, rotationDeg: i * 3 };
      project.valueDisplay = { mode: 'raw', scale: 'common' };
      await ProjectStorage.putProject(project);
    }
    sessionStorage.setItem('atlas-stack3d-standard-atlas-mode-v1', JSON.stringify('atlas'));
    sessionStorage.setItem('atlas-stack3d-view-v1', JSON.stringify({ ids, selectedId: ids[1], spacing: 1.2, spacingDefaultsVersion: 1,
      options: { mode: 'raw', channels: ['DA', 'NE', '5-HT'] }, range: [1, ids.length] }));
  }, IDS);
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({ contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};' }));
}
async function ready(page, count = 3) {
  await page.waitForFunction(count => window.__stack3dReady && Atlas3D.sections.length === count &&
    Atlas3D.renderer?.getStats().renderCount > 0 && !document.querySelector('#series-select').disabled, count);
  assert.equal(await page.locator('#render-error').isVisible(), false);
}
async function snapshot(page) {
  return page.evaluate(async () => ({ projects: await ProjectStorage.listProjects(),
    rasters: await Promise.all((await ProjectStorage.listProjects()).flatMap(p => p.molecules.map(async m =>
      [m.blobId, Array.from(new Uint8Array((await ProjectStorage.getValueRaster(m.blobId)).buffer))]))) }));
}
function roundedPlacements(rows) {
  return rows.map(row => ({ id: row.id, position: row.position.map(v => Number(v.toFixed(8))), rotationDeg: Number(row.rotationDeg.toFixed(8)) }));
}

test('old Atlas session choice is ignored: only saved legacy poses load, without preset requests or a placement switch', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page, presetRequests = [];
  try {
    await seed(h);
    const before = await snapshot(page);
    page.on('request', request => { if (/standard-atlas|bma2023-placement/.test(request.url())) presetRequests.push(request.url()); });
    await page.goto(h.baseURL + '/stack3d/index.html?series=legacy_marmoset'); await ready(page);
    assert.equal(await page.locator('#placement-mode,#standard-atlas-control,#standard-atlas-scene-note').count(), 0);
    assert.equal(await page.evaluate(() => typeof window.Stack3DStandardAtlas), 'undefined');
    assert.equal(await page.evaluate(() => Atlas3D.sections.some(s => Object.hasOwn(s, 'standardAtlasPose'))), false);
    assert.equal(await page.locator('#spacing').isDisabled(), false);
    assert.equal(await page.locator('#spacing').inputValue(), '1.2');
    assert.equal(await page.locator('#save-placement').isDisabled(), false);
    assert.equal(await page.locator('#offset-x').inputValue(), '350');
    assert.equal(await page.locator('#rotation').inputValue(), '3');
    const expected = IDS.map((id, i) => ({ id, position: [.3 + i * .05, -.2, (i - 1) * 1.2].map(v => Number(v.toFixed(8))), rotationDeg: -(5 + i * 13) }));
    assert.deepEqual(roundedPlacements(await page.evaluate(() => Atlas3D.renderer.getStats().placements)), expected);
    assert.deepEqual(await snapshot(page), before, 'opening the legacy model changes no saved pose or data');
    await page.locator('#spacing').fill('0.8'); await page.locator('#spacing').dispatchEvent('input');
    await page.reload(); await ready(page);
    assert.equal(await page.locator('#spacing').inputValue(), '0.8');
    assert.deepEqual(roundedPlacements(await page.evaluate(() => Atlas3D.renderer.getStats().placements)), expected.map((row, i) => ({ ...row, position: [row.position[0], row.position[1], (i - 1) * .8] })));
    assert.deepEqual(await snapshot(page), before, 'spacing is a view preference, not a project write');
    assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('atlas-stack3d-standard-atlas-mode-v1'))), 'atlas', 'obsolete preference can remain harmlessly');
    assert.deepEqual(presetRequests, []);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('restoring legacy Marmoset presentation preserves independent Mouse pixel poses and per-series spacing', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h);
    await page.evaluate(async () => {
      const source = await ProjectStorage.getProject('legacy-only-1');
      await ProjectStorage.putProject({ ...source, id: 'legacy-only-mouse', displayName: 'Mouse 15', plane: 'coronal',
        atlas: { species: 'mouse', seriesId: 'mouse-test', coordinateMode: 'pixel', sectionNumber: 15 },
        rotation: { all: 90, msi: 90, he: 0 },
        stack3d: { coordinateMode: 'pixel', offsetXPx: -.020565, offsetYPx: .678034, rotationDeg: -91.393457 } });
    });
    const before = await snapshot(page);
    await page.goto(h.baseURL + '/stack3d/index.html?series=mouse-test'); await ready(page, 1);
    assert.equal(await page.locator('#placement-mode').count(), 0);
    assert.equal(await page.locator('#spacing').inputValue(), '2');
    assert.equal(await page.locator('#save-placement').isDisabled(), true);
    const mousePose = roundedPlacements(await page.evaluate(() => Atlas3D.renderer.getStats().placements));
    assert.deepEqual(mousePose, [{ id: 'legacy-only-mouse', position: [-.020565, .678034, 0], rotationDeg: -91.393457 }]);
    await page.locator('#spacing').fill('3'); await page.locator('#spacing').dispatchEvent('input');
    await page.locator('#series-select').selectOption('legacy_marmoset'); await ready(page);
    assert.equal(await page.locator('#spacing').inputValue(), '1.2');
    await page.locator('#series-select').selectOption('mouse-test'); await ready(page, 1);
    assert.equal(await page.locator('#spacing').inputValue(), '3');
    assert.deepEqual(roundedPlacements(await page.evaluate(() => Atlas3D.renderer.getStats().placements)), mousePose);
    assert.deepEqual(await snapshot(page), before);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
