'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

async function seed(h, { id = 'display-geometry', T = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], rotation = { all: 0, he: 0, msi: 0 } } = {}) {
  await seedViewerProject(h.page, h.baseURL, { id });
  await h.page.evaluate(async ({ id, T, rotation }) => {
    const p = await ProjectStorage.getProject(id), W = 34, H = 55;
    delete p.normalization;
    p.grid = { W, H }; p.rotation = rotation; p.valueDisplay = { mode: 'raw', scale: 'individual' };
    p.atlas = { seriesId: 'synthetic-display', species: 'mouse', coordinateMode: 'pixel', sectionNumber: 15 };
    p.world_coords = { T_he_to_msi: T }; p.visibleLayers = ['HE_Stain'];
    p.roi = { roi_items: { tissue: [{ poly_msi: [[2, 3], [30, 3], [30, 50], [2, 50]] }] },
      roi_names: { tissue: 'Tissue' }, palette: { tissue: [255, 0, 0, 255] }, roi_show_flags: { tissue: true } };
    const values = Float32Array.from({ length: W * H }, (_, i) => i + 1);
    p.molecules = [{ key: 'MSI_5-HT', name: '5-HT', blobId: await ProjectStorage.putValueRaster(values), stats: MSIRaster.deriveBakeStats(values) }];
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#d44287'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#3621d8'; for (const [x, y] of [[0, 0], [W - 5, 0], [0, H - 5], [W - 5, H - 5]]) ctx.fillRect(x, y, 5, 5);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    p.images = { HE_Stain: { blobId: await ProjectStorage.putBlob({ blob }), filename: 'synthetic-display.png' } };
    await ProjectStorage.putProject(p);
  }, { id, T, rotation });
  await h.page.goto(h.baseURL + '/viewer/index.html?project=' + id);
  await h.page.waitForFunction(() => typeof viewerReady !== 'undefined' && viewerReady && imageSources.HE_Stain?.complete && viewerDisplayGeometry);
  // The hermetic harness omits Tailwind layout sizing. Supply an explicit
  // viewport for geometry/picking checks, rather than depending on CDN CSS.
  await h.page.evaluate(() => {
    const host = document.getElementById('image-viewer');
    document.body.append(host);
    Object.assign(host.style, { position: 'fixed', left: '100px', top: '200px', width: '900px', height: '300px', minHeight: '300px', zIndex: '10000' });
    renderCompositeImage(); applyViewTransform(); drawAllRois();
  });
  return id;
}
async function immutable(page) {
  return page.evaluate(async () => {
    const p = await ProjectStorage.getProject(currentProject.id);
    const b = (await ProjectStorage.getBlob(p.images.HE_Stain.blobId)).blob;
    return { T: p.world_coords.T_he_to_msi, roi: p.roi, molecules: p.molecules,
      bytes: Array.from(new Uint8Array(await b.arrayBuffer())), raw: Array.from(valueRasters['MSI_5-HT'].values),
      stats: calcStats(extractRoiPixels('MSI_5-HT', 'tissue')) };
  });
}
async function evidence(page) {
  return page.evaluate(() => {
    renderCompositeImage();
    const geometry = viewerDisplayGeometry, data = displayCtx.getImageData(0, 0, displayCanvas.width, displayCanvas.height).data;
    let alphaMass = 0; for (let i = 3; i < data.length; i += 4) alphaMass += data[i] / 255;
    const original = [[2.5, 2.5], [31.5, 2.5], [2.5, 52.5], [31.5, 52.5]];
    const points = original.map(([x, y]) => ViewerDisplayGeometry.point(geometry.layerMatrices.HE_Stain, x, y));
    const alphaAtMarkers = points.map(([x, y]) => displayCtx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3]);
    const roundtrips = original.map(p => canvasToMsi(...msiToCanvas(...p)));
    const before = displayCanvas.toDataURL(), preview = createAlignedDisplayPreview(atlasData.world_coords.T_he_to_msi);
    const expected = rotateViewerCanvas(displayCanvas);
    const a = preview.getContext('2d').getImageData(0, 0, preview.width, preview.height).data;
    const b = expected.getContext('2d').getImageData(0, 0, expected.width, expected.height).data;
    let maxDifference = 0, changedBytes = 0;
    for (let i = 0; i < a.length; i++) { maxDifference = Math.max(maxDifference, Math.abs(a[i] - b[i])); if (a[i] !== b[i]) changedBytes++; }
    return { width: displayCanvas.width, height: displayCanvas.height, alphaMass, alphaAtMarkers,
      roundtrips, original, previewMatches: preview.toDataURL() === expected.toDataURL(),
      maxDifference, changedBytes,
      previewDidNotChangeLiveCanvas: before === displayCanvas.toDataURL() };
  });
}

