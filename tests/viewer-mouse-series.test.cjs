'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');

const compounds = [
  ['GABA-DPP', [0, 200, 255]],
  ['Histamine-DPP', [255, 128, 0]],
  ['Dopamine-DPP', [255, 0, 0]],
  ['Norepinephrine-DPP', [255, 255, 0]],
  ['Serotonin-DPP', [0, 255, 0]],
  ['Serotonin-d4-DPP', [190, 120, 255]],
];
// Five measured pixels, including a true zero, and one unmeasured pixel.
// Every corner differs, so a mirror or a 180-degree rotation cannot pass.
const sourceValues = [0, 20, 50, 80, 110, NaN];

async function decodedThumbnails(page) {
  await page.evaluate(async () => {
    await Promise.all([...document.querySelectorAll('.msi-thumb')].map(img => img.decode()));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function openMouseViewer(h) {
  // This is a local-only test. Configured cloud authentication is not a fixture.
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};',
  }));
  await h.page.goto(h.baseURL + '/__test_seed');
  const id = await h.page.evaluate(async ({ names, sourceValues }) => {
    const id = 'mouse-pixel-orientation';
    const project = {
      id, displayName: 'Mouse_tissue_1set_01', folderPath: ['Mouse', 'tissue_1set'],
      grid: { W: 3, H: 2, umPerPxX: null, umPerPxY: null }, images: {}, molecules: [],
      atlas: {
        species: 'mouse', seriesId: 'mouse_tissue_1set', seriesName: 'tissue_1set',
        specimenId: 'tissue_1set', sectionNumber: 1, sourceCandidateId: 'C008',
        coordinateMode: 'pixel', physicalSectionSpacing: null, displaySpacing: 2,
      },
      valueDisplay: { mode: 'raw', scale: 'individual' }, layerDisplay: {},
      visibleLayers: ['MSI_GABA-DPP'],
      rotation: { all: 0, he: 0, msi: 0 },
      stack3d: { coordinateMode: 'pixel', offsetXPx: 0, offsetYPx: 0, rotationDeg: 0 },
      roi: { roi_items: {}, roi_names: {}, palette: {}, roi_show_flags: {} },
    };
    for (const name of names) {
      const key = 'MSI_' + name, values = new Float32Array(sourceValues);
      const blobId = await ProjectStorage.putValueRaster(values);
      project.molecules.push({ key, name, analyteId: name, blobId, nSpectra: 5, stats: MSIRaster.deriveBakeStats(values) });
      project.layerDisplay[key] = { rawRange: { min: 0, max: 110 }, opacity: 1, applyOpacity: false };
    }
    await ProjectStorage.putProject(project);
    return id;
  }, { names: compounds.map(([name]) => name), sourceValues });
  await h.page.goto(h.baseURL + '/viewer/index.html?project=' + id);
  await h.page.waitForFunction(id => typeof currentProject !== 'undefined' && currentProject?.id === id && viewerReady, id);
  await decodedThumbnails(h.page);
  return id;
}

function expectedPixels(color, values, opaqueBackground = false) {
  return values.flatMap(value => Number.isFinite(value)
    ? [...color.map(component => Math.round(component * value / 110)), 255]
    : [0, 0, 0, opaqueBackground ? 255 : 0]);
}

async function renderedEvidence(page, key, expectedWidth, expectedHeight) {
  return page.evaluate(async ({ key, expectedWidth, expectedHeight }) => {
    // Select exactly one molecular layer through the same checkboxes used by the UI.
    for (const cb of document.querySelectorAll('input.layer-check')) cb.checked = cb.value === key;
    renderCompositeImage();
    const img = msiThumbRefs.get(key);
    await img.decode();
    const thumb = document.createElement('canvas');
    thumb.width = img.naturalWidth; thumb.height = img.naturalHeight;
    thumb.getContext('2d').drawImage(img, 0, 0);
    const thumbPixels = Array.from(thumb.getContext('2d').getImageData(0, 0, thumb.width, thumb.height).data);

    // Rasterize the actual CSS orientation of the central canvas at native resolution.
    // Remove screen zoom and pan, which do not alter image orientation.
    const outer = new DOMMatrix(getComputedStyle(document.getElementById('image-viewer-rot')).transform);
    const sx = Math.hypot(outer.a, outer.b), sy = Math.hypot(outer.c, outer.d);
    const a = outer.a / sx, b = outer.b / sx, c = outer.c / sy, d = outer.d / sy;
    const main = document.createElement('canvas');
    main.width = Math.round(Math.abs(a) * displayCanvas.width + Math.abs(c) * displayCanvas.height);
    main.height = Math.round(Math.abs(b) * displayCanvas.width + Math.abs(d) * displayCanvas.height);
    const ctx = main.getContext('2d'); ctx.imageSmoothingEnabled = false;
    ctx.translate(main.width / 2, main.height / 2);
    ctx.transform(a, b, c, d, 0, 0);
    ctx.drawImage(displayCanvas, -displayCanvas.width / 2, -displayCanvas.height / 2);
    const mainPixels = Array.from(ctx.getImageData(0, 0, main.width, main.height).data);

    // Decode the actual export PNG, including the export's black background for gaps.
    const exported = buildExportCanvas(), png = new Image();
    png.src = exported.toDataURL('image/png'); await png.decode();
    const decoded = document.createElement('canvas');
    decoded.width = png.naturalWidth; decoded.height = png.naturalHeight;
    decoded.getContext('2d').drawImage(png, 0, 0);
    const exportPixels = Array.from(decoded.getContext('2d').getImageData(
      Math.floor((decoded.width - expectedWidth) / 2), 0, expectedWidth, expectedHeight).data);
    return {
      color: getMsiColor(key), raw: Array.from(valueRasters[key].values),
      thumb: { width: thumb.width, height: thumb.height, pixels: thumbPixels },
      main: { width: main.width, height: main.height, pixels: mainPixels },
      exportPixels,
    };
  }, { key, expectedWidth, expectedHeight });
}

