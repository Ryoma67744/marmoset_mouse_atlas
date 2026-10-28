'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const XLSX = require('xlsx');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

async function fixture(id, { lowCoverage = false } = {}) {
  const h = await startBrowserHarness();
  try {
    const body = await fs.readFile(require.resolve('xlsx/dist/xlsx.full.min.js'), 'utf8');
    await h.context.route('**/xlsx@*/dist/xlsx.full.min.js', route => route.fulfill({ contentType: 'application/javascript', body }));
    await seedViewerProject(h.page, h.baseURL, { id });
    await h.page.evaluate(async ({ id, lowCoverage }) => {
      const project = await ProjectStorage.getProject(id);
      const all = project.roi.roi_items.all;
      project.roi = {
        roi_items: { empty: [], zero: [{ poly_msi: [[0, 0], [1, 0], [1, 1], [0, 1]] }], all, hidden: structuredClone(all) },
        roi_names: { empty: '空領域', zero: '=1+1', all: '全画素', hidden: '非表示領域' },
        palette: {}, roi_show_flags: { empty: true, zero: true, all: true, hidden: false },
      };
      const rasters = await Normalization.loadRasters(project, { storage: ProjectStorage });
      if (lowCoverage) {
        rasters['MSI_D4-5-HT'].values.fill(0, 1, 4);
        const molecule = project.molecules.find(m => m.key === 'MSI_D4-5-HT');
        molecule.blobId = await ProjectStorage.putValueRaster(rasters['MSI_D4-5-HT'].values);
      }
      project.normalization = Normalization.createProfiles([{ project, rasters, mapping: Normalization.suggestMapping(project.molecules) }], {
        id: 'graph-excel-profile', revision: 1, batchId: 'batch', prepId: 'prep', quality: 'provisional',
        coordinateMatchConfirmed: true, comparabilityConfirmed: true,
        qc: { minD4: 0, saturationD4: 1000, minCoverage: 0.8 },
        reference: { kind: 'whole_tissue', projectIds: [id], roiNames: [] },
      }).profiles[0].normalization;
      await ProjectStorage.putProject(project);
    }, { id, lowCoverage });
    await h.page.goto(h.baseURL + '/viewer/index.html?project=' + id);
    await h.page.waitForFunction(() => typeof viewerReady !== 'undefined' && viewerReady);
    // The shared hermetic Tailwind stub omits icon sizing and typography reset;
    // supply those production utilities so the graph toolbar is mouse-accessible.
    await h.page.addStyleTag({ content: '.w-4{width:1rem}.h-4{height:1rem}h2,p{margin:0}.text-xs{font-size:12px}' });
    await h.page.getByLabel('分子1', { exact: true }).selectOption('MSI_5-HT');
    await h.page.getByLabel('追加表示2', { exact: true }).selectOption('MSI_D4-5-HT');
    await h.page.getByLabel('追加表示3', { exact: true }).selectOption('MSI_5-HT');
    await h.page.locator('.roi-item[data-roi-key="all"]').click();
    await h.page.getByLabel('並び順', { exact: true }).selectOption('mean');
    return h;
  } catch (error) { await h.close(); throw error; }
}

async function downloadWorkbook(page) {
  let download;
  try {
    [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Excel出力', exact: true }).click(),
    ]);
  } catch (error) {
    throw new Error(error.message + '\nExport status: ' + await page.locator('#graph-export-status').innerText());
  }
  assert.equal(await download.failure(), null);
  assert.match(download.suggestedFilename(), /_graph_statistics_.*\.xlsx$/);
  const workbook = XLSX.read(await fs.readFile(await download.path()), { type: 'buffer' });
  const sheet = workbook.Sheets.Statistics;
  const [headers] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  const conditions = Object.fromEntries(XLSX.utils.sheet_to_json(workbook.Sheets.Conditions, { header: 1 }));
  const cell = (rowIndex, header) => sheet[XLSX.utils.encode_cell({ r: rowIndex + 1, c: headers.indexOf(header) })];
  return { workbook, sheet, rows, conditions, cell };
}

const scientificSnapshot = page => page.evaluate(() => ({
  roi: structuredClone(atlasData.roi), normalization: structuredClone(currentProject.normalization),
  bits: Object.fromEntries(Object.entries(valueRasters).map(([key, raster]) => [key, Array.from(new Uint32Array(raster.values.buffer))])),
}));

