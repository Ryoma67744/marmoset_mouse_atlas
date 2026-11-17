'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');
const root = path.resolve(__dirname, '..');
const scope = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'comparison/data/t462/manifest.js'), 'utf8'), scope);
const manifest = scope.window.MSI_ST_T462;
const bootstrap = fs.readFileSync(path.join(root, 'comparison/bootstrap.js'), 'utf8');
const payload = JSON.parse(zlib.gunzipSync(Buffer.from(JSON.parse(bootstrap.match(/^window\.MARMOSET_BOOTSTRAP=("[^"]+");/)[1]), 'base64')));

async function fixture(t) {
  const h = await startBrowserHarness(); t.after(() => h.close());
  const requests = [];
  await h.context.route('**/stomics/api/explore/api/**', route => {
    requests.push(route.request().url());
    const section = new URL(route.request().url()).searchParams.get('id')?.replace('MBCSTA_', '');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ var: payload.catalogs[section] || [] }) });
  });
  await seedViewerProject(h.page, h.baseURL, { id: 'proj_msy523hn_590k3n' });
  await h.page.goto(h.baseURL + '/comparison/index.html?section=Cor_9_3');
  await h.page.waitForFunction(() => document.querySelector('#mx-st-canvas')._points?.length === 11337);
  await h.page.waitForFunction(() => !document.querySelector('#mx-msi-canvas').hidden);
  return { ...h, requests };
}
async function hoverBin(page, index) {
  const canvas = page.locator('#mx-st-canvas'); await canvas.scrollIntoViewIfNeeded();
  const point = await canvas.evaluate((node, i) => node._points[i].slice(0, 2), index);
  await canvas.hover({ position: { x: point[0], y: point[1] } });
  await page.waitForFunction(i => {
    const s=document.querySelector('#mx-st-canvas')._section,tip=document.querySelector('#mx-st-tooltip');
    return !tip.hidden && tip.textContent.includes('x='+s.x[i]+', y='+s.y[i]);
  }, index);
  return page.locator('#mx-st-tooltip').innerText();
}
async function selectGene(page, gene) {
  if (!await page.locator('#mx-library').isVisible()) await page.locator('#mx-library-toggle').click();
  await page.locator('#mx-gene-search').fill(gene);
  await page.getByRole('checkbox', { name: gene + 'を表示', exact: true }).check();
}

test('Cor_9_3 displays all three sources as one ST with accurate hover, common range and section navigation', async t => {
  const { page, requests, errors } = await fixture(t);
  assert.equal(await page.locator('#mx-st-canvas').count(), 1);
  assert.match(await page.locator('#mx-st-coverage').innerText(), /皮質＋視床・線条体/);
  assert.match(await page.locator('#mx-section-context').innerText(), /32,891/);
  assert.match(await page.locator('#mx-st-data-note').innerText(), /RNAカウント/);
  assert.equal(requests.length, 0, 'T462 never calls the cortex-only API');
  for (const source of manifest.sources) {
    const i = source.offset + Math.floor(source.n / 2);
    const tooltip = await hoverBin(page, i);
    assert.ok(tooltip.includes(source.label));
    assert.ok(tooltip.includes(manifest.region.categories[manifest.region.values[i]]));
    assert.ok(tooltip.includes('DRD1 = ' + manifest.initialGenes.DRD1[i]));
    if (source.id !== 'Cortex') assert.match(tooltip, /対象外（皮質下）/);
  }
  await page.locator('#mx-st-mode').selectOption('layer');
  await page.waitForFunction(() => document.querySelector('#mx-st-canvas')._context.includes('|layer|'));
  assert.match(await hoverBin(page, manifest.sources[2].offset), /対象外（皮質下）/);
  await page.locator('#mx-st-mode').selectOption('gene');
  await page.locator('#mx-st-controls summary').click();
  await page.locator('#mx-st-range-min').fill('0');
  await page.locator('#mx-st-range-max').fill('10');
  assert.equal(await page.locator('#mx-max').innerText(), '10');
  assert.match(await page.locator('#mx-st-range-note').innerText(), /全領域に共通/);
  await page.locator('#mx-st-controls summary').click();
  assert.equal(await page.locator('#mx-st-range-max').isVisible(), false);
  await page.locator('#mx-pair-select').selectOption('T430');
  await page.waitForFunction(() => document.querySelector('#mx-st-canvas')._points?.length === 6101);
  assert.match(await page.locator('#mx-st-coverage').innerText(), /^表示範囲：皮質 ·/);
  await page.locator('#mx-pair-select').selectOption('T462');
  await page.waitForFunction(() => document.querySelector('#mx-st-canvas')._points?.length === 11337);
  assert.equal(await page.locator('#mx-max').innerText(), '10');
  assert.ok(requests.every(url => !url.includes('T462')));
  assert.deepEqual(errors, []);
});

test('lazy local genes preserve missing-vs-zero and recover from a shard failure', async t => {
  const { page, context, errors } = await fixture(t);
  const cortex = new Set(manifest.sources[0].genes);
  const gene = manifest.genes.find(g => !cortex.has(g) && !Object.hasOwn(manifest.initialGenes, g));
  assert.ok(gene, 'fixture exercises a real subcortex-only catalog entry');
  const shardPath = manifest.geneChunks[gene]; let attempts = 0;
  await context.route('**/data/t462/' + shardPath, route => {
    attempts++;
    return attempts === 1 ? route.fulfill({ status: 503, body: 'temporary fixture failure' }) : route.continue();
  });
  await selectGene(page, gene);
  await page.waitForFunction(() => document.querySelector('#mx-overlay').textContent === '取得できませんでした');
  assert.equal(await page.locator('#mx-st-canvas').evaluate(c => c._points.length), 11337);
  await page.locator('#mx-retry').click();
  await page.waitForFunction(() => document.querySelector('#mx-overlay').hidden && !document.querySelector('#mx-st-availability').hidden);
  assert.equal(attempts, 2);
  const measured = manifest.sources.filter(s => s.genes.includes(gene)).reduce((n, s) => n + s.n, 0);
  const missing = 11337 - measured;
  const availability = await page.locator('#mx-st-availability').innerText();
  assert.ok(availability.includes(missing.toLocaleString('en-US') + ' bin'));
  assert.ok(availability.includes(measured.toLocaleString('en-US') + ' binで計算'));
  await page.locator('#mx-library-toggle').click();
  assert.match(await hoverBin(page, 0), /この領域では未収録/);
  const shard = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'comparison/data/t462', shardPath))));
  const sparse = shard.genes[gene]; const positive = new Set(); let index = 0;
  sparse.deltaIndices.forEach((delta, i) => { index = i ? index + delta : delta; positive.add(index); });
  const source = manifest.sources.find(s => s.genes.includes(gene));
  let zero = source.offset;
  while (positive.has(zero) && zero < source.offset + source.n) zero++;
  assert.ok(zero < source.offset + source.n, 'fixture has a measured zero');
  assert.ok((await hoverBin(page, zero)).includes(gene + ' = 0'));
  await selectGene(page, gene); // Already selected: no request or duplicate rows.
  assert.equal(attempts, 2);
  const hide = page.getByRole('button', { name: gene + 'を非表示', exact: true }); await hide.click();
  assert.equal(await hide.count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.deepEqual(errors, []);
});
