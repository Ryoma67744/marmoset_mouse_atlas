'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

function navigationTest(name, run) {
  test(name, { timeout: 90000 }, async () => {
    const h = await startBrowserHarness();
    h.page.on('dialog', dialog => dialog.accept());
    await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
      contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};',
    }));
    try { await run(h); assert.deepEqual(h.errors, []); } finally { await h.close(); }
  });
}
function mouse(number, overrides = {}) {
  return { id: 'mouse-' + number, number, series: 'navigation-mouse', species: 'mouse', ...overrides };
}
async function seedSections(h, definitions) {
  await seedViewerProject(h.page, h.baseURL, { id: 'navigation-template' });
  await h.page.evaluate(async definitions => {
    const base = await ProjectStorage.getProject('navigation-template');
    for (const item of definitions) {
      const p = structuredClone(base);
      p.id = item.id; delete p.updatedAt;
      p.displayName = item.name || 'Mouse_tissue_1set_' + String(item.number).padStart(2, '0');
      p.plane = item.plane || 'coronal'; p.folderPath = item.folderPath || ['Mouse', 'navigation-mouse'];
      p.rotation = { all: 0, he: 0, msi: 0 };
      p.alignment = {};
      p.roi.roi_names.all = 'ROI belonging to ' + item.id;
      if (!item.legacy) p.atlas = {
        species: item.species, seriesId: item.series, seriesName: item.series,
        specimenId: item.series, sectionNumber: item.number, coordinateMode: 'pixel', displaySpacing: 2,
      };
      else delete p.atlas;
      Object.assign(p, item.fields || {});
      await ProjectStorage.putProject(p);
    }
    await ProjectStorage.deleteProjectRecord('navigation-template');
  }, definitions);
}
async function ready(page, id) {
  await page.waitForFunction(id => typeof currentProject !== 'undefined' && currentProject?.id === id && viewerReady, id);
  await page.waitForFunction(() => /\d/.test(document.getElementById('section-position')?.textContent || ''));
}
async function open(h, id, suffix = '') {
  await h.page.goto(h.baseURL + '/viewer/index.html?project=' + encodeURIComponent(id) + suffix);
  await ready(h.page, id);
}
async function move(h, direction, id) {
  await Promise.all([
    h.page.waitForURL(url => url.searchParams.get('project') === id),
    h.page.locator('#section-' + direction).click(),
  ]);
  await ready(h.page, id);
}
async function saved(page, ids) {
  return page.evaluate(async ids => Promise.all(ids.map(id => ProjectStorage.getProject(id))), ids);
}
async function holdNotesDebounce(page) {
  await page.evaluate(() => {
    const original = window.setTimeout.bind(window);
    window.setTimeout = (fn, delay, ...args) => original(fn, delay === 400 ? 30000 : delay, ...args);
  });
}

navigationTest('Mouse 48-section navigation stays in the same tab and disables both terminal directions', async h => {
  // Deliberately store in reverse order: storage recency must not define order.
  await seedSections(h, Array.from({ length: 48 }, (_, i) => mouse(48 - i)));
  await open(h, 'mouse-1');
  assert.equal(await h.page.locator('#section-previous').isDisabled(), true);
  assert.equal(await h.page.locator('#section-next').isDisabled(), false);
  assert.match(await h.page.locator('#section-position').textContent(), /1\s*\/\s*48/);
  const pages = h.context.pages().length;
  await move(h, 'next', 'mouse-2');
  await move(h, 'previous', 'mouse-1');
  await open(h, 'mouse-47');
  await move(h, 'next', 'mouse-48');
  assert.equal(await h.page.locator('#section-next').isDisabled(), true);
  assert.equal(await h.page.locator('#section-previous').isDisabled(), false);
  assert.match(await h.page.locator('#section-position').textContent(), /48\s*\/\s*48/);
  assert.equal(h.context.pages().length, pages);
});

