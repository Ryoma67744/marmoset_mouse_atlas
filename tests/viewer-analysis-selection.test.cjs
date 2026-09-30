'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

async function openViewer(h, id) {
  await seedViewerProject(h.page, h.baseURL, { id });
  await h.page.goto(h.baseURL + '/viewer/index.html?project=' + id);
  await h.page.waitForFunction(id => typeof currentProject !== 'undefined' && currentProject?.id === id && viewerReady, id);
  await h.page.locator('.roi-item[data-roi-key="all"]').click();
}

async function assertIndependentGraphs(page, count) {
  assert.equal(await page.locator('#graph-container canvas').count(), count);
  assert.equal(await page.locator('#graph-container table').count(), count);
}

test('Analysis selects up to three separate molecule displays without implying a concentration comparison', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  const { page, errors } = h;
  try {
    await openViewer(h, 'analysis-selection');
    const group = page.getByRole('group', { name: '表示する分子（最大3分子）' });
    assert.equal(await group.getByRole('combobox').count(), 3);
    assert.doesNotMatch(await group.innerText(), /\bvs\b/i);
    const first = page.getByLabel('分子1', { exact: true });
    const second = page.getByLabel('追加表示2', { exact: true });
    const third = page.getByLabel('追加表示3', { exact: true });
    await first.selectOption('MSI_5-HT');
    await second.selectOption('none');
    await third.selectOption('none');
    await assertIndependentGraphs(page, 1);
    assert.equal(await second.locator('option[value="none"]').innerText(), '表示しない');
    await second.selectOption('MSI_DA');
    await assertIndependentGraphs(page, 2);
    await third.selectOption('MSI_NE');
    await assertIndependentGraphs(page, 3);
    await third.selectOption('MSI_DA');
    await assertIndependentGraphs(page, 2);
    await second.selectOption('MSI_5-HT');
    await third.selectOption('MSI_5-HT');
    await assertIndependentGraphs(page, 1);
    const note = await page.locator('#graph-container > p').innerText();
    assert.match(note, /選択した分子を個別に表示/);
    assert.match(note, /イオン化効率や単位が異なる/);
    assert.match(note, /濃度の大小は比較できません/);
    assert.match(note, /各グラフの軸は独立/);
    assert.match(note, /Otsu の非表示画素を含む/);
    assert.match(note, /SD は画素間分布で、切片間の誤差ではありません/);
    assert.deepEqual(errors, []);
  } finally { await h.close(); }
});

test('Analysis molecule selection retains raw and normalized ROI means, pixel SD, and underlying values', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  const { page, errors } = h;
  try {
    await openViewer(h, 'analysis-selection-values');
    const before = await page.evaluate(() => ({
      roi: structuredClone(atlasData.roi),
      bits: Object.fromEntries(Object.entries(valueRasters).map(([key, raster]) => [key, Array.from(new Uint32Array(raster.values.buffer))])),
    }));
    await page.getByLabel('分子1', { exact: true }).selectOption('MSI_5-HT');
    await page.getByLabel('追加表示2', { exact: true }).selectOption('MSI_DA');
    await page.getByLabel('追加表示3', { exact: true }).selectOption('MSI_NE');
    const rawValues = [[0, 2, 3, 4, 50, 60, 70, 80], [1, 1, 1, 1, 25, 30, 35, 40], [2, 2, 2, 2, 50, 60, 70, 80]];
    for (const mode of ['normalized', 'raw', 'normalized']) {
      await page.locator('#value-' + mode).click();
      await assertIndependentGraphs(page, 3);
      const tables = page.locator('#graph-container table');
      for (let i = 0; i < 3; i++) {
        const values = rawValues[i].map(value => mode === 'normalized' && i === 0 ? value / 2 : value);
        const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
        const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
        const cells = await tables.nth(i).locator('tr').nth(1).locator('td').allTextContents();
        const reported = cells[1].split(' ± ').map(Number);
        assert.ok(Math.abs(reported[0] - mean) < 0.0001, mode + ' mean for molecule ' + i);
        assert.ok(Math.abs(reported[1] - sd) < 0.0001, mode + ' pixel SD for molecule ' + i);
        assert.match(cells[2], /^8 \/ 8 \/ 8/);
      }
      const axisLabels = await page.evaluate(() => {
        const labels = [], original = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function (text, ...args) { labels.push(String(text)); return original.call(this, text, ...args); };
        try { displayGraphForRoi('all'); } finally { CanvasRenderingContext2D.prototype.fillText = original; }
        return labels;
      });
      if (mode === 'raw') assert.equal(axisLabels.filter(label => label === '生信号 (a.u.)').length, 3);
      else {
        assert.ok(axisLabels.includes('5-HT/D4-5-HT ratio'));
        assert.equal(axisLabels.filter(label => label === 'normalized a.u.').length, 2);
      }
    }
    assert.deepEqual(await page.evaluate(() => ({
      roi: structuredClone(atlasData.roi),
      bits: Object.fromEntries(Object.entries(valueRasters).map(([key, raster]) => [key, Array.from(new Uint32Array(raster.values.buffer))])),
    })), before);
    assert.deepEqual(errors, []);
  } finally { await h.close(); }
});
