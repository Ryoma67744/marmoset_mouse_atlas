'use strict';
// Synthetic, local-only browser fixtures: no live account, cloud or mouse data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

const SERIES = 'mouse_tissue_1set';
const ANALYTES = ['GABA-DPP', 'Histamine-DPP', 'Dopamine-DPP', 'Norepinephrine-DPP', 'Serotonin-DPP', 'Serotonin-d4-DPP'];
const MOUSE_IDS = Array.from({ length: 48 }, (_, i) => 'gallery-mouse-' + (i + 1));
const COR_IDS = ['gallery-cor-1-2', 'gallery-cor-1-10', 'gallery-cor-2-1'];
const ARTIFACTS = path.resolve(__dirname, '../test-artifacts');

function galleryTest(name, run) {
  test(name, { timeout: 120000 }, async () => {
    const h = await startBrowserHarness();
    await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
      contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};',
    }));
    try { await run(h); assert.deepEqual(h.errors, []); } finally { await h.close(); }
  });
}

async function seedGallery(h) {
  await seedViewerProject(h.page, h.baseURL, { id: 'gallery-template' });
  await h.page.evaluate(async ({ analytes, series }) => {
    async function reference(key, left, right, width = 24, height = 16) {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = left; ctx.fillRect(0, 0, width / 2, height);
      ctx.fillStyle = right; ctx.fillRect(width / 2, 0, width / 2, height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      return { blobId: await ProjectStorage.putBlob({ blob, mime: 'image/png', filename: key + '.png' }),
        filename: key + '.png', mime: 'image/png' };
    }
    const he = await reference('HE_Stain', '#d11937', '#18ca65');
    const immuno = await reference('IF_Stain', '#182ce1', '#e6cc17');
    const atlas = await reference('ATLAS', '#9b35c7', '#ed801f', 40, 10);
    const legacy = await ProjectStorage.getProject('gallery-template');
    legacy.grid.umPerPxX = 150; legacy.grid.umPerPxY = 150;
    legacy.rotation = { all: 0, he: 0, msi: 0 }; legacy.images = { HE_Stain: he, IF_Stain: immuno };
    for (const [id, name] of [['gallery-cor-2-1', 'Cor_2_1'], ['gallery-cor-1-10', 'Cor_1_10'], ['gallery-cor-1-2', 'Cor_1_2']]) {
      const p = structuredClone(legacy); p.id = id; p.displayName = name; delete p.updatedAt;
      await ProjectStorage.putProject(p);
    }
    await ProjectStorage.deleteProjectRecord('gallery-template');
    // Reverse insertion makes updatedAt/lexical order visibly wrong.
    for (let number = 48; number >= 1; number--) {
      const W = 8, H = 6;
      const p = { id: 'gallery-mouse-' + number, displayName: 'Mouse_tissue_1set_' + String(number).padStart(2, '0'),
        plane: 'coronal', folderPath: ['Mouse', 'tissue_1set'], grid: { W, H, umPerPxX: null, umPerPxY: null },
        atlas: { species: 'mouse', seriesId: series, seriesName: 'tissue_1set', specimenId: 'tissue_1set',
          sectionNumber: number, sourceCandidateId: number === 11 ? 'C028' : 'candidate-' + number,
          coordinateMode: 'pixel', physicalSectionSpacing: null, displaySpacing: 2 },
        molecules: [], images: number === 1 ? { HE_Stain: he, IF_Stain: immuno, ATLAS: atlas } : number === 2 ? {} :
          number === 4 ? { HE_Stain: he, IF_Stain: immuno } : { HE_Stain: he },
        valueDisplay: { mode: 'raw', scale: 'individual' }, visibleLayers: ['MSI_Serotonin-DPP'], layerDisplay: {},
        rotation: { all: 0, msi: 0, he: 0 }, stack3d: { coordinateMode: 'pixel', offsetXPx: 0, offsetYPx: 0, rotationDeg: 0 },
        alignment: { HE_Stain: { T: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] } },
        notes: { atlasUrl: '', geneAtlasUrl: '', others: [] },
        roi: { roi_items: {}, roi_names: {}, palette: {}, roi_show_flags: {} } };
      const rasters = {};
      for (let channel = 0; channel < analytes.length; channel++) {
        if (number === 2 && channel === 1) continue; // Histamine genuinely absent in this section.
        const name = analytes[channel], key = 'MSI_' + name;
        const values = Float32Array.from({ length: W * H }, (_, i) =>
          i === W * H - 1 ? NaN : channel === 5 ? 2 + i % 3 : i * (channel + 1) * number);
        p.molecules.push({ key, name, analyteId: name, blobId: await ProjectStorage.putValueRaster(values),
          stats: MSIRaster.deriveBakeStats(values) });
        rasters[key] = { W, H, values };
      }
      p.normalization = Normalization.createPixelRatioProfile(p, rasters, { id: 'gallery-profile-' + number, revision: 1,
        standardKey: 'MSI_Serotonin-d4-DPP', targetKeys: p.molecules.filter(m => m.analyteId !== analytes[5]).map(m => m.key),
        standardApplication: { method: 'uniform_spray', confirmed: true, source: 'synthetic-test' } });
      await ProjectStorage.putProject(p);
    }
  }, { analytes: ANALYTES, series: SERIES });
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const projects = (await ProjectStorage.listProjects()).sort((a, b) => a.id.localeCompare(b.id));
    const rasters = {};
    for (const p of projects) for (const m of p.molecules || []) {
      const values = await ProjectStorage.getValueRaster(m.blobId);
      rasters[p.id + ':' + m.key] = Array.from(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
    }
    return { projects, rasters };
  });
}
async function ready(page, kind) {
  await page.waitForFunction(() => typeof SectionGallery !== 'undefined' && document.getElementById('section-gallery-launcher'));
  if (kind === 'viewer') await page.waitForFunction(() => typeof viewerReady !== 'undefined' && viewerReady);
  if (kind === 'stack') await page.waitForFunction(() => window.__stack3dReady && window.Atlas3D && Atlas3D.sections.length > 0);
}
async function cardIds(page) {
  return page.locator('#section-gallery-grid a[data-project-id]').evaluateAll(cards => cards.map(card => card.dataset.projectId));
}
async function openGallery(page, count = 48) {
  await page.locator('#section-gallery-launcher').click();
  await page.waitForFunction(() => document.getElementById('section-gallery-dialog')?.open === true);
  await page.waitForFunction(count => document.querySelectorAll('#section-gallery-grid a[data-project-id]').length === count, count);
}
async function closeGallery(page) {
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('section-gallery-dialog')?.open === false);
}
async function openViewer(h, id = MOUSE_IDS[0]) {
  await h.page.goto(h.baseURL + '/viewer/index.html?project=' + id);
  await ready(h.page, 'viewer');
}
async function thumbnailState(page, id, expected) {
  await page.waitForFunction(({ id, expected }) => {
    const card = document.querySelector('#section-gallery-grid a[data-project-id="' + id + '"]');
    return (card?.dataset.status || card?.querySelector('.section-gallery-thumbnail')?.dataset.status) === expected;
  }, { id, expected });
}
async function colorsInThumbnail(page, id) {
  return page.locator('#section-gallery-grid a[data-project-id="' + id + '"] canvas').evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set(); let colored = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3]) {
      colors.add(Array.from(pixels.slice(i, i + 3)).join(','));
      if (pixels[i] || pixels[i + 1] || pixels[i + 2]) colored++;
    }
    return { colors: [...colors], colored, png: canvas.toDataURL(), width: canvas.width, height: canvas.height };
  });
}

