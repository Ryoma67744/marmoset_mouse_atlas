'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const XLSX = require('xlsx');
const postcss = require('postcss');
const tailwindcss = require('tailwindcss');
const { startBrowserHarness } = require('./browser-harness.cjs');

const root = path.resolve(__dirname, '..');
const layerKey = layer => '__cortical_layer__' + layer;
let styles;
function productionStyles() {
  if (!styles) styles = postcss([tailwindcss({ content: [path.join(root, 'viewer/index.html')], theme: { extend: {} } })])
    .process('@tailwind base; @tailwind components; @tailwind utilities;', { from: undefined }).then(result => result.css);
  return styles;
}

async function fixture(id, { missing = false, nonnested = false, ambiguous = false } = {}) {
  const h = await startBrowserHarness();
  try {
    const [xlsx, css] = await Promise.all([fs.readFile(require.resolve('xlsx/dist/xlsx.full.min.js'), 'utf8'), productionStyles()]);
    await h.context.route('**/xlsx@*/dist/xlsx.full.min.js', route => route.fulfill({ contentType: 'application/javascript', body: xlsx }));
    await h.context.route(/https:\/\/cdn\.tailwindcss\.com\/?$/, route => route.fulfill({ contentType: 'application/javascript',
      body: 'const style=document.createElement("style");style.textContent=' + JSON.stringify(css) + ';document.head.append(style);' }));
    await h.page.goto(h.baseURL + '/__test_seed');
    h.original = await h.page.evaluate(async ({ id, missing, nonnested, ambiguous }) => {
      const W = 16, H = 16;
      const rectangle = inset => [{ poly_msi: [[inset - .5, inset - .5], [15.5 - inset, inset - .5],
        [15.5 - inset, 15.5 - inset], [inset - .5, 15.5 - inset]] }];
      const roi = { roi_items: { whole: rectangle(0), wm: rectangle(6) },
        roi_names: { whole: 'Occipital lobe whole', wm: 'White matter' },
        palette: { whole: [255, 215, 0, 255], wm: [180, 80, 210, 255] },
        roi_show_flags: { whole: true, wm: true } };
      const colors = [[250, 190, 40], [70, 180, 235], [235, 100, 110], [45, 200, 170], [140, 110, 240]];
      for (let layer = 1; layer <= 5; layer++) {
        const key = 'boundary' + layer;
        roi.roi_items[key] = rectangle(layer);
        roi.roi_names[key] = 'Layer ' + layer;
        roi.palette[key] = [...colors[layer - 1], 255];
        roi.roi_show_flags[key] = true;
      }
      if (missing) { delete roi.roi_items.boundary2; delete roi.roi_names.boundary2; }
      if (nonnested) roi.roi_items.boundary3 = rectangle(1);
      if (ambiguous) {
        roi.roi_items.boundary2duplicate = rectangle(2);
        roi.roi_names.boundary2duplicate = 'Layer 2';
        roi.palette.boundary2duplicate = [240, 120, 80, 255];
        roi.roi_show_flags.boundary2duplicate = true;
      }
      const values = Float32Array.from({ length: W * H }, (_, i) => {
        const x = i % W, y = Math.floor(i / W), depth = Math.min(x, y, W - 1 - x, H - 1 - y);
        return Math.min(depth, 6) * 10 + 2 * ((x + y) % 2);
      });
      const standard = new Float32Array(W * H).fill(2);
      const p = { id, displayName: 'Synthetic cortical layers (16 × 16)', grid: { W, H }, images: {}, roi,
        visibleLayers: ['MSI_5-HT'], valueDisplay: { mode: 'normalized', scaleMode: 'individual' },
        rotation: { all: 0, msi: 0, he: 0 }, otsu: { applied: false, sourceKeys: ['MSI_5-HT'], strength: 0, manualThreshold: null }, molecules: [] };
      const rasters = {};
      for (const [key, name, signal] of [['MSI_5-HT', '5-HT', values], ['MSI_D4-5-HT', 'D4-5-HT', standard]]) {
        p.molecules.push({ key, name, blobId: await ProjectStorage.putValueRaster(signal), stats: MSIRaster.deriveBakeStats(signal) });
        rasters[key] = { W, H, values: signal };
      }
      p.normalization = Normalization.createPixelRatioProfile(p, rasters, {
        id: 'cortical-browser-profile', revision: 1, standardKey: 'MSI_D4-5-HT', targetKeys: ['MSI_5-HT'],
        standardApplication: { method: 'uniform_spray', confirmed: true, source: 'synthetic regression fixture' },
      });
      await ProjectStorage.putProject(p);
      return { source: { items: roi.roi_items, names: roi.roi_names, palette: roi.palette },
        normalization: p.normalization, raw: Array.from(new Uint32Array(values.buffer)) };
    }, { id, missing, nonnested, ambiguous });
    await h.page.goto(h.baseURL + '/viewer/index.html?project=' + id);
    await h.page.waitForFunction(() => typeof viewerReady !== 'undefined' && viewerReady);
    await h.page.getByLabel('分子1', { exact: true }).selectOption('MSI_5-HT');
    await h.page.getByLabel('追加表示2', { exact: true }).selectOption('none');
    await h.page.getByLabel('追加表示3', { exact: true }).selectOption('none');
    await h.page.locator('.roi-item[data-roi-key="__cortical_layer__4"]').click();
    return h;
  } catch (error) { await h.close(); throw error; }
}

