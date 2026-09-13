'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

async function seedRangeGroup(page, baseURL, id) {
  await seedViewerProject(page, baseURL, { id });
  await page.addScriptTag({ url: baseURL + '/lib/display-range.js' });
  return page.evaluate(async id => {
    const original = await ProjectStorage.getProject(id), entries = [];
    const folderId = await ProjectStorage.ensureFolderPath(['Marmoset', 'Coronal']);
    const folder = await ProjectStorage.getFolder(folderId);
    folder.normalizationGroupId = 'display-range-group';
    await ProjectStorage.putFolder(folder);
    for (let section = 0; section < 2; section++) {
      const project = structuredClone(original);
      project.id = section ? id + '-extreme' : id;
      project.displayName = section ? 'Extreme denominator section' : 'Readable section';
      project.folderId = folderId;
      project.normalizationBinding = { groupId: 'display-range-group', folderPath: ['Marmoset', 'Coronal'], memberId: project.id };
      project.molecules = [];
      delete project.normalization;
      project.otsu = { applied: false };
      const rasters = {};
      const definitions = [
        ['MSI_5-HT', '5-HT', section ? [10, 20, 30, 40, 50, 60, 70, 439.284] : [.327383, 12, 20, 50, 70, 100, 200, 222.131]],
        ['MSI_D4-5-HT', 'D4-5-HT', section ? [100, 100, 100, 100, 100, 100, 100, 1e-6] : [100, 100, 100, 100, 100, 100, 100, 100]],
        ['MSI_DA', 'DA', [1, 2, 3, 4, 5, 6, 7, 8]],
        ['MSI_NE', 'NE', [0, 0, 0, 0, 0, 0, 0, 0]],
      ];
      for (const [key, name, source] of definitions) {
        const values = new Float32Array(source), blobId = await ProjectStorage.putValueRaster(values);
        project.molecules.push({ key, name, blobId, stats: MSIRaster.deriveBakeStats(values) });
        rasters[key] = { W: 4, H: 2, values };
      }
      entries.push({ project, rasters });
    }
    const result = Normalization.createSimpleProfiles(entries, {
      id: 'display-range-profile', revision: 1, mode: 'simple',
      scope: { type: 'folder-depth', depth: 2, includeDescendants: true, groupId: 'display-range-group', folderPath: ['Marmoset', 'Coronal'], memberIds: entries.map(e => e.project.id) },
      qc: { minD4: 0, saturationD4: null, minCoverage: .8, enforceCoverage: false },
      reference: { kind: 'd4_measured', projectIds: entries.map(e => e.project.id), roiNames: [] }, calibration: null,
    });
    if (!result.canSave) throw new Error('Invalid range fixture: ' + result.reasonCodes);
    for (let i = 0; i < entries.length; i++) entries[i].project.normalization = result.profiles[i].normalization;
    const snapshot = DisplayRange.buildGroupSnapshot(entries);
    for (const entry of entries) {
      entry.project.valueDisplay = { mode: 'normalized', scale: 'common', groupRangeSnapshot: snapshot };
      entry.project.layerDisplay = { 'MSI_5-HT': { normalizedRange: [0, 439284000], rawRange: [1, 250], vmin: 0, vmax: 439284000 } };
      await ProjectStorage.putProject(entry.project);
    }
    return { id, fingerprint: entries[0].project.normalization.calculationFingerprint };
  }, id);
}

const rangeOf = (page, key) => page.evaluate(key => [imageSettings[key].vmin, imageSettings[key].vmax], key);
const greens = page => page.evaluate(() => {
  const pixels = paintDisplayRaster('MSI_5-HT').getContext('2d').getImageData(0, 0, 4, 2).data;
  return Array.from({ length: 8 }, (_, i) => pixels[4 * i + 1]);
});