async function saveGalleryScreenshot(page, filename) {
  await page.waitForFunction(() => document.getElementById('section-gallery-grid')?.getAttribute('aria-busy') === 'false');
  await fs.mkdir(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS, filename), animations: 'disabled' });
}

galleryTest('Master, 3D and Viewer expose one gallery with the full same-series numeric order', async h => {
  await seedGallery(h);
  const routes = [
    ['master', '/index.html?series=' + SERIES],
    ['stack', '/stack3d/index.html?series=' + SERIES],
    ['viewer', '/viewer/index.html?project=' + MOUSE_IDS[10]],
  ];
  for (const [kind, url] of routes) {
    // The gallery must not inherit the 3D-only requested subset.
    await h.page.evaluate(ids => sessionStorage.setItem('atlas-stack3d-selection:mouse_tissue_1set', JSON.stringify(ids)), MOUSE_IDS.slice(0, 2));
    await h.page.goto(h.baseURL + url); await ready(h.page, kind);
    if (kind === 'stack') assert.equal(await h.page.evaluate(() => Atlas3D.sections.length), 2);
    assert.equal(await h.page.locator('#section-gallery-launcher').count(), 1);
    const before = await snapshot(h.page), originalUrl = h.page.url();
    await openGallery(h.page);
    assert.deepEqual(await cardIds(h.page), MOUSE_IDS, kind + ' confirmed numeric mouse order');
    assert.equal(await h.page.locator('#section-gallery-series').inputValue(), SERIES);
    if (kind === 'viewer') await saveGalleryScreenshot(h.page, 'section-gallery-desktop.png');
    await h.page.locator('#section-gallery-series').selectOption('legacy_marmoset');
    await h.page.waitForFunction(() => document.querySelectorAll('#section-gallery-grid a[data-project-id]').length === 3);
    assert.deepEqual(await cardIds(h.page), COR_IDS, kind + ' numeric legacy order');
    assert.equal(h.page.url(), originalUrl);
    await closeGallery(h.page);
    assert.equal(await h.page.locator('#section-gallery-launcher').evaluate(el => el === document.activeElement), true);
    assert.deepEqual(await snapshot(h.page), before, kind + ' gallery does not save scientific or display data');
  }
});