const snapshot = page => page.evaluate(() => structuredClone(analysisExportSnapshot));
const scientific = page => page.evaluate(async () => {
  const saved = await ProjectStorage.getProject(currentProject.id);
  return { source: { items: saved.roi.roi_items, names: saved.roi.roi_names, palette: saved.roi.palette },
    normalization: saved.normalization, raw: Array.from(new Uint32Array(valueRasters['MSI_5-HT'].values.buffer)) };
});
const numeric = snap => snap.rows.map(row => Object.fromEntries(['roiKey', 'median', 'mean', 'sd', 'q1', 'q3', 'min', 'max', 'n', 'nValid', 'nMeasured', 'nGeometry']
  .map(key => [key, row[key]])));

function verifyLayers(snap, mode) {
  const rows = snap.rows.filter(row => row.roiKind === 'cortical-layer');
  assert.equal(rows.length, 6);
  for (let layer = 1; layer <= 6; layer++) {
    const row = rows.find(row => row.roiKey === layerKey(layer));
    const divisor = mode === 'normalized' ? 2 : 1;
    const base = (layer - 1) * 10, count = 68 - 8 * layer;
    assert.ok(row, 'Layer ' + layer + ' exists');
    assert.equal(row.roiName, 'Layer ' + layer);
    assert.equal(row.valueMode, mode);
    assert.equal(row.median, (base + 1) / divisor);
    assert.ok(Math.abs(row.mean - (base + 1) / divisor) < 1e-10, row.roiName + ' exact mean');
    assert.ok(Math.abs(row.sd - 1 / divisor) < 1e-10, row.roiName + ' pixel SD');
    assert.equal(row.q1, base / divisor);
    assert.equal(row.q3, (base + 2) / divisor);
    for (const field of ['n', 'nValid', 'nMeasured', 'nGeometry']) assert.equal(row[field], count, row.roiName + ' ' + field);
    assert.equal(row.roiDefinition, layer === 1 ? 'Whole − Layer 1' : layer === 6 ? 'Layer 5 − White matter' : 'Layer ' + (layer - 1) + ' − Layer ' + layer);
    assert.equal(row.roiRuleVersion, 'cortical-difference-v1');
  }
}

async function graphWorkbook(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Excel出力', exact: true }).click()]);
  assert.equal(await download.failure(), null);
  const book = XLSX.read(await fs.readFile(await download.path()), { type: 'buffer' });
  return { rows: XLSX.utils.sheet_to_json(book.Sheets.Statistics, { defval: null }),
    conditions: Object.fromEntries(XLSX.utils.sheet_to_json(book.Sheets.Conditions, { header: 1 })) };
}

