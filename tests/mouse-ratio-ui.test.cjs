'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');
const ANALYTES = ['GABA-DPP', 'Histamine-DPP', 'Dopamine-DPP', 'Norepinephrine-DPP', 'Serotonin-DPP', 'Serotonin-d4-DPP'];
const STANDARD = ANALYTES[5], KEY = 'MSI_' + STANDARD;

async function seedRatioSeries(h) {
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};'
  }));
  await seedViewerProject(h.page, h.baseURL, { id: 'ratio-legacy' });
  return h.page.evaluate(async analytes => {
    const legacy = await ProjectStorage.getProject('ratio-legacy');
    legacy.displayName = 'Cor_1_1'; legacy.grid.umPerPxX = 150; legacy.grid.umPerPxY = 150;
    await ProjectStorage.putProject(legacy);
    const snapshots = [];
    for (let number = 1; number <= 2; number++) {
      const project = {
        id: 'ratio-mouse-' + number, displayName: 'Mouse ratio ' + number, plane: 'coronal',
        atlas: { species: 'mouse', seriesId: 'mouse_tissue_1set', seriesName: 'tissue_1set',
          specimenId: 'tissue_1set', sectionNumber: number, sourceCandidateId: 'C00' + number,
          coordinateMode: 'pixel', physicalSectionSpacing: null, displaySpacing: 2 },
        grid: { W: 4, H: 2, umPerPxX: null, umPerPxY: null }, images: {}, molecules: [],
        rotation: { all: 0, msi: 0, he: 0 }, valueDisplay: { mode: 'normalized', scale: 'individual' },
        stack3d: { coordinateMode: 'pixel', offsetXPx: .5 * number, offsetYPx: -.25, rotationDeg: 3 },
        visibleLayers: analytes.map(name => 'MSI_' + name),
        roi: { roi_items: {}, roi_names: {}, palette: {}, roi_show_flags: {} }
      };
      const rasters = {};
      for (let channel = 0; channel < analytes.length; channel++) {
        const name = analytes[channel], key = 'MSI_' + name;
        const values = channel === 5 ? new Float32Array([2, 0, NaN, .001, 4, 8, 2, 2])
          : Float32Array.from([0, 2, 3, 4, 8, 16, NaN, 20], value => value * (channel + 1) * number);
        project.molecules.push({ key, name, analyteId: name,
          blobId: await ProjectStorage.putValueRaster(values), stats: MSIRaster.deriveBakeStats(values) });
        rasters[key] = { W: 4, H: 2, values };
      }
      project.normalization = Normalization.createPixelRatioProfile(project, rasters, {
        id: 'mouse-pixel-ratio', revision: 1, standardKey: 'MSI_' + analytes[5],
        targetKeys: analytes.slice(0, 5).map(name => 'MSI_' + name),
        standardApplication: { method: 'uniform_spray', confirmed: true, source: 'user' }
      });
      await ProjectStorage.putProject(project);
      snapshots.push({ id: project.id, normalization: project.normalization,
        raws: Object.fromEntries(Object.entries(rasters).map(([key, raster]) => [key, Array.from(raster.values)])) });
    }
    return snapshots;
  }, ANALYTES);
}
async function sources(page, ids) {
  return page.evaluate(async ids => Promise.all(ids.map(async id => {
    const p = await ProjectStorage.getProject(id);
    return { id, normalization: p.normalization, raws: Object.fromEntries(await Promise.all(p.molecules.map(
      async m => [m.key, Array.from(await ProjectStorage.getValueRaster(m.blobId))]))) };
  })), ids);
}
async function stackReady(page, series = 'mouse_tissue_1set') {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(series => window.__stack3dReady && Atlas3D.seriesId === series &&
    Atlas3D.sections.length > 0 && !document.querySelector('#series-select').disabled &&
    !document.querySelector('#render-state').textContent.includes('更新中'), series);
}
async function viewerReady(page) {
  await page.waitForFunction(() => window.Normalization && typeof viewerReady !== 'undefined' && viewerReady);
}