galleryTest('Gallery links open a new Viewer tab while retaining the current Viewer draft and state', async h => {
  await seedGallery(h); await openViewer(h);
  const before = await snapshot(h.page), originalUrl = h.page.url();
  await h.page.evaluate(() => {
    currentProject.notes = { ...currentProject.notes, atlasUrl: 'https://example.org/uncommitted-source-note' };
    notesPendingSave = true;
    document.getElementById('notes-atlas-url').value = currentProject.notes.atlasUrl;
    drawingMode = true; drawingVertices = [[1, 1], [3, 2]];
  });
  await openGallery(h.page);
  const card = h.page.locator('#section-gallery-grid a[data-project-id="gallery-mouse-11"]');
  assert.equal(await card.getAttribute('target'), '_blank');
  assert.match(await card.getAttribute('rel') || '', /noopener/);
  const popupPromise = h.context.waitForEvent('page');
  await card.click(); const popup = await popupPromise;
  popup.on('pageerror', error => h.errors.push(error.message));
  await popup.waitForURL(url => url.pathname.endsWith('/viewer/index.html') && url.searchParams.get('project') === 'gallery-mouse-11');
  await popup.waitForFunction(() => typeof viewerReady !== 'undefined' && viewerReady);
  assert.equal(h.page.url(), originalUrl);
  assert.equal(await h.page.locator('#section-gallery-dialog').evaluate(el => el.open), true);
  assert.equal(await h.page.locator('#notes-atlas-url').inputValue(), 'https://example.org/uncommitted-source-note');
  assert.deepEqual(await h.page.evaluate(() => ({ id: currentProject.id, drawingMode, drawingVertices,
    pending: notesPendingSave })),
  { id: MOUSE_IDS[0], drawingMode: true, drawingVertices: [[1, 1], [3, 2]], pending: true });
  assert.equal(await popup.evaluate(() => window.opener), null);
  assert.deepEqual(await snapshot(h.page), before, 'opening cards does not flush or overwrite the current draft');
  await popup.close();
});

galleryTest('The gallery remains usable on a narrow screen and Escape returns focus without replacing the page', async h => {
  await seedGallery(h); await h.page.setViewportSize({ width: 390, height: 844 });
  await openViewer(h); const originalUrl = h.page.url();
  await openGallery(h.page);
  const layout = await h.page.locator('#section-gallery-dialog').evaluate(dialog => {
    const r = dialog.getBoundingClientRect();
    const grid = document.getElementById('section-gallery-grid');
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight,
      dialogOverflow: dialog.scrollWidth - dialog.clientWidth, gridOverflow: grid.scrollWidth - grid.clientWidth };
  });
  assert.ok(layout.left >= -1 && layout.right <= layout.width + 1, JSON.stringify(layout));
  assert.ok(layout.top >= -1 && layout.bottom <= layout.height + 1, JSON.stringify(layout));
  assert.ok(layout.dialogOverflow <= 1 && layout.gridOverflow <= 1, JSON.stringify(layout));
  await saveGalleryScreenshot(h.page, 'section-gallery-mobile.png');
  await h.page.locator('#section-gallery-grid a[data-project-id="gallery-mouse-48"]').scrollIntoViewIfNeeded();
  assert.equal(await h.page.locator('#section-gallery-grid a[data-project-id="gallery-mouse-48"]').isVisible(), true);
  await closeGallery(h.page);
  assert.equal(h.page.url(), originalUrl);
  assert.equal(await h.page.locator('#section-gallery-launcher').evaluate(el => el === document.activeElement), true);
});

