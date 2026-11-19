'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

async function setup(t) {
  const harness = await startBrowserHarness();
  t.after(() => harness.close());
  const { page, baseURL, context } = harness;
  const registered = 'proj_mu2doxrs_euob1x';
  const reference = 'proj_mu1e4mep_x3hlio';
  // The fixtures populate the actual browser storage. Only the registered sample has a V1 ROI.
  for (const id of [registered, reference]) await seedViewerProject(page, baseURL, { id });
  await page.evaluate(async id => {
    const project = await ProjectStorage.getProject(id);
    project.roi.roi_names.all = 'V1';
    await ProjectStorage.putProject(project);
  }, registered);
  await context.route('**/stomics/api/explore/api/**', route => route.fulfill({
    status: 503, body: 'No external requests in the browser fixture.'
  }));
  await page.goto(baseURL + '/comparison/index.html?section=Cor_2_3');
  await page.waitForFunction(() => document.querySelector('#la-status').textContent.includes('30,009'));
  await page.waitForFunction(() => !document.querySelector('#mx-msi-canvas').hidden);
  return harness;
}

test('real T503 matrix, ROI source switching, contrast and gene selection stay in sync', async t => {
  const { page, errors } = await setup(t);
  const profile = page.locator('#la-profile-rows');
  await page.locator('#la-show-matrix').click();
  assert.equal(await page.locator('#la-matrix-head th').allTextContents().then(x => x.join(',')),
    '遺伝子,L1,L2,L3,L4,L5,L6,V1,V2');
  await page.locator('#la-matrix-next').click();
  assert.match(await page.locator('#la-matrix-count').innerText(), /9–16/);
  await page.locator('#la-matrix-query').fill('htr2a');
  await page.locator('#la-matrix-rows button').first().click();
  assert.match(await page.locator('#la-profile-title').innerText(), /HTR2A/);
  assert.match(await page.locator('#mx-st-heading').innerText(), /HTR2A/);
  assert.match(await page.locator('#la-gene-stats').innerText(), /1\.46/);
  const l4 = profile.getByRole('row').filter({ has: page.getByRole('button', { name: 'L4', exact: true }) });
  assert.deepEqual((await l4.locator('td').allTextContents()).slice(1), ['—', '—', '2.271', '1,029 / 1,053', '97.7%']);
  await page.locator('#la-matrix-metric').selectOption('detected');
  assert.equal(await page.locator('#la-matrix-rows tr').first().locator('td').nth(4).innerText(), '1,029');
  const v1 = profile.getByRole('row').filter({ has: page.getByRole('button', { name: 'V1', exact: true }) });
  assert.equal(await v1.locator('td').nth(1).innerText(), '27');
  await v1.getByRole('button').click();
  assert.equal(await page.locator('#la-contrast').inputValue(), 'V1');
  await page.locator('#mx-msi-source').selectOption('proj_mu1e4mep_x3hlio');
  await page.waitForFunction(() => document.querySelector('#mx-msi-load-status').textContent.includes('Cor_2_2の保存済みMSI・ROIを表示中'));
  assert.match(await page.locator('#la-scope').innerText(), /Cor_2_2.*参照/);
  assert.equal(new URL(page.url()).searchParams.get('msiReference'), 'Cor_2_2');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#la-status').textContent.includes('30,009') &&
    document.querySelector('#mx-msi-load-status').textContent.includes('Cor_2_2の保存済みMSI・ROIを表示中'));
  assert.equal(await page.locator('#mx-msi-source').inputValue(), 'proj_mu1e4mep_x3hlio');
  assert.equal(await v1.locator('td').nth(1).innerText(), '—');
  assert.equal(await l4.locator('td').nth(3).innerText(), '2.271');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.locator('#la-show-analysis').click();
  await page.locator('#la-contrast').selectOption('L4');
  await page.locator('#la-query').fill('HTR2A');
  assert.match(await page.locator('#la-gene-rows').innerText(), /HTR2A/);
  await page.locator('#la-export-scope').selectOption('gene');
  await page.locator('#la-format').selectOption('svg');
  const download = page.waitForEvent('download');
  await page.locator('#la-save').click();
  const file = await download;
  assert.match(file.suggestedFilename(), /\.svg$/);
  const figure = await fs.readFile(await file.path(), 'utf8');
  assert.match(figure, /T503/);
  assert.match(figure, /L4/);
  assert.equal(await page.evaluate(source =>
    new DOMParser().parseFromString(source, 'image/svg+xml').querySelector('parsererror') === null, figure), true);
  await page.locator('#la-format').selectOption('png');
  const pngDownload = page.waitForEvent('download');
  await page.locator('#la-save').click();
  const pngFile = await pngDownload;
  const png = await fs.readFile(await pngFile.path());
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual(errors, []);
});