test('Mouse ratio 2D shows five exact ratios, keeps d4 raw QC distinct, and preserves raw arrays', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), { page } = h;
  try {
    const original = await seedRatioSeries(h);
    await page.goto(h.baseURL + '/viewer/index.html?project=ratio-mouse-1');
    await viewerReady(page);
    assert.equal(await page.locator('#value-normalized').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#value-display-status').innerText(), /相対比（濃度ではありません）/);
    assert.match(await page.locator('#value-display-status').innerText(), /P10による低値除外はしていません/);
    assert.doesNotMatch(await page.locator('#value-display-status').innerText(), /グループごとに基準値が独立/);
    assert.equal(await page.locator(`input.layer-check[value="${KEY}"]`).isDisabled(), true);
    assert.equal(await page.locator(`input.layer-check[value="${KEY}"]`).isChecked(), false);
    const evidence = await page.evaluate(analytes => ({
      selected: checkedLayerKeys(),
      channels: analytes.map(name => {
        const key = 'MSI_' + name, c = channelResult(key), r = displayRaster(key);
        return { values: Array.from(r.values), derived: !!r.derived, type: r.values.constructor.name,
          unit: channelUnit(key), method: c.method, status: c.status };
      }),
      rendered: Array.from(paintDisplayRaster('MSI_GABA-DPP').getContext('2d').getImageData(0, 0, 4, 2).data)
    }), ANALYTES);
    assert.equal(evidence.selected.length, 5);
    const d4 = original[0].raws[KEY];
    for (let channel = 0; channel < 5; channel++) {
      const raw = original[0].raws['MSI_' + ANALYTES[channel]];
      assert.deepEqual(evidence.channels[channel].values, raw.map((value, i) =>
        Number.isFinite(value) && Number.isFinite(d4[i]) && d4[i] > 0 ? value / d4[i] : NaN));
      assert.equal(evidence.channels[channel].type, 'Float64Array');
      assert.equal(evidence.channels[channel].derived, true);
      assert.equal(evidence.channels[channel].status, 'PARTIAL');
    }
    assert.ok(evidence.channels[0].values[3] > 3999, 'a small positive d4 is retained, not removed by P10');
    assert.deepEqual(evidence.rendered.slice(4, 8), [128, 128, 128, 255], 'measured numerator / zero d4 is gray');
    assert.deepEqual(evidence.rendered.slice(8, 12), [128, 128, 128, 255], 'measured numerator / missing d4 is gray');
    assert.equal(evidence.rendered[27], 0, 'unmeasured numerator is transparent');
    assert.equal(evidence.channels[5].method, 'raw_qc');
    assert.equal(evidence.channels[5].derived, false);
    assert.match(evidence.channels[5].unit, /raw QC/);
    await page.locator(`img.thumbnail[data-key="${KEY}"]`).click();
    await page.waitForFunction(() => valueDisplay.mode === 'raw');
    assert.equal(await page.locator(`input.layer-check[value="${KEY}"]`).isChecked(), true);
    assert.equal(await page.locator(`input.layer-check[value="${KEY}"]`).isDisabled(), false);
    assert.equal(await page.evaluate(() => displayRaster('MSI_GABA-DPP').derived || false), false);
    await page.waitForFunction(() => !saveTimer && !viewerSaving && !viewerRefreshTask);
    assert.equal(await page.evaluate(async () => (await ProjectStorage.getProject('ratio-mouse-1')).valueDisplay.mode), 'raw');
    assert.equal(await page.evaluate(() => valueDisplay.mode), 'raw', 'save completion retains active raw mode');
    await page.reload(); await viewerReady(page);
    assert.equal(await page.locator('#value-raw').getAttribute('aria-pressed'), 'true');
    await page.locator('#value-normalized').click();
    await page.waitForFunction(() => valueDisplay.mode === 'normalized');
    assert.equal(await page.locator(`input.layer-check[value="${KEY}"]`).isDisabled(), true);
    assert.equal(await page.locator(`input.layer-check[value="${KEY}"]`).isChecked(), false);
    assert.deepEqual(await sources(page, original.map(p => p.id)), original);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Mouse atlas fixes normalized display, overrides saved raw QC, and keeps Marmoset modes independent', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), { page } = h;
  try {
    const original = await seedRatioSeries(h);
    await page.evaluate(analytes => sessionStorage.setItem('atlas-stack3d-view-v1:mouse_tissue_1set', JSON.stringify({
      ids: ['ratio-mouse-1', 'ratio-mouse-2'], mouseRatioDisplayVersion: 1,
      options: { mode: 'raw', channels: analytes }
    })), ANALYTES);
    await page.goto(h.baseURL + '/stack3d/index.html?series=mouse_tissue_1set');
    await stackReady(page);
    assert.equal(await page.locator('#value-mode').inputValue(), 'normalized');
    assert.equal(await page.locator('#value-mode').isVisible(), false);
    assert.equal(await page.locator(`input[name="channel"][value="${STANDARD}"]`).isVisible(), false);
    assert.equal(await page.locator(`input[name="channel"][value="${STANDARD}"]`).isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => Atlas3D.options().channels), ANALYTES.slice(0, 5));
    assert.match(await page.locator('#value-mode-help').innerText(), /相対比.*濃度ではありません/);
    const ratios = await page.evaluate(() => Atlas3D.sections.map(s => ({
      values: Array.from(s.channels['GABA-DPP'].normalized), standard: s.channels['Serotonin-d4-DPP'].normalized,
      position: [s.offsetXPx, s.offsetYPx, s.rotationDeg]
    })));
    for (let i = 0; i < original.length; i++) {
      const raw = original[i].raws['MSI_GABA-DPP'], d4 = original[i].raws[KEY];
      assert.deepEqual(ratios[i].values, raw.map((v, j) => Number.isFinite(v) && Number.isFinite(d4[j]) && d4[j] > 0 ? v / d4[j] : NaN));
      assert.equal(ratios[i].standard, null);
      assert.deepEqual(ratios[i].position, [.5 * (i + 1), -.25, 3]);
    }
    assert.equal(await page.evaluate(() => Atlas3D.options().outerEdgeWidth), 2);
    // Even a stale/programmatic raw event cannot bypass the fixed policy.
    await page.evaluate(() => {
      const control = document.querySelector('#value-mode'); control.value = 'raw';
      control.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await stackReady(page);
    assert.equal(await page.evaluate(() => Atlas3D.options().mode), 'normalized');
    await page.evaluate(standard => {
      const key = 'atlas-stack3d-view-v1:mouse_tissue_1set';
      const saved = JSON.parse(sessionStorage.getItem(key));
      saved.options.mode = 'raw'; saved.options.channels = [standard];
      sessionStorage.setItem(key, JSON.stringify(saved));
    }, STANDARD);
    await page.reload(); await stackReady(page);
    assert.equal(await page.locator('#value-mode').inputValue(), 'normalized');
    assert.ok((await page.evaluate(() => Atlas3D.options().channels)).length > 0,
      'an old d4-only QC view restores analytes rather than an accidental blank view');
    assert.equal(await page.locator(`input[name="channel"][value="${STANDARD}"]`).isChecked(), false);
    // Deliberately switching every analyte off remains a valid empty selection.
    for (const input of await page.locator('input[name="channel"]:visible:enabled').all()) await input.uncheck();
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('atlas-stack3d-view-v1:mouse_tissue_1set')).options.channels.length === 0);
    await page.reload(); await stackReady(page);
    assert.deepEqual(await page.evaluate(() => Atlas3D.options().channels), []);
    await page.locator('#series-select').selectOption('legacy_marmoset'); await stackReady(page, 'legacy_marmoset');
    assert.equal(await page.locator('#value-mode-help').isVisible(), false);
    assert.equal(await page.locator('#value-mode').isVisible(), true);
    assert.equal(await page.locator('#value-mode').inputValue(), 'raw');
    await page.locator('#value-mode').selectOption('normalized'); await stackReady(page, 'legacy_marmoset');
    await page.locator('#series-select').selectOption('mouse_tissue_1set'); await stackReady(page);
    assert.equal(await page.locator('#value-mode').inputValue(), 'normalized');
    assert.deepEqual(await page.evaluate(() => Atlas3D.options().channels), []);
    assert.equal(await page.locator(`input[name="channel"][value="${STANDARD}"]`).isChecked(), false);
    await page.locator('#series-select').selectOption('legacy_marmoset'); await stackReady(page, 'legacy_marmoset');
    assert.equal(await page.locator('#value-mode').inputValue(), 'normalized');
    await page.locator('#value-mode').selectOption('raw'); await stackReady(page, 'legacy_marmoset');
    assert.equal(await page.evaluate(() => Atlas3D.options().mode), 'raw');
    assert.deepEqual(await sources(page, original.map(p => p.id)), original);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('fixed mouse exterior mask agrees in 3D, selected MSI and enlarged MSI without altering values or P99', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), { page } = h;
  try {
    await seedRatioSeries(h);
    await page.evaluate(async analytes => {
      for (let number = 1; number <= 2; number++) {
        const p = await ProjectStorage.getProject('ratio-mouse-' + number), W = 9, H = 9, rasters = {};
        p.grid = { W, H, umPerPxX: null, umPerPxY: null };
        p.valueDisplay.mode = 'raw'; // The 3D policy must not rewrite this independent Viewer preference.
        for (let channel = 0; channel < analytes.length; channel++) {
          const molecule = p.molecules[channel], values = new Float32Array(W * H).fill(NaN);
          // A 7x7 acquired square with an enclosed missing point. This simple
          // geometry has 40 measured pixels in its outer two chessboard layers.
          for (let y = 1; y <= 7; y++) for (let x = 1; x <= 7; x++) {
            if (x === 4 && y === 4) continue;
            values[y * W + x] = channel === 5 ? (x === 3 && y === 3 ? 0 : 2)
              : (x === 1 && y === 1 ? 0 : x === 1 ? 1000 : 1 + x + y * W) * (channel + 1) * number;
          }
          molecule.blobId = await ProjectStorage.putValueRaster(values);
          molecule.stats = MSIRaster.deriveBakeStats(values);
          rasters[molecule.key] = { W, H, values };
        }
        p.normalization = Normalization.createPixelRatioProfile(p, rasters, {
          id: 'large-mouse-ratio-' + number, revision: 1, standardKey: p.molecules[5].key,
          targetKeys: p.molecules.slice(0, 5).map(m => m.key),
          standardApplication: { method: 'uniform_spray', confirmed: true, source: 'synthetic-test' }
        });
        await ProjectStorage.putProject(p);
      }
      sessionStorage.setItem('atlas-stack3d-view-v1:mouse_tissue_1set', JSON.stringify({
        ids: ['ratio-mouse-1', 'ratio-mouse-2'], mouseRatioDisplayVersion: 1,
        options: { mode: 'raw', channels: ['GABA-DPP'] }
      }));
    }, ANALYTES);
    const original = await sources(page, ['ratio-mouse-1', 'ratio-mouse-2']);
    await page.goto(h.baseURL + '/stack3d/index.html?series=mouse_tissue_1set'); await stackReady(page);
    await page.waitForFunction(() => document.querySelector('#section-preview canvas'));
    const evidence = await page.evaluate(() => {
      const section = Atlas3D.sections[0], result = Atlas3D.rendered[0], channel = section.channels['GABA-DPP'];
      const range = result.ranges['GABA-DPP'];
      const unmasked = SectionDisplay.mergeChannels([{
        canvas: SectionDisplay.paintChannel(channel.normalized, channel.raw, 9, 9,
          { analyte: 'GABA-DPP', range, derived: true }),
        values: channel.normalized, rawValues: channel.raw, derived: true, range, opacity: channel.opacity
      }], 9, 9, { threshold: 0 });
      const pixels = canvas => Array.from(canvas.getContext('2d').getImageData(0, 0, 9, 9).data);
      window.__edge2UnmaskedPreview = pixels(unmasked.previewCanvas);
      return { texture: pixels(result.canvas), baseline: pixels(unmasked.canvas), preview: pixels(result.previewCanvas),
        baselinePreview: window.__edge2UnmaskedPreview, range, edgeHiddenPixels: result.edgeHiddenPixels,
        values: Array.from(channel.normalized), raw: Array.from(channel.raw), options: Atlas3D.options() };
    });
    assert.equal(evidence.options.mode, 'normalized'); assert.equal(evidence.options.outerEdgeWidth, 2);
    assert.equal(evidence.edgeHiddenPixels, 40);
    let retained = 0;
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
      const start = (y * 9 + x) * 4, keep = x >= 3 && x <= 5 && y >= 3 && y <= 5 && !(x === 4 && y === 4);
      if (keep) {
        retained++;
        assert.deepEqual(evidence.texture.slice(start, start + 4), evidence.baseline.slice(start, start + 4), `unchanged texture ${x},${y}`);
        assert.deepEqual(evidence.preview.slice(start, start + 4), evidence.baselinePreview.slice(start, start + 4), `unchanged preview ${x},${y}`);
      } else {
        assert.equal(evidence.texture[start + 3], 0, `hidden texture ${x},${y}`);
        assert.equal(evidence.preview[start + 3], 0, `hidden preview ${x},${y}`);
      }
    }
    assert.equal(retained, 8, 'an enclosed hole does not erode its measured neighbors');
    assert.deepEqual(evidence.preview.slice((3 * 9 + 3) * 4, (3 * 9 + 3) * 4 + 4), [128, 128, 128, 255],
      'an invalid d4 inside the retained interior remains gray');
    const pooled = original.flatMap(s => s.raws['MSI_GABA-DPP'].map((v, i) =>
      Number.isFinite(v) && Number.isFinite(s.raws[KEY][i]) && s.raws[KEY][i] > 0 ? v / s.raws[KEY][i] : NaN
    )).filter(Number.isFinite).sort((a, b) => a - b);
    assert.equal(evidence.range.nFinite, 94, 'range retains all finite ratios, including the hidden exterior');
    assert.equal(evidence.range.max, pooled[Math.ceil(.99 * pooled.length) - 1]);
    assert.deepEqual(evidence.raw, original[0].raws['MSI_GABA-DPP']);
    assert.deepEqual(evidence.values, original[0].raws['MSI_GABA-DPP'].map((v, i) =>
      Number.isFinite(v) && Number.isFinite(original[0].raws[KEY][i]) && original[0].raws[KEY][i] > 0 ? v / original[0].raws[KEY][i] : NaN));
    async function verifyPreview(selector) {
      const audit = await page.locator(selector).evaluate(canvas => {
        const ctx = canvas.getContext('2d'), mismatches = [], baseline = window.__edge2UnmaskedPreview;
        for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
          const pixel = Array.from(ctx.getImageData(Math.floor((x + .5) * canvas.width / 9), Math.floor((y + .5) * canvas.height / 9), 1, 1).data);
          const keep = x >= 3 && x <= 5 && y >= 3 && y <= 5 && !(x === 4 && y === 4), start = (y * 9 + x) * 4;
          if (keep ? pixel.some((v, i) => v !== baseline[start + i]) : pixel[3] !== 0) mismatches.push([x, y, pixel]);
        }
        return mismatches;
      });
      assert.deepEqual(audit, [], selector + ' uses the same mask and retained colors');
    }
    await verifyPreview('#section-preview canvas');
    await page.locator('#enlarge-preview').click();
    await page.waitForFunction(() => document.querySelector('#detail-preview canvas'));
    await verifyPreview('#detail-preview canvas');
    assert.deepEqual(await sources(page, original.map(p => p.id)), original);
    assert.deepEqual(await page.evaluate(async () => Promise.all(['ratio-mouse-1', 'ratio-mouse-2'].map(async id =>
      (await ProjectStorage.getProject(id)).valueDisplay.mode))), ['raw', 'raw']);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