test('HE quarter-turn is unclipped before and after saving, while raw data and ROI remain unchanged', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await seed(h); const before = await immutable(h.page);
    await h.page.selectOption('#rot-target', 'he'); await h.page.locator('#rot-angle').fill('-90');
    await h.page.locator('#rot-angle').press('Tab'); await h.page.evaluate(() => flushViewerEdits());
    const rotated = await evidence(h.page);
    assert.ok(rotated.alphaMass > 1860, 'all 1870 HE source pixels remain, allowing antialias rounding');
    assert.ok(rotated.height >= 55 && rotated.width >= 55, 'union contains both native MSI and rotated HE');
    assert.deepEqual(rotated.alphaAtMarkers, [255, 255, 255, 255]);
    for (let i = 0; i < rotated.original.length; i++) for (let j = 0; j < 2; j++)
      assert.ok(Math.abs(rotated.roundtrips[i][j] - rotated.original[i][j]) < 1e-6);
    assert.equal(rotated.previewMatches, true, JSON.stringify(rotated)); assert.equal(rotated.previewDidNotChangeLiveCanvas, true);
    assert.deepEqual(await immutable(h.page), before);
    await h.page.reload(); await h.page.waitForFunction(() => typeof viewerReady !== 'undefined' && viewerReady && viewerDisplayGeometry);
    assert.deepEqual(await evidence(h.page), rotated);
    assert.equal(await h.page.evaluate(() => rotationState.he), -90);
    assert.deepEqual(await immutable(h.page), before);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('translated HE, arbitrary whole-view fit, preview, PNG and ROI picking use the same expanded geometry', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await seed(h, { T: [[1, 0, -20], [0, 1, 30], [0, 0, 1]], rotation: { all: 20.375, he: 0, msi: 17 } });
    const before = await immutable(h.page), rendered = await evidence(h.page);
    assert.ok(rendered.alphaMass > 1860); assert.deepEqual(rendered.alphaAtMarkers, [255, 255, 255, 255]);
    assert.equal(rendered.previewMatches, true, JSON.stringify(rendered));
    const fit = await h.page.evaluate(() => {
      const host = document.getElementById('image-viewer').getBoundingClientRect(), canvas = displayCanvas.getBoundingClientRect();
      const png = buildExportCanvas(), expected = rotateViewerCanvas(displayCanvas, roiCanvas);
      return { within: canvas.left >= host.left - 1 && canvas.top >= host.top - 1 && canvas.right <= host.right + 1 && canvas.bottom <= host.bottom + 1,
        host: host.toJSON(), canvas: canvas.toJSON(), outer: getComputedStyle(document.getElementById('image-viewer-rot')).transform,
        pngContains: png.width >= expected.width && png.height >= expected.height,
        canvasScale: screenPxPerMsiPx(), expectedScale: Math.hypot(...viewerDisplayGeometry.msiMatrix.slice(0, 2)) * parseFloat(displayCanvas.style.width) / displayCanvas.width };
    });
    assert.equal(fit.within, true, JSON.stringify(fit)); assert.equal(fit.pngContains, true);
    assert.ok(Math.abs(fit.canvasScale - fit.expectedScale) < 1e-8);
    // A click in the ROI canvas under CSS rotation must still return raw MSI coordinates.
    const click = await h.page.evaluate(() => {
      const p = msiToCanvas(12.25, 23.75), sx = roiCanvas.clientWidth / roiCanvas.width, sy = roiCanvas.clientHeight / roiCanvas.height;
      const outer = new DOMMatrix(getComputedStyle(document.getElementById('image-viewer-rot')).transform);
      const host = document.getElementById('image-viewer').getBoundingClientRect();
      const local = { x: parseFloat(roiCanvas.style.left) + p[0] * sx - host.width / 2,
        y: parseFloat(roiCanvas.style.top) + p[1] * sy - host.height / 2 };
      const mapped = outer.transformPoint(local);
      toggleDrawingMode(true);
      // The test harness's utility CSS uses !important for this class, unlike
      // production Tailwind; let the real inline drawing-mode setting apply.
      roiCanvas.classList.remove('pointer-events-none');
      const x = host.left + host.width / 2 + mapped.x, y = host.top + host.height / 2 + mapped.y;
      return { x, y, target: document.elementFromPoint(x, y)?.outerHTML?.slice(0, 180) };
    });
    await h.page.mouse.click(click.x, click.y);
    const vertex = await h.page.evaluate(() => drawingVertices[0]);
    assert.ok(vertex && Math.abs(vertex[0] - 12.25) < .5 && Math.abs(vertex[1] - 23.75) < .5, JSON.stringify({ vertex, click }));
    assert.deepEqual(await immutable(h.page), before);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