test('T503 validated contrast opens directly, renders real P values and keeps other contrasts descriptive', async t => {
  const { page, errors } = await setup(t);
  const button = page.getByRole('button', { name: 'L3のボルケーノを開く' });
  await button.click();
  assert.equal(await page.locator('#la-mode').inputValue(), 'volcano');
  assert.equal(await page.locator('#la-contrast').inputValue(), 'L3');
  assert.match(await page.locator('#la-plot-note').innerText(), /検定/);
  await page.locator('#la-order').selectOption('q');
  const first = page.locator('#la-gene-rows tr').first();
  const gene = await first.getByRole('button').innerText();
  await first.getByRole('button').click();
  assert.ok((await page.locator('#la-gene-stats').innerText()).includes(gene));
  assert.match(await page.locator('#la-gene-stats').innerText(), /BH調整P [\de.\-+]+/);
  const marker = page.locator('#la-plot circle');
  await marker.hover();
  assert.match(await page.locator('#la-tooltip').innerText(), /BH調整P/);
  await marker.click();
  await page.locator('#la-contrast').selectOption('L4');
  assert.equal(await page.locator('#la-mode').inputValue(), 'ma');
  assert.equal(await page.locator('#la-mode option[value=volcano]').evaluate(option => option.matches(':disabled')), true);
  assert.equal(await page.locator('#la-order').inputValue(), 'targetMean');
  assert.deepEqual(errors, []);
});

test('downloaded HTML restores the visible gene list and links volcano points to the regional profile offline', async t => {
  const { page, context, baseURL, errors } = await setup(t);
  await page.getByRole('button', { name: 'L3のボルケーノを開く' }).click();
  await page.locator('#la-query').fill('HTR');
  await page.locator('#la-order').selectOption('q');
  const expected = await page.locator('#la-gene-rows button').allTextContents();
  assert.ok(expected.length > 1);
  await page.locator('#la-gene-rows button').first().click();
  await page.locator('#la-export-scope').selectOption('contrast');
  await page.locator('#la-format').selectOption('html');
  const pending = page.waitForEvent('download');
  await page.locator('#la-save').click();
  const file = await pending;
  const html = await fs.readFile(await file.path(), 'utf8');
  const report = await context.newPage();
  const requests = [];
  report.on('pageerror', error => errors.push(error.message));
  await report.route('**/*', route => {
    if (route.request().url() === baseURL + '/report.html') {
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    requests.push(route.request().url());
    return route.abort();
  });
  await report.goto(baseURL + '/report.html');
  assert.equal(await report.locator('#mode').inputValue(), 'volcano');
  assert.equal(await report.locator('#gene-name').innerText(), expected[0]);
  assert.equal(await report.locator('#list-order').inputValue(), 'q');
  assert.equal(await report.locator('#list-query').inputValue(), 'HTR');
  assert.deepEqual((await report.locator('#results button').allTextContents()).slice(0, expected.length), expected);
  await report.locator('#plot').scrollIntoViewIfNeeded();
  const point = await report.evaluate(() => {
    const data = JSON.parse(document.querySelector('#data').textContent);
    const j = data.keys.indexOf(data.active);
    const points = data.rows.filter(row => row[3][j][5] === 'validated').map(row => ({
      gene: row[0], x: row[3][j][2], y: -Math.log10(Math.max(Number.MIN_VALUE, row[3][j][4])),
    }));
    const top = points.reduce((best, cur) => cur.y > best.y ? cur : best);
    const min = Math.min(-data.settings.effectThreshold, ...points.map(p => p.x));
    const max = Math.max(data.settings.effectThreshold, ...points.map(p => p.x));
    const canvas = document.querySelector('#plot'), box = canvas.getBoundingClientRect();
    return {
      gene: top.gene,
      x: box.left + (52 + (top.x - min) / (max - min) * (canvas.width - 76)) * box.width / canvas.width,
      y: box.top + 20 * box.height / canvas.height,
    };
  });
  await report.mouse.move(point.x, point.y);
  assert.ok((await report.locator('#hover').innerText()).startsWith(point.gene + '　モデルlog₂FC '));
  assert.match(await report.locator('#hover').innerText(), /BH調整P/);
  await report.mouse.click(point.x, point.y);
  assert.equal(await report.locator('#gene-name').innerText(), point.gene);
  assert.equal(await report.locator('#profile tr').count(), 8);
  assert.deepEqual(requests, []);
  assert.deepEqual(errors, []);
});