galleryTest('Gallery thumbnails use the selected MSI, HE, IF and Atlas sources and keep genuinely missing sections blank', async h => {
  await seedGallery(h); await openViewer(h);
  const before = await snapshot(h.page);
  await openGallery(h.page);
  const source = h.page.locator('#section-gallery-source');
  const options = await source.locator('option').evaluateAll(nodes => nodes.map(node => node.value));
  for (const value of ['msi:GABA-DPP', 'msi:Histamine-DPP', 'he', 'if:IF_Stain', 'atlas']) assert.ok(options.includes(value), value);

  await source.selectOption('msi:GABA-DPP');
  await thumbnailState(h.page, MOUSE_IDS[0], 'ready');
  await thumbnailState(h.page, MOUSE_IDS[1], 'ready');
  const gaba = await colorsInThumbnail(h.page, MOUSE_IDS[0]);
  assert.ok(gaba.colored > 0, 'MSI thumbnail has measured signal');
  await source.selectOption('msi:Histamine-DPP');
  await thumbnailState(h.page, MOUSE_IDS[0], 'ready');
  await thumbnailState(h.page, MOUSE_IDS[1], 'missing');
  const histamine = await colorsInThumbnail(h.page, MOUSE_IDS[0]);
  assert.ok(histamine.colored > 0); assert.notEqual(histamine.png, gaba.png, 'molecule selection changes the actual molecular thumbnail');
  const missingMsi = h.page.locator('#section-gallery-grid a[data-project-id="' + MOUSE_IDS[1] + '"]');
  assert.equal(await missingMsi.locator('canvas,img').count(), 0, 'missing Histamine never reuses the old GABA image');
  assert.match(await missingMsi.innerText(), /未登録|なし|見つか|ありません|欠損/);

  await source.selectOption('he');
  await thumbnailState(h.page, MOUSE_IDS[0], 'ready');
  await thumbnailState(h.page, MOUSE_IDS[1], 'missing');
  const he = await colorsInThumbnail(h.page, MOUSE_IDS[0]);
  assert.ok(he.colors.includes('209,25,55') && he.colors.includes('24,202,101'), 'HE comes from the stored two-color reference PNG');
  assert.equal(await missingMsi.locator('canvas,img').count(), 0);
  await source.selectOption('if:IF_Stain');
  await thumbnailState(h.page, MOUSE_IDS[0], 'ready');
  await thumbnailState(h.page, MOUSE_IDS[2], 'missing');
  const immuno = await colorsInThumbnail(h.page, MOUSE_IDS[0]);
  assert.ok(immuno.colors.includes('24,44,225') && immuno.colors.includes('230,204,23'), 'IF uses its own stored image rather than HE or MSI');
  assert.notEqual(immuno.png, he.png);
  assert.equal(await h.page.locator('#section-gallery-grid a[data-project-id="' + MOUSE_IDS[2] + '"] canvas').count(), 0);

  await source.selectOption('atlas');
  await thumbnailState(h.page, MOUSE_IDS[0], 'ready');
  await thumbnailState(h.page, MOUSE_IDS[1], 'missing');
  await thumbnailState(h.page, MOUSE_IDS[2], 'missing');
  await thumbnailState(h.page, MOUSE_IDS[3], 'missing');
  const atlas = await colorsInThumbnail(h.page, MOUSE_IDS[0]);
  assert.ok(atlas.colors.includes('155,53,199') && atlas.colors.includes('237,128,31'), 'Atlas uses its own stored two-color PNG');
  assert.equal(atlas.width / atlas.height, 4, 'Atlas keeps its native 4:1 aspect ratio rather than the MSI grid or HE alignment');
  assert.equal(await h.page.locator('#section-gallery-grid a[data-project-id="' + MOUSE_IDS[0] + '"] canvas')
    .evaluate(canvas => getComputedStyle(canvas).objectFit), 'contain', 'the thumbnail display retains that native aspect ratio');
  assert.notEqual(atlas.png, he.png); assert.notEqual(atlas.png, immuno.png);
  for (const id of MOUSE_IDS.slice(1, 4)) {
    const card = h.page.locator('#section-gallery-grid a[data-project-id="' + id + '"]');
    assert.equal(await card.locator('canvas,img').count(), 0, 'missing Atlas never borrows an available HE, IF or previous MSI image');
    assert.match(await card.innerText(), /未登録|なし|見つか|ありません|欠損/);
  }

  // Fast source changes must not let an older asynchronous reference image win.
  await source.selectOption('he'); await source.selectOption('if:IF_Stain'); await source.selectOption('atlas'); await source.selectOption('msi:Histamine-DPP');
  await thumbnailState(h.page, MOUSE_IDS[0], 'ready'); await thumbnailState(h.page, MOUSE_IDS[1], 'missing');
  assert.equal((await colorsInThumbnail(h.page, MOUSE_IDS[0])).png, histamine.png);
  assert.deepEqual(await snapshot(h.page), before, 'source choices do not rewrite original rasters, normalization, ROI, alignment or preferences');
});

