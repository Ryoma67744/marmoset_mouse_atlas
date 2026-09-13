'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

test('Viewer keeps raw analysis immutable and Otsu changes transactional', { timeout: 90000 }, async () => {
  const harness = await startBrowserHarness();
  const { page, baseURL, errors } = harness;
  page.on('dialog', dialog => dialog.dismiss());
  try {
    const id = await seedViewerProject(page, baseURL, { savedOtsu: true });
    await page.goto(baseURL + '/viewer/index.html?project=' + id);
    await page.waitForSelector('#otsu-confirmation[open]');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'otsu-confirm-no');
    assert.equal(await page.evaluate(() => otsuState.applied), false, 'saved ON must not paint any masked first frame');
    for (const selector of ['#save-png', '#export-zip', '#import-zip']) assert.equal(await page.locator(selector).isDisabled(), true);
    await page.locator('#otsu-confirm-no').click();
    await page.waitForSelector('#otsu-confirmation', { state: 'detached' });
    await page.evaluate(() => displayGraphForRoi('all'));
    const rawBefore = await page.evaluate(() => Array.from(new Uint32Array(valueRasters['MSI_5-HT'].values.buffer)));
    const roiBefore = await page.evaluate(() => calcStats(extractRoiPixels('MSI_5-HT', 'all')));
    assert.ok(roiBefore.n > 0);
    assert.match(await page.locator('#graph-container').innerText(), /CALIBRATION|検量|校正|算出不可/);

    await page.locator('#otsu-toggle').click();
    await page.locator('#otsu-confirm-yes').click();
    await page.waitForFunction(() => otsuState.applied);
    assert.deepEqual(await page.evaluate(() => calcStats(extractRoiPixels('MSI_5-HT', 'all'))), roiBefore);
    const modeBefore = await page.evaluate(() => valueDisplay.mode);
    await page.locator('#value-raw').click();
    await page.locator('#otsu-confirm-no').click();
    assert.equal(await page.evaluate(() => valueDisplay.mode), modeBefore, 'decline retains the entire prior mode');
    assert.equal(await page.locator('#value-normalized').getAttribute('aria-pressed'), 'true');

    // Draft histogram updates must not mutate committed masks, settings, thumbnails, or PNG exports.
    const snapshot = await page.evaluate(() => ({ settings: committedOtsuSettings(), keep: Array.from(otsuState.record.keep), pixels: displayCanvas.toDataURL() }));
    await page.evaluate(() => {
      const canvas = document.getElementById('otsu-hist');
      const box = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: box.right - 1, pointerId: 13, bubbles: true }));
    });
    assert.equal(await page.locator('#export-zip').isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => ({ settings: committedOtsuSettings(), keep: Array.from(otsuState.record.keep), pixels: displayCanvas.toDataURL() })), snapshot);
    await page.evaluate(() => document.getElementById('otsu-hist').dispatchEvent(new PointerEvent('pointercancel', { pointerId: 13, bubbles: true })));
    assert.equal(await page.locator('#otsu-confirmation').count(), 0);
    assert.deepEqual(await page.evaluate(() => committedOtsuSettings()), snapshot.settings);
    await page.evaluate(() => {
      const canvas = document.getElementById('otsu-hist'), box = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: box.right - 1, pointerId: 14, bubbles: true }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 14, bubbles: true }));
    });
    await page.locator('#otsu-confirm-no').click();
    assert.deepEqual(await page.evaluate(() => committedOtsuSettings()), snapshot.settings, 'declined released threshold restores committed settings');

    // All hidden in presentation must still retain numerical ROI values.
    await page.evaluate(() => { window.__allHiddenCommit = requestOtsuCommit({ ...otsuState, manualThreshold: 10000 }, '試験用の全非表示閾値'); });
    await page.locator('#otsu-confirm-yes').click();
    await page.evaluate(() => window.__allHiddenCommit);
    assert.equal(await page.evaluate(() => otsuState.record.nRemoved === otsuState.record.nOriginal), true);
    assert.deepEqual(await page.evaluate(() => calcStats(extractRoiPixels('MSI_5-HT', 'all'))), roiBefore);
    assert.match(await page.locator('#graph-container').innerText(), /Otsu 表示画素 0/);
    await page.locator('#otsu-reset').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => otsuState.manualThreshold), 10000);
    await page.locator('#otsu-reset').click();
    await page.locator('#otsu-confirm-yes').click();
    await page.waitForFunction(() => otsuState.manualThreshold === null);
    await page.locator('#otsu-reset').click();
    assert.equal(await page.locator('#otsu-confirmation').count(), 0, 'unchanged reset is a no-op');

    await page.locator('#value-raw').click();
    await page.locator('#otsu-confirm-yes').click();
    await page.waitForFunction(() => valueDisplay.mode === 'raw');
    assert.equal(await page.evaluate(() => calcStats(extractRoiPixels('MSI_5-HT', 'all')).mean), roiBefore.mean * 2);
    await page.locator('#otsu-toggle').click();
    assert.equal(await page.locator('#otsu-confirmation').count(), 0, 'turning OFF needs no consent');
    await page.locator('#value-normalized').click();
    assert.equal(await page.locator('#otsu-confirmation').count(), 0, 'OFF mode switch needs no consent');
    assert.deepEqual(await page.evaluate(() => Array.from(new Uint32Array(valueRasters['MSI_5-HT'].values.buffer))), rawBefore);
    assert.deepEqual(await page.evaluate(() => calcStats(extractRoiPixels('MSI_5-HT', 'all'))), roiBefore);
    const png = await page.evaluate(() => { const canvas = buildExportCanvas(); return { width: canvas.width, height: canvas.height, imageHeight: displayCanvas.width }; });
    assert.ok(png.height > png.imageHeight, 'PNG annotation must be outside rotated image area');
    await page.locator('#otsu-toggle').click();
    await page.evaluate(() => { viewerContextRevision++; });
    await page.locator('#otsu-confirm-yes').click();
    assert.equal(await page.evaluate(() => otsuState.applied), false, 'outdated dialog cannot authorize a changed project context');
    assert.deepEqual(errors, []);
  } finally { await harness.close(); }
});

