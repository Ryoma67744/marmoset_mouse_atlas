'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');

test('Master keeps pixel-ratio profiles intact instead of opening a section-factor replacement form', async () => {
  const h = await startBrowserHarness();
  try {
    await h.page.goto(h.baseURL + '/__test_seed');
    await h.page.addScriptTag({ url: h.baseURL + '/lib/normalization-ui.js' });
    const before = await h.page.evaluate(async () => {
      const p = { id: 'pixel-ratio', displayName: 'Mouse pixel ratio', grid: { W: 2, H: 1, umPerPxX: null, umPerPxY: null },
        images: {}, molecules: [], valueDisplay: { mode: 'normalized' } };
      const rasters = {};
      for (const [key, name, source] of [['ht', 'Serotonin-DPP', [2, 4]], ['d4', 'Serotonin-d4-DPP', [1, 2]]]) {
        const values = new Float32Array(source);
        p.molecules.push({ key, name, analyteId: name, blobId: await ProjectStorage.putValueRaster(values) });
        rasters[key] = { W: 2, H: 1, values };
      }
      p.normalization = Normalization.createPixelRatioProfile(p, rasters, { id: 'test-ratio', revision: 1,
        standardKey: 'd4', targetKeys: ['ht'], standardApplication: { method: 'uniform_spray', confirmed: true } });
      await ProjectStorage.putProject(p);
      const projects = await ProjectStorage.listProjects();
      NormalizationUI.open({ projects, selectedIds: [p.id], storage: ProjectStorage, loadProject: item => ProjectStorage.getProject(item.id) });
      return projects;
    });
    await h.page.locator('#normalization-load').click();
    await h.page.locator('#normalization-pixel-back').waitFor();
    assert.match(await h.page.locator('#normalization-title').innerText(), /画素ごと/);
    assert.match(await h.page.locator('#normalization-body').innerText(), /Serotonin-d4-DPP/);
    assert.equal(await h.page.locator('#normalization-save').count(), 0);
    assert.equal(await h.page.locator('#normalization-body form').count(), 0);
    await h.page.locator('#normalization-pixel-back').click();
    await h.page.locator('#normalization-load').waitFor();
    await h.page.locator('#normalization-close').click();
    assert.deepEqual(await h.page.evaluate(() => ProjectStorage.listProjects()), before);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
