'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');
const { sectionId, seedAnalysisStack, readyAnalysisStack, scientificSnapshot } = require('./stack3d-analysis-fixture.cjs');

async function paint(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function ready(page, mode) {
  await paint(page);
  await page.waitForFunction(mode => Atlas3D.analysis.getState().result?.mode === mode &&
    document.querySelector('#analysis-panel').getAttribute('aria-busy') === 'false', mode);
}
async function displayed(page) {
  await paint(page);
  return page.locator('.analysis-molecule:visible').evaluate(card => {
    const groups = Atlas3D.analysis.getState().result.channels.find(channel => channel.key === card.dataset.channel).groups;
    const keys = JSON.parse(card.querySelector('canvas').dataset.groupKeys);
    return { keys, names: keys.map(key => groups.find(group => group.key === key).roiName),
      ids: keys.map(key => groups.find(group => group.key === key).sectionId),
      tableKeys: [...card.querySelectorAll('tbody tr')].map(row => row.dataset.groupKey) };
  });
}
async function switchOrder(page, order, selector = '#analysis-sort-order') {
  const before = await page.evaluate(() => {
    const state = Atlas3D.analysis.getState(); window.__sortResult = state.result;
    return { result: JSON.stringify(state.result), generation: state.generation, calculations: window.__analysisCalls };
  });
  await page.locator(selector).selectOption(order); await paint(page);
  const after = await page.evaluate(() => {
    const state = Atlas3D.analysis.getState();
    return { result: JSON.stringify(state.result), generation: state.generation, calculations: window.__analysisCalls,
      sameResult: state.result === window.__sortResult };
  });
  assert.equal(after.sameResult, true, 'display sorting retains the completed scientific result');
  delete after.sameResult; assert.deepEqual(after, before, 'sorting cannot rerun analysis or change any statistic');
  assert.equal(await page.locator('#analysis-sort-order').inputValue(), order);
  assert.equal(await page.locator('#analysis-mini-sort-order').inputValue(), order);
  const label = order === 'mean' ? '平均値の高い順' : '中央値の高い順';
  assert.ok((await page.locator('.analysis-molecule:visible .analysis-row-label').innerText()).startsWith(label));
  assert.ok((await page.locator('.analysis-molecule:visible .analysis-plot').getAttribute('aria-label')).includes(label));
  const current = await displayed(page); assert.deepEqual(current.keys, current.tableKeys);
  return current;
}

test('3D mean sorting reverses median order for ROI, pooled and section graphs, preserving statistics and selection', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), { page } = h;
  try {
    await seedAnalysisStack(h, { count: 4, missingCorrection: false });
    // Independent data oracle: section 1 has low Caudate median with a high
    // outlier, sections 2 and 3 have equal means, section 4 has no Caudate ROI.
    await page.evaluate(async ids => {
      for (const [index, id] of ids.entries()) {
        const project = await ProjectStorage.getProject(id), { W, H } = project.grid;
        for (const molecule of project.molecules.filter(item => item.name !== 'D4-5-HT')) {
          const values = new Float32Array(W * H).fill(10);
          for (let y = 0; y < H; y++) for (let x = 0; x < 4; x++) values[y * W + x] = index === 0 ? 1 : 6;
          if (index === 0) values[0] = 1000;
          molecule.blobId = await ProjectStorage.putValueRaster(values);
          molecule.stats = MSIRaster.deriveBakeStats(values);
        }
        if (index === 3) for (const field of Object.values(project.roi)) delete field.caudate;
        await ProjectStorage.putProject(project);
      }
    }, [1, 2, 3, 4].map(sectionId));
    const original = await scientificSnapshot(page);
    await page.goto(h.baseURL + '/stack3d/index.html?project=' + sectionId(1)); await readyAnalysisStack(page, 4);
    await ready(page, 'selected');
    await page.evaluate(() => {
      const analyze = Stack3DAnalysis.analyze; window.__analysisCalls = 0;
      Stack3DAnalysis.analyze = (...args) => { window.__analysisCalls++; return analyze(...args); };
    });
    assert.equal(await page.locator('#analysis-sort-order').inputValue(), 'median', 'old sessions retain median default');
    assert.deepEqual((await displayed(page)).names, ['Putamen', 'Thalamus', 'Caudate']);
    assert.deepEqual((await switchOrder(page, 'mean')).names, ['Caudate', 'Putamen', 'Thalamus']);
    // Each molecule's graph and statistics table share the chosen ranking.
    for (const channel of ['NE', '5-HT', 'DA']) {
      await page.locator('[data-analysis-molecule="' + channel + '"]').click();
      const current = await displayed(page); assert.deepEqual(current.names, ['Caudate', 'Putamen', 'Thalamus']);
      assert.deepEqual(current.keys, current.tableKeys);
    }
    await page.locator('[data-analysis-mode="pooled"]').click(); await ready(page, 'pooled');
    assert.deepEqual((await displayed(page)).names, ['Caudate', 'Putamen', 'Thalamus']);
    assert.deepEqual((await switchOrder(page, 'median')).names, ['Putamen', 'Thalamus', 'Caudate']);
    await switchOrder(page, 'mean');
    await page.locator('[data-analysis-mode="by-section"]').click(); await ready(page, 'by-section');
    assert.deepEqual((await displayed(page)).ids, [1, 2, 3, 4].map(sectionId));
    assert.deepEqual((await switchOrder(page, 'median')).ids, [2, 3, 1, 4].map(sectionId));
    await page.locator('.analysis-molecule:visible .analysis-table-details > summary').click();
    await page.locator('#analysis-toolbar-toggle').click();
    assert.deepEqual((await switchOrder(page, 'mean', '#analysis-mini-sort-order')).ids, [1, 2, 3, 4].map(sectionId));
    assert.equal(await page.locator('.analysis-molecule:visible .analysis-table-details').evaluate(node => node.open), true,
      'changing order keeps an opened statistics table open');
    await page.locator('.analysis-molecule:visible tr[data-section-id="' + sectionId(3) + '"] button').click();
    await page.waitForFunction(id => Atlas3D.sections[Atlas3D.selected].id === id, sectionId(3));
    // Click the first ranked canvas column after reordering; its stable ID is section 1.
    const canvas = page.locator('.analysis-molecule:visible canvas');
    const point = await canvas.evaluate(node => ({ x: 84 + (parseFloat(node.style.width) - 104) / 8, y: 120 }));
    await canvas.click({ position: point });
    await page.waitForFunction(id => Atlas3D.sections[Atlas3D.selected].id === id, sectionId(1));
    assert.equal(await page.locator('.analysis-molecule:visible tr[data-section-id="' + sectionId(1) + '"]').getAttribute('aria-selected'), 'true');
    assert.equal((await page.evaluate(() => Atlas3D.analysis.getState())).result.selection.count, 4);
    assert.deepEqual(await scientificSnapshot(page), original);
    await page.reload(); await readyAnalysisStack(page, 4); await ready(page, 'by-section');
    assert.equal(await page.locator('#analysis-mini-sort-order').inputValue(), 'mean');
    assert.deepEqual((await displayed(page)).ids, [1, 2, 3, 4].map(sectionId));
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
