'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

async function openPatternViewer(h, { W = 64, H = 40, rotation = { all: 0, he: 0, msi: 0 } } = {}) {
  const id = await seedViewerProject(h.page, h.baseURL, { id: 'thumbnail-rotation' });
  await h.page.evaluate(async ({ id, W, H, rotation }) => {
    const project = await ProjectStorage.getProject(id);
    project.grid = { W, H }; project.rotation = rotation;
    project.valueDisplay = { mode: 'raw', scale: 'individual' };
    project.roi.roi_items.all[0].poly_msi = [[0, 0], [W, 0], [W, H], [0, H]];
    for (const molecule of project.molecules) {
      const values = new Float32Array(W * H);
      const size = Math.max(4, Math.floor(Math.min(W, H) / 5));
      for (const [cx, cy, value] of [[W / 8, H / 5, 40], [W * 7 / 8, H / 5, 80], [W / 8, H * 4 / 5, 120], [W * 7 / 8, H * 4 / 5, 200]]) {
        for (let y = Math.floor(cy - size / 2); y < Math.floor(cy + size / 2); y++) {
          for (let x = Math.floor(cx - size / 2); x < Math.floor(cx + size / 2); x++) values[y * W + x] = value;
        }
      }
      molecule.blobId = await ProjectStorage.putValueRaster(values);
      molecule.stats = MSIRaster.deriveBakeStats(values);
    }
    const ref = document.createElement('canvas'); ref.width = W; ref.height = H;
    const ctx = ref.getContext('2d'); ctx.fillStyle = '#8395a7'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#f0f0f0'; ctx.fillRect(0, 0, W / 4, H / 3);
    const blob = await new Promise(resolve => ref.toBlob(resolve));
    const blobId = await ProjectStorage.putBlob({ blob });
    project.images = { ATLAS: { blobId, filename: 'Atlas.png' }, HE_Stain: { blobId, filename: 'HE_Stain.png' } };
    await ProjectStorage.putProject(project);
  }, { id, W, H, rotation });
  await h.page.goto(h.baseURL + '/viewer/index.html?project=' + id);
  await h.page.waitForFunction(id => typeof currentProject !== 'undefined' && currentProject?.id === id && viewerReady, id);
  await decodedThumbnails(h.page);
  return id;
}

async function decodedThumbnails(page) {
  await page.evaluate(async () => {
    await Promise.all([...document.querySelectorAll('.thumbnail')].map(img => img.decode()));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function rotate(page, target, angle) {
  await page.selectOption('#rot-target', target);
  await page.locator('#rot-angle').fill(String(angle));
  await page.locator('#rot-angle').press('Tab');
  await decodedThumbnails(page);
}

async function thumbnailEvidence(page) {
  return page.evaluate(() => {
    const outer = new DOMMatrix(getComputedStyle(document.getElementById('image-viewer-rot')).transform);
    const [a, b, c, d] = msiCanvasTransform(displayCanvas.width, displayCanvas.height);
    const cssX = displayCanvas.clientWidth / displayCanvas.width, cssY = displayCanvas.clientHeight / displayCanvas.height;
    const horizontal = outer.transformPoint({ x: a * cssX, y: b * cssY });
    const vertical = outer.transformPoint({ x: c * cssX, y: d * cssY });
    // Directions only: remove any CSS pan translation.
    const expected = [[horizontal.x - outer.e, horizontal.y - outer.f], [vertical.x - outer.e, vertical.y - outer.f]];
    const thumbs = [...msiThumbRefs].map(([key, img]) => {
      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const src = paintDisplayRaster(key), sourceCtx = src.getContext('2d');
      const points = [[src.width / 8, src.height / 5], [src.width * 7 / 8, src.height / 5], [src.width / 8, src.height * 4 / 5], [src.width * 7 / 8, src.height * 4 / 5]];
      const markers = points.map(([x, y]) => {
        const rgb = sourceCtx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
        let count = 0, sx = 0, sy = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] < 240 || ![0, 1, 2].every(j => Math.abs(pixels[i + j] - rgb[j]) <= 1)) continue;
          count++; sx += (i / 4) % canvas.width + 0.5; sy += Math.floor(i / 4 / canvas.width) + 0.5;
        }
        return { x: sx / count, y: sy / count, count };
      });
      const imgBox = img.getBoundingClientRect(), box = img.parentElement.getBoundingClientRect();
      return { key, width: canvas.width, height: canvas.height, markers,
        fit: getComputedStyle(img).objectFit, transform: getComputedStyle(img).transform,
        imgBox: { width: imgBox.width, height: imgBox.height }, box: { width: box.width, height: box.height } };
    });
    return { expected, thumbs };
  });
}

function assertDirectionsAndFit(evidence, { W = 64, H = 40, all = 0, msi = 0 } = {}) {
  const angle = (all + msi - 180) * Math.PI / 180;
  const width = W * Math.abs(Math.cos(angle)) + H * Math.abs(Math.sin(angle));
  const height = W * Math.abs(Math.sin(angle)) + H * Math.abs(Math.cos(angle));
  const scale = Math.min(1, 512 / Math.max(width, height));
  for (const thumb of evidence.thumbs) {
    assert.equal(thumb.width, Math.ceil(width * scale - 1e-9), thumb.key + ' full rotated width');
    assert.equal(thumb.height, Math.ceil(height * scale - 1e-9), thumb.key + ' full rotated height');
    assert.equal(thumb.fit, 'contain'); assert.equal(thumb.transform, 'none', 'no second CSS rotation');
    assert.ok(Math.abs(thumb.imgBox.width - thumb.box.width) <= 2.1);
    assert.ok(Math.abs(thumb.imgBox.height - thumb.box.height) <= 2.1);
    assert.ok(thumb.box.height <= 170.1);
    for (const marker of thumb.markers) assert.ok(marker.count >= (W <= 64 ? 55 : 500), thumb.key + ' preserves all corner markers: ' + JSON.stringify(thumb.markers));
    for (const [axis, endpoint] of [[0, 1], [1, 2]]) {
      const delta = [thumb.markers[endpoint].x - thumb.markers[0].x, thumb.markers[endpoint].y - thumb.markers[0].y];
      const expected = evidence.expected[axis];
      const dot = (delta[0] * expected[0] + delta[1] * expected[1]) / (Math.hypot(...delta) * Math.hypot(...expected));
      assert.ok(dot > 0.999, thumb.key + ' marker direction matches central MSI transform, dot=' + dot);
    }
  }
}

