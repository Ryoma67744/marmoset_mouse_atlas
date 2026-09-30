'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

async function openViewer(h, id = 'viewer-actions') {
  await seedViewerProject(h.page, h.baseURL, { id });
  await h.page.goto(h.baseURL + '/viewer/index.html?project=' + id);
  await h.page.waitForFunction(id => typeof currentProject !== 'undefined' && currentProject?.id === id && viewerReady, id);
  return id;
}
async function enableSyntheticCloud(page) {
  await page.evaluate(async () => {
    Cloud.configured = () => true;
    localStorage.setItem('marmoset:cloudSession', JSON.stringify({ access_token: 'synthetic', refresh_token: 'synthetic', expires_at: Date.now() + 3600000 }));
    viewerSaving++;
    try {
      const saved = await ProjectStorage.patchProjectFields(currentProject.id, { cloudUpdatedAt: 'synthetic', cloudRev: 1,
        cloudBundlePath: 'synthetic/bundle.zip', cloudStateHash: 'old-hash' }, { expectedUpdatedAt: currentProject.updatedAt });
      currentProject = saved; viewerStoredProject = structuredClone(saved); viewerStoredUpdatedAt = saved.updatedAt;
    } finally { viewerSaving--; }
    window.__saveCalls = 0;
    const gate = new Promise((resolve, reject) => { window.__finishSave = resolve; window.__failSave = reject; });
    ProjectSync.saveState = async project => {
      window.__saveCalls++;
      const sent = structuredClone(project);
      await gate;
      return { ...sent, cloudStateHash: Cloud.hashState(Cloud.stateOf(sent)) };
    };
    ProjectSync.statusOf = () => ({ status: 'saved', remoteWriteSucceeded: true, reason: 'クラウドに保存しました。' });
    refreshCloudSaveState();
  });
}


async function delayRealCloudWrite(page) {
  await page.evaluate(async () => {
    Cloud.configured = () => true;
    localStorage.setItem('marmoset:cloudSession', JSON.stringify({ access_token: 'synthetic', refresh_token: 'synthetic', expires_at: Date.now() + 3600000 }));
    const state = structuredClone(Cloud.stateOf(currentProject));
    window.__remote = { id: currentProject.id, updated_at: 'remote-initial', display_name: currentProject.displayName,
      bundle_path: 'synthetic/bundle.zip', bundle_rev: 1, state, meta: Cloud.metaOf(currentProject) };
    viewerSaving++;
    try {
      const saved = await ProjectStorage.patchProjectFields(currentProject.id, { cloudUpdatedAt: window.__remote.updated_at,
        cloudRev: 1, cloudBundlePath: window.__remote.bundle_path, cloudStateHash: Cloud.hashState(state), cloudDisplayName: currentProject.displayName }, { expectedUpdatedAt: currentProject.updatedAt });
      currentProject = saved; viewerStoredProject = structuredClone(saved); viewerStoredUpdatedAt = saved.updatedAt;
    } finally { viewerSaving--; }
    Cloud.getProject = async () => structuredClone(window.__remote);
    window.__saveCalls = 0;
    const gate = new Promise(resolve => { window.__finishSave = resolve; });
    Cloud.patchRowIfUnchanged = async (id, patch, expected) => {
      if (id !== window.__remote.id || expected !== window.__remote.updated_at) return null;
      window.__saveCalls++; window.__sentPatch = structuredClone(patch); await gate;
      window.__remote = { ...window.__remote, ...patch, updated_at: 'remote-saved' };
      return structuredClone(window.__remote);
    };
    refreshCloudSaveState();
  });
}

