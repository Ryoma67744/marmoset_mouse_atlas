'use strict';
// Browser regressions are run by GitHub CI through the existing local harness.
// Fixtures are entirely synthetic; the harness blocks external cloud requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');
const IDS = ['stack-first', 'stack-second', 'stack-skipped'];

async function seed(h) {
  for (const id of IDS) await seedViewerProject(h.page, h.baseURL, { id });
  await h.page.evaluate(async ids => {
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
  }, IDS);
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};'
  }));
}

async function ready(page, count) {
  await page.waitForFunction(n => window.__stack3dReady && window.Atlas3D && Atlas3D.sections.length === n, count);
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

function sameView(actual, expected) {
  for (const key of ['position', 'target', 'up']) for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(actual[key][i] - expected[key][i]) < 1e-8, key + '[' + i + '] restored');
  }
  assert.equal(actual.zoom, expected.zoom);
}

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
    await page.locator('#range-mode').selectOption('common');
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
    assert.equal(await page.locator('#range-mode').inputValue(), 'common');
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
    await page.locator('#range-mode').selectOption('common');
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