test('MSI range migration restores visible ratios and common/individual never share cached windows', { timeout: 90000 }, async () => {
  const harness = await startBrowserHarness(), { page, baseURL, errors } = harness;
  page.on('dialog', dialog => dialog.dismiss());
  try {
    const { id, fingerprint } = await seedRangeGroup(page, baseURL, 'range-extreme');
    await page.goto(baseURL + '/viewer/index.html?project=' + id);
    await page.waitForFunction(() => viewerReady && imageSettings['MSI_5-HT']?.displayWindow);
    await page.evaluate(() => setActiveSettingsKey('MSI_5-HT'));
    assert.equal(await page.locator('#value-scale').inputValue(), 'individual');
    const auto = await rangeOf(page, 'MSI_5-HT');
    assert.equal(auto[0], 0);
    assert.ok(auto[1] > 2.2 && auto[1] < 2.3);
    assert.ok((await greens(page)).some(v => v > 200));
    assert.match(await page.locator('#value-display-status').innerText(), /旧補正レンジは退避/);
    assert.equal(await page.locator('#value-range-restore').isVisible(), true);
    assert.equal(await page.evaluate(() => Object.keys(viewerChanges()).length), 0, 'view-only migration must not block remote refresh as a local edit');
    const numerical = await page.evaluate(() => ({ roi: calcStats(extractRoiPixels('MSI_5-HT', 'all')), raw: Array.from(valueRasters['MSI_5-HT'].values), corrected: Array.from(channelResult('MSI_5-HT').values) }));
    const da = await rangeOf(page, 'MSI_DA');
    await page.locator('#value-scale').selectOption('common');
    assert.ok((await rangeOf(page, 'MSI_5-HT'))[1] > 4e8);
    assert.ok((await greens(page)).every(v => v === 0), 'small-group P99 deliberately retains its maximum; individual mode must still recover');
    assert.match(await page.locator('#value-display-status').innerText(), /Extreme denominator section/);
    await page.locator('#value-scale').selectOption('individual');
    assert.deepEqual(await rangeOf(page, 'MSI_5-HT'), auto);
    assert.deepEqual(await rangeOf(page, 'MSI_DA'), da, 'active molecule range selection leaves other molecules untouched');
    assert.ok((await greens(page)).some(v => v > 200));
    await page.locator('#value-range-restore').click();
    assert.deepEqual(await rangeOf(page, 'MSI_5-HT'), [0, 439284000]);
    assert.equal(await page.locator('#value-scale').inputValue(), 'manual');
    await page.locator('#layer-settings-strip .range-reset').click();
    assert.deepEqual(await rangeOf(page, 'MSI_5-HT'), auto);
    assert.deepEqual(await page.evaluate(() => ({ roi: calcStats(extractRoiPixels('MSI_5-HT', 'all')), raw: Array.from(valueRasters['MSI_5-HT'].values), corrected: Array.from(channelResult('MSI_5-HT').values) })), numerical);
    assert.equal(await page.evaluate(() => currentProject.normalization.calculationFingerprint), fingerprint);
    assert.deepEqual(errors, []);
  } finally { await harness.close(); }
});

test('Manual windows persist by molecule and value mode, and PNG uses each effective window', { timeout: 90000 }, async () => {
  const harness = await startBrowserHarness(), { page, baseURL, errors } = harness;
  page.on('dialog', dialog => dialog.dismiss());
  try {
    const { id } = await seedRangeGroup(page, baseURL, 'range-manual');
    await page.goto(baseURL + '/viewer/index.html?project=' + id);
    await page.waitForFunction(() => viewerReady);
    await page.evaluate(() => setActiveSettingsKey('MSI_5-HT'));
    const da = await rangeOf(page, 'MSI_DA');
    await page.locator('#layer-settings-strip .vmax-input').fill('1');
    await page.locator('#layer-settings-strip .vmax-input').dispatchEvent('change');
    assert.deepEqual(await rangeOf(page, 'MSI_5-HT'), [0, 1]);
    assert.deepEqual(await rangeOf(page, 'MSI_DA'), da);
    await page.locator('#value-raw').click();
    assert.deepEqual(await rangeOf(page, 'MSI_5-HT'), [1, 250]);
    await page.locator('#layer-settings-strip .vmax-input').fill('150');
    await page.locator('#layer-settings-strip .vmax-input').dispatchEvent('change');
    await page.locator('#value-normalized').click();
    assert.deepEqual(await rangeOf(page, 'MSI_5-HT'), [0, 1]);
    await page.evaluate(() => setActiveSettingsKey('MSI_D4-5-HT'));
    assert.equal(await page.locator('#value-scale option[value="common"]').evaluate(el => el.disabled), true);
    await page.locator('#layer-settings-strip .vmax-input').fill('200');
    await page.locator('#layer-settings-strip .vmax-input').dispatchEvent('change');
    await page.locator('#value-raw').click();
    assert.deepEqual(await rangeOf(page, 'MSI_D4-5-HT'), [0, 200]);
    await page.locator('#value-normalized').click();
    await page.evaluate(async () => { syncProjectFromViewer(); await saveViewerProject(); });
    await page.reload();
    await page.waitForFunction(() => viewerReady);
    await page.evaluate(() => setActiveSettingsKey('MSI_5-HT'));
    assert.equal(await page.locator('#value-scale').inputValue(), 'manual');
    assert.deepEqual(await rangeOf(page, 'MSI_5-HT'), [0, 1]);
    const png = await page.evaluate(() => {
      const labels = [], original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (text, ...args) { labels.push(String(text)); return original.call(this, text, ...args); };
      try { const canvas = buildExportCanvas(); return { labels: labels.join('\n'), height: canvas.height, imageHeight: displayCanvas.height }; }
      finally { CanvasRenderingContext2D.prototype.fillText = original; }
    });
    assert.match(png.labels, /手動.*range \[0, 1\]/);
    assert.ok(png.height > png.imageHeight);
    await page.locator('#value-range-auto-all').click();
    assert.equal(await page.locator('#value-scale').inputValue(), 'individual');
    const zero = await page.evaluate(() => imageSettings.MSI_NE.displayWindow);
    assert.equal(zero.status, 'ALL_ZERO');
    assert.deepEqual([zero.min, zero.max], [0, 1]);
    await page.evaluate(() => setActiveSettingsKey('MSI_NE'));
    await page.locator('#value-raw').click();
    await page.evaluate(() => setActiveSettingsKey('MSI_5-HT'));
    assert.deepEqual(await rangeOf(page, 'MSI_5-HT'), [1, 150], 'all-auto in normalized view must not erase saved raw HT manual settings');
    assert.deepEqual(errors, []);
  } finally { await harness.close(); }
});

