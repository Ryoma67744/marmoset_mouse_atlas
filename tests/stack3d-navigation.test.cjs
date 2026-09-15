'use strict';
// Browser regressions are run by GitHub CI through the existing local harness.
// Fixtures are entirely synthetic; the harness blocks external cloud requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');
const IDS = ['stack-first', 'stack-second', 'stack-skipped'];

async function seed(h, { brightOutlier = false } = {}) {
  for (const id of IDS) await seedViewerProject(h.page, h.baseURL, { id });
  await h.page.evaluate(async ({ ids, brightOutlier }) => {
    await ProjectStorage.putFolder({ id: 'species', name: 'Synthetic', parentId: null });
    await ProjectStorage.putFolder({ id: 'coronal', name: 'Coronal', parentId: 'species', normalizationGroupId: 'stack-group' });
    const entries = [];
    for (let i = 0; i < ids.length; i++) {
      const p = await ProjectStorage.getProject(ids[i]);
      p.displayName = ['Cor_1_2', 'Cor_1_10', 'Cor_10_1'][i];
      p.folderId = 'coronal';
      p.grid.umPerPxX = 25; p.grid.umPerPxY = 50;
      p.rotation = { all: i ? 0 : 94, msi: 0, he: 0 };
      p.valueDisplay = { mode: 'raw' };
      delete p.normalization;
      if (brightOutlier && i === 1) for (const molecule of p.molecules) {
        if (molecule.key === 'MSI_D4-5-HT') continue;
        const source = await ProjectStorage.getValueRaster(molecule.blobId);
        const values = Float32Array.from(source, value => value * 1000);
        molecule.blobId = await ProjectStorage.putValueRaster(values);
        molecule.stats = MSIRaster.deriveBakeStats(values);
      }
      if (i === 2) p.molecules = p.molecules.filter(m => m.key !== 'MSI_D4-5-HT');
      p.normalizationBinding = { groupId: 'stack-group', memberId: p.id, folderPath: ['Synthetic', 'Coronal'] };
      entries.push({ project: p, rasters: await Normalization.loadRasters(p, { storage: ProjectStorage }) });
    }
    const result = Normalization.createSimpleProfiles(entries, { id: 'stack-profile', revision: 1,
      scope: { type: 'folder-depth', depth: 2, includeDescendants: true, groupId: 'stack-group',
        folderPath: ['Synthetic', 'Coronal'], memberIds: ids } });
    if (!result.canSave) throw new Error('Invalid synthetic normalization fixture');
    for (let i = 0; i < entries.length; i++) {
      entries[i].project.normalization = result.profiles[i].normalization;
      await ProjectStorage.putProject(entries[i].project);
    }
    sessionStorage.setItem('marmoset:currentFolder', 'coronal');
    sessionStorage.removeItem('atlas-stack3d-selection');
    sessionStorage.removeItem('atlas-stack3d-view-v1');
    sessionStorage.removeItem('atlas-stack3d-layout-v1');
  }, { ids: IDS, brightOutlier });
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};'
  }));
}

async function ready(page, count) {
  try { await page.waitForFunction(n => window.__stack3dReady && window.Atlas3D && Atlas3D.sections.length === n, count); }
  catch (error) { throw new Error(await page.locator("#notice").innerText(), { cause: error }); }
  assert.equal(await page.locator('#render-error').isVisible(), false, 'WebGL should initialize in the CI browser');
  await page.waitForFunction(n => Atlas3D.renderer && Atlas3D.renderer.getStats().sectionCount === n && Atlas3D.renderer.getStats().renderCount > 0, count);
}