for (const writer of ['peer', 'same-viewer']) {
  test('Real cloud acknowledgement preserves ' + writer + ' edits made during the request', { timeout: 60000 }, async () => {
    const h = await startBrowserHarness(); h.page.on('dialog', dialog => dialog.dismiss());
    try {
      const id = await openViewer(h); await delayRealCloudWrite(h.page);
      await h.page.click('#value-raw');
      await h.page.waitForFunction(() => !saveTimer && !viewerSaving);
      await h.page.click('#cloud-save');
      await h.page.waitForFunction(() => window.__saveCalls === 1);
      const before = await h.page.evaluate(() => ({ displayed: atlasData.roi.roi_names.all, baseline: viewerStoredProject.roi.roi_names.all }));
      if (writer === 'peer') {
        const peer = await h.context.newPage(); await peer.goto(h.baseURL + '/__test_seed');
        await peer.evaluate(async id => {
          const p = await ProjectStorage.getProject(id), roi = structuredClone(p.roi); roi.roi_names.all = 'new peer ROI';
          await ProjectStorage.patchProjectFields(id, { roi }, { expectedUpdatedAt: p.updatedAt });
        }, id);
      } else {
        await h.page.evaluate(async () => { atlasData.roi.roi_names.all = 'new own ROI'; persistRoi(); if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; } await saveViewerProject(); });
      }
      await h.page.evaluate(() => window.__finishSave());
      await h.page.waitForFunction(() => !viewerActions.cloud);
      if (writer === 'peer') {
        assert.equal(await h.page.evaluate(() => viewerSaveConflict), true);
        assert.deepEqual(await h.page.evaluate(() => ({ displayed: atlasData.roi.roi_names.all, baseline: viewerStoredProject.roi.roi_names.all })), before);
        assert.match(await h.page.locator('#viewer-action-status').textContent(), /送信した内容.*保存されました.*停止/);
        await h.page.evaluate(() => saveToCloud());
        assert.equal(await h.page.evaluate(() => window.__saveCalls), 1, 'unseen ROI cannot be overwritten by another cloud click');
      } else {
        assert.equal(await h.page.evaluate(() => viewerSaveConflict), false);
        assert.equal(await h.page.locator('#cloud-save').isDisabled(), false);
        assert.match(await h.page.locator('#cloud-save-label').textContent(), /未保存/);
        assert.equal(await h.page.evaluate(() => atlasData.roi.roi_names.all), 'new own ROI');
      }
      assert.equal(await h.page.evaluate(async () => (await ProjectStorage.getProject(currentProject.id)).roi.roi_names.all), writer === 'peer' ? 'new peer ROI' : 'new own ROI');
      assert.equal(await h.page.evaluate(() => window.__remote.state.roi.roi_names.all), before.displayed, 'remote contains only the sent snapshot');
      assert.deepEqual(h.errors, []);
    } finally { await h.close(); }
  });
}

for (const order of ['save-first', 'dialog-first', 'failed-save']) {
  test('Viewer cloud save and Otsu release independent locks: ' + order, { timeout: 60000 }, async () => {
    const h = await startBrowserHarness();
    h.page.on('dialog', dialog => dialog.dismiss());
    try {
      await openViewer(h); await enableSyntheticCloud(h.page);
      await h.page.click('#cloud-save');
      await h.page.waitForFunction(() => window.__saveCalls === 1);
      assert.equal(await h.page.locator('#cloud-save-label').textContent(), '保存中…');
      await h.page.evaluate(() => saveToCloud());
      assert.equal(await h.page.evaluate(() => window.__saveCalls), 1, 'repeated handler invocation cannot send again');
      await h.page.click('#otsu-toggle');
      await h.page.locator('#otsu-confirmation').waitFor({ state: 'visible' });
      if (order === 'dialog-first') {
        await h.page.click('#otsu-confirm-no');
        assert.equal(await h.page.locator('#cloud-save').isDisabled(), true, 'closing dialog cannot unlock active save');
      }
      await h.page.evaluate(order => order === 'failed-save' ? window.__failSave(new Error('synthetic failure')) : window.__finishSave(), order);
      await h.page.waitForFunction(() => !viewerActions.cloud);
      if (order !== 'dialog-first') {
        assert.equal(await h.page.locator('#cloud-save').isDisabled(), true, 'completed save cannot unlock active dialog');
        await h.page.click('#otsu-confirm-no');
      }
      assert.equal(await h.page.locator('#cloud-save').isDisabled(), false);
      await h.page.click('#value-raw');
      await h.page.waitForFunction(() => !saveTimer && !viewerSaving);
      assert.equal(await h.page.locator('#cloud-save').isDisabled(), false);
      assert.match(await h.page.locator('#cloud-save-label').textContent(), /未保存/);
      assert.equal(await h.page.locator('#otsu-toggle').isChecked(), false);
      assert.deepEqual(h.errors, []);
    } finally { await h.close(); }
  });
}