test('Viewer exposes six disjoint layers, exact raw/normalized statistics and matching graph Excel without changing source boundaries', { timeout: 90000 }, async () => {
  const h = await fixture('viewer-cortical-exact'), { page } = h;
  try {
    assert.equal(await page.locator('.roi-item').count(), 8, 'Whole, white matter and six analytical layers');
    assert.equal(await page.locator('#roi-boundaries .roi-boundary-item').count(), 5, 'source boundaries remain separately editable');
    assert.equal(await page.locator('.analysis-table tr[data-roi-key^="boundary"]').count(), 0, 'cumulative boundaries are not quantified as layers');
    assert.equal(await page.locator('.roi-item[data-roi-key="__cortical_layer__6"]').count(), 1);
    const swatches = await page.locator('.roi-item[data-roi-kind="cortical-layer"] .color-swatch').evaluateAll(nodes => nodes.map(node => node.style.backgroundColor));
    assert.ok(swatches.every(Boolean), 'every derived layer has a valid color swatch');
    let expected = await snapshot(page);
    verifyLayers(expected, 'normalized');
    const exported = await graphWorkbook(page);
    assert.equal(exported.rows.length, expected.rows.length);
    for (const row of expected.rows) {
      const cell = exported.rows.find(candidate => candidate['ROIキー'] === row.roiKey);
      for (const [header, field] of [['中央値', 'median'], ['平均値', 'mean'], ['標準偏差', 'sd'], ['集計画素数', 'n'], ['ROI画素数', 'nGeometry']]) {
        assert.equal(cell[header], row[field], row.roiName + ' ' + header);
      }
      assert.equal(cell['ROI定義'], row.roiDefinition);
      assert.equal(cell['元ROIキー'], row.sourceRoiKeys);
    }
    assert.equal(exported.conditions.layerRuleVersion, 'cortical-difference-v1');
    assert.equal(JSON.parse(exported.conditions.layerDefinitions).length, 6);
    await page.locator('#value-raw').click();
    expected = await snapshot(page);
    verifyLayers(expected, 'raw');
    const beforeDisplayChange = numeric(expected);
    await page.selectOption('#rot-target', 'both');
    await page.locator('#rot-angle').fill('90');
    await page.locator('#rot-angle').press('Tab');
    const masked = await page.evaluate(() => {
      imageSettings['MSI_5-HT'].vmax = 1;
      otsuState.applied = true;
      otsuState.manualThreshold = 1e9;
      otsuState.record = Otsu.buildProjectRecord(currentProject, valueRasters, { applied: true, sourceKeys: ['MSI_5-HT'], manualThreshold: 1e9, strength: 0 });
      applyOtsuAndRedraw();
      displayGraphForRoi('__cortical_layer__4');
      return { usable: otsuState.record.usable, visible: Array.from(otsuState.record.keep || []).reduce((sum, value) => sum + value, 0) };
    });
    assert.equal(masked.usable, true);
    assert.equal(masked.visible, 0, 'the display mask really hides every pixel');
    assert.deepEqual(numeric(await snapshot(page)), beforeDisplayChange, 'rotation, clipping and an all-hidden Otsu mask do not change numbers');
    const coordinateError = await page.evaluate(() => Math.max(...[[0, 0], [7.25, 10.25], [15, 15]].flatMap(point => {
      const back = canvasToMsi(...msiToCanvas(...point));
      return back.map((value, index) => Math.abs(value - point[index]));
    })));
    assert.ok(coordinateError < 1e-8, 'ROI coordinates remain in the native MSI grid');
    await page.evaluate(() => { otsuState.applied = false; applyOtsuAndRedraw(); });
    await page.locator('#value-normalized').click();
    await page.locator('.roi-item[data-roi-key="__cortical_layer__1"] input[type="checkbox"]').uncheck();
    await page.evaluate(() => flushViewerEdits());
    assert.deepEqual(await scientific(page), h.original, 'new virtual visibility flags do not modify source polygons, names, colors, normalization or signal');
    await page.reload();
    await page.waitForFunction(() => typeof viewerReady !== 'undefined' && viewerReady);
    await page.getByLabel('分子1', { exact: true }).selectOption('MSI_5-HT');
    await page.getByLabel('追加表示2', { exact: true }).selectOption('none');
    await page.getByLabel('追加表示3', { exact: true }).selectOption('none');
    assert.equal(await page.locator('.roi-item[data-roi-key="__cortical_layer__1"] input[type="checkbox"]').isChecked(), false);
    assert.ok(!(await snapshot(page)).rows.some(row => row.roiKey === layerKey(1)), 'saved visibility survives reload');
    assert.deepEqual(await scientific(page), h.original);
    await page.locator('.roi-item[data-roi-key="__cortical_layer__1"] input[type="checkbox"]').check();
    await page.locator('.roi-item[data-roi-key="__cortical_layer__4"]').click();
    verifyLayers(await snapshot(page), 'normalized');
    await fs.mkdir(path.join(root, 'test-artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-artifacts/cortical-layer-viewer.png'), fullPage: true });
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Viewer leaves missing cortical layers unavailable and exports blank counts with the boundary reason', { timeout: 90000 }, async () => {
  const h = await fixture('viewer-cortical-missing', { missing: true }), { page } = h;
  try {
    const snap = await snapshot(page);
    for (const layer of [2, 3]) {
      const key = layerKey(layer), row = snap.rows.find(row => row.roiKey === key);
      assert.equal(row.status, 'UNAVAILABLE');
      for (const field of ['mean', 'median', 'sd', 'n', 'nValid', 'nMeasured', 'nGeometry']) assert.equal(row[field], null, 'missing ' + field);
      assert.match(row.geometryReasonCodes, /ROI_BOUNDARY_MISSING/);
      assert.match(row.reason, /境界ROIがありません/);
      for (const field of ['mean', 'median', 'count']) assert.equal(await page.locator(`.analysis-table tr[data-roi-key="${key}"] [data-field="${field}"]`).innerText(), '算出不可');
    }
    assert.equal(snap.rows.find(row => row.roiKey === layerKey(4)).mean, 15.5, 'independent complete layers still compute');
    const output = await graphWorkbook(page);
    for (const layer of [2, 3]) {
      const row = output.rows.find(row => row['ROIキー'] === layerKey(layer));
      for (const header of ['中央値', '平均値', '標準偏差', '集計画素数', '有効画素数', '測定画素数', 'ROI画素数']) assert.equal(row[header], null);
      assert.match(row['領域算出理由コード'], /ROI_BOUNDARY_MISSING/);
    }
    assert.deepEqual(await scientific(page), h.original);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Viewer reports crossed cortical boundary order as unavailable instead of overlapping layer statistics', { timeout: 90000 }, async () => {
  const h = await fixture('viewer-cortical-crossed', { nonnested: true }), { page } = h;
  try {
    const rows = (await snapshot(page)).rows.filter(row => row.roiKind === 'cortical-layer');
    assert.equal(rows.length, 6);
    for (const row of rows) {
      assert.equal(row.status, 'UNAVAILABLE');
      assert.equal(row.mean, null);
      assert.equal(row.nGeometry, null);
      assert.match(row.geometryReasonCodes, /ROI_LAYER_NOT_NESTED/);
      assert.ok(JSON.parse(row.geometryQc).outsidePixels > 0);
    }
    assert.deepEqual(await scientific(page), h.original);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Viewer refuses duplicate same-name cortical boundaries without merging or deleting either source key', { timeout: 90000 }, async () => {
  const h = await fixture('viewer-cortical-ambiguous', { ambiguous: true }), { page } = h;
  try {
    const sourceKeys = await page.evaluate(() => Object.keys(atlasData.roi.roi_items));
    assert.ok(sourceKeys.includes('boundary2'));
    assert.ok(sourceKeys.includes('boundary2duplicate'));
    assert.equal(await page.locator('#roi-boundaries .roi-boundary-item').count(), 6, 'both Layer 2 boundary records stay individually visible for correction');
    const snap = await snapshot(page);
    for (const layer of [2, 3]) {
      const row = snap.rows.find(row => row.roiKey === layerKey(layer));
      assert.equal(row.status, 'UNAVAILABLE');
      assert.equal(row.mean, null);
      assert.equal(row.nGeometry, null);
      assert.match(row.geometryReasonCodes, /ROI_BOUNDARY_AMBIGUOUS/);
      assert.match(row.reason, /同じ境界に該当するROIが複数/);
      assert.match(row.sourceRoiKeys, /boundary2duplicate/);
    }
    assert.equal(snap.rows.find(row => row.roiKey === layerKey(4)).mean, 15.5);
    await page.locator('.roi-item[data-roi-key="__cortical_layer__4"] input[type="checkbox"]').uncheck();
    await page.evaluate(() => flushViewerEdits());
    assert.deepEqual(await scientific(page), h.original, 'saving a layer visibility change cannot collapse ambiguous source boundaries');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