navigationTest('Missing Mouse numbers are skipped without entering another series or specimen', async h => {
  await seedSections(h, [mouse(12), mouse(3), mouse(1), mouse(2, { id: 'other-series', series: 'other-mouse' }),
    mouse(2, { id: 'other-species', species: 'marmoset' })]);
  await open(h, 'mouse-1');
  await move(h, 'next', 'mouse-3');
  await move(h, 'next', 'mouse-12');
  assert.equal(await h.page.locator('#section-next').isDisabled(), true);
  await move(h, 'previous', 'mouse-3');
});

navigationTest('Legacy Marmoset Cor names follow numerical group and section order', async h => {
  const legacy = (id, name) => ({ id, name, legacy: true, folderPath: ['Marmoset', 'Coronal'] });
  await seedSections(h, [legacy('cor-10-1', 'Cor_10_1'), legacy('cor-2-10', 'Cor_2_10'), legacy('cor-2-2', 'Cor_2_2'),
    mouse(1, { id: 'unrelated-mouse' })]);
  await open(h, 'cor-2-2');
  assert.equal(await h.page.locator('#section-previous').isDisabled(), true);
  await move(h, 'next', 'cor-2-10');
  await move(h, 'next', 'cor-10-1');
  assert.equal(await h.page.locator('#section-next').isDisabled(), true);
});

navigationTest('Molecules and value mode carry temporarily while source preferences and target geometry remain saved unchanged', async h => {
  await seedSections(h, [mouse(1, { fields: { visibleLayers: ['MSI_DA', 'MSI_NE'], valueDisplay: { mode: 'normalized', scale: 'common' } } }),
    mouse(2, { fields: { visibleLayers: ['MSI_5-HT'], valueDisplay: { mode: 'raw', scale: 'individual' },
      rotation: { all: 90, he: 15, msi: 30 },
      alignment: { HE_Stain: { flip_lr: true, flip_ud: false, scale_pct: 110, rotate_deg: 7, offx: 2, offy: -1 } } } })]);
  await open(h, 'mouse-1');
  const before = await saved(h.page, ['mouse-1', 'mouse-2']);
  await move(h, 'next', 'mouse-2');
  assert.deepEqual(await h.page.evaluate(() => checkedLayerKeys().sort()), ['MSI_DA', 'MSI_NE']);
  assert.equal(await h.page.evaluate(() => valueDisplay.mode), 'normalized');
  assert.deepEqual(await h.page.evaluate(() => ({ roi: atlasData.roi, rotation: rotationState, alignment: atlasData.alignment })),
    { roi: before[1].roi, rotation: before[1].rotation, alignment: before[1].alignment });
  assert.deepEqual(await saved(h.page, ['mouse-1', 'mouse-2']), before, 'navigation is not an automatic preference save');
  await h.page.reload(); await ready(h.page, 'mouse-2');
  assert.deepEqual(await saved(h.page, ['mouse-1', 'mouse-2']), before, 'reload must not persist carried preferences either');
});

navigationTest('A note typed immediately before Next is saved to its source before changing sections', async h => {
  await seedSections(h, [mouse(1), mouse(2)]); await open(h, 'mouse-1');
  await holdNotesDebounce(h.page);
  await h.page.locator('#notes-atlas-url').fill('https://example.org/source-section-1');
  assert.equal(await h.page.evaluate(() => !!saveTimer && notesWorkPending()), true);
  await move(h, 'next', 'mouse-2');
  const projects = await saved(h.page, ['mouse-1', 'mouse-2']);
  assert.equal(projects[0].notes.atlasUrl, 'https://example.org/source-section-1');
  assert.equal(projects[1].notes, undefined);
  assert.equal(await h.page.locator('#notes-atlas-url').inputValue(), '');
});

navigationTest('A source save failure retains the current section and unsaved text', async h => {
  await seedSections(h, [mouse(1), mouse(2)]); await open(h, 'mouse-1');
  const before = await saved(h.page, ['mouse-1', 'mouse-2']);
  await holdNotesDebounce(h.page);
  await h.page.evaluate(() => { ProjectStorage.patchProjectFields = async () => { throw new Error('Synthetic local write failure'); }; });
  await h.page.locator('#notes-atlas-url').fill('https://example.org/unsaved-draft');
  await h.page.locator('#section-next').click();
  await h.page.waitForFunction(() => viewerSaveConflict);
  assert.equal(new URL(h.page.url()).searchParams.get('project'), 'mouse-1');
  assert.equal(await h.page.locator('#notes-atlas-url').inputValue(), 'https://example.org/unsaved-draft');
  assert.deepEqual(await saved(h.page, ['mouse-1', 'mouse-2']), before);
  assert.match(await h.page.locator('#section-navigation-status').textContent(), /保存|保持|停止|移動しません/);
});