test('Viewer reports session loss and restores save after another tab signs in without dropping edits', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openViewer(h); await enableSyntheticCloud(h.page);
    const before = await h.page.evaluate(() => { currentProject.roi.roi_names.all = 'unsaved draft'; return JSON.stringify(currentProject.roi); });
    await h.page.evaluate(() => Cloud.signOut());
    assert.equal(await h.page.locator('#cloud-save').isVisible(), true);
    assert.equal(await h.page.locator('#cloud-save').isDisabled(), true);
    assert.match(await h.page.locator('#viewer-action-status').textContent(), /再ログイン/);
    assert.equal(await h.page.locator('#viewer-action-status a').getAttribute('target'), '_blank');
    await h.page.evaluate(() => saveToCloud());
    assert.equal(await h.page.evaluate(() => window.__saveCalls), 0);
    const peer = await h.context.newPage(); await peer.goto(h.baseURL + '/__test_seed');
    await peer.evaluate(() => localStorage.setItem('marmoset:cloudSession', JSON.stringify({ access_token: 'new-synthetic', refresh_token: 'synthetic', expires_at: Date.now() + 3600000 })));
    await h.page.waitForFunction(() => !document.getElementById('cloud-save').disabled);
    assert.equal(await h.page.evaluate(() => JSON.stringify(currentProject.roi)), before);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Viewer conflict disables Export visibly while preserving the in-memory ROI draft', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  h.page.on('dialog', dialog => dialog.dismiss());
  try {
    const id = await openViewer(h);
    await h.page.evaluate(() => { currentProject.roi.roi_names.all = 'unsaved Viewer draft'; });
    const peer = await h.context.newPage(); await peer.goto(h.baseURL + '/__test_seed');
    await peer.evaluate(async id => {
      const p = await ProjectStorage.getProject(id), roi = structuredClone(p.roi);
      roi.roi_names.all = 'competing saved name';
      await ProjectStorage.patchProjectFields(id, { roi }, { expectedUpdatedAt: p.updatedAt });
    }, id);
    await h.page.evaluate(() => saveViewerProject().catch(() => {}));
    assert.equal(await h.page.locator('#export-zip').isDisabled(), true);
    assert.match(await h.page.locator('#viewer-action-status').textContent(), /Export.*保持/);
    assert.match(await h.page.locator('#export-zip').getAttribute('title'), /未保存の編集/);
    let downloads = 0; h.page.on('download', () => downloads++);
    await h.page.evaluate(() => exportZip());
    assert.equal(downloads, 0);
    assert.equal(await h.page.evaluate(() => currentProject.roi.roi_names.all), 'unsaved Viewer draft');
    assert.equal(await peer.evaluate(async id => (await ProjectStorage.getProject(id)).roi.roi_names.all, id), 'competing saved name');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('PNG and ZIP preparation keep independent busy locks across Otsu confirmation', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openViewer(h);
    await h.page.evaluate(() => {
      const build = buildExportCanvas;
      buildExportCanvas = () => { const canvas = build(); canvas.toBlob = callback => { window.__finishPng = () => callback(new Blob(['synthetic PNG'])); }; return canvas; };
    });
    await h.page.click('#save-png');
    assert.equal(await h.page.locator('#save-png').isDisabled(), true);
    await h.page.click('#otsu-toggle');
    await h.page.locator('#otsu-confirmation').waitFor({ state: 'visible' });
    await h.page.evaluate(() => window.__finishPng());
    await h.page.waitForFunction(() => !viewerActions.png);
    assert.equal(await h.page.locator('#save-png').isDisabled(), true);
    await h.page.keyboard.press('Escape');
    assert.equal(await h.page.locator('#save-png').isDisabled(), false);
    assert.equal(await h.page.locator('#save-png svg').count(), 1, 'busy labels preserve the icon');

    await h.page.evaluate(() => { ZipIO.exportProject = () => new Promise(resolve => { window.__finishZip = () => resolve(new Blob(['synthetic ZIP'])); }); });
    await h.page.click('#export-zip');
    await h.page.waitForFunction(() => typeof window.__finishZip === 'function');
    await h.page.click('#otsu-toggle');
    await h.page.click('#otsu-confirm-no');
    assert.equal(await h.page.locator('#export-zip').isDisabled(), true, 'closing dialog retains an active export lock');
    await h.page.evaluate(() => window.__finishZip());
    await h.page.waitForFunction(() => !viewerActions.export);
    assert.equal(await h.page.locator('#export-zip').isDisabled(), false);
    assert.equal(await h.page.locator('#export-zip svg').count(), 1);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('MSI rotation shares image, ROI, preview and picking coordinates without changing analysis', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openViewer(h);
    const result = await h.page.evaluate(() => {
      const rawBefore = Object.fromEntries(Object.entries(valueRasters).map(([key, r]) => [key, Array.from(new Uint32Array(r.values.buffer))]));
      const roiBefore = JSON.stringify(atlasData.roi), statsBefore = calcStats(extractRoiPixels('MSI_5-HT', 'all'));
      const expected = (mx, my, angle) => {
        const { w, h } = getMsiRefSize(), W = roiCanvas.width, H = roiCanvas.height;
        const x = my * W / h - W / 2, y = H / 2 - mx * H / w;
        const rad = angle * Math.PI / 180;
        return [W / 2 + x * Math.cos(rad) - y * Math.sin(rad), H / 2 + x * Math.sin(rad) + y * Math.cos(rad)];
      };
      const samples = [];
      for (const angle of [0, 90, -90, 180, 37]) {
        applyRotation(angle, 'msi');
        for (const point of [[0.5, 0.25], [2.7, 1.25], [3.5, 1.75]]) {
          const canvas = msiToCanvas(...point), inverse = canvasToMsi(...canvas);
          samples.push({ expected: expected(...point, angle), actual: canvas, raw: point, inverse });
        }
      }
      // Capture what real image and ROI drawing hand to the browser canvas API.
      const imageTransforms = [], roiPoints = [], originalTransform = displayCtx.transform.bind(displayCtx), originalMove = roiCtx.moveTo.bind(roiCtx);
      displayCtx.transform = (...args) => { imageTransforms.push(args); return originalTransform(...args); };
      roiCtx.moveTo = (...args) => { roiPoints.push(args); return originalMove(...args); };
      renderCompositeImage(); drawAllRois('all');
      const imageAffine = imageTransforms[0], first = atlasData.roi.roi_items.all[0].poly_msi[0];
      const imagePoint = [imageAffine[0] * first[0] + imageAffine[2] * first[1] + imageAffine[4], imageAffine[1] * first[0] + imageAffine[3] * first[1] + imageAffine[5]];
      displayCtx.transform = originalTransform; roiCtx.moveTo = originalMove;
      // Outer CSS rotation and zoom must not be applied a second time to offset coordinates.
      rotationState.all = 23; viewTransform.scale = 1.7; viewTransform.tx = 21; applyViewTransform();
      toggleDrawingMode(true);
      const point = [1.3, 0.8], canvas = msiToCanvas(...point);
      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperties(event, { offsetX: { value: canvas[0] * roiCanvas.offsetWidth / roiCanvas.width }, offsetY: { value: canvas[1] * roiCanvas.offsetHeight / roiCanvas.height } });
      roiCanvas.dispatchEvent(event);
      const picked = drawingVertices[0].slice(); toggleDrawingMode(false);
      return { samples, imagePoint, roiPoint: roiPoints[0], picked, point, rawBefore,
        rawAfter: Object.fromEntries(Object.entries(valueRasters).map(([key, r]) => [key, Array.from(new Uint32Array(r.values.buffer))])),
        roiBefore, roiAfter: JSON.stringify(atlasData.roi), statsBefore, statsAfter: calcStats(extractRoiPixels('MSI_5-HT', 'all')) };
    });
    const close = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-7, `${a} != ${b}`));
    result.samples.forEach(sample => { close(sample.actual, sample.expected); close(sample.inverse, sample.raw); });
    close(result.imagePoint, result.roiPoint); close(result.picked, result.point);
    assert.deepEqual(result.rawAfter, result.rawBefore); assert.equal(result.roiAfter, result.roiBefore); assert.deepEqual(result.statsAfter, result.statsBefore);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Deleting another user ROI keeps the selected stable ROI id and graph', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness(); h.page.on('dialog', dialog => dialog.accept());
  try {
    await openViewer(h);
    const keys = await h.page.evaluate(() => {
      const keys = ['first', 'second'].map(suffix => USER_ROI_PREFIX + suffix);
      for (const key of keys) {
        atlasData.roi.roi_items[key] = structuredClone(atlasData.roi.roi_items.all);
        atlasData.roi.roi_names[key] = key; atlasData.roi.palette[key] = [0, 255, 0, 255];
      }
      populateRoiList(); return keys;
    });
    await h.page.locator(`.roi-item[data-roi-key="${keys[0]}"]`).click();
    const graphBefore = await h.page.locator('#graph-container tr').filter({ hasText: keys[0] }).allTextContents();
    await h.page.locator(`.roi-item[data-roi-key="${keys[1]}"] button`).click();
    assert.equal(await h.page.locator('.roi-item.active').getAttribute('data-roi-key'), keys[0]);
    assert.deepEqual(await h.page.locator('#graph-container tr').filter({ hasText: keys[0] }).allTextContents(), graphBefore);
    await h.page.locator(`.roi-item[data-roi-key="${keys[0]}"] button`).click();
    assert.equal(await h.page.locator('.roi-item.active').getAttribute('data-roi-key'), 'all');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});


test('Cloud acknowledgement of own persisted B preserves a newer pending draft C', { timeout: 60000 }, async () => {
  const h=await startBrowserHarness(); h.page.on('dialog', dialog=>dialog.dismiss());
  try {
    await openViewer(h); await delayRealCloudWrite(h.page);
    await h.page.click('#value-raw'); await h.page.waitForFunction(()=>!saveTimer&&!viewerSaving);
    await h.page.click('#cloud-save'); await h.page.waitForFunction(()=>window.__saveCalls===1);
    await h.page.evaluate(async()=>{
      atlasData.roi.roi_names.all='own persisted B'; persistRoi();
      clearTimeout(saveTimer); saveTimer=0; await saveViewerProject();
      atlasData.roi.roi_names.all='own pending C';
      // Hold the debounce while the response acknowledges B, then release it explicitly.
      const original=window.setTimeout;
      window.setTimeout=(fn,delay,...args)=>original(fn,delay===400?10000:delay,...args);
      try { persistRoi(); } finally { window.setTimeout=original; }
      window.__finishSave();
    });
    await h.page.waitForFunction(()=>!viewerActions.cloud);
    assert.deepEqual(await h.page.evaluate(()=>({conflict:viewerSaveConflict,current:currentProject.roi.roi_names.all,
      displayed:atlasData.roi.roi_names.all,baseline:viewerStoredProject.roi.roi_names.all,pending:!!saveTimer})),
      {conflict:false,current:'own pending C',displayed:'own pending C',baseline:'own persisted B',pending:true});
    assert.equal(await h.page.locator('#cloud-save').isDisabled(),false);
    assert.match(await h.page.locator('#cloud-save-label').textContent(),/未保存/);
    await h.page.evaluate(async()=>{clearTimeout(saveTimer);saveTimer=0;await saveViewerProject();});
    assert.equal(await h.page.evaluate(async()=>(await ProjectStorage.getProject(currentProject.id)).roi.roi_names.all),'own pending C');
    assert.equal(await h.page.evaluate(()=>window.__remote.state.roi.roi_names.all),'All pixels');
    assert.deepEqual(h.errors,[]);
  } finally { await h.close(); }
});

test('Cloud success with unreadable local acknowledgement preserves the screen and blocks stale writes', { timeout: 60000 }, async()=>{
  const h=await startBrowserHarness(); h.page.on('dialog',dialog=>dialog.dismiss());
  try {
    await openViewer(h); await delayRealCloudWrite(h.page);
    await h.page.click('#value-raw'); await h.page.waitForFunction(()=>!saveTimer&&!viewerSaving);
    await h.page.evaluate(()=>{
      const patch=Cloud.patchRowIfUnchanged;
      Cloud.patchRowIfUnchanged=async(...args)=>{
        const row=await patch(...args), get=ProjectStorage.getProject;
        ProjectStorage.getProject=async()=>{ProjectStorage.getProject=get;throw new Error('Synthetic post-success local read failure');};
        return row;
      };
    });
    await h.page.click('#cloud-save'); await h.page.waitForFunction(()=>window.__saveCalls===1);
    const before=await h.page.evaluate(()=>{atlasData.roi.roi_names.all='draft kept on local read failure';currentProject.roi=atlasData.roi;return structuredClone(viewerStoredProject);});
    await h.page.evaluate(()=>window.__finishSave()); await h.page.waitForFunction(()=>!viewerActions.cloud);
    assert.equal(await h.page.evaluate(()=>viewerSaveConflict),true);
    assert.deepEqual(await h.page.evaluate(()=>viewerStoredProject),before,'unknown fallback cannot become the baseline');
    assert.equal(await h.page.evaluate(()=>atlasData.roi.roi_names.all),'draft kept on local read failure');
    assert.equal(await h.page.evaluate(()=>currentProject.roi.roi_names.all),'draft kept on local read failure');
    assert.match(await h.page.locator('#viewer-action-status').textContent(),/クラウドに保存されました.*最新データを確認できません/);
    assert.equal(await h.page.locator('#cloud-save').isDisabled(),true);
    assert.equal(await h.page.locator('#export-zip').isDisabled(),true);
    assert.equal(await h.page.evaluate(()=>window.__remote.state.roi.roi_names.all),'All pixels');
    assert.deepEqual(h.errors,[]);
  } finally { await h.close(); }
});