test('Viewer distinguishes invalid ratios, missing pixels, and Otsu-unknown pixels', { timeout: 90000 }, async () => {
  const harness = await startBrowserHarness();
  const { page, baseURL, errors } = harness;
  page.on('dialog', dialog => dialog.dismiss());
  try {
    const id = await seedViewerProject(page, baseURL, { id: 'viewer-invalid' });
    await page.evaluate(async id => {
      const p = await ProjectStorage.getProject(id), rasters = {};
      for (const molecule of p.molecules) {
        const values = await ProjectStorage.getValueRaster(molecule.blobId);
        if (molecule.key === 'MSI_D4-5-HT') values[2] = 0;
        if (molecule.key === 'MSI_5-HT') values[7] = NaN;
        if (molecule.key === 'MSI_DA') values[6] = NaN;
        molecule.blobId = await ProjectStorage.putValueRaster(values);
        molecule.stats = MSIRaster.deriveBakeStats(values);
        rasters[molecule.key] = { W: 4, H: 2, values };
      }
      const configured = Normalization.createProfiles([{ project: p, rasters, mapping: p.normalization.mapping }], { ...p.normalization, revision: 2 });
      p.normalization = configured.profiles[0].normalization;
      await ProjectStorage.putProject(p);
    }, id);
    await page.goto(baseURL + '/viewer/index.html?project=' + id);
    await page.waitForFunction(() => normalizationEvaluation && Object.keys(imageSettings).length > 0);
    const pixels = await page.evaluate(() => Array.from(paintDisplayRaster('MSI_5-HT').getContext('2d').getImageData(0, 0, 4, 2).data));
    assert.deepEqual(pixels.slice(2 * 4, 3 * 4), [128, 128, 128, 255], 'low D4 is gray, not an imputed zero');
    assert.equal(pixels[7 * 4 + 3], 0, 'unmeasured numerator is transparent');
    assert.equal(pixels[3], 255, 'real zero is a measured opaque pixel');
    assert.equal(await page.evaluate(() => displayRaster('MSI_DA').values[2]), 1, 'local invalid D4 does not remove DA with a valid section factor');
    await page.locator('#otsu-toggle').click();
    await page.locator('#otsu-confirm-yes').click();
    await page.waitForFunction(() => otsuState.applied);
    assert.equal(await page.evaluate(() => otsuState.record.evaluable[6]), 0);
    assert.equal(await page.evaluate(() => otsuKeepFor('MSI_5-HT')[6]), 1, 'Otsu-unknown pixel must retain its pre-mask display');
    assert.match(await page.locator('#value-display-status').innerText(), /Otsu 判定不可/);
    await page.locator('#otsu-toggle').click();
    await page.evaluate(() => {
      document.getElementById('graph-select-1').value = 'MSI_5-HT';
      document.getElementById('graph-select-2').value = 'MSI_DA';
      document.getElementById('graph-select-3').value = 'MSI_NE';
      displayGraphForRoi('all');
    });
    assert.equal(await page.locator('#graph-container canvas').count(), 3, 'different molecules have separate chart axes');
    const correctedRange = await page.evaluate(() => [imageSettings['MSI_5-HT'].vmin, imageSettings['MSI_5-HT'].vmax]);
    await page.locator('#value-raw').click();
    await page.evaluate(() => setActiveSettingsKey('MSI_5-HT'));
    await page.locator('#layer-settings-strip .vmin-input').fill('1');
    await page.locator('#layer-settings-strip .vmin-input').dispatchEvent('change');
    await page.locator('#layer-settings-strip .vmax-input').fill('100');
    await page.locator('#layer-settings-strip .vmax-input').dispatchEvent('change');
    await page.locator('#value-normalized').click();
    assert.deepEqual(await page.evaluate(() => [imageSettings['MSI_5-HT'].vmin, imageSettings['MSI_5-HT'].vmax]), correctedRange);
    await page.locator('#value-raw').click();
    assert.deepEqual(await page.evaluate(() => [imageSettings['MSI_5-HT'].vmin, imageSettings['MSI_5-HT'].vmax]), [1, 100]);
    assert.deepEqual(errors, []);
  } finally { await harness.close(); }
});