test('Sparse corrected signals remain visible, unavailable common ranges are explicit, and source changes invalidate stale manual windows', { timeout: 90000 }, async () => {
  const harness = await startBrowserHarness(), { page, baseURL, errors } = harness;
  page.on('dialog', dialog => dialog.dismiss());
  try {
    const id = await seedViewerProject(page, baseURL, { id: 'range-sparse' });
    await page.goto(baseURL + '/viewer/index.html?project=' + id);
    await page.waitForFunction(() => viewerReady);
    await page.evaluate(() => {
      const raw = new Float32Array(200); raw[199] = 10;
      const derived = new Float64Array(200); derived[199] = .5;
      valueRasters['MSI_5-HT'] = { W: 200, H: 1, values: raw };
      normalizationEvaluation.channels['MSI_5-HT'].values = derived;
      useModeRanges(); setActiveSettingsKey('MSI_5-HT');
    });
    assert.deepEqual(await rangeOf(page, 'MSI_5-HT'), [0, .5]);
    assert.equal(await page.evaluate(() => imageSettings['MSI_5-HT'].displayWindow.status), 'SPARSE_FALLBACK');
    assert.equal(await page.evaluate(() => paintDisplayRaster('MSI_5-HT').getContext('2d').getImageData(199, 0, 1, 1).data[1]), 255);
    await page.locator('#value-scale').selectOption('common');
    assert.equal(await page.evaluate(() => imageSettings['MSI_5-HT'].displayWindow.strategy), 'individual');
    assert.match(await page.locator('#value-display-status').innerText(), /共通範囲を使用できない/);
    await page.locator('#layer-settings-strip .vmax-input').fill('1000');
    await page.locator('#layer-settings-strip .vmax-input').dispatchEvent('change');
    await page.evaluate(() => {
      // A newer saved calculation changes only the identity in this presentation test.
      displayRangeProject.normalization = { ...displayRangeProject.normalization, revision: 2 };
      useModeRanges(); refreshValueDisplayUi();
    });
    assert.deepEqual(await rangeOf(page, 'MSI_5-HT'), [0, .5]);
    assert.match(await page.locator('#value-display-status').innerText(), /補正設定が変わった/);
    await page.evaluate(() => {
      normalizationEvaluation.channels['MSI_5-HT'].values = new Float64Array(200).fill(NaN);
      useModeRanges();
    });
    await page.locator('#layer-settings-strip .vmin-input').fill('');
    await page.locator('#layer-settings-strip .vmin-input').dispatchEvent('change');
    assert.deepEqual(await rangeOf(page, 'MSI_5-HT'), [0, 1], 'blank input with no finite values retains a valid display window');
    assert.deepEqual(errors, []);
  } finally { await harness.close(); }
});