function assertEvidence(actual, color, values, W, H, label) {
  assert.deepEqual(actual.color, color, label + ' molecular color');
  assert.deepEqual(actual.raw, sourceValues, label + ' untouched source raster');
  assert.deepEqual([actual.main.width, actual.main.height], [W, H], label + ' central image bounds');
  assert.deepEqual([actual.thumb.width, actual.thumb.height], [W, H], label + ' thumbnail bounds');
  const pixels = expectedPixels(color, values);
  assert.deepEqual(actual.main.pixels, pixels, label + ' central image orientation and color');
  assert.deepEqual(actual.thumb.pixels, pixels, label + ' thumbnail orientation and color');
  assert.deepEqual(actual.exportPixels, expectedPixels(color, values, true), label + ' exported PNG orientation and color');
}

test('Mouse pixel series keeps canonical 3x2 orientation, DPP colors, and raw data across main image, thumbnails, and PNG', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    const id = await openMouseViewer(h);
    assert.deepEqual(await h.page.evaluate(() => ['meta-specimen', 'meta-organism', 'meta-strain', 'meta-age', 'meta-sex']
      .map(id => document.getElementById(id).textContent)), ['tissue_1set', 'Mouse', 'Unknown', 'Unknown', 'Unknown']);
    assert.equal(await h.page.locator('label[for="notes-atlas-url"]').textContent(), 'Mouse Atlas URL');
    assert.equal(await h.page.locator('label[for="notes-gene-atlas-url"]').textContent(), 'Mouse Gene Atlas URL');
    assert.equal(await h.page.locator('.msi-thumb').count(), 6, 'all six imported molecules have thumbnails');
    for (const [name, color] of compounds) {
      assertEvidence(await renderedEvidence(h.page, 'MSI_' + name, 3, 2), color, sourceValues, 3, 2, name);
    }

    // An explicit user whole-image rotation is still applied exactly once.
    await h.page.selectOption('#rot-target', 'both');
    await h.page.locator('#rot-angle').fill('90');
    await h.page.locator('#rot-angle').press('Tab');
    await decodedThumbnails(h.page);
    assertEvidence(await renderedEvidence(h.page, 'MSI_GABA-DPP', 2, 3), compounds[0][1],
      [80, 0, 110, 20, NaN, 50], 2, 3, '90-degree user rotation');
    await h.page.click('#rot-reset'); await decodedThumbnails(h.page);
    assertEvidence(await renderedEvidence(h.page, 'MSI_GABA-DPP', 3, 2), compounds[0][1], sourceValues, 3, 2, 'reset');

    // Rendering, PNG export, and rotations must never rewrite quantitative pixels.
    const saved = await h.page.evaluate(async id => {
      const project = await ProjectStorage.getProject(id);
      return {
        grid: project.grid, atlas: project.atlas,
        rasters: await Promise.all(project.molecules.map(async m => Array.from(await ProjectStorage.getValueRaster(m.blobId)))),
      };
    }, id);
    assert.deepEqual(saved.grid, { W: 3, H: 2, umPerPxX: null, umPerPxY: null });
    assert.equal(saved.atlas.coordinateMode, 'pixel');
    assert.equal(saved.atlas.physicalSectionSpacing, null);
    for (const raw of saved.rasters) assert.deepEqual(raw, sourceValues);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