async function rawBits(page) {
  return page.evaluate(async () => {
    const result = {};
    for (const p of await ProjectStorage.listProjects()) for (const m of p.molecules) {
      const values = await ProjectStorage.getValueRaster(m.blobId);
      result[p.id + ':' + m.key] = Array.from(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
    }
    return result;
  });
}

async function setSlider(page, selector, value) {
  await page.locator(selector).evaluate((element, value) => {
    element.value = String(value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function seedReferenceImages(page) {
  await page.evaluate(async ids => {
    const he = document.createElement('canvas'); he.width = 128; he.height = 64;
    const ctx = he.getContext('2d');
    ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 128, 32);
    ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 32, 128, 32);
    // A one-native-pixel feature is destroyed if HE is reduced to the 4×2 MSI raster.
    ctx.fillStyle = '#00ff00'; ctx.fillRect(48, 0, 1, 32);
    const atlas = document.createElement('canvas'); atlas.width = 256; atlas.height = 128;
    atlas.getContext('2d').drawImage(he, 0, 0, atlas.width, atlas.height);
    for (const id of ids.slice(0, 2)) {
      const project = await ProjectStorage.getProject(id);
      for (const [key, source] of [['HE_Stain', he], ['ATLAS', atlas]]) {
        const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'));
        const filename = key + '.png';
        project.images[key] = { blobId: await ProjectStorage.putBlob({ blob, mime: 'image/png', filename }), filename, mime: 'image/png' };
      }
      project.world_coords = { T_he_to_msi: [[1 / 32, 0, 0.5], [0, 1 / 32, 0], [0, 0, 1]] };
      await ProjectStorage.putProject(project);
    }
  }, IDS);
}

function sameView(actual, expected) {
  for (const key of ['position', 'target', 'up']) for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(actual[key][i] - expected[key][i]) < 1e-8, key + '[' + i + '] restored');
  }
  assert.equal(actual.zoom, expected.zoom);
}

test('3D ROI contours labels and regional MSI filtering follow visibility without changing scientific values', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); await seedReferenceImages(page);
    await page.evaluate(async ids => {
      for (const id of ids.slice(0, 2)) {
        const p = await ProjectStorage.getProject(id);
        p.roi = { roi_names: { left: '領域A', right: '領域B' }, palette: { left: [0,255,255], right: [255,0,255] },
          roi_items: { left: [{ poly_msi: [[-.5,-.5],[1.5,-.5],[1.5,2.5],[-.5,2.5]] }],
            right: [{ poly_msi: [[1.5,-.5],[4.5,-.5],[4.5,2.5],[1.5,2.5]] }] } };
        await ProjectStorage.putProject(p);
      }
    }, IDS);
    const before = await rawBits(page), stored = await page.evaluate(() => ProjectStorage.listProjects());
    await page.goto(h.baseURL + '/stack3d/index.html?project=stack-second'); await ready(page, 3);
    assert.equal(await page.locator('#he-visible').count(), 0);
    assert.equal(await page.evaluate(() => Atlas3D.renderer.getStats().heTextureCount), 0);
    let roi = await page.evaluate(() => Atlas3D.renderer.getStats().roi);
    assert.deepEqual(roi[1].labels, ['領域A','領域B']); assert.equal(roi[0].labels.length, 0);
    const ranges = await page.evaluate(() => Atlas3D.rendered[1].ranges);
    await page.locator('#roi-region').selectOption('領域A');
    await page.waitForFunction(() => {
      const c = Atlas3D.rendered[1].canvas, d = c.getContext('2d').getImageData(0,0,4,2).data;
      return d[3] > 0 && d[2*4+3] === 0 && d[3*4+3] === 0;
    });
    roi = await page.evaluate(() => Atlas3D.renderer.getStats().roi);
    assert.equal(roi[1].contours, 1); assert.deepEqual(roi[1].labels, ['領域A']);
    assert.deepEqual(await page.evaluate(() => Atlas3D.rendered[1].ranges), ranges);
    await page.locator('#roi-labels').uncheck();
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().roi[1].labels), []);
    await page.locator('#roi-visible').uncheck();
    assert.equal(await page.evaluate(() => Atlas3D.renderer.getStats().roi[1].contours), 0);
    await page.locator('#roi-visible').check(); await page.locator('#roi-labels').check();
    await page.locator('input.section-visible[data-section-id="stack-second"]').uncheck();
    assert.equal(await page.evaluate(() => Atlas3D.renderer.getStats().roi[1].contours), 0);
    await page.locator('input.section-visible[data-section-id="stack-second"]').check();
    await page.reload(); await ready(page, 3);
    assert.equal(await page.locator('#roi-region').inputValue(), '領域A');
    await page.locator('#roi-region').selectOption('');
    await page.waitForFunction(() => Atlas3D.rendered[1].canvas.getContext('2d').getImageData(3,0,1,1).data[3] > 0);
    await page.locator('[data-preview="HE_Stain"]').click();
    await page.waitForFunction(() => document.querySelector('#section-preview canvas')?.width >= 128 && document.getElementById('section-preview').dataset.previewKind === 'HE_Stain');
    assert.deepEqual(await rawBits(page), before);
    assert.deepEqual(await page.evaluate(() => ProjectStorage.listProjects()), stored); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('initial spacing is exactly 1.7x and only the former session default migrates', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); await page.goto(h.baseURL + '/stack3d/index.html'); await ready(page, 3);
    assert.equal(await page.locator('#spacing').inputValue(), '0.595');
    assert.equal(await page.locator('#spacing-value').innerText(), '1.7×');
    assert.equal(await page.evaluate(() => Atlas3D.renderer.getStats().spacing), 0.595);
    for (const [spacing, version, expected] of [[0.35, null, 0.595], [0.61, null, 0.61], [0.35, 1, 0.35]]) {
      await seed(h);
      await page.evaluate(({ ids, spacing, version }) => sessionStorage.setItem('atlas-stack3d-view-v1', JSON.stringify({
        ids, spacing, spacingDefaultsVersion: version, options: { mode: 'raw' }
      })), { ids: IDS, spacing, version });
      await page.goto(h.baseURL + '/stack3d/index.html'); await ready(page, 3);
      assert.equal(Number(await page.locator('#spacing').inputValue()), expected);
    }
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('sidebar drag preserves MSI HE and Atlas dimensions and restores layout without changing data or camera', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); await seedReferenceImages(page);
    const before = await rawBits(page);
    await page.goto(h.baseURL + '/stack3d/index.html?project=stack-second'); await ready(page, 3);
    const view = await page.evaluate(() => Atlas3D.renderer.getView());
    const size = () => page.locator('#section-preview').evaluate(e => [e.getBoundingClientRect().width, e.getBoundingClientRect().height]);
    const initial = await size(), panelWidth = (await page.locator('#section-panel').boundingBox()).width;
    const handle = page.locator('#section-resizer'), box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 100); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 120, box.y + 100, { steps: 8 }); await page.mouse.up();
    assert.ok((await page.locator('#section-panel').boundingBox()).width > panelWidth + 80);
    assert.deepEqual(await size(), initial);
    for (const kind of ['MSI', 'HE_Stain', 'ATLAS']) {
      await page.locator('[data-preview="' + kind + '"]').click();
      await page.waitForFunction(kind => document.getElementById('section-preview').dataset.previewKind === kind && document.querySelector('#section-preview canvas,#section-preview img'), kind);
      const nativeBefore = await page.locator('#section-preview canvas,#section-preview img').evaluate(e => [e.width, e.height]);
      await handle.focus(); await page.keyboard.press('Home');
      assert.deepEqual(await size(), initial);
      assert.equal(await page.locator('#preview-viewport').evaluate(e => e.scrollWidth > e.clientWidth), true);
      assert.deepEqual(await page.locator('#section-preview canvas,#section-preview img').evaluate(e => [e.width, e.height]), nativeBefore);
      await page.keyboard.press('End'); assert.deepEqual(await size(), initial);
    }
    sameView(await page.evaluate(() => Atlas3D.renderer.getView()), view);
    const savedWidth = (await page.locator('#section-panel').boundingBox()).width;
    await page.locator('#open-section').click(); await page.waitForURL('**/viewer/index.html?project=stack-second&from=stack3d');
    await page.waitForFunction(() => viewerReady); await page.locator('#back-stack3d').click(); await ready(page, 3);
    assert.equal((await page.locator('#section-panel').boundingBox()).width, savedWidth);
    assert.deepEqual(await size(), initial);
    await page.reload(); await ready(page, 3); assert.deepEqual(await size(), initial);
    const viewport = page.viewportSize(); await page.setViewportSize({ width: 700, height: 900 });
    assert.equal(await handle.isVisible(), false);
    await page.setViewportSize(viewport); assert.deepEqual(await size(), initial);
    await handle.dblclick();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('atlas-stack3d-layout-v1')), null);
    assert.deepEqual(await rawBits(page), before); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Master subset opens a 3D stack and section detail returns with camera, controls and selected section preserved', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h);
    const before = await rawBits(page);
    await page.goto(h.baseURL + '/');
    await page.waitForFunction(() => document.querySelectorAll('#project-list input.sel').length === 3);
    for (const id of IDS.slice(0, 2)) await page.locator('#project-list input.sel[value="' + id + '"]').check();
    await page.locator('#open-stack3d').click();
    await ready(page, 2);
    assert.deepEqual(await page.evaluate(() => Atlas3D.sections.map(s => s.name)), ['Cor_1_2', 'Cor_1_10']);
    await setSlider(page, '#opacity', 0.31);
    await setSlider(page, '#threshold', 0.2);
    await setSlider(page, '#spacing', 0.61);
    assert.equal(await page.locator('#range-mode').count(), 0, 'color range is no longer an editable choice');
    assert.equal(await page.evaluate(() => Atlas3D.options().rangeMode), 'common');
    await page.locator('input[name="channel"][value="NE"]').uncheck();
    await page.locator('#next-section').click();
    await page.waitForFunction(() => document.getElementById('section-name').textContent === 'Cor_1_10');
    const view = await page.evaluate(() => {
      const view = Atlas3D.renderer.getView();
      view.position[0] += 0.3; view.position[1] += 0.5; view.zoom = 1.25;
      Atlas3D.renderer.setView(view);
      return Atlas3D.renderer.getView();
    });
    await page.locator('#open-section').click();
    await page.waitForURL('**/viewer/index.html?project=stack-second&from=stack3d');
    await page.waitForFunction(() => viewerReady);
    assert.equal(new URL(page.url()).searchParams.get('project'), 'stack-second');
    assert.equal(await page.locator('#atlas-title').innerText(), 'Cor_1_10');
    await page.locator('#back-stack3d').click();
    await ready(page, 2);
    assert.equal(new URL(page.url()).searchParams.get('project'), 'stack-second');
    assert.equal(await page.locator('#section-name').innerText(), 'Cor_1_10');
    assert.equal(await page.locator('#opacity').inputValue(), '0.31');
    assert.equal(await page.locator('#threshold').inputValue(), '0.2');
    assert.equal(await page.locator('#spacing').inputValue(), '0.61');
    assert.equal(await page.evaluate(() => Atlas3D.options().rangeMode), 'common');
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().range), [0, 1], 'section cutoff survives the detail round trip');
    assert.equal(await page.locator('input[name="channel"][value="NE"]').isChecked(), false);
    sameView(await page.evaluate(() => Atlas3D.renderer.getView()), view);
    await page.locator('#master-link').click();
    await page.waitForFunction(() => document.querySelectorAll('#project-list input.sel').length === 3);
    assert.equal(await page.locator('#project-list input.sel:checked').count(), 0);
    await page.locator('#open-stack3d').click();
    await ready(page, 3);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('atlas-stack3d-selection')), null, 'unselected Master clears the previous subset');
    assert.deepEqual(await rawBits(page), before);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('normalized 3D mode exposes a skipped correction without rendering or pooling raw values as corrected', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h);
    const before = await rawBits(page);
    await page.goto(h.baseURL + '/stack3d/index.html?project=stack-skipped');
    await ready(page, 3);
    assert.equal(await page.locator('#section-name').innerText(), 'Cor_10_1');
    await page.locator('#value-mode').selectOption('normalized');
    assert.equal(await page.evaluate(() => Atlas3D.options().rangeMode), 'common');
    await page.waitForFunction(() => Atlas3D.rendered[Atlas3D.selected]?.status.code === 'UNAVAILABLE');
    assert.match(await page.locator('#section-status').innerText(), /表示できる値がありません|補正値を表示できません/);
    const actual = await page.evaluate(() => {
      const section = Atlas3D.sections.find(s => s.id === 'stack-skipped');
      const common = Stack3D.computeCommonRanges(Atlas3D.sections, 'normalized');
      const rendered = Stack3D.renderSection(section, { mode: 'normalized', rangeMode: 'common', commonRanges: common, channels: ['DA', 'NE', '5-HT'] });
      const pixels = rendered.canvas.getContext('2d').getImageData(0, 0, section.W, section.H).data;
      const result = { code: rendered.status.code, visible: rendered.status.visiblePixels,
        alpha: Array.from(pixels).filter((_, i) => i % 4 === 3), members: common.DA.memberIds };
      rendered.canvas.width = 0; rendered.previewCanvas.width = 0;
      return result;
    });
    assert.equal(actual.code, 'UNAVAILABLE');
    assert.equal(actual.visible, 0);
    assert.ok(actual.alpha.every(value => value === 0));
    assert.deepEqual(actual.members, ['stack-first', 'stack-second']);
    await page.locator('#value-mode').selectOption('raw');
    await page.waitForFunction(() => Atlas3D.rendered[Atlas3D.selected]?.status.code === 'RAW');
    assert.match(await page.locator('#section-status').innerText(), /原値/);
    assert.deepEqual(await rawBits(page), before);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('common color ranges override older sessions and the bottom scrubber hides later sections until reset', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h);
    const before = await rawBits(page);
    await page.evaluate(ids => sessionStorage.setItem('atlas-stack3d-view-v1', JSON.stringify({
      ids, selectedId: ids[0], previewKind: 'ROI', options: { mode: 'raw', rangeMode: 'individual', channels: ['DA', 'NE', '5-HT'] }, range: [1, 3]
    })), IDS);
    await page.goto(h.baseURL + '/stack3d/index.html');
    await ready(page, 3);
    assert.equal(await page.locator('#range-mode').count(), 0);
    assert.equal(await page.evaluate(() => Atlas3D.options().rangeMode), 'common');
    assert.match(await page.locator('.scene-bottom').innerText(), /小脳側\s*→\s*嗅球側.*初期視点/);
    assert.equal(await page.locator('[data-preview="ROI"]').count(), 0, 'ROI no longer has a standalone tab');
    await page.waitForFunction(() => document.getElementById('section-preview').dataset.previewKind === 'MSI');
    assert.match(await page.locator('[data-preview="MSI"]').innerText(), /MSI.*ROI/);
    assert.match(await page.locator('[data-preview="HE_Stain"]').innerText(), /HE.*ROI/);
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().visibleSectionIds), IDS,
      'initial selection of the first slice does not clip the fresh stack');
    const rangesBefore = await page.evaluate(() => {
      window.__rangeCalls = 0;
      const original = Stack3D.computeCommonRanges;
      Stack3D.computeCommonRanges = (...args) => { window.__rangeCalls++; return original(...args); };
      return Atlas3D.rendered[0].ranges;
    });
    await setSlider(page, '#section-slider', 1);
    assert.equal(await page.locator('#section-name').innerText(), 'Cor_1_10');
    let stats = await page.evaluate(() => Atlas3D.renderer.getStats());
    assert.deepEqual(stats.range, [0, 1]);
    assert.deepEqual(stats.visibleSectionIds, IDS.slice(0, 2), 'the selected section and earlier sections remain visible');
    assert.equal(stats.selectedIndex, 1);
    assert.equal(await page.evaluate(() => window.__rangeCalls), 0, 'scrubbing does not recompute the common color scale');
    assert.deepEqual(await page.evaluate(() => Atlas3D.rendered[0].ranges), rangesBefore);
    await page.locator('#reload').click();
    await ready(page, 3);
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().range), [0, 1], 'cutoff survives reload');
    await page.locator('#previous-section').click();
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().range), [0, 0]);
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().visibleSectionIds), [IDS[0]],
      'the first scrubber endpoint displays only the first slice');
    await page.locator('#next-section').click();
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().range), [0, 1]);
    await setSlider(page, '#section-slider', 2);
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().visibleSectionIds), IDS,
      'the last scrubber endpoint displays all enabled slices');
    await page.locator('#range-start').fill('2');
    await page.locator('#range-start').dispatchEvent('change');
    await setSlider(page, '#section-slider', 2);
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().range), [1, 2], 'scrubbing preserves a manually limited start');
    await setSlider(page, '#section-slider', 0);
    stats = await page.evaluate(() => Atlas3D.renderer.getStats());
    assert.deepEqual(stats.range, [0, 0], 'scrubbing before the old start includes the selected section');
    assert.deepEqual(stats.visibleSectionIds, [IDS[0]]);
    await page.locator('#show-all').click();
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().range), [0, 2]);
    assert.equal(await page.locator('#section-name').innerText(), 'Cor_1_2');
    assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('atlas-stack3d-view-v1')).options.rangeMode), 'common');
    assert.deepEqual(await rawBits(page), before);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('unsynchronized edits appear as a compact header warning with complete accessible details', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h);
    await h.context.route(h.baseURL + '/lib/cloud.js', route => route.fulfill({
      contentType: 'application/javascript', body: `window.Cloud = {
        configured: () => true, signedIn: () => true,
        listProjects: async () => (await ProjectStorage.listProjects()).map(p => ({ id: p.id, display_name: p.displayName }))
      };`
    }));
    await h.context.route(h.baseURL + '/lib/project-sync.js', route => route.fulfill({
      contentType: 'application/javascript', body: `window.ProjectSync = {
        ensureLocal: id => ProjectStorage.getProject(id),
        statusOf: p => p.id === 'stack-skipped' ? { status: 'current' } : {
          status: 'local-edits', reason: '手元に未同期の編集があります'
        }
      };`
    }));
    await page.goto(h.baseURL + '/stack3d/index.html');
    await ready(page, 3);
    assert.equal(await page.locator('#sync-warning').isVisible(), true);
    const title = await page.locator('#sync-warning').getAttribute('title');
    assert.match(title, /Cor_1_2/); assert.match(title, /Cor_1_10/); assert.match(title, /未同期/);
    assert.match(await page.locator('#sync-warning').getAttribute('aria-label'), /未同期.*2/);
    const bounds = await page.locator('#sync-warning').boundingBox();
    assert.ok(bounds.y < 100 && bounds.width <= 48 && bounds.height <= 48, 'warning is a small icon in the top header');
    assert.equal(await page.locator('#notice').isVisible(), false, 'ordinary local edits do not cover the bottom scrubber');
    await page.locator('#sync-warning').click();
    assert.equal(await page.locator('#sync-warning').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#sync-details').isVisible(), true);
    const details = await page.locator('#sync-details').innerText();
    assert.match(details, /Cor_1_2/); assert.match(details, /Cor_1_10/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#sync-details').isVisible(), false);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('switching a bright section OFF removes its influence from both common display ranges without changing measurements', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h, { brightOutlier: true });
    const before = await rawBits(page), stored = await page.evaluate(() => ProjectStorage.listProjects());
    await page.goto(h.baseURL + '/stack3d/index.html?project=stack-first');
    await ready(page, 3);
    await page.locator('#value-mode').selectOption('raw');
    await page.waitForFunction(() => Atlas3D.rendered[0]?.ranges['5-HT']?.max === 80000);
    const valuesBefore = await page.evaluate(() => Atlas3D.sections.map(section => ({
      id: section.id, zIndex: section.zIndex,
      channels: Object.fromEntries(Object.entries(section.channels).map(([key, channel]) => [key, {
        raw: Array.from(channel.raw), normalized: channel.normalized && Array.from(channel.normalized)
      }]))
    })));
    const view = await page.evaluate(() => Atlas3D.renderer.getView());
    const outlier = page.getByRole('checkbox', { name: 'Cor_1_10を3D表示', exact: true });
    assert.equal(await outlier.isChecked(), true);
    await outlier.uncheck();
    await page.waitForFunction(() => Atlas3D.rendered[0]?.ranges['5-HT']?.max === 80);
    let range = await page.evaluate(() => Atlas3D.rendered[0].ranges['5-HT']);
    assert.deepEqual(range.memberIds, [IDS[0], IDS[2]]);
    assert.equal(range.nFinite, 16, 'the eight outlier pixels are excluded from the pooled raw range');
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().hiddenSectionIds), [IDS[1]]);
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().visibleSectionIds), [IDS[0], IDS[2]]);
    assert.equal(await page.locator('#section-name').innerText(), 'Cor_1_2', 'checkbox interaction does not change selection');
    sameView(await page.evaluate(() => Atlas3D.renderer.getView()), view);
    await page.locator('#value-mode').selectOption('normalized');
    await page.waitForFunction(() => Atlas3D.rendered[0]?.ranges['5-HT']?.mode === 'normalized' && Atlas3D.rendered[0].ranges['5-HT'].max === 40);
    range = await page.evaluate(() => Atlas3D.rendered[0].ranges['5-HT']);
    assert.deepEqual(range.memberIds, [IDS[0]], 'the skipped section must not pool raw measurements as corrected');
    assert.equal(range.nFinite, 8);
    assert.equal(await page.evaluate(() => Atlas3D.rendered[2].status.code), 'UNAVAILABLE');
    await outlier.check();
    await page.waitForFunction(() => Atlas3D.rendered[0]?.ranges['5-HT']?.max === 40000);
    assert.deepEqual(await page.evaluate(() => Atlas3D.rendered[0].ranges['5-HT'].memberIds), IDS.slice(0, 2));
    await page.locator('#value-mode').selectOption('raw');
    await page.waitForFunction(() => Atlas3D.rendered[0]?.ranges['5-HT']?.mode === 'raw' && Atlas3D.rendered[0].ranges['5-HT'].max === 80000);
    assert.deepEqual(await page.evaluate(() => Atlas3D.rendered[0].ranges['5-HT'].memberIds), IDS,
      're-enabling a section invalidates the previously cached raw range as well');
    assert.deepEqual(await page.evaluate(() => Atlas3D.sections.map(section => ({
      id: section.id, zIndex: section.zIndex,
      channels: Object.fromEntries(Object.entries(section.channels).map(([key, channel]) => [key, {
        raw: Array.from(channel.raw), normalized: channel.normalized && Array.from(channel.normalized)
      }]))
    }))), valuesBefore, 'visibility and recoloring preserve corrected arrays and ordinal positions');
    assert.deepEqual(await rawBits(page), before);
    assert.deepEqual(await page.evaluate(() => ProjectStorage.listProjects()), stored);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('a hidden section remains inspectable and its OFF state survives HE changes, cutoffs, reload and detail navigation', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); await seedReferenceImages(page);
    const before = await rawBits(page), stored = await page.evaluate(() => ProjectStorage.listProjects());
    await page.goto(h.baseURL + '/stack3d/index.html?project=stack-second');
    await ready(page, 3);
    await page.waitForFunction(() => Atlas3D.renderer.getStats().heVisibleCount === 0);
    const view = await page.evaluate(() => {
      const view = Atlas3D.renderer.getView(); view.position[0] += 0.3; view.zoom = 1.2;
      Atlas3D.renderer.setView(view); return Atlas3D.renderer.getView();
    });
    const checkbox = page.locator('input.section-visible[data-section-id="stack-second"]');
    await checkbox.uncheck();
    await page.waitForFunction(() => Atlas3D.renderer.getStats().heVisibleSectionIds.length === 0);
    assert.equal(await page.locator('#section-name').innerText(), 'Cor_1_10');
    assert.deepEqual(await page.evaluate(() => Atlas3D.hiddenSectionIds), [IDS[1]]);
    await page.locator('[data-preview="HE_Stain"]').click();
    await page.waitForFunction(() => document.getElementById('section-preview').dataset.previewKind === 'HE_Stain' && document.querySelector('#section-preview canvas')?.width >= 128);
    await page.waitForFunction(() => Atlas3D.renderer.getStats().heVisibleCount === 0);
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().heVisibleSectionIds), []);
    await page.locator('#open-section').click();
    await page.waitForURL('**/viewer/index.html?project=stack-second&from=stack3d');
    await page.waitForFunction(() => viewerReady);
    assert.equal(await page.locator('#atlas-title').innerText(), 'Cor_1_10');
    await page.locator('#back-stack3d').click();
    await ready(page, 3);
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(await page.locator('#section-name').innerText(), 'Cor_1_10');
    sameView(await page.evaluate(() => Atlas3D.renderer.getView()), view);
    const rangeBefore = await page.evaluate(() => Atlas3D.rendered[0].ranges);
    await setSlider(page, '#section-slider', 1);
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().visibleSectionIds), [IDS[0]],
      'the reverse cutoff and individual OFF state are both applied');
    assert.deepEqual(await page.evaluate(() => Atlas3D.rendered[0].ranges), rangeBefore, 'scrubbing does not recalculate the common scale');
    await page.locator('#show-all').click();
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().range), [0, 2]);
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().visibleSectionIds), [IDS[0], IDS[2]]);
    assert.equal(await checkbox.isChecked(), false, 'resetting the ordinal range does not re-enable an excluded outlier');
    assert.deepEqual(await page.evaluate(() => Atlas3D.rendered[0].ranges), rangeBefore, 'cutoffs do not change the common scale');
    await page.locator('.section-row[data-index="1"] .section-select').click();
    assert.equal(await checkbox.isChecked(), false, 'selecting a hidden section does not switch its 3D visibility ON');
    assert.equal(await page.locator('#section-name').innerText(), 'Cor_1_10');
    await page.reload();
    await ready(page, 3);
    assert.equal(await checkbox.isChecked(), false);
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem('atlas-stack3d-view-v1')).hiddenSectionIds), [IDS[1]]);
    sameView(await page.evaluate(() => Atlas3D.renderer.getView()), view);
    await page.locator('#enable-all-sections').click();
    await page.waitForFunction(() => Atlas3D.renderer.getStats().heVisibleCount === 0 && Atlas3D.hiddenSectionIds.length === 0);
    assert.equal(await checkbox.isChecked(), true);
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().enabledSectionIds), IDS);
    assert.deepEqual(await rawBits(page), before);
    assert.deepEqual(await page.evaluate(() => ProjectStorage.listProjects()), stored);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('all sections can be OFF, rapid toggles use the final state, and an enabled skipped section has no corrected raw fallback', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); await seedReferenceImages(page);
    const before = await rawBits(page), stored = await page.evaluate(() => ProjectStorage.listProjects());
    await page.goto(h.baseURL + '/stack3d/index.html?project=stack-second');
    await ready(page, 3);
    await page.locator('#value-mode').selectOption('normalized');
    await page.waitForFunction(() => Atlas3D.rendered[0]?.ranges['5-HT']?.mode === 'normalized');
    for (const id of IDS) await page.locator('input.section-visible[data-section-id="' + id + '"]').uncheck();
    await page.waitForFunction(() => Atlas3D.renderer.getStats().enabledSectionIds.length === 0 && Atlas3D.rendered.every(result => result.status.visiblePixels === 0));
    let stats = await page.evaluate(() => Atlas3D.renderer.getStats());
    assert.equal(stats.visibleCount, 0); assert.equal(stats.heVisibleCount, 0);
    assert.deepEqual(stats.hiddenSectionIds, IDS);
    assert.deepEqual(stats.visibleSectionIds, []);
    assert.equal(await page.locator('#visibility-status').isVisible(), true);
    assert.match(await page.locator('#render-state').innerText(), /ON\s+0\s*\/\s*3/);
    assert.match(await page.locator('#visibility-status').innerText(), /ON|OFF|チェック/);
    assert.equal(await page.evaluate(() => Atlas3D.rendered.every(result => {
      const pixels = result.canvas.getContext('2d').getImageData(0, 0, result.canvas.width, result.canvas.height).data;
      return Array.from(pixels).every((value, index) => index % 4 !== 3 || value === 0);
    })), true, 'all-OFF cannot retain stale colored MSI textures');
    await page.locator('[data-preview="HE_Stain"]').click();
    await page.waitForFunction(() => document.getElementById('section-preview').dataset.previewKind === 'HE_Stain' && document.querySelector('#section-preview canvas')?.width >= 128);
    await page.locator('[data-preview="ATLAS"]').click();
    await page.waitForFunction(() => document.getElementById('section-preview').dataset.previewKind === 'ATLAS' && document.querySelector('#section-preview img')?.naturalWidth === 256);
    await page.locator('[data-preview="MSI"]').click();
    await page.waitForFunction(() => /OFF|ON/.test(document.getElementById('section-preview').textContent));
    // Several changes in one event-loop turn must leave only the final enabled
    // section in both the common range and the visible MSI/HE layers.
    await page.evaluate(() => {
      for (const checked of [true, false, true, false, true]) {
        const element = document.querySelector('input.section-visible[data-section-id="stack-second"]');
        element.checked = checked; element.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await page.waitForFunction(() => Atlas3D.rendered[1]?.ranges['5-HT']?.memberIds.join() === 'stack-second' && Atlas3D.renderer.getStats().visibleSectionIds.join() === 'stack-second');
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().heVisibleSectionIds), []);
    assert.equal(await page.evaluate(() => Atlas3D.rendered[1].ranges['5-HT'].max), 40);
    await page.locator('input.section-visible[data-section-id="stack-skipped"]').check();
    await page.locator('input.section-visible[data-section-id="stack-second"]').uncheck();
    await page.waitForFunction(() => Atlas3D.rendered[0]?.ranges['5-HT']?.nFinite === 0 && Atlas3D.rendered[2]?.status.code === 'UNAVAILABLE');
    stats = await page.evaluate(() => Atlas3D.renderer.getStats());
    assert.deepEqual(stats.enabledSectionIds, [IDS[2]]);
    assert.equal(stats.heVisibleCount, 0);
    assert.deepEqual(await page.evaluate(() => Atlas3D.rendered[0].ranges['5-HT'].memberIds), []);
    assert.equal(await page.evaluate(() => Atlas3D.rendered[2].status.visiblePixels), 0, 'skipped normalized values remain unavailable after visibility changes');
    assert.equal(await page.evaluate(() => {
      const canvas = Atlas3D.rendered[2].canvas;
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return Array.from(pixels).every((value, index) => index % 4 !== 3 || value === 0);
    }), true, 'the enabled skipped section has a transparent MSI texture, not a raw fallback');
    await page.waitForFunction(() => /ONの切片に表示できる値/.test(document.getElementById('section-preview').textContent));
    assert.equal(await page.locator('#section-preview canvas').count(), 0,
      'a hidden selected section cannot be previewed with an invented common range when every enabled section is unavailable');
    await page.locator('#enable-all-sections').click();
    await page.waitForFunction(() => Atlas3D.hiddenSectionIds.length === 0 && Atlas3D.rendered[0]?.ranges['5-HT']?.nFinite === 16);
    assert.deepEqual(await page.evaluate(() => Atlas3D.rendered[0].ranges['5-HT'].memberIds), IDS.slice(0, 2));
    assert.equal(await page.evaluate(() => Atlas3D.rendered[2].status.code), 'UNAVAILABLE');
    assert.deepEqual(await rawBits(page), before);
    assert.deepEqual(await page.evaluate(() => ProjectStorage.listProjects()), stored);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('HE stays in the detail preview with native image detail and alignment', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); await seedReferenceImages(page);
    const before = await rawBits(page);
    const storedBefore = await page.evaluate(() => ProjectStorage.listProjects());
    await page.goto(h.baseURL + '/stack3d/index.html?project=stack-second');
    await ready(page, 3);
    assert.equal(await page.locator('#he-visible').count(), 0);
    assert.equal(await page.evaluate(() => Atlas3D.renderer.getStats().heTextureCount), 0);
    const plane = await page.evaluate(async () => {
      const section = Atlas3D.sections.find(s => s.id === 'stack-second');
      const canvas = await Stack3D.renderHePlane(section, { maxSize: 512 });
      const ctx = canvas.getContext('2d');
      const sample = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
      const result = { width: canvas.width, height: canvas.height, blank: sample(4, 8), red: sample(32, 8),
        blue: sample(32, 48), stripe: sample(64, 8), besideStripe: sample(65, 8) };
      canvas.width = 0; canvas.height = 0; return result;
    });
    assert.equal(plane.width, 128); assert.equal(plane.height, 64);
    assert.equal(plane.blank[3], 0, 'saved affine translation leaves the expected transparent margin');
    assert.deepEqual(plane.red, [255, 0, 0, 255]); assert.deepEqual(plane.blue, [0, 0, 255, 255]);
    assert.deepEqual(plane.stripe, [0, 255, 0, 255]); assert.deepEqual(plane.besideStripe, [255, 0, 0, 255]);
    // Hold one HE preview in flight, then scrub through several sections.
    // Intermediate requests must not build an unbounded image-decode queue.
    await page.locator('[data-preview="MSI"]').click();
    await page.evaluate(() => Atlas3D.selectSection(0));
    await page.waitForFunction(() => document.getElementById('section-preview').dataset.previewKind === 'MSI');
    await page.evaluate(() => {
      const state = window.__previewQueueTest = { calls: [], active: 0, maximum: 0, original: Stack3D.renderHePreview };
      const gate = new Promise(resolve => { state.release = resolve; });
      Stack3D.renderHePreview = async (...args) => {
        state.calls.push(args[0].id); state.active++; state.maximum = Math.max(state.maximum, state.active);
        try { if (state.calls.length === 1) await gate; return await state.original(...args); }
        finally { state.active--; }
      };
    });
    await page.locator('[data-preview="HE_Stain"]').click();
    await page.waitForFunction(() => window.__previewQueueTest.calls.length === 1);
    await page.evaluate(() => { Atlas3D.selectSection(1); Atlas3D.selectSection(2); Atlas3D.selectSection(0); Atlas3D.selectSection(1); });
    assert.deepEqual(await page.evaluate(() => window.__previewQueueTest.calls), [IDS[0]]);
    await page.evaluate(() => window.__previewQueueTest.release());
    await page.waitForFunction(() => window.__previewQueueTest.calls.length === 2 && window.__previewQueueTest.active === 0 &&
      document.getElementById('section-preview').dataset.previewKind === 'HE_Stain');
    const queue = await page.evaluate(() => {
      const state = window.__previewQueueTest; Stack3D.renderHePreview = state.original;
      return { calls: state.calls, maximum: state.maximum, size: Array.from(document.querySelectorAll('#section-preview canvas'), c => [c.width, c.height]) };
    });
    assert.deepEqual(queue.calls, IDS.slice(0, 2)); assert.equal(queue.maximum, 1);
    assert.deepEqual(queue.size, [[128, 128]], 'the final requested section replaces the obsolete preview');
    for (const kind of ['MSI', 'HE_Stain']) {
      await page.locator('[data-preview="' + kind + '"]').click();
      await page.waitForFunction(kind => {
        const host = document.getElementById('section-preview'), canvas = host.querySelector('canvas');
        return host.dataset.previewKind === kind && canvas && canvas.width > 4 && canvas.height > 2;
      }, kind);
      await page.locator('#enlarge-preview').click();
      await page.waitForFunction(kind => document.getElementById('preview-dialog').open &&
        document.getElementById('detail-preview').dataset.previewKind === kind && document.querySelector('#detail-preview canvas')?.width > 4, kind);
      if (kind === 'HE_Stain') {
        const size = await page.locator('#detail-preview canvas').evaluate(canvas => [canvas.width, canvas.height]);
        assert.ok(size[0] >= 128 && size[1] >= 64, 'enlarged HE retains source-level sampling');
      }
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#preview-dialog').isVisible(), false);
    }
    await page.locator('[data-preview="ATLAS"]').click();
    await page.waitForFunction(() => document.getElementById('section-preview').dataset.previewKind === 'ATLAS' && document.querySelector('#section-preview img')?.naturalWidth === 256);
    await page.locator('#enlarge-preview').click();
    await page.waitForFunction(() => document.getElementById('detail-preview').dataset.previewKind === 'ATLAS' && document.querySelector('#detail-preview img')?.naturalWidth === 256);
    assert.equal(await page.locator('#detail-preview img').evaluate(image => image.naturalHeight), 128);
    await page.keyboard.press('Escape');
    await page.locator('#show-all').click();
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().heVisibleSectionIds), []);
    assert.deepEqual(await rawBits(page), before);
    assert.deepEqual(await page.evaluate(() => ProjectStorage.listProjects()), storedBefore, 'display controls and previews preserve all saved data and affine matrices');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('MSI and HE previews draw saved ROI landmarks without changing scientific textures, image detail or data', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); await seedReferenceImages(page);
    await page.evaluate(async () => {
      const p = await ProjectStorage.getProject('stack-second');
      // Saved HE and MSI rotations can legitimately differ. ROI coordinates
      // are raw MSI coordinates and must follow the MSI rotation in both tabs.
      p.rotation = { all: 180, msi: 90, he: 0 };
      p.roi = { roi_names: { landmark: 'Two separate landmarks' },
        palette: { landmark: [0, 255, 255, 255], hidden: [255, 0, 255, 255], malformed: [0, 255, 0, 255] },
        roi_show_flags: { landmark: true, hidden: false, malformed: true },
        roi_items: {
          landmark: [{ poly_msi: [[1, .25], [2, .25], [2, .75], [1, .75]] },
            { poly_msi: [[2.5, 1.25], [3, 1.25], [3, 1.75], [2.5, 1.75]] }],
          hidden: [{ poly_msi: [[.5, .9], [.75, .9], [.75, 1.1], [.5, 1.1]] }],
          malformed: [{ poly_msi: [[0, 0], [NaN, 1], [4, 2]] }]
        } };
      await ProjectStorage.putProject(p);
    });
    const before = await rawBits(page), stored = await page.evaluate(() => ProjectStorage.listProjects());
    await page.goto(h.baseURL + '/stack3d/index.html?project=stack-second');
    await ready(page, 3);
    const result = await page.evaluate(async () => {
      const section = Atlas3D.sections.find(s => s.id === 'stack-second');
      const pixels = canvas => Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data);
      const keep = [], hold = canvas => { keep.push(canvas); return canvas; };
      const opts = { mode: 'raw', rangeMode: 'common', commonRanges: Stack3D.computeCommonRanges(Atlas3D.sections, 'raw'),
        channels: ['DA', 'NE', '5-HT'], previewPixelScale: 32 };
      const plain = Stack3D.renderSection(section, opts), overlay = Stack3D.renderSection(section, { ...opts, roi: true });
      keep.push(plain.canvas, plain.previewCanvas, overlay.canvas, overlay.previewCanvas);
      const he = hold(await Stack3D.renderHePreview(section, { maxSize: 2048 }));
      const heRoi = hold(await Stack3D.renderHePreview(section, { maxSize: 2048, roi: true }));
      const hePlane = hold(await Stack3D.renderHePlane(section, { maxSize: 512 }));
      const justVisible = { ...section, project: { ...section.project, roi: {
        ...section.project.roi, roi_items: { landmark: section.project.roi.roi_items.landmark }
      } } };
      const visibleOnly = hold(await Stack3D.renderHePreview(justVisible, { maxSize: 2048, roi: true }));
      const empty = { ...section, project: { ...section.project, roi: { roi_items: {} } } };
      const absent = hold(await Stack3D.renderHePreview(empty, { maxSize: 2048, roi: true }));
      const unequal = { ...section, umPerPxY: 75 };
      const union = hold(await Stack3D.renderHePreview(unequal, { maxSize: 2048, roi: true }));
      const close = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
      // Hard-coded landmarks follow the saved 90° rotation about the center:
      // raw (1,.5) => (96,32), raw (2.5,1.5) => (32,80).
      const delta = (a, b, x, y) => {
        const ca = a.getContext('2d'), cb = b.getContext('2d'); let peak = 0;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const pa = ca.getImageData(x + dx, y + dy, 1, 1).data, pb = cb.getImageData(x + dx, y + dy, 1, 1).data;
          peak = Math.max(peak, ...Array.from(pa, (v, i) => Math.abs(v - pb[i])));
        }
        return peak;
      };
      const answer = {
        textureUnchanged: close(pixels(plain.canvas), pixels(overlay.canvas)),
        rangesUnchanged: JSON.stringify(plain.ranges) === JSON.stringify(overlay.ranges),
        msiLandmarks: [delta(overlay.previewCanvas, plain.previewCanvas, 96, 32), delta(overlay.previewCanvas, plain.previewCanvas, 32, 80)],
        heLandmarks: [delta(heRoi, he, 96, 32), delta(heRoi, he, 32, 80)],
        wrongRotation: delta(heRoi, he, 32, 32), phantomConnection: delta(heRoi, he, 64, 56),
        heSize: [heRoi.width, heRoi.height], unionSize: [union.width, union.height],
        hiddenAndMalformedIgnored: close(pixels(heRoi), pixels(visibleOnly)), absentUnchanged: close(pixels(he), pixels(absent)),
        // Native HE contains a one-pixel-wide green stripe at x=48, translated
        // by 16 output pixels. It must remain sharp in both HE render paths.
        stripe: Array.from(heRoi.getContext('2d').getImageData(64, 8, 1, 1).data),
        besideStripe: Array.from(heRoi.getContext('2d').getImageData(65, 8, 1, 1).data),
        planeStripe: Array.from(hePlane.getContext('2d').getImageData(64, 8, 1, 1).data)
      };
      for (const canvas of keep) { canvas.width = 0; canvas.height = 0; }
      return answer;
    });
    assert.equal(result.textureUnchanged, true, 'ROI remains out of the scientific 3D texture');
    assert.equal(result.rangesUnchanged, true);
    assert.ok(result.msiLandmarks.every(x => x > 100), 'both separate ROI outlines appear over MSI');
    assert.ok(result.heLandmarks.every(x => x > 100), 'HE uses the saved MSI rotation for ROI');
    assert.equal(result.wrongRotation, 0, 'ROI must not inherit the different HE rotation');
    assert.equal(result.phantomConnection, 0, 'separate ROI polygons must not be joined');
    assert.equal(result.hiddenAndMalformedIgnored, true);
    assert.equal(result.absentUnchanged, true, 'missing ROI does not suppress or change HE');
    assert.deepEqual(result.heSize, [128, 128]);
    assert.deepEqual(result.unionSize, [192, 192], 'different rotated anisotropic bounds retain the whole HE and ROI');
    assert.deepEqual(result.stripe, [0, 255, 0, 255]);
    assert.deepEqual(result.besideStripe, [255, 0, 0, 255]);
    assert.deepEqual(result.planeStripe, [0, 255, 0, 255]);
    await page.locator('[data-preview="HE_Stain"]').click();
    await page.waitForFunction(() => document.getElementById('section-preview').dataset.previewKind === 'HE_Stain');
    await page.locator('#enlarge-preview').click();
    await page.waitForFunction(() => document.getElementById('detail-preview').dataset.previewKind === 'HE_Stain');
    const cyan = await page.locator('#detail-preview canvas').evaluate(canvas => {
      const values = canvas.getContext('2d').getImageData(95, 31, 3, 3).data;
      for (let i = 0; i < values.length; i += 4) if (values[i + 1] > 100 && values[i + 2] > 100) return true;
      return false;
    });
    assert.equal(cyan, true, 'the enlarged HE preview actually enables the ROI overlay');
    await page.keyboard.press('Escape');
    assert.deepEqual(await rawBits(page), before);
    assert.deepEqual(await page.evaluate(() => ProjectStorage.listProjects()), stored);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('optional brain context preserves camera, scientific data and full-stack bounds through cutoffs and detail navigation', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h);
    await page.evaluate(async () => {
      const source = await ProjectStorage.getProject('stack-second');
      for (let i = 1; i <= 9; i++) {
        const p = structuredClone(source);
        p.id = 'brain-context-' + i; p.displayName = 'Cor_2_' + i;
        delete p.updatedAt; delete p.normalization; delete p.normalizationBinding;
        await ProjectStorage.putProject(p);
      }
      // A 12-plane synthetic model with a visible XY extent is useful for CI
      // screenshot review as well as renderer resource and navigation checks.
      for (const p of await ProjectStorage.listProjects()) {
        p.grid.umPerPxX = 2000; p.grid.umPerPxY = 4000;
        await ProjectStorage.putProject(p);
      }
    });
    const before = await rawBits(page), stored = await page.evaluate(() => ProjectStorage.listProjects());
    await page.goto(h.baseURL + '/stack3d/index.html?project=stack-second');
    await ready(page, 12);
    await page.locator('#value-mode').selectOption('raw');
    assert.equal(await page.locator('#brain-visible').isChecked(), false, 'schematic context is opt-in');
    assert.equal(await page.evaluate(() => Atlas3D.renderer.getStats().brainContextRendered), false);
    const view = await page.evaluate(() => Atlas3D.renderer.getView());
    const ranges = await page.evaluate(() => Stack3D.computeCommonRanges(Atlas3D.sections, 'raw'));
    await page.locator('#brain-visible').check();
    await page.waitForFunction(() => Atlas3D.renderer.getStats().brainContextRendered && Atlas3D.renderer.getStats().brainObjectCount > 0);
    assert.equal(await page.locator('#brain-context-note').isVisible(), true);
    assert.match(await page.locator('#brain-context-note').innerText(), /模式図/);
    assert.match(await page.locator('#brain-context-note').innerText(), /位置合わせ|登録|解剖/);
    sameView(await page.evaluate(() => Atlas3D.renderer.getView()), view);
    await setSlider(page, '#brain-opacity', 0.23);
    await page.waitForFunction(() => {
      const stats = Atlas3D.renderer.getStats();
      return stats.gpuGeometries >= 12 + stats.brainObjectCount;
    });
    const baseline = await page.evaluate(() => Atlas3D.renderer.getStats());
    assert.equal(baseline.brainOpacity, 0.23);
    await setSlider(page, '#section-slider', 4);
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getStats().brainModelBounds), baseline.brainModelBounds,
      'the context uses the full stack, so a cutoff cannot shrink the reference brain');
    // Selecting another section uploads its ROI label on the next frame.
    // Measure toggle reuse only after that separate allocation has rendered.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const toggleBaseline = await page.evaluate(() => Atlas3D.renderer.getStats());
    for (let i = 0; i < 3; i++) {
      await page.locator('#brain-visible').uncheck();
      assert.equal(await page.evaluate(() => Atlas3D.renderer.getStats().brainContextRendered), false);
      await page.locator('#brain-visible').check();
      assert.equal(await page.evaluate(() => Atlas3D.renderer.getStats().brainObjectCount), baseline.brainObjectCount);
    }
    const toggled = await page.evaluate(() => Atlas3D.renderer.getStats());
    assert.ok(toggled.gpuGeometries <= toggleBaseline.gpuGeometries, 'toggles reuse geometry');
    assert.ok(toggled.gpuTextures <= toggleBaseline.gpuTextures, 'the illustration allocates no new textures on toggle');
    sameView(await page.evaluate(() => Atlas3D.renderer.getView()), view);
    assert.deepEqual(await page.evaluate(() => Stack3D.computeCommonRanges(Atlas3D.sections, 'raw')), ranges);
    assert.deepEqual(await page.evaluate(() => ProjectStorage.listProjects()), stored, 'context controls do not save model metadata');
    const selected = await page.evaluate(() => Atlas3D.sections[Atlas3D.selected].id);
    await page.locator('#open-section').click();
    await page.waitForURL('**/viewer/index.html?project=' + selected + '&from=stack3d');
    await page.waitForFunction(() => viewerReady);
    await page.locator('#back-stack3d').click();
    await ready(page, 12);
    assert.equal(await page.locator('#brain-visible').isChecked(), true);
    assert.equal(await page.locator('#brain-opacity').inputValue(), '0.23');
    assert.equal(await page.evaluate(() => Atlas3D.renderer.getStats().brainContextRendered), true);
    sameView(await page.evaluate(() => Atlas3D.renderer.getView()), view);
    assert.deepEqual(await rawBits(page), before);
    if (process.env.CI) {
      await page.locator('#show-all').click();
      await setSlider(page, '#spacing', 0.9);
      const previousRender = await page.evaluate(() => {
        const count = Atlas3D.renderer.getStats().renderCount; Atlas3D.renderer.resetView(); return count;
      });
      await page.waitForFunction(count => Atlas3D.renderer.getStats().renderCount > count, previousRender);
      require('node:fs').mkdirSync('test-artifacts', { recursive: true });
      await page.screenshot({ path: 'test-artifacts/stack3d-brain-preview.png' });
    }
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('placement saves preserve a newer ROI, reject conflicting placement or correction changes, and recover after reload', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  page.on('dialog', dialog => dialog.accept());
  try {
    await seed(h);
    const before = await rawBits(page);
    await page.goto(h.baseURL + '/stack3d/index.html?project=stack-first');
    await ready(page, 3);
    await page.locator('#placement-details > summary').click();
    await page.locator('#offset-x').fill('123');
    await page.locator('#offset-x').dispatchEvent('change');
    const other = await h.context.newPage();
    await other.goto(h.baseURL + '/__test_seed');
    const preserved = await other.evaluate(async () => {
      const p = await ProjectStorage.getProject('stack-first');
      p.roi.roi_names.all = 'Updated in detail';
      await ProjectStorage.saveProjectIfUnchanged(p, p.updatedAt);
      return { roi: p.roi, normalization: p.normalization };
    });
    await page.waitForFunction(() => Atlas3D.sourceChanged);
    await page.locator('#save-placement').click();
    await page.waitForFunction(async () => (await ProjectStorage.getProject('stack-first')).stack3d?.offsetXUm === 123);
    let saved = await page.evaluate(() => ProjectStorage.getProject('stack-first'));
    assert.deepEqual(saved.roi, preserved.roi);
    assert.deepEqual(saved.normalization, preserved.normalization);
    assert.deepEqual(saved.stack3d, { schemaVersion: 1, offsetXUm: 123, offsetYUm: 0, rotationDeg: 0 });
    await page.locator('#offset-x').fill('321');
    await page.locator('#offset-y').fill('-250');
    await page.locator('#rotation').fill('12');
    await page.locator('#rotation').dispatchEvent('change');
    const newerPlacement = await other.evaluate(async () => {
      const p = await ProjectStorage.getProject('stack-first');
      p.stack3d = { schemaVersion: 1, offsetXUm: 777, offsetYUm: 800, rotationDeg: 9 };
      await ProjectStorage.saveProjectIfUnchanged(p, p.updatedAt);
      return p.stack3d;
    });
    await page.locator('#save-placement').click();
    await page.waitForFunction(() => /配置を保存できませんでした/.test(document.getElementById('notice').textContent));
    saved = await page.evaluate(() => ProjectStorage.getProject('stack-first'));
    assert.deepEqual(saved.stack3d, newerPlacement, 'same-field conflict preserves the newer placement');
    assert.deepEqual(saved.roi, preserved.roi);
    assert.deepEqual(saved.normalization, preserved.normalization);
    assert.deepEqual(saved.rotation, { all: 94, msi: 0, he: 0 });
    await page.locator('#reload').click();
    await page.waitForFunction(() => window.__stack3dReady && !Atlas3D.sourceChanged &&
      Atlas3D.sections.find(s => s.id === 'stack-first')?.project.stack3d?.offsetXUm === 777);
    await page.locator('#offset-x').fill('321');
    await page.locator('#offset-y').fill('-250');
    await page.locator('#rotation').fill('12');
    await page.locator('#rotation').dispatchEvent('change');
    await page.locator('#save-placement').click();
    await page.waitForFunction(async () => (await ProjectStorage.getProject('stack-first')).stack3d?.offsetXUm === 321);
    saved = await page.evaluate(() => ProjectStorage.getProject('stack-first'));
    assert.deepEqual(saved.stack3d, { schemaVersion: 1, offsetXUm: 321, offsetYUm: -250, rotationDeg: 12 });
    assert.deepEqual(saved.roi, preserved.roi);
    assert.deepEqual(saved.normalization, preserved.normalization);
    await page.locator('#offset-x').fill('444');
    await page.locator('#offset-x').dispatchEvent('change');
    await other.evaluate(async () => {
      const p = await ProjectStorage.getProject('stack-first');
      p.normalization.id = 'newer-detailed-profile';
      await ProjectStorage.saveProjectIfUnchanged(p, p.updatedAt);
    });
    await page.locator('#save-placement').click();
    await page.waitForFunction(() => /配置を保存できませんでした/.test(document.getElementById('notice').textContent));
    saved = await page.evaluate(() => ProjectStorage.getProject('stack-first'));
    assert.equal(saved.normalization.id, 'newer-detailed-profile');
    assert.equal(saved.stack3d.offsetXUm, 321, 'changed correction requires reloading the rasters/evaluation before saving');
    assert.deepEqual(saved.roi, preserved.roi);
    assert.deepEqual(await rawBits(page), before);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