test('MSI thumbnails match central orientation for initial, whole-view, MSI, and arbitrary rotations without clipping', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openPatternViewer(h);
    const nonMsi = await h.page.evaluate(() => [...document.querySelectorAll('.thumbnail:not(.msi-thumb)')].map(img => ({ key: img.dataset.key, src: img.src, transform: getComputedStyle(img).transform })));
    assert.equal(nonMsi.length, 2);
    const rawBefore = await h.page.evaluate(() => Array.from(valueRasters['MSI_5-HT'].values));
    const roiBefore = await h.page.evaluate(() => calcStats(extractRoiPixels('MSI_5-HT', 'all')));
    assertDirectionsAndFit(await thumbnailEvidence(h.page));
    await rotate(h.page, 'both', 90);
    assertDirectionsAndFit(await thumbnailEvidence(h.page), { all: 90 });
    await rotate(h.page, 'msi', 90);
    assertDirectionsAndFit(await thumbnailEvidence(h.page), { all: 90, msi: 90 });
    await rotate(h.page, 'both', 37);
    await rotate(h.page, 'msi', -18);
    assertDirectionsAndFit(await thumbnailEvidence(h.page), { all: 37, msi: -18 });
    await rotate(h.page, 'he', 63);
    assertDirectionsAndFit(await thumbnailEvidence(h.page), { all: 37, msi: -18 });
    assert.deepEqual(await h.page.evaluate(() => [...document.querySelectorAll('.thumbnail:not(.msi-thumb)')].map(img => ({ key: img.dataset.key, src: img.src, transform: getComputedStyle(img).transform }))), nonMsi);
    assert.deepEqual(await h.page.evaluate(() => Array.from(valueRasters['MSI_5-HT'].values)), rawBefore);
    assert.deepEqual(await h.page.evaluate(() => calcStats(extractRoiPixels('MSI_5-HT', 'all'))), roiBefore);
    const artifacts = path.join(__dirname, '..', 'test-artifacts'); await fs.mkdir(artifacts, { recursive: true });
    // The harness substitutes layout utilities; this artifact documents thumbnail pixels, not production page styling.
    await h.page.locator('#thumbnail-container').screenshot({ path: path.join(artifacts, 'viewer-thumbnail-arbitrary-rotation.png') });
    await h.page.click('#rot-reset'); await decodedThumbnails(h.page);
    assertDirectionsAndFit(await thumbnailEvidence(h.page));
    assert.deepEqual(await h.page.evaluate(() => rotationState), { all: 0, he: 0, msi: 0 });
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Saved thumbnail orientation survives reload, hidden molecules, and display range updates', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openPatternViewer(h, { rotation: { all: 32, he: 0, msi: 71 } });
    assertDirectionsAndFit(await thumbnailEvidence(h.page), { all: 32, msi: 71 });
    const previous = await h.page.locator('.msi-thumb[data-key="MSI_5-HT"]').getAttribute('src');
    await h.page.locator('.msi-thumb[data-key="MSI_5-HT"]').click();
    assert.equal(await h.page.locator('input.layer-check[value="MSI_5-HT"]').isChecked(), false);
    assert.equal(await h.page.locator('.msi-thumb[data-key="MSI_5-HT"]').getAttribute('src'), previous);
    await h.page.evaluate(() => {
      for (const key of Object.keys(valueRasters)) {
        DisplayRange.setManual(displayRangeProject, key, rangeModeForKey(key), 0, 400);
      }
      useModeRanges(); redrawValueViews(); persistLayerDisplay();
    });
    await decodedThumbnails(h.page);
    assert.notEqual(await h.page.locator('.msi-thumb[data-key="MSI_5-HT"]').getAttribute('src'), previous, 'range changed the rendered pixel values');
    assertDirectionsAndFit(await thumbnailEvidence(h.page), { all: 32, msi: 71 });
    await rotate(h.page, 'both', -73); await rotate(h.page, 'msi', 26);
    await h.page.waitForFunction(() => !saveTimer && !viewerSaving);
    await h.page.reload(); await h.page.waitForFunction(() => typeof viewerReady !== 'undefined' && viewerReady);
    await decodedThumbnails(h.page);
    assert.deepEqual(await h.page.evaluate(() => rotationState), { all: -73, he: 0, msi: 26 });
    assertDirectionsAndFit(await thumbnailEvidence(h.page), { all: -73, msi: 26 });
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Large non-square MSI thumbnails keep bounded output size and all rotated corners', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openPatternViewer(h, { W: 1600, H: 800, rotation: { all: 37, he: 0, msi: 18 } });
    assertDirectionsAndFit(await thumbnailEvidence(h.page), { W: 1600, H: 800, all: 37, msi: 18 });
    assert.deepEqual(await h.page.evaluate(() => ({ W: valueRasters['MSI_5-HT'].W, H: valueRasters['MSI_5-HT'].H, length: valueRasters['MSI_5-HT'].values.length })), { W: 1600, H: 800, length: 1280000 });
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
