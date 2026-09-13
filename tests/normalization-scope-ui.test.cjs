'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {startBrowserHarness, seedViewerProject} = require('./browser-harness.cjs');

async function loadUI(h) {
  await h.page.addScriptTag({url:h.baseURL + '/lib/normalization-scope.js'});
  await h.page.addScriptTag({url:h.baseURL + '/lib/normalization-ui.js'});
}

test('Folder normalization refuses a partial target set from malformed descendant hierarchy', {timeout:60000}, async () => {
  const h = await startBrowserHarness();
  try {
    await h.page.goto(h.baseURL + '/__test_seed');
    await loadUI(h);
    await h.page.evaluate(() => {
      const folders = [
        {id:'marmoset',name:'Marmoset',parentId:null},
        {id:'coronal',name:'Coronal',parentId:'marmoset'},
        {id:'duplicate',name:'Deep',parentId:'coronal'},
        {id:'duplicate',name:'Ambiguous',parentId:'coronal'}
      ];
      const projects = [{id:'valid',displayName:'Valid direct member',folderId:'coronal'},
        {id:'ambiguous',displayName:'Ambiguous descendant',folderId:'duplicate'}];
      window.__scopeUILoads = [];
      NormalizationUI.open({projects,folders,currentFolderId:'coronal',storage:ProjectStorage,
        refreshScope:async () => ({projects,folders}),
        loadProject:async p => { window.__scopeUILoads.push(p.id); return p; }
      });
    });
    assert.equal(await h.page.locator('#normalization-group').inputValue(), 'coronal');
    assert.equal(await h.page.locator('#normalization-load').isDisabled(), true);
    assert.match(await h.page.locator('#normalization-group-targets').innerText(), /全対象を確定できません/);
    assert.equal(await h.page.locator('#normalization-form').count(), 0);
    assert.deepEqual(await h.page.evaluate(() => window.__scopeUILoads), []);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Folder normalization names every failed load and never configures a successful subset', {timeout:60000}, async () => {
  const h = await startBrowserHarness();
  try {
    for (const id of ['scope-load-a','scope-load-b','scope-load-c']) await seedViewerProject(h.page, h.baseURL, {id});
    await loadUI(h);
    await h.page.evaluate(async () => {
      for (const folder of [
        {id:'marmoset',name:'Marmoset',parentId:null},
        {id:'coronal',name:'Coronal',parentId:'marmoset'},
        {id:'deep',name:'Child',parentId:'coronal'},
        {id:'sagittal',name:'Sagittal',parentId:'marmoset'}
      ]) await ProjectStorage.putFolder(folder);
      const byId = {'scope-load-a':'coronal','scope-load-b':'deep','scope-load-c':'sagittal'};
      for (const p of await ProjectStorage.listProjects()) {
        p.folderId = byId[p.id]; p.displayName = p.id;
        delete p.normalization;
        await ProjectStorage.putProject(p);
      }
      window.__scopeUILoads = [];
      const refreshScope = async () => ({projects:await ProjectStorage.listProjects(),folders:await ProjectStorage.listFolders(),currentFolderId:'deep'});
      NormalizationUI.open(Object.assign(await refreshScope(), {storage:ProjectStorage,refreshScope,
        loadProject:async p => {
          window.__scopeUILoads.push(p.id);
          if (p.id === 'scope-load-b') throw new Error('合成データの読み込み失敗');
          return ProjectStorage.getProject(p.id);
        }
      }));
    });
    assert.equal(await h.page.locator('#normalization-group').inputValue(), 'coronal', 'descendant chooses its depth-two ancestor');
    assert.equal(await h.page.locator('[data-group-project]').count(), 2);
    await h.page.locator('#normalization-load').click();
    await h.page.waitForFunction(() => /失敗 1件/.test(document.querySelector('#normalization-status').textContent));
    assert.match(await h.page.locator('#normalization-status').innerText(), /scope-load-b: 合成データの読み込み失敗/);
    assert.equal(await h.page.locator('#normalization-form').count(), 0);
    assert.deepEqual(await h.page.evaluate(() => window.__scopeUILoads), ['scope-load-a','scope-load-b']);
    assert.equal(await h.page.evaluate(async () => (await ProjectStorage.listProjects()).filter(p=>p.normalization).length), 0);
    assert.equal(await h.page.locator('#normalization-load').isEnabled(), true, 'failed group load remains retryable');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Explicit whole-group save repairs a shared group ID without modifying the other folder', {timeout:60000}, async () => {
  const h = await startBrowserHarness(), page = h.page;
  let accept = false;
  page.on('dialog', dialog => accept ? dialog.accept() : dialog.dismiss());
  try {
    for (const id of ['scope-split-a1','scope-split-a2','scope-split-b']) await seedViewerProject(page, h.baseURL, {id});
    await loadUI(h);
    const before = await page.evaluate(async () => {
      for (const folder of [
        {id:'marmoset',name:'Marmoset',parentId:null},
        {id:'coronal',name:'Coronal',parentId:'marmoset',normalizationGroupId:'shared-group'},
        {id:'deep',name:'Child',parentId:'coronal'},
        {id:'sagittal',name:'Sagittal',parentId:'marmoset',normalizationGroupId:'shared-group'}
      ]) await ProjectStorage.putFolder(folder);
      const entries = [];
      for (const p of await ProjectStorage.listProjects()) {
        p.folderId = p.id === 'scope-split-b' ? 'sagittal' : p.id === 'scope-split-a2' ? 'deep' : 'coronal';
        p.displayName = p.id;
        p.normalizationBinding = {groupId:'shared-group',folderPath:['Marmoset',p.id === 'scope-split-b' ? 'Sagittal' : 'Coronal'],memberId:p.id};
        entries.push({project:p,rasters:await Normalization.loadRasters(p,{storage:ProjectStorage})});
      }
      const created = Normalization.createProfiles(entries, {
        id:'shared-profile',revision:1,batchId:'batch',prepId:'prep',quality:'provisional',coordinateMatchConfirmed:true,comparabilityConfirmed:true,
        qc:{minD4:0,saturationD4:1000,minCoverage:0.8},reference:{kind:'whole_tissue',projectIds:['scope-split-a1'],roiNames:[]},
        scope:{type:'folder-depth',depth:2,includeDescendants:true,groupId:'shared-group',folderPath:['Marmoset','Coronal'],memberIds:entries.map(e=>e.project.id).sort()}
      });
      for (const entry of entries) {
        entry.project.normalization = created.profiles.find(p=>p.projectId === entry.project.id).normalization;
        await ProjectStorage.putProject(entry.project);
      }
      const refreshScope = async () => ({projects:await ProjectStorage.listProjects(),folders:await ProjectStorage.listFolders(),currentFolderId:'coronal'});
      const state = await refreshScope();
      NormalizationUI.open(Object.assign(state,{storage:ProjectStorage,refreshScope,loadProject:p=>ProjectStorage.getProject(p.id)}));
      return state;
    });
    assert.match(await page.locator('#normalization-group-targets').innerText(), /独立した新しいグループ/);
    await page.locator('#normalization-load').click();
    await page.locator('#normalization-form').waitFor();
    assert.notEqual(await page.locator('[name=profileId]').inputValue(), 'shared-profile');
    await page.locator('[name=batchId]').fill('confirmed-batch');
    await page.locator('[name=prepId]').fill('confirmed-prep');
    await page.locator('[name=minD4]').fill('0');
    await page.locator('[name=saturationD4]').fill('1000');
    await page.locator('[name=referenceKind]').selectOption('whole_tissue');
    await page.locator('[name=comparability]').check();
    await page.locator('[name=ref_0]').check();
    await page.locator('#normalization-preview').click();
    await page.waitForFunction(() => !document.querySelector('#normalization-save').disabled);
    await page.locator('#normalization-save').click();
    assert.deepEqual(await page.evaluate(() => ProjectStorage.listProjects()), before.projects, 'dismissed confirmation preserves every original profile');
    accept = true;
    await page.locator('#normalization-save').click();
    await page.waitForFunction(() => /2 件をこの PC に保存しました/.test(document.querySelector('#normalization-status').textContent));
    const after = await page.evaluate(async () => ({projects:await ProjectStorage.listProjects(),folders:await ProjectStorage.listFolders()}));
    const newId = after.folders.find(f=>f.id==='coronal').normalizationGroupId;
    assert.notEqual(newId, 'shared-group');
    for (const id of ['scope-split-a1','scope-split-a2']) {
      const project = after.projects.find(p=>p.id===id);
      assert.equal(project.normalization.scope.groupId, newId);
      assert.equal(project.normalizationBinding.groupId, newId);
      assert.deepEqual(project.normalization.scope.memberIds, ['scope-split-a1','scope-split-a2']);
    }
    assert.deepEqual(after.projects.find(p=>p.id==='scope-split-b'), before.projects.find(p=>p.id==='scope-split-b'));
    assert.deepEqual(after.folders.find(f=>f.id==='sagittal'), before.folders.find(f=>f.id==='sagittal'));
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