navigationTest('IME composition, ROI drawing and a mask-confirmation modal each prevent a section change', async h => {
  await seedSections(h, [mouse(1), mouse(2)]); await open(h, 'mouse-1');
  const field = h.page.locator('#notes-atlas-url');
  await field.dispatchEvent('compositionstart');
  await h.page.waitForFunction(() => document.getElementById('section-next').disabled);
  assert.equal(new URL(h.page.url()).searchParams.get('project'), 'mouse-1');
  await field.dispatchEvent('compositionend');
  await h.page.waitForFunction(() => !document.getElementById('section-next').disabled);
  await h.page.waitForFunction(() => !saveTimer && !viewerSaving);
  await h.page.locator('#roi-draw-toggle').click();
  await h.page.waitForFunction(() => drawingMode && document.getElementById('section-next').disabled);
  await h.page.locator('#roi-draw-toggle').click();
  await h.page.waitForFunction(() => !document.getElementById('section-next').disabled);
  await h.page.locator('#otsu-toggle').click();
  await h.page.locator('#otsu-confirmation').waitFor({ state: 'visible' });
  assert.equal(await h.page.locator('#section-next').isDisabled(), true);
  await h.page.locator('#otsu-confirm-no').click();
  await h.page.waitForFunction(() => !document.getElementById('section-next').disabled);
  await move(h, 'next', 'mouse-2');
});

navigationTest('Independent cloud, export, import and PNG work locks cannot release section navigation early', async h => {
  await seedSections(h, [mouse(1), mouse(2)]); await open(h, 'mouse-1');
  // These flags belong to the existing action coordinator. Exercise every
  // cross-feature lock without network calls, downloads or file picker races.
  for (const action of ['cloud', 'export', 'import', 'png']) {
    await h.page.evaluate(action => { viewerActions[action] = true; refreshViewerActionControls(); }, action);
    await h.page.waitForFunction(() => document.getElementById('section-next').disabled);
    assert.equal(await h.page.locator('#section-previous').isDisabled(), true);
    await h.page.evaluate(action => {
      viewerActions[action] = false; viewerActions.png = true; refreshViewerActionControls();
    }, action);
    assert.equal(await h.page.locator('#section-next').isDisabled(), true, 'a second active lock still blocks navigation');
    await h.page.evaluate(() => { viewerActions.png = false; refreshViewerActionControls(); });
    await h.page.waitForFunction(() => !document.getElementById('section-next').disabled);
  }
  assert.equal(new URL(h.page.url()).searchParams.get('project'), 'mouse-1');
  await move(h, 'next', 'mouse-2');
});

navigationTest('Repeated Next clicks make one transition and browser Back/Forward retain stack3d URL flags', async h => {
  await seedSections(h, [mouse(1), mouse(2), mouse(3)]);
  await open(h, 'mouse-1', '&from=stack3d&newtab=1');
  const pages = h.context.pages().length;
  await Promise.all([
    h.page.waitForURL(url => url.searchParams.get('project') === 'mouse-2'),
    h.page.evaluate(() => { const next = document.getElementById('section-next'); next.click(); next.click(); next.click(); }),
  ]);
  await ready(h.page, 'mouse-2');
  assert.equal(new URL(h.page.url()).searchParams.get('from'), 'stack3d');
  assert.equal(new URL(h.page.url()).searchParams.get('newtab'), '1');
  await h.page.goBack(); await ready(h.page, 'mouse-1');
  assert.equal(new URL(h.page.url()).searchParams.get('from'), 'stack3d');
  await h.page.goForward(); await ready(h.page, 'mouse-2');
  assert.equal(new URL(h.page.url()).searchParams.get('newtab'), '1');
  assert.equal(h.context.pages().length, pages);
});
