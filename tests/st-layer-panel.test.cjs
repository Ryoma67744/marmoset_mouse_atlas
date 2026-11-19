'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const XLSX = require('xlsx');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

const layers = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
const csvFields = ['st_section', 'layer', 'gene', 'mean_cp10k', 'detected_bins', 'total_bins', 'detection_pct'];
const t503Genes = 30009;

async function setup(t, beforeOpen) {
  const harness = await startBrowserHarness();
  t.after(() => harness.close());
  const { page, baseURL, context } = harness;
  const testFiles = [];
  page.on('request', request => {
    if (/\/layer-analysis\/t503-(?:l3|spatial-validation)/.test(request.url())) testFiles.push(request.url());
  });
  await context.route('**/stomics/api/explore/api/**', route => route.fulfill({ status: 503, body: '' }));
  await context.route('**/xlsx.full.min.js', route => route.fulfill({
    path: require.resolve('xlsx/dist/xlsx.full.min.js'), contentType: 'application/javascript'
  }));
  if (beforeOpen) await beforeOpen(page, baseURL);
  await page.goto(baseURL + '/comparison/index.html?section=Cor_2_3');
  await page.waitForFunction(() => document.querySelector('#la-status')?.textContent.includes('30,009'));
  return { ...harness, testFiles };
}

function numeric(text) {
  return Number(text.replace(/[,\s%]/g, ''));
}

async function checkHtr2a(page, mean, detected, total) {
  const row = page.locator('#la-gene-rows tr').filter({ has: page.getByText('HTR2A', { exact: true }) });
  const cells = (await row.locator('td').allTextContents()).map(text => text.trim());
  assert.equal(cells.length, 5);
  assert.equal(cells[0], 'HTR2A');
  const values = cells.slice(1).map(numeric);
  assert.ok(Math.abs(values[0] - mean) < 0.001);
  assert.equal(values[1], detected);
  assert.equal(values[2], total);
  assert.ok(Math.abs(values[3] - 100 * detected / total) < 0.1);
}

async function download(page, scope, format) {
  await page.locator('#la-export-scope').selectOption(scope);
  await page.locator('#la-format').selectOption(format);
  const pending = page.waitForEvent('download', { timeout: 60000 });
  await page.locator('#la-save').click();
  const file = await pending;
  assert.equal(await file.failure(), null);
  return { name: file.suggestedFilename(), bytes: await fs.readFile(await file.path()) };
}

test('each layer opens without MSI: real T503 values, another section, and no contrast controls or test files', async t => {
  const { page, context, baseURL, errors, testFiles } = await setup(t);
  const home = await context.newPage();
  await home.goto(baseURL + '/index.html');
  const entry = home.locator('#open-layer-data');
  assert.match(await entry.textContent(), /層別データ/);
  assert.equal(await entry.evaluate(link => link.href), baseURL + '/comparison/index.html');
  await home.close();
  const layer = page.locator('#la-layer');
  assert.equal(await layer.inputValue(), 'L1');
  assert.deepEqual(await layer.locator('option').evaluateAll(options => options.map(option => option.value)), layers);
  assert.equal(await page.locator('#la-contrast, #la-mode, #la-plot').count(), 0);
  await page.locator('.la-msi summary').click();
  assert.match(await page.locator('#la-msi-summary').innerText(), /保存|未登録|登録ROI|未読込/);

  await page.locator('#la-query').fill('htr2a');
  await checkHtr2a(page, 0.4591896074885584, 342, 1046);
  await layer.selectOption('L4');
  await checkHtr2a(page, 2.2713066699364455, 1029, 1053);
  await page.locator('#mx-pair-select').selectOption('T430');
  await page.waitForFunction(() => document.querySelector('#la-status').textContent.includes('28,887'));
  await layer.selectOption('L4');
  await page.locator('#la-query').fill('HTR2A');
  const row = page.locator('#la-gene-rows tr').filter({ has: page.getByText('HTR2A', { exact: true }) });
  assert.equal(numeric(await row.locator('td').nth(3).innerText()), 202);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.deepEqual(testFiles, []);
  assert.deepEqual(errors, []);
});

async function seedSavedLayer(page, baseURL) {
  const id = 'proj_mu2doxrs_euob1x';
  await seedViewerProject(page, baseURL, { id });
  await page.evaluate(async id => {
    const project = await ProjectStorage.getProject(id);
    const rectangle = left => [{ poly_msi: [[left, -.5], [3.5, -.5], [3.5, 1.5], [left, 1.5]] }];
    project.roi.roi_items = { b3: rectangle(-.5), b4: rectangle(.5) };
    project.roi.roi_names = { b3: 'Layer 3', b4: 'Layer 4' };
    await ProjectStorage.putProject(project);
  }, id);
}

test('selected and all-layer downloads contain full gene tables even with an empty visible search result', async t => {
  const { page, errors, testFiles } = await setup(t, seedSavedLayer);
  await page.waitForFunction(() => !document.querySelector('#mx-msi-canvas').hidden);
  await page.locator('#la-layer').selectOption('L4');
  await page.locator('#la-query').fill('no-such-gene-0000000');
  const one = await download(page, 'layer', 'csv');
  assert.equal(one.name, 'T503_L4.csv');
  const csv = one.bytes.toString('utf8').replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
  assert.deepEqual(csv[0].split(','), csvFields);
  assert.equal(csv.length - 1, t503Genes);
  const targets = csv.filter(line => line.startsWith('T503,L4,HTR2A,'));
  assert.equal(targets.length, 1);
  const values = targets[0].split(',').slice(3).map(Number);
  assert.ok(Math.abs(values[0] - 2.2713066699364455) < 1e-12);
  assert.deepEqual(values.slice(1, 3), [1029, 1053]);
  assert.ok(Math.abs(values[3] - 100 * 1029 / 1053) < 1e-12);

  const all = await download(page, 'all', 'csv');
  const rows = all.bytes.toString('utf8').trimEnd().split(/\r?\n/).slice(1);
  assert.equal(rows.length, t503Genes * 6);
  const counts = new Map();
  for (const row of rows) {
    const match = /^T503,(L[1-6]),/.exec(row);
    if (!match) assert.fail('Unexpected section or layer in a CSV data row');
    const layer = match[1];
    counts.set(layer, (counts.get(layer) || 0) + 1);
  }
  assert.deepEqual([...counts], layers.map(layer => [layer, t503Genes]));

  const workbook = await download(page, 'layer', 'xlsx');
  assert.equal(workbook.name, 'T503_L4.xlsx');
  const book = XLSX.read(workbook.bytes, { type: 'buffer', sheetRows: 2 });
  assert.deepEqual(book.SheetNames, ['説明', 'L4', 'Metadata', 'MSI_ROI']);
  assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets['説明'], { header: 1 })[0], ['区分', '項目', '説明']);
  const sheet = book.Sheets.L4;
  assert.equal(XLSX.utils.decode_range(sheet['!fullref']).e.r, t503Genes);
  assert.deepEqual(XLSX.utils.sheet_to_json(sheet, { header: 1 })[0], csvFields.slice(2));
  const [msi] = XLSX.utils.sheet_to_json(book.Sheets.MSI_ROI);
  assert.equal(msi.msi_section, 'Cor_2_3');
  assert.equal(msi.layer, 'L4');
  assert.equal(msi.molecule, '5-HT');
  // Saved Layer 3 minus Layer 4 contains two native pixels with raw signals 0 and 50.
  assert.equal(msi.median_au, 25);
  assert.equal(msi.measured_pixels, 2);
  assert.deepEqual(testFiles, []);
  assert.deepEqual(errors, []);
});