galleryTest('An extra IF source discovered after catalogue metadata hydration can be selected and rendered', async h => {
  await seedGallery(h);
  await h.page.evaluate(async id => {
    const p = await ProjectStorage.getProject(id), canvas = document.createElement('canvas');
    canvas.width = 24; canvas.height = 16;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'rgb(45,200,190)'; ctx.fillRect(0, 0, 12, 16);
    ctx.fillStyle = 'rgb(190,35,205)'; ctx.fillRect(12, 0, 12, 16);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    p.images.IF_GFAP = { blobId: await ProjectStorage.putBlob({ blob, mime: 'image/png', filename: 'GFAP.png' }),
      mime: 'image/png', filename: 'GFAP.png' };
    await ProjectStorage.putProject(p);
  }, MOUSE_IDS[0]);
  // Cloud list metadata can omit an exact IF key even though the fetched
  // project contains it. Remove that option only from the initial catalogue;
  // real project reads, thumbnail rendering and discovery remain unchanged.
  const script = await fs.readFile(path.resolve(__dirname, '../lib/section-gallery-data.js'), 'utf8');
  await h.context.route('**/lib/section-gallery-data.js*', route => route.fulfill({
    contentType: 'application/javascript', body: script + '\n' + `
      (function () {
        const production = window.SectionGalleryData;
        window.SectionGalleryData = { create(options) {
          const data = production.create(options), loadCatalog = data.loadCatalog;
          return { ...data, async loadCatalog(request) {
            const catalog = await loadCatalog(request);
            catalog.sources = catalog.sources.filter(source => source.key !== 'if:IF_GFAP');
            window.__galleryInitialSourceKeys = catalog.sources.map(source => source.key);
            return catalog;
          } };
        } };
      })();`,
  }));
  await openViewer(h); const before = await snapshot(h.page);
  await openGallery(h.page);
  await h.page.waitForFunction(() => document.querySelector('#section-gallery-source option[value="if:IF_GFAP"]'));
  assert.equal(await h.page.evaluate(() => __galleryInitialSourceKeys.includes('if:IF_GFAP')), false);
  await h.page.locator('#section-gallery-source').selectOption('if:IF_GFAP');
  await thumbnailState(h.page, MOUSE_IDS[0], 'ready'); await thumbnailState(h.page, MOUSE_IDS[1], 'missing');
  const gfap = await colorsInThumbnail(h.page, MOUSE_IDS[0]);
  assert.ok(gfap.colors.includes('45,200,190') && gfap.colors.includes('190,35,205'), 'newly discovered key renders the actual GFAP image');
  assert.equal(await h.page.locator('#section-gallery-grid a[data-project-id="' + MOUSE_IDS[1] + '"] canvas').count(), 0);
  assert.deepEqual(await snapshot(h.page), before);
});
