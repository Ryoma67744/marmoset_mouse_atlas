'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const XLSX = require('xlsx');
const { startBrowserHarness } = require('./browser-harness.cjs');
const { sectionId, seedAnalysisStack, readyAnalysisStack, scientificSnapshot } = require('./stack3d-analysis-fixture.cjs');

async function fixture() {
  const h = await startBrowserHarness();
  try {
    const body = await fs.readFile(require.resolve('xlsx/dist/xlsx.full.min.js'), 'utf8');
    await h.context.route('**/xlsx@*/dist/xlsx.full.min.js', route => route.fulfill({ contentType: 'application/javascript', body }));
    await seedAnalysisStack(h, { count: 8 });
    h.original = await scientificSnapshot(h.page); h.downloads = [];
    h.page.on('download', download => h.downloads.push(download));
    await h.page.goto(h.baseURL + '/stack3d/index.html?project=' + sectionId(1));
    await readyAnalysisStack(h.page, 8); await ready(h.page, 'selected');
    return h;
  } catch (error) { await h.close(); throw error; }
}
async function paint(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function ready(page, mode, valueMode) {
  await paint(page);
  await page.waitForFunction(({ mode, valueMode }) => {
    const state = Atlas3D.analysis.getState();
    return state.result?.mode === mode && (!valueMode || state.result.valueMode === valueMode) &&
      !document.querySelector('#analysis-export-excel').disabled;
  }, { mode, valueMode });
}
async function graphSnapshot(page) {
  await paint(page);
  return page.evaluate(() => {
    const state = Atlas3D.analysis.getState(), result = state.result;
    const channel = result.channels.find(item => item.key === state.activeMolecule);
    const card = document.querySelector('.analysis-molecule:not([hidden])');
    const keys = JSON.parse(card.querySelector('canvas').dataset.groupKeys);
    return { channel, groups: keys.map(key => channel.groups.find(group => group.key === key)), keys,
      result: JSON.stringify(result), generation: state.generation, mode: result.mode, valueMode: result.valueMode,
      sortOrder: state.sortOrder, selection: result.selection };
  });
}
async function download(h, selector = '#analysis-export-excel') {
  const event = h.page.waitForEvent('download');
  await h.page.locator(selector).click();
  const item = await event; assert.equal(await item.failure(), null); assert.match(item.suggestedFilename(), /^graph_.+\.xlsx$/);
  return XLSX.read(await fs.readFile(await item.path()), { type: 'buffer' });
}
function rows(workbook, sheet) { return XLSX.utils.sheet_to_json(workbook.Sheets[sheet], { defval: null }); }
function conditions(workbook) {
  return Object.fromEntries(XLSX.utils.sheet_to_json(workbook.Sheets.Conditions, { header: 1, defval: null }).slice(1));
}
function assertWorkbook(workbook, expected) {
  const actual = rows(workbook, 'Statistics'), sheet = workbook.Sheets.Statistics;
  const headers = XLSX.utils.sheet_to_json(sheet, { header: 1 })[0];
  assert.deepEqual(actual.map(row => row[expected.mode === 'by-section' ? '切片ID' : 'ROIキー']), expected.keys);
  assert.ok(actual.every(row => row['分子キー'] === expected.channel.key && row['分子名'] === expected.channel.name));
  const numeric = [
    ['中央値', group => group.distribution?.median], ['平均値', group => group.distribution ? group.statistics.mean : null],
    ['標準偏差', group => group.distribution ? group.statistics.sd : null], ['第1四分位数', group => group.distribution?.q1],
    ['第3四分位数', group => group.distribution?.q3], ['最小値', group => group.distribution?.min],
    ['P99', group => group.distribution?.whiskerHigh], ['最大値', group => group.distribution?.max],
    ['集計画素数', group => group.counts.nIncluded], ['有効画素数', group => group.counts.nValid],
    ['測定画素数', group => group.counts.nMeasured], ['ROI画素数', group => group.counts.nGeometry],
    ['対象切片数', group => group.counts.targetSections], ['ROI存在切片数', group => group.counts.roiSections],
    ['採用切片数', group => group.counts.includedSections]
  ];
  for (const [index, group] of expected.groups.entries()) {
    const row = actual[index];
    assert.equal(row['ROI名'], group.roiName || group.name); assert.equal(row['ROIキー'], group.roiName || group.key);
    assert.equal(row['単位'], group.unit || expected.channel.unit);
    assert.equal(row['値モード'], expected.valueMode); assert.equal(row['集計方法'], expected.mode);
    assert.equal(row['表示順'], index + 1); assert.equal(row['並び順'], expected.sortOrder); assert.equal(row['状態'], group.status);
    for (const [header, value] of numeric) {
      const expectedValue = value(group), cell = sheet[XLSX.utils.encode_cell({ r: index + 1, c: headers.indexOf(header) })];
      assert.equal(row[header], Number.isFinite(expectedValue) ? expectedValue : null, group.key + ' ' + header);
      if (Number.isFinite(expectedValue)) assert.equal(cell.t, 'n', header + ' stays numeric');
      else assert.ok(!cell || cell.t === 'z', header + ' unavailable values stay blank');
    }
  }
  const meta = conditions(workbook);
  assert.equal(meta.surface, '3D'); assert.equal(meta.channelKey, expected.channel.key);
  assert.equal(meta.mode, expected.mode); assert.equal(meta.valueMode, expected.valueMode); assert.equal(meta.sortOrder, expected.sortOrder);
  assert.equal(meta.targetSectionList, 'Sections シート参照'); assert.equal(meta.roiList, 'Statistics シート参照');
  assert.equal(meta.roiKeyDefinition, '3Dでは同名ROIをまとめた名称を識別子として使用');
  assert.equal(meta.targetSectionIds, undefined); assert.equal(meta.roiNames, undefined);
  assert.deepEqual([...new Set(rows(workbook, 'Sections').map(row => row['切片ID']))].sort(), expected.selection.sectionIds.slice().sort());
  return actual;
}

test('3D graph Excel exports only the active molecule in displayed order, including compact controls, without recalculation', { timeout: 90000 }, async () => {
  const h = await fixture(), { page } = h;
  try {
    let expected = await graphSnapshot(page);
    assertWorkbook(await download(h), expected);
    await page.locator('#analysis-sort-order').selectOption('mean');
    await page.locator('[data-analysis-molecule="NE"]').click();
    await page.locator('#analysis-axis-mode').selectOption('full');
    await page.locator('#analysis-toolbar-toggle').click();
    expected = await graphSnapshot(page);
    assertWorkbook(await download(h, '#analysis-mini-export-excel'), expected);
    const after = await graphSnapshot(page);
    assert.equal(after.result, expected.result); assert.equal(after.generation, expected.generation);
    assert.deepEqual(await scientificSnapshot(page), h.original);
    assert.match(await page.locator('#analysis-export-status').innerText(), /NE.*3行/);
    assert.equal(h.downloads.length, 2); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('3D section and pooled Excel keep unavailable rows blank and list every included and excluded target section', { timeout: 90000 }, async () => {
  const h = await fixture(), { page } = h;
  try {
    await page.locator('[data-analysis-mode="by-section"]').click(); await ready(page, 'by-section');
    await page.locator('#analysis-conditions-summary').click();
    await page.locator('#analysis-single-roi').selectOption('Thalamus'); await ready(page, 'by-section');
    await page.locator('#value-mode').selectOption('normalized'); await ready(page, 'by-section', 'normalized');
    await page.locator('#analysis-sort-order').selectOption('mean');
    let expected = await graphSnapshot(page), workbook = await download(h);
    const sectionStats = assertWorkbook(workbook, expected);
    assert.equal(sectionStats.length, 8);
    assert.ok(sectionStats.every(row => row['ROIキー'] === 'Thalamus'));
    assert.ok(rows(workbook, 'Sections').every(row => row['ROIキー'] === 'Thalamus'));
    const unavailable = sectionStats.filter(row => [sectionId(7), sectionId(8)].includes(row['切片ID']));
    assert.equal(unavailable.length, 2);
    for (const row of unavailable) {
      assert.equal(row['平均値'], null); assert.equal(row['標準偏差'], null); assert.equal(row['集計画素数'], 0);
      assert.ok(row['理由']);
    }
    assert.deepEqual(sectionStats.slice(-2).map(row => row['切片ID']), [sectionId(7), sectionId(8)]);
    await page.locator('[data-analysis-mode="pooled"]').click(); await ready(page, 'pooled', 'normalized');
    await page.locator('#analysis-all-rois').uncheck();
    await page.locator('#analysis-roi-checks input[data-roi-name="Thalamus"]').check(); await ready(page, 'pooled', 'normalized');
    expected = await graphSnapshot(page); workbook = await download(h);
    const pooled = assertWorkbook(workbook, expected);
    assert.equal(pooled.length, 1); assert.equal(pooled[0]['対象切片数'], 8); assert.equal(pooled[0]['採用切片数'], 6);
    assert.match(pooled[0]['理由'], /全有効画素を統合/, 'group warnings are retained alongside exclusions');
    const targets = rows(workbook, 'Sections');
    assert.deepEqual(targets.map(row => row['切片ID']), Array.from({ length: 8 }, (_, index) => sectionId(index + 1)));
    assert.deepEqual(targets.filter(row => row['状態'] === 'EXCLUDED').map(row => row['切片ID']), [sectionId(7), sectionId(8)]);
    assert.equal(targets.filter(row => row['状態'] === 'INCLUDED').length, 6);
    assert.ok(targets.filter(row => row['状態'] === 'EXCLUDED').every(row => row['理由']));
    assert.equal((await graphSnapshot(page)).result, expected.result);
    assert.deepEqual(await scientificSnapshot(page), h.original); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('3D Excel disables immediately for queued calculations, pending results, stale data and failed loads', { timeout: 90000 }, async () => {
  const h = await fixture(), { page } = h;
  try {
    const scheduled = await page.evaluate(() => {
      document.querySelector('[data-analysis-mode="by-section"]').click();
      return { regular: document.querySelector('#analysis-export-excel').disabled,
        compact: document.querySelector('#analysis-mini-export-excel').disabled, attempted: Atlas3D.analysis.exportGraphExcel() };
    });
    assert.deepEqual(scheduled, { regular: true, compact: true, attempted: false });
    await ready(page, 'by-section');
    await page.evaluate(() => {
      const analyze = Stack3DAnalysis.analyze;
      Stack3DAnalysis.analyze = (...args) => new Promise(resolve => {
        window.__resumeAnalysis = () => { Stack3DAnalysis.analyze = analyze; resolve(analyze(...args)); };
      });
      document.querySelector('[data-analysis-mode="pooled"]').click();
    });
    await page.waitForFunction(() => typeof window.__resumeAnalysis === 'function');
    assert.equal(await page.locator('#analysis-export-excel').isDisabled(), true);
    assert.equal(await page.locator('#analysis-mini-export-excel').isDisabled(), true);
    assert.equal(await page.evaluate(() => Atlas3D.analysis.exportGraphExcel()), false);
    await page.evaluate(() => window.__resumeAnalysis()); await ready(page, 'pooled');
    await page.evaluate(() => Atlas3D.analysis.markStale());
    assert.equal(await page.locator('#analysis-export-excel').isDisabled(), true);
    assert.match(await page.locator('#analysis-export-excel').getAttribute('title'), /再読込/);
    assert.equal(await page.evaluate(() => Atlas3D.analysis.exportGraphExcel()), false);
    await page.evaluate(() => Atlas3D.analysis.beginLoad());
    assert.equal(await page.locator('#analysis-export-excel').isDisabled(), true);
    await page.evaluate(() => Atlas3D.analysis.loadFailed('Synthetic failure'));
    assert.equal(await page.locator('#analysis-export-excel').isDisabled(), true);
    assert.equal(await page.evaluate(() => Atlas3D.analysis.exportGraphExcel()), false);
    assert.equal(h.downloads.length, 0); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
