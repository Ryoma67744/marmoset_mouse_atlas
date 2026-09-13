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

test('Viewer protects concurrent ROI edits while preserving a newer Master normalization', { timeout: 90000 }, async () => {
  const harness = await startBrowserHarness();
  const { page, context, baseURL, errors } = harness;
  page.on('dialog', dialog => dialog.dismiss());
  try {
    const id = await seedViewerProject(page, baseURL, { id: 'viewer-conflict' });
    await page.goto(baseURL + '/viewer/index.html?project=' + id);
    await page.waitForFunction(() => viewerReady && Object.keys(imageSettings).length > 0);
    await page.evaluate(() => Promise.all([saveViewerProject(), saveViewerProject()]));
    assert.equal(await page.evaluate(() => viewerSaveConflict), false, 'serialized own writes must not self-conflict');
    // Keep a draft ROI in this Viewer while Master changes that same field.
    await page.evaluate(() => { currentProject.roi.roi_names.all = 'unsaved Viewer ROI'; });
    const master = await context.newPage();
    await master.goto(baseURL + '/__test_seed');
    await master.evaluate(async id => {
      const newer = await ProjectStorage.getProject(id);
      newer.normalization.revision++;
      newer.roi.roi_names.all = 'newer Master ROI';
      newer.masterMarker = 'newer-profile-must-survive';
      await ProjectStorage.putProject(newer);
    }, id);
    const rejected = await page.evaluate(() => saveViewerProject().then(() => false, () => true));
    assert.equal(rejected, true, 'two edits of the same ROI cannot overwrite each other');
    assert.equal(await page.evaluate(() => currentProject.roi.roi_names.all), 'unsaved Viewer ROI', 'in-memory ROI is retained on conflict');
    assert.match(await page.locator('#value-display-status').innerText(), /保存を停止しました/);
    const stored = await master.evaluate(id => ProjectStorage.getProject(id), id);
    assert.equal(stored.masterMarker, 'newer-profile-must-survive');
    assert.equal(stored.normalization.revision, 2);
    assert.equal(stored.roi.roi_names.all, 'newer Master ROI');
    assert.deepEqual(errors, []);
    await master.close();
  } finally { await harness.close(); }
});

test('Missing normalization opens in effective raw mode without changing the saved project', { timeout: 90000 }, async () => {
  const harness = await startBrowserHarness();
  const { page, baseURL, errors } = harness;
  page.on('dialog', dialog => dialog.dismiss());
  try {
    const id = await seedViewerProject(page, baseURL, { id: 'viewer-unconfigured' });
    const before = await page.evaluate(async id => {
      const p = await ProjectStorage.getProject(id);
      delete p.normalization;
      await ProjectStorage.putProject(p);
      return JSON.stringify(await ProjectStorage.getProject(id));
    }, id);
    await page.goto(baseURL + '/viewer/index.html?project=' + id);
    await page.waitForFunction(() => viewerReady && Object.keys(imageSettings).length > 0);
    await page.evaluate(() => displayGraphForRoi('all'));
    assert.equal(await page.evaluate(() => valueDisplay.mode), 'raw');
    assert.equal(await page.locator('#value-normalized').isDisabled(), true);
    assert.match(await page.locator('#value-display-status').innerText(), /補正設定なし：生値を表示/);
    assert.doesNotMatch(await page.locator('#graph-container').innerText(), /UNAVAILABLE|補正 coverage|最低有効率|絶対定量/);
    assert.ok(await page.evaluate(() => calcStats(extractRoiPixels('MSI_5-HT', 'all')).mean > 0));
    assert.equal(await page.evaluate(id => ProjectStorage.getProject(id).then(p => JSON.stringify(p)), id), before, 'opening alone must not rewrite valueDisplay or any saved field');
    await page.evaluate(() => changeValueMode('normalized'));
    assert.equal(await page.evaluate(() => valueDisplay.mode), 'raw');
    assert.deepEqual(errors, []);
  } finally { await harness.close(); }
});