test('Stale Viewer saves cannot overwrite a newer Master profile in the same browser', { timeout: 90000 }, async () => {
  const harness = await startBrowserHarness();
  const { page, context, baseURL, errors } = harness;
  page.on('dialog', dialog => dialog.dismiss());
  try {
    const id = await seedViewerProject(page, baseURL, { id: 'viewer-conflict' });
    await page.goto(baseURL + '/viewer/index.html?project=' + id);
    await page.waitForFunction(() => normalizationEvaluation && Object.keys(imageSettings).length > 0);
    await page.evaluate(() => Promise.all([saveViewerProject(), saveViewerProject()]));
    assert.equal(await page.evaluate(() => viewerSaveConflict), false, 'serialized own writes must not self-conflict');
    const master = await context.newPage();
    await master.goto(baseURL + '/__test_seed');
    await master.evaluate(async id => {
      const newer = await ProjectStorage.getProject(id);
      newer.normalization.revision++;
      newer.masterMarker = 'newer-profile-must-survive';
      await ProjectStorage.putProject(newer);
    }, id);
    await page.evaluate(() => {
      currentProject.viewerMarker = 'stale-autosave';
      queueSaveProject();
    });
    await page.waitForFunction(() => viewerSaveConflict);
    assert.match(await page.locator('#value-display-status').innerText(), /保存を停止しました/);
    const stored = await master.evaluate(id => ProjectStorage.getProject(id), id);
    assert.equal(stored.masterMarker, 'newer-profile-must-survive');
    assert.equal(stored.normalization.revision, 2);
    assert.equal(stored.viewerMarker, undefined);
    const rejected = await page.evaluate(() => saveViewerProject().then(() => false, () => true));
    assert.equal(rejected, true, 'conflict pauses further writes until reload');
    assert.deepEqual(errors, []);
    await master.close();
  } finally { await harness.close(); }
});

