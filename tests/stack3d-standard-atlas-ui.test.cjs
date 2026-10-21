'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');
const MODE_KEY = 'atlas-stack3d-standard-atlas-mode-v1';
const IDS = ['atlas-ui-one', 'atlas-ui-two', 'atlas-ui-three'];

async function seed(h, { preference, missing = false } = {}) {
  for (const id of IDS) await seedViewerProject(h.page, h.baseURL, { id });
  const dataset = await h.page.evaluate(async ({ ids, preference, key }) => {
    const sections = [];
    for (const [index, id] of ids.entries()) {
      const p = await ProjectStorage.getProject(id);
      p.displayName = `Cor_3_${index + 1}`;
      p.grid = { W: 4, H: 2, umPerPxX: 100, umPerPxY: 100 };
      p.rotation = { all: 180, msi: 0, he: 0 };
      p.world_coords = { T_he_to_msi: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
      p.stack3d = { schemaVersion: 1, offsetXUm: index * 50, offsetYUm: 100, rotationDeg: index * 3 };
      p.valueDisplay = { mode: 'raw', scale: 'common' };
      await ProjectStorage.putProject(p);
      sections.push({ projectId: id, name: p.displayName, source: { grid: p.grid, rotation: p.rotation, T_he_to_msi: p.world_coords.T_he_to_msi },
        atlasSlice: [280, 314, 350][index], atlasSliceSource: index === 2 ? 'interpolated-reference' : 'stored-reference', rawMSIToAtlas: [[2, 0, 350 + index * 3], [0, 2, 350], [0, 0, 1]],
        method: index === 0 ? 'accepted-pilot' : 'interpolated-estimate',
        qc: { requiresIndividualReview: index !== 0, flags: index === 1 ? ['reference-s-reversal', 'reference-s-duplicate', 'low-envelope-overlap', 'he-envelope-outside-reference'] : [] } });
    }
    if (preference) sessionStorage.setItem(key, JSON.stringify(preference));
    return { schemaVersion: 1, id: 'marmoset-bma2023-v1', reference: { name: 'Synthetic BMA fixture' }, sections };
  }, { ids: IDS, preference, key: MODE_KEY });
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({ contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};' }));
  await h.context.route(h.baseURL + '/data/marmoset-bma2023-placement.json', route => route.fulfill({ status: missing ? 404 : 200, contentType: 'application/json', body: JSON.stringify(dataset) }));
  return dataset;
}
async function ready(page, count = 3) {
  await page.waitForFunction(count => window.__stack3dReady && Atlas3D.sections.length === count &&
    Atlas3D.renderer?.getStats().renderCount > 0 && !document.querySelector('#series-select').disabled, count);
  assert.equal(await page.locator('#render-error').isVisible(), false);
}
async function open(h) {
  await h.page.goto(h.baseURL + '/stack3d/index.html?series=legacy_marmoset'); await ready(h.page);
}
async function snapshot(page) {
  return page.evaluate(async () => ({ projects: await ProjectStorage.listProjects(),
    preview: document.querySelector('#section-preview canvas')?.toDataURL(),
    rasters: await Promise.all(Atlas3D.sections.flatMap(s => s.project.molecules.map(async m =>
      [m.blobId, Array.from(await ProjectStorage.getValueRaster(m.blobId))]))) }));
}
async function mode(page, next) {
  await page.locator('#placement-mode').selectOption(next);
  await page.waitForFunction(next => Atlas3D.placementMode === next && Atlas3D.renderer.getStats().placementMode === next, next);
}

test('matching standard Atlas defaults on, switches without writes or 2D changes, and blocks legacy edits', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), p = h.page;
  try {
    await seed(h); await open(h);
    assert.equal(await p.locator('#placement-mode').inputValue(), 'atlas');
    assert.equal(await p.locator('#spacing').isDisabled(), true);
    assert.match(await p.locator('#spacing-value').innerText(), /50 µm/);
    assert.match(await p.locator('#standard-atlas-section-note').innerText(), /s = 280.*採用済み代表切片/);
    for (const id of ['offset-x', 'offset-y', 'rotation', 'save-placement', 'save-cloud', 'batch-calculate', 'alignment-calculate'])
      assert.equal(await p.locator('#' + id).isDisabled(), true, id);
    const before = await snapshot(p), atlas = await p.evaluate(() => Atlas3D.renderer.getStats());
    assert.deepEqual(atlas.placements.map(row => Number(row.position[2].toFixed(6))), [-1.7, 0, 1.8]);
    await p.evaluate(() => {
      window.__atlasWrites = 0;
      ProjectStorage.patchProjectFields = async () => { window.__atlasWrites++; throw Error('Unexpected write'); };
      ProjectSync.saveState = async () => { window.__atlasWrites++; throw Error('Unexpected cloud write'); };
      document.querySelector('#offset-x').value = '9000';
      document.querySelector('#offset-x').dispatchEvent(new Event('change'));
      for (const id of ['save-placement', 'save-cloud', 'batch-calculate', 'alignment-calculate']) document.getElementById(id).dispatchEvent(new Event('click'));
    });
    assert.equal(await p.evaluate(() => window.__atlasWrites), 0);
    assert.deepEqual(await p.evaluate(() => Atlas3D.renderer.getStats().placements), atlas.placements);
    await mode(p, 'legacy');
    assert.equal(await p.locator('#spacing').isDisabled(), false);
    assert.equal(await p.locator('#offset-x').isDisabled(), false);
    assert.deepEqual(await snapshot(p), before, 'mode choice changes no project, pixels or selected 2D image');
    const legacy = await p.evaluate(() => Atlas3D.renderer.getStats());
    assert.notDeepEqual(legacy.placements, atlas.placements);
    assert.equal(legacy.textureCount, atlas.textureCount);
    await mode(p, 'atlas');
    assert.deepEqual(await p.evaluate(() => Atlas3D.renderer.getStats().placements), atlas.placements);
    await p.evaluate(() => Atlas3D.selectSection(1));
    assert.match(await p.locator('#standard-atlas-section-note').innerText(), /代表切片からの推定/);
    assert.match(await p.locator('#standard-atlas-section-note').innerText(), /参照断面番号の逆転あり/);
    assert.match(await p.locator('#standard-atlas-section-note').innerText(), /参照断面番号の重複あり/);
    assert.match(await p.locator('#standard-atlas-section-note').innerText(), /輪郭対応を要確認/);
    assert.match(await p.locator('#standard-atlas-section-note').innerText(), /参照輪郭の外に出るHE領域あり/);
    await p.evaluate(() => Atlas3D.selectSection(2));
    assert.match(await p.locator('#standard-atlas-section-note').innerText(), /前後位置も補間推定/);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('manual legacy draft and explicit mode survive comparison; batch or save activity blocks switching', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), p = h.page;
  try {
    await seed(h, { preference: 'legacy' }); await open(h);
    assert.equal(await p.locator('#placement-mode').inputValue(), 'legacy');
    await p.locator('#placement-details').evaluate(e => { e.open = true; });
    await p.locator('#offset-x').fill('725'); await p.locator('#offset-x').dispatchEvent('change');
    const draft = await p.evaluate(() => Atlas3D.sections[0].offsetXUm);
    await mode(p, 'atlas'); await mode(p, 'legacy');
    assert.equal(await p.evaluate(() => Atlas3D.sections[0].offsetXUm), draft);
    assert.match(await p.locator('#placement-status').innerText(), /未保存/);
    await p.evaluate(() => {
      const get = ProjectStorage.getProject;
      ProjectStorage.getProject = async (...args) => { await new Promise(resolve => setTimeout(resolve, 500)); return get(...args); };
    });
    await p.locator('#save-placement').click();
    await p.waitForFunction(() => document.querySelector('#placement-mode').disabled);
    await p.locator('#placement-mode').evaluate(e => { e.value = 'atlas'; e.dispatchEvent(new Event('change')); });
    assert.equal(await p.evaluate(() => Atlas3D.placementMode), 'legacy');
    await p.waitForFunction(() => !document.querySelector('#placement-mode').disabled);
    assert.equal(await p.evaluate(() => JSON.parse(sessionStorage.getItem('atlas-stack3d-standard-atlas-mode-v1'))), 'legacy');
    await p.reload(); await ready(p);
    assert.equal(await p.locator('#placement-mode').inputValue(), 'legacy');
    await p.evaluate(() => {
      window.Stack3DBatchAlignment = { ...Stack3DBatchAlignment, solve: async () => {
        await new Promise(resolve => setTimeout(resolve, 1500)); return { available: false, reason: 'Synthetic insufficient ROI' };
      } };
    });
    await p.locator('#batch-calculate').click();
    await p.waitForFunction(() => document.querySelector('#placement-mode').disabled);
    await p.locator('#placement-mode').evaluate(e => { e.value = 'atlas'; e.dispatchEvent(new Event('change')); });
    assert.equal(await p.evaluate(() => Atlas3D.placementMode), 'legacy');
    await p.waitForFunction(() => !document.querySelector('#placement-mode').disabled);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('source revision mismatch falls back on reload without overwriting an explicit Atlas preference', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), p = h.page;
  try {
    await seed(h); await open(h); await mode(p, 'legacy'); await mode(p, 'atlas');
    await p.evaluate(async id => {
      const project = await ProjectStorage.getProject(id); project.rotation.all = 90;
      await ProjectStorage.putProject(project);
    }, IDS[1]);
    await p.waitForFunction(() => document.querySelector('#placement-mode-help').textContent.includes('登録データが更新'));
    await mode(p, 'legacy');
    assert.equal(await p.locator('#placement-mode option[value=atlas]').isDisabled(), true);
    // Put back an explicit Atlas preference to verify a mismatch never erases it.
    await p.evaluate(key => sessionStorage.setItem(key, JSON.stringify('atlas')), MODE_KEY);
    await p.reload(); await ready(p);
    assert.equal(await p.locator('#placement-mode').inputValue(), 'legacy');
    assert.match(await p.locator('#placement-mode-help').innerText(), /3切片.*2切片/);
    assert.equal(await p.evaluate(key => JSON.parse(sessionStorage.getItem(key)), MODE_KEY), 'atlas');
    assert.deepEqual(await p.evaluate(() => Atlas3D.sections.map(s => Boolean(s.standardAtlasPose))), [false, false, false]);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('missing preset explains fallback and Mouse keeps its saved pixel placement', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), p = h.page;
  try {
    await seed(h, { missing: true }); await open(h);
    assert.equal(await p.locator('#placement-mode').inputValue(), 'legacy');
    assert.match(await p.locator('#placement-mode-help').innerText(), /取得できません/);
    await p.evaluate(async () => {
      const original = await ProjectStorage.getProject('atlas-ui-one');
      await ProjectStorage.putProject({ ...original, id: 'atlas-ui-mouse', displayName: 'Mouse 01', plane: 'coronal',
        atlas: { species: 'mouse', seriesId: 'mouse-test', coordinateMode: 'pixel', sectionNumber: 1 },
        stack3d: { coordinateMode: 'pixel', offsetXPx: 5, offsetYPx: -3, rotationDeg: 30 } });
    });
    await p.goto(h.baseURL + '/stack3d/index.html?series=mouse-test'); await ready(p, 1);
    assert.equal(await p.locator('#standard-atlas-control').isVisible(), false);
    assert.equal(await p.locator('#spacing').isDisabled(), false);
    const pose = await p.evaluate(() => Atlas3D.renderer.getStats().placements[0]);
    assert.deepEqual(pose.position, [5, -3, 0]);
    assert.ok(Math.abs(pose.rotationDeg - 30) < 1e-10);
    assert.equal(await p.evaluate(() => Boolean(Atlas3D.sections[0].standardAtlasPose)), false);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