test('Open Viewer receives a Master normalization update, and narrow saves retain unrelated updates', { timeout: 90000 }, async () => {
  const harness = await startBrowserHarness();
  const { page, context, baseURL, errors } = harness;
  page.on('dialog', dialog => dialog.dismiss());
  try {
    const id = await seedViewerProject(page, baseURL, { id: 'viewer-profile-refresh' });
    await page.evaluate(async id => {
      const p = await ProjectStorage.getProject(id);
      delete p.normalization;
      await ProjectStorage.putProject(p);
    }, id);
    await page.goto(baseURL + '/viewer/index.html?project=' + id);
    await page.waitForFunction(() => viewerReady && valueDisplay.mode === 'raw');
    const bits = await page.evaluate(() => Array.from(new Uint32Array(valueRasters['MSI_5-HT'].values.buffer)));
    const master = await context.newPage();
    await master.goto(baseURL + '/__test_seed');
    await master.evaluate(async id => {
      const p = await ProjectStorage.getProject(id), rasters = await Normalization.loadRasters(p, {storage:ProjectStorage});
      const result = Normalization.createProfiles([{project:p,rasters,mapping:Normalization.suggestMapping(p.molecules)}], {
        id:'new-master-profile',revision:1,batchId:'synthetic',prepId:'synthetic-prep',quality:'provisional',coordinateMatchConfirmed:true,comparabilityConfirmed:true,
        qc:{minD4:0,saturationD4:1000,minCoverage:0.8},reference:{kind:'whole_tissue',projectIds:[id],roiNames:[]},otsuSourceRoles:['ht','da']
      });
      p.normalization = result.profiles[0].normalization;
      await ProjectStorage.putProject(p);
    }, id);
    await page.waitForFunction(() => currentProject.normalization?.id === 'new-master-profile' && valueDisplay.mode === 'normalized');
    assert.equal(await page.locator('#value-normalized').isDisabled(), false);
    assert.ok(await page.evaluate(() => Array.from(displayRaster('MSI_5-HT').values).some(Number.isFinite)));
    assert.deepEqual(await page.evaluate(() => Array.from(new Uint32Array(valueRasters['MSI_5-HT'].values.buffer))), bits);
    // A queued local appearance edit and a newer unrelated Master field are merged narrowly.
    await page.evaluate(() => { currentProject.rotation = {all:90,he:0,msi:0}; });
    await master.evaluate(async id => {
      const p = await ProjectStorage.getProject(id);
      p.displayName = 'Updated in Master';
      p.normalization.revision++;
      await ProjectStorage.putProject(p);
    }, id);
    await page.evaluate(() => saveViewerProject());
    const stored = await page.evaluate(id => ProjectStorage.getProject(id), id);
    assert.equal(stored.normalization.revision, 2);
    assert.equal(stored.displayName, 'Updated in Master');
    assert.equal(stored.rotation.all, 90);
    assert.equal(await page.evaluate(() => viewerSaveConflict), false);
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


test('Viewer checks newer cloud settings at load and preserves a draft started during focus refresh', { timeout: 90000 }, async () => {
  const harness = await startBrowserHarness();
  const { page, context, baseURL, errors } = harness;
  page.on('dialog', dialog => dialog.dismiss());
  try {
    const id = await seedViewerProject(page, baseURL, { id: 'viewer-cloud-refresh' });
    await page.addScriptTag({ url: baseURL + '/lib/cloud.js' });
    const setup = await page.evaluate(async id => {
      const p = await ProjectStorage.getProject(id);
      const profile = structuredClone(p.normalization);
      delete p.normalization;
      p.cloudRev = 1; p.cloudBundlePath = id + '/bundle-v1.zip';
      p.cloudUpdatedAt = '2026-09-13T00:00:00.000Z';
      p.cloudStateHash = Cloud.hashState(Cloud.stateOf(p));
      await ProjectStorage.putProject(p);
      const state = Cloud.stateOf({...p,normalization:profile});
      return { row: {id,display_name:p.displayName,bundle_rev:1,bundle_path:p.cloudBundlePath,
        updated_at:'2026-09-13T01:00:00.000Z',folder_path:[],state}, profile };
    }, id);
    await context.addInitScript(row => { window.__viewerRemoteRow = row; }, setup.row);
    const cloudScript = require('node:fs').readFileSync(require('node:path').join(__dirname, '../lib/cloud.js'), 'utf8');
    await context.route('**/lib/cloud.js', route => route.fulfill({status:200,contentType:'application/javascript',body:cloudScript + `
      Cloud.configured = () => true; Cloud.signedIn = () => true;
      Cloud.getProject = async () => {
        if (window.__pauseRemote) {
          window.__remoteWaiting = true;
          await new Promise(resolve => { window.__releaseRemote = resolve; });
        }
        return structuredClone(window.__viewerRemoteRow);
      };
      Cloud.listProjects = async () => [structuredClone(window.__viewerRemoteRow)];
      Cloud.downloadBundle = async () => { throw new Error('same bundle must not download raw data'); };
      Cloud.patchRowIfUnchanged = async () => { throw new Error('load and focus must not write cloud'); };
    `}));
    await page.goto(baseURL + '/viewer/index.html?project=' + id);
    await page.waitForFunction(() => viewerReady && valueDisplay.mode === 'normalized');
    assert.equal(await page.evaluate(() => currentProject.normalization.id), setup.profile.id);
    assert.equal(await page.evaluate(() => currentProject.cloudUpdatedAt), setup.row.updated_at);
    const before = await page.evaluate(id => ProjectStorage.getProject(id).then(p=>JSON.stringify(p)), id);
    await page.evaluate(() => {
      window.__viewerRemoteRow.updated_at = '2026-09-13T02:00:00.000Z';
      window.__viewerRemoteRow.state.normalization.revision++;
      window.__pauseRemote = true;
      window.__focusRefresh = refreshViewerProject({remote:true});
    });
    await page.waitForFunction(() => window.__remoteWaiting);
    await page.evaluate(() => {
      currentProject.roi.roi_names.all = 'Draft created during request';
      window.__releaseRemote();
    });
    await page.evaluate(() => window.__focusRefresh);
    assert.equal(await page.evaluate(() => currentProject.roi.roi_names.all), 'Draft created during request');
    assert.equal(await page.evaluate(() => currentProject.normalization.revision), setup.profile.revision);
    assert.equal(await page.evaluate(id => ProjectStorage.getProject(id).then(p=>JSON.stringify(p)), id), before, 'request that overlaps a new draft cannot replace its stored baseline');
    assert.match(await page.locator('#value-display-status').innerText(), /未保存の編集を保持/);
    assert.deepEqual(errors, []);
  } finally { await harness.close(); }
});


test('Viewer never adopts an unseen ROI baseline while saving a separate appearance edit', { timeout: 90000 }, async () => {
  const harness = await startBrowserHarness();
  const { page, context, baseURL, errors } = harness;
  page.on('dialog', dialog => dialog.dismiss());
  try {
    const id = await seedViewerProject(page, baseURL, {id:'viewer-unseen-roi'});
    await page.goto(baseURL + '/viewer/index.html?project=' + id);
    await page.waitForFunction(() => viewerReady);
    await page.evaluate(() => {currentProject.rotation = {all:90,he:0,msi:0};});
    const master = await context.newPage();
    await master.goto(baseURL + '/__test_seed');
    await master.evaluate(async id => {
      const p = await ProjectStorage.getProject(id);
      p.roi.roi_items.all[0].poly_msi = [[0,0],[2,0],[2,1],[0,1]];
      await ProjectStorage.putProject(p);
    }, id);
    assert.equal(await page.evaluate(() => saveViewerProject().then(()=>false,()=>true)),true);
    assert.equal(await page.evaluate(() => currentProject.rotation.all),90);
    assert.deepEqual(await page.evaluate(() => atlasData.roi.roi_items.all[0].poly_msi),[[0,0],[4,0],[4,2],[0,2]]);
    assert.deepEqual(await page.evaluate(id => ProjectStorage.getProject(id).then(p=>p.roi.roi_items.all[0].poly_msi),id),[[0,0],[2,0],[2,1],[0,1]]);
    assert.deepEqual(errors,[]);
    await master.close();
  } finally {await harness.close();}
});

async function seedSimpleViewerGroup(page, baseURL, { enforceCoverage = false } = {}) {
  const id = await seedViewerProject(page, baseURL, {id: 'simple-viewer-' + (enforceCoverage ? 'enforced' : 'reported')});
  return page.evaluate(async ({id,enforceCoverage}) => {
    const folderId = await ProjectStorage.ensureFolderPath(['Marmoset', 'Coronal']);
    const folder = await ProjectStorage.getFolder(folderId);
    folder.normalizationGroupId = 'simple-viewer-group';
    await ProjectStorage.putFolder(folder);
    const original = await ProjectStorage.getProject(id);
    const entries = [];
    for (let section = 0; section < 2; section++) {
      const project = structuredClone(original);
      project.id = section ? id + '-reference' : id;
      project.folderId = folderId;
      project.normalizationBinding = {groupId:'simple-viewer-group',folderPath:['Marmoset','Coronal'],memberId:project.id};
      project.molecules = [];
      delete project.normalization;
      project.visibleLayers = ['MSI_Glutamate'];
      project.otsu = {applied:false,sourceKeys:[]};
      const definitions = [
        ['MSI_5-HT','5-HT',[2,4,6,8,10,12,14,16]],
        ['MSI_D4-5-HT','D4-5-HT',section ? [6,6,6,6,6,6,6,6] : [2,0,0,0,2,2,2,2]],
        ['MSI_Glutamate','Glutamate',section ? [4,8,12,16,20,24,28,160] : [0,4,NaN,8,10,12,14,16]],
        ['MSI_GABA','GABA',section ? [200,400,600,800,1000,1200,1400,1600] : [100,200,300,400,500,600,700,800]],
      ];
      const rasters = {};
      for (const [key,name,source] of definitions) {
        const values = new Float32Array(source);
        const blobId = await ProjectStorage.putValueRaster(values);
        project.molecules.push({key,name,blobId,stats:MSIRaster.deriveBakeStats(values)});
        rasters[key] = {W:4,H:2,values};
      }
      entries.push({project,rasters});
    }
    const result = Normalization.createSimpleProfiles(entries, {
      id:'simple-viewer-profile',revision:1,mode:'simple',
      scope:{type:'folder-depth',depth:2,includeDescendants:true,groupId:'simple-viewer-group',folderPath:['Marmoset','Coronal'],memberIds:entries.map(e=>e.project.id)},
      qc:{minD4:0,saturationD4:null,minCoverage:0.8,enforceCoverage},
      reference:{kind:'d4_measured',projectIds:entries.map(e=>e.project.id),roiNames:[]},calibration:null
    });
    for (let i=0;i<entries.length;i++) {
      entries[i].project.normalization = result.profiles[i].normalization;
      await ProjectStorage.putProject(entries[i].project);
    }
    return {id,rawBits:Array.from(new Uint32Array(entries[0].rasters.MSI_Glutamate.values.buffer))};
  }, {id,enforceCoverage});
}

test('Skipped correction keeps a persistent raw notice, ROI values and PNG provenance despite a saved normalized mode', {timeout:90000}, async () => {
  const harness = await startBrowserHarness();
  const {page,baseURL,errors} = harness;
  page.on('dialog',dialog=>dialog.dismiss());
  try {
    const setup = await seedSimpleViewerGroup(page,baseURL);
    await page.evaluate(async id => {
      const project = await ProjectStorage.getProject(id);
      const reference = await ProjectStorage.getProject(id + '-reference');
      project.molecules = project.molecules.filter(m => m.key !== 'MSI_D4-5-HT');
      const entries = [];
      for (const p of [project, reference]) entries.push({project:p,rasters:await Normalization.loadRasters(p,{storage:ProjectStorage})});
      const result = Normalization.createSimpleProfiles(entries,{...project.normalization,revision:2});
      if (!result.canSave || !Normalization.isSkippedProfile(result.profiles[0].normalization)) throw new Error('Skip fixture was not saved');
      for(let i=0;i<entries.length;i++) {
        entries[i].project.normalization=result.profiles[i].normalization;
        // Imported/older display preferences must never relabel skipped raw data.
        entries[i].project.valueDisplay={mode:'normalized',scale:'common'};
        await ProjectStorage.putProject(entries[i].project);
      }
    },setup.id);
    await page.goto(baseURL + '/viewer/index.html?project=' + setup.id);
    await page.waitForFunction(()=>viewerReady && imageSettings.MSI_Glutamate);
    assert.equal(await page.locator('#normalization-skipped-notice').isVisible(),true);
    assert.equal(await page.locator('#normalization-skipped-notice').innerText(),'内部標準なし・未補正（生値表示）');
    assert.equal(await page.locator('#value-normalized').isDisabled(),true);
    assert.equal(await page.locator('#value-raw').getAttribute('aria-pressed'),'true');
    const state=await page.evaluate(()=>({mode:valueDisplay.mode,unit:channelUnit('MSI_Glutamate'),values:Array.from(displayRaster('MSI_Glutamate').values),range:[imageSettings.MSI_Glutamate.vmin,imageSettings.MSI_Glutamate.vmax]}));
    assert.equal(state.mode,'raw');
    assert.match(state.unit,/内部標準なし・未補正/);
    assert.deepEqual(state.values,[0,4,NaN,8,10,12,14,16]);
    assert.ok(state.range[1]<=16,'the corrected group range must not be reused for skipped raw data');
    const status=await page.locator('#value-display-status').innerText();
    assert.match(status,/補正をスキップ/);
    assert.doesNotMatch(status,/d4-5-HTを基準にした相対補正|グループ状態：適用済み|切片係数で補正した分子/);
    await page.evaluate(async()=>{
      await changeValueMode('normalized');
      document.getElementById('graph-select-1').value='MSI_Glutamate';
      document.getElementById('graph-select-2').value='none';
      document.getElementById('graph-select-3').value='none';
      displayGraphForRoi('all');
    });
    assert.equal(await page.evaluate(()=>valueDisplay.mode),'raw');
    const cells=await page.locator('#graph-container table tr').nth(1).locator('td').allTextContents();
    assert.ok(Math.abs(Number.parseFloat(cells[1])-64/7)<0.00001,'ROI must show the raw mean');
    assert.match(cells[3],/内部標準なし・未補正（生値表示）/);
    assert.doesNotMatch(await page.locator('#graph-container').innerText(),/絶対定量|検量線/);
    const pngLabels=await page.evaluate(()=>{
      const labels=[], original=CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText=function(text,...args){labels.push(String(text));return original.call(this,text,...args);};
      try {buildExportCanvas();} finally {CanvasRenderingContext2D.prototype.fillText=original;}
      return labels.join('\n');
    });
    assert.match(pngLabels,/内部標準なし・未補正（生値表示）/);
    assert.doesNotMatch(pngLabels,/補正・正規化表示|切片係数で補正した分子/);
    // The same guard must run when a newer Master profile arrives in an open Viewer.
    await page.evaluate(async()=>{
      currentProject.valueDisplay.mode='normalized';
      valueDisplay.mode='normalized';
      await refreshViewerEvaluation();
    });
    assert.equal(await page.evaluate(()=>valueDisplay.mode),'raw');
    assert.equal(await page.locator('#normalization-skipped-notice').isVisible(),true);
    assert.deepEqual(await page.evaluate(()=>Array.from(new Uint32Array(valueRasters.MSI_Glutamate.values.buffer))),setup.rawBits);
    assert.deepEqual(errors,[]);
  } finally {await harness.close();}
});

test('Simple Viewer renders generic corrected molecules with distinct ranges and exports the same image to PNG', {timeout:90000}, async () => {
  const harness = await startBrowserHarness();
  const {page,baseURL,errors} = harness;
  page.on('dialog',dialog=>dialog.dismiss());
  try {
    const setup = await seedSimpleViewerGroup(page,baseURL);
    await page.goto(baseURL + '/viewer/index.html?project=' + setup.id);
    await page.waitForFunction(() => viewerReady && imageSettings.MSI_Glutamate);
    assert.equal(await page.locator('#normalization-skipped-notice').isVisible(),false);
    const view = await page.evaluate(() => ({
      method:channelResult('MSI_Glutamate').method,
      values:Array.from(displayRaster('MSI_Glutamate').values),
      standardValues:Array.from(displayRaster('MSI_D4-5-HT').values),
      unit:channelUnit('MSI_Glutamate'),
      genericRange:[imageSettings.MSI_Glutamate.vmin,imageSettings.MSI_Glutamate.vmax],
      gabaRange:[imageSettings.MSI_GABA.vmin,imageSettings.MSI_GABA.vmax],
      rawBits:Array.from(new Uint32Array(valueRasters.MSI_Glutamate.values.buffer)),
    }));
    assert.equal(view.method,'section_scale');
    assert.deepEqual(view.values,[0,8,NaN,16,20,24,28,32]);
    assert.equal(view.standardValues[0],2,'the selected internal standard remains raw QC');
    assert.doesNotMatch(view.unit,/生信号|補正対象外/);
    assert.equal(view.genericRange[1],32,'the default automatic range uses this image rather than another section');
    assert.ok(view.genericRange[1] < view.gabaRange[1] / 10,'different generic analytes must not share one pooled scale');
    assert.deepEqual(view.rawBits,setup.rawBits);
    await page.evaluate(() => {
      document.getElementById('graph-select-1').value='MSI_Glutamate';
      document.getElementById('graph-select-2').value='none';
      document.getElementById('graph-select-3').value='none';
      displayGraphForRoi('all');
    });
    assert.match(await page.locator('#graph-container table tr').nth(1).innerText(),/18\.2857/,'ROI mean must use scaled generic values');
    assert.doesNotMatch(await page.locator('#graph-container').innerText(),/絶対定量|CALIBRATION_MISSING|検量線が未登録/);
    const png = await page.evaluate(() => {
      rotationState.all=90;
      renderCompositeImage();
      roiCanvas.getContext('2d').clearRect(0,0,roiCanvas.width,roiCanvas.height);
      const labels=[];
      const originalFillText=CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText=function(text,...args){labels.push(String(text));return originalFillText.call(this,text,...args);};
      let exported;
      try {exported=buildExportCanvas();} finally {CanvasRenderingContext2D.prototype.fillText=originalFillText;}
      const x=Math.floor((exported.width-displayCanvas.width)/2);
      const actual=exported.getContext('2d').getImageData(x,0,displayCanvas.width,displayCanvas.height).data;
      const expected=displayCanvas.getContext('2d').getImageData(0,0,displayCanvas.width,displayCanvas.height).data;
      // Export fills the transparent canvas background black, matching the Viewer background.
      let mismatch=0;
      for(let i=0;i<expected.length;i+=4) {
        for(let c=0;c<3;c++) if(actual[i+c]!==Math.round(expected[i+c]*expected[i+3]/255)) mismatch++;
        if(actual[i+3]!==255) mismatch++;
      }
      return {mismatch,labels:labels.join('\n'),height:exported.height,imageHeight:displayCanvas.height};
    });
    assert.equal(png.mismatch,0,'PNG image area must be the displayed corrected composition');
    assert.match(png.labels,/Glutamate.*range/);
    assert.ok(png.height>png.imageHeight,'provenance remains outside tissue pixels');
    await page.locator('#value-raw').click();
    assert.equal(await page.evaluate(()=>displayRaster('MSI_Glutamate').values[1]),4);
    await page.locator('#value-normalized').click();
    assert.equal(await page.evaluate(()=>displayRaster('MSI_Glutamate').values[1]),8);
    assert.deepEqual(await page.evaluate(()=>Array.from(new Uint32Array(valueRasters.MSI_Glutamate.values.buffer))),setup.rawBits);
    assert.deepEqual(errors,[]);
  } finally {await harness.close();}
});

test('Simple Viewer reports partial 5-HT coverage without hiding its mean; explicit threshold still suppresses it', {timeout:90000}, async () => {
  const harness = await startBrowserHarness();
  const {page,baseURL,errors}=harness;
  page.on('dialog',dialog=>dialog.dismiss());
  try {
    for(const enforceCoverage of [false,true]) {
      const setup=await seedSimpleViewerGroup(page,baseURL,{enforceCoverage});
      await page.goto(baseURL+'/viewer/index.html?project='+setup.id);
      await page.waitForFunction(()=>viewerReady && imageSettings['MSI_5-HT']);
      await page.evaluate(()=>{
        document.getElementById('graph-select-1').value='MSI_5-HT';
        document.getElementById('graph-select-2').value='none';
        document.getElementById('graph-select-3').value='none';
        displayGraphForRoi('all');
      });
      const cells=await page.locator('#graph-container table tr').nth(1).locator('td').allTextContents();
      assert.match(cells[2],/5 \/ 8 \/ 8/);
      assert.match(cells[2],/62\.5%/);
      if(enforceCoverage) assert.equal(cells[1],'算出不可');
      else {assert.match(cells[1],/^5\.4 ± /);assert.doesNotMatch(cells[3],/UNAVAILABLE/);}
      assert.doesNotMatch(await page.locator('#graph-container').innerText(),/絶対定量|CALIBRATION_MISSING|検量線が未登録/);
    }
    const legacyId=await seedViewerProject(page,baseURL,{id:'legacy-low-coverage'});
    await page.evaluate(async id=>{
      const project=await ProjectStorage.getProject(id);
      const rasters=await Normalization.loadRasters(project,{storage:ProjectStorage});
      const standard=rasters['MSI_D4-5-HT'];
      standard.values[1]=0;standard.values[2]=0;standard.values[3]=0;
      const molecule=project.molecules.find(m=>m.key==='MSI_D4-5-HT');
      molecule.blobId=await ProjectStorage.putValueRaster(standard.values);
      molecule.stats=MSIRaster.deriveBakeStats(standard.values);
      const recalculated=Normalization.createProfiles([{project,rasters}],{...project.normalization,revision:2});
      project.normalization=recalculated.profiles[0].normalization;
      await ProjectStorage.putProject(project);
    },legacyId);
    await page.goto(baseURL+'/viewer/index.html?project='+legacyId);
    await page.waitForFunction(()=>viewerReady);
    await page.evaluate(()=>{
      document.getElementById('graph-select-1').value='MSI_5-HT';
      document.getElementById('graph-select-2').value='none';
      document.getElementById('graph-select-3').value='none';
      displayGraphForRoi('all');
    });
    assert.equal(await page.locator('#graph-container table tr').nth(1).locator('td').nth(1).innerText(),'算出不可','legacy saved thresholds retain suppression');
    assert.deepEqual(errors,[]);
  } finally {await harness.close();}
});