test('Viewer reports saved/current folder paths, mixed settings and moved-group unavailability without rewriting the snapshot', { timeout: 90000 }, async () => {
  const harness = await startBrowserHarness();
  const { page, baseURL, errors } = harness;
  page.on('dialog', dialog => dialog.dismiss());
  try {
    const id = await seedViewerProject(page, baseURL, { id: 'viewer-folder-scope' });
    const setup = await page.evaluate(async id => {
      const folderId = await ProjectStorage.ensureFolderPath(['Marmoset', 'Coronal']);
      const folder = await ProjectStorage.getFolder(folderId);
      folder.normalizationGroupId = 'viewer-group';
      await ProjectStorage.putFolder(folder);
      const p = await ProjectStorage.getProject(id), rasters = await Normalization.loadRasters(p, { storage: ProjectStorage });
      p.folderId = folderId;
      p.normalizationBinding = { groupId: 'viewer-group', folderPath: ['Marmoset', 'Coronal'], memberId: p.id };
      const result = Normalization.createProfiles([{ project: p, rasters }], { ...p.normalization, revision: 2,
        scope: { type: 'folder-depth', depth: 2, includeDescendants: true, groupId: 'viewer-group',
          folderPath: ['Marmoset', 'Coronal'], memberIds: [p.id] } });
      p.normalization = result.profiles[0].normalization;
      await ProjectStorage.putProject(p);
      return { folderId, normalization: JSON.stringify(p.normalization) };
    }, id);
    await page.goto(baseURL + '/viewer/index.html?project=' + id);
    await page.waitForFunction(() => normalizationEvaluation && Object.keys(imageSettings).length > 0);
    assert.match(await page.locator('#value-display-status').innerText(), /補正グループ（計算時）：Marmoset \/ Coronal/);
    assert.match(await page.locator('#value-display-status').innerText(), /この補正グループ内の比較用/);
    assert.equal(await page.evaluate(() => viewerScopeAssessment.status), 'CURRENT');
    const ratioBefore = await page.evaluate(() => Array.from(channelResult('MSI_5-HT').values));
    await page.evaluate(async ({ id, folderId }) => {
      const folder = await ProjectStorage.getFolder(folderId);
      folder.name = 'Coronal renamed';
      await ProjectStorage.putFolder(folder);
      const p = await ProjectStorage.getProject(id);
      p.normalizationBinding.folderPath = ['Marmoset', 'Coronal renamed'];
      await ProjectStorage.putProject(p);
    }, { id, folderId: setup.folderId });
    await page.reload();
    await page.waitForFunction(() => normalizationEvaluation && Object.keys(imageSettings).length > 0);
    const status = await page.locator('#value-display-status').innerText();
    assert.match(status, /補正グループ（計算時）：Marmoset \/ Coronal\n/);
    assert.match(status, /現在の補正フォルダー：Marmoset \/ Coronal renamed/);
    assert.deepEqual(await page.evaluate(() => Array.from(channelResult('MSI_5-HT').values)), ratioBefore);
    await page.evaluate(async id => {
      const p = await ProjectStorage.getProject(id), other = structuredClone(p);
      other.id = 'mixed-folder-member';
      other.normalizationBinding.memberId = other.id;
      other.normalization.revision++;
      await ProjectStorage.putProject(other);
    }, id);
    await page.reload();
    await page.waitForFunction(() => viewerScopeAssessment?.status === 'MIXED' && Object.keys(imageSettings).length > 0);
    assert.match(await page.locator('#value-display-status').innerText(), /設定混在／同期未完了/);
    await page.evaluate(async id => {
      const p = await ProjectStorage.getProject(id);
      p.folderId = await ProjectStorage.ensureFolderPath(['Marmoset', 'Sagittal']);
      const folder = await ProjectStorage.getFolder(p.folderId);
      folder.normalizationGroupId = 'different-group';
      await ProjectStorage.putFolder(folder);
      // Simulate an old tab moving the project without updating its binding.
      // The Viewer must use current folder records to stop derived display.
      await ProjectStorage.putProject(p);
    }, id);
    await page.reload();
    await page.waitForFunction(() => normalizationEvaluation && viewerScopeAssessment?.status === 'MOVED' && Object.keys(imageSettings).length > 0);
    assert.match(await page.locator('#value-display-status').innerText(), /所属変更・現在のグループには未適用/);
    assert.equal(await page.evaluate(() => normalizationEvaluation.reasonCodes.includes('GROUP_MEMBERSHIP_CHANGED')), true);
    assert.equal(await page.evaluate(() => Array.from(channelResult('MSI_5-HT').values || []).some(Number.isFinite)), false);
    const persisted = await page.evaluate(id => ProjectStorage.getProject(id), id);
    assert.equal(JSON.stringify(persisted.normalization), setup.normalization);
    assert.equal(persisted.normalizationBinding.groupId, 'viewer-group', 'Viewer membership assessment is read only');
    assert.deepEqual(errors, []);
  } finally { await harness.close(); }
});