test('2D graph Excel exports all visible graphs in their current order with precise numeric cells, zeroes, and blank missing statistics', { timeout: 90000 }, async () => {
  const h = await fixture('viewer-graph-excel'), { page } = h;
  try {
    const before = await scientificSnapshot(page);
    const expectedSd = await page.evaluate(() => Normalization.statistics(Array.from(valueRasters['MSI_5-HT'].values, value => value / 2)).sd);
    const visibleOrder = await page.locator('.analysis-section').evaluateAll(sections => sections.flatMap(section =>
      Array.from(section.querySelectorAll('tr[data-roi-key]'), row => [section.dataset.channel, row.dataset.roiKey])));
    const output = await downloadWorkbook(page);
    assert.equal(output.rows.length, 6, 'duplicate molecule selections export once and hidden ROIs are excluded');
    assert.deepEqual(output.rows.map(row => [row['分子キー'], row['ROIキー']]), visibleOrder);
    assert.deepEqual(output.rows.filter(row => row['分子キー'] === 'MSI_5-HT').map(row => row['ROIキー']), ['all', 'zero', 'empty']);
    const allIndex = output.rows.findIndex(row => row['分子キー'] === 'MSI_5-HT' && row['ROIキー'] === 'all');
    const all = output.rows[allIndex];
    assert.equal(all['ROI名'], '全画素');
    assert.equal(all['中央値'], 13.5);
    assert.equal(all['平均値'], 16.8125);
    assert.equal(all['標準偏差'], expectedSd, 'retain more precision than the six-digit UI text');
    assert.equal(all['第1四分位数'], 1.375);
    assert.equal(all['第3四分位数'], 31.25);
    assert.equal(all.P99, 39.65);
    assert.equal(all['最大値'], 40);
    assert.equal(all['集計画素数'], 8);
    for (const column of ['中央値', '平均値', '標準偏差', '第1四分位数', '第3四分位数', '最小値', 'P99', '最大値', '集計画素数', '有効画素数', '測定画素数', 'ROI画素数', '表示順']) {
      assert.equal(output.cell(allIndex, column).t, 'n', column + ' must be a real numeric Excel cell');
    }
    for (let index = 0; index < output.rows.length; index++) {
      const row = output.rows[index];
      assert.equal(row['並び順'], 'mean');
      assert.equal(row['切片ID'], 'viewer-graph-excel');
      if (row['ROIキー'] === 'empty') {
        for (const column of ['中央値', '平均値', '標準偏差', '最小値', 'P99', '最大値']) assert.equal(row[column], null);
        assert.equal(row['集計画素数'], 0);
        assert.equal(row['状態'], 'UNAVAILABLE');
      }
      if (row['ROIキー'] === 'zero' && row['分子キー'] === 'MSI_5-HT') {
        assert.equal(row['平均値'], 0);
        assert.equal(output.cell(index, '平均値').t, 'n');
        assert.equal(output.cell(index, 'ROI名').t, 's');
        assert.equal(output.cell(index, 'ROI名').f, undefined, 'ROI names remain text rather than formulas');
      }
      assert.equal(row['値モード'], row['分子キー'] === 'MSI_5-HT' ? 'normalized' : 'raw');
      if (row['分子キー'] === 'MSI_D4-5-HT' && row['ROIキー'] === 'all') {
        assert.equal(row['平均値'], 2);
        assert.match(row['単位'], /raw|生信号/i);
      }
    }
    assert.equal(output.conditions.valueMode, 'normalized');
    assert.equal(output.conditions.sortOrder, 'mean');
    assert.equal(output.conditions.visibleRoiCount, 3);
    assert.match(output.conditions.note, /Otsu の非表示画素を含む/);
    assert.deepEqual(await scientificSnapshot(page), before);
    assert.match(await page.locator('#graph-export-status').innerText(), /6 行/);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('2D graph Excel refreshes after value mode, molecule, order and ROI changes and never exports suppressed corrected statistics', { timeout: 90000 }, async () => {
  const h = await fixture('viewer-graph-excel-coverage', { lowCoverage: true }), { page } = h;
  try {
    await page.getByLabel('追加表示2', { exact: true }).selectOption('none');
    await page.getByLabel('追加表示3', { exact: true }).selectOption('none');
    let output = await downloadWorkbook(page);
    let all = output.rows.find(row => row['ROIキー'] === 'all');
    assert.equal(all['中央値'], null);
    assert.equal(all['平均値'], null);
    assert.equal(all['標準偏差'], null);
    assert.equal(all['集計画素数'], 0);
    assert.equal(all['有効画素数'], 5);
    assert.equal(all['測定画素数'], 8);
    assert.equal(all['状態'], 'UNAVAILABLE');
    assert.ok(all['理由']);
    await page.locator('#value-raw').click();
    output = await downloadWorkbook(page);
    all = output.rows.find(row => row['ROIキー'] === 'all');
    assert.equal(all['値モード'], 'raw');
    assert.equal(all['中央値'], 27);
    assert.equal(all['平均値'], 33.625);
    assert.equal(all['集計画素数'], 8);
    assert.equal(all['有効画素数'], 8);
    await page.getByLabel('分子1', { exact: true }).selectOption('MSI_DA');
    await page.getByLabel('並び順', { exact: true }).selectOption('registration');
    await page.locator('.roi-item[data-roi-key="zero"] input[type="checkbox"]').uncheck();
    output = await downloadWorkbook(page);
    assert.deepEqual(output.rows.map(row => [row['分子キー'], row['ROIキー']]), [['MSI_DA', 'empty'], ['MSI_DA', 'all']]);
    assert.equal(output.conditions.sortOrder, 'registration');
    assert.equal(output.rows[1]['平均値'], 16.75);
    await page.locator('.roi-item[data-roi-key="empty"] input[type="checkbox"]').uncheck();
    await page.locator('.roi-item[data-roi-key="all"] input[type="checkbox"]').uncheck();
    assert.equal(await page.getByRole('button', { name: 'Excel出力', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('#graph-container').innerText(), '表示中の ROI がありません');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
