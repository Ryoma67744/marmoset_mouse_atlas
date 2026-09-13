'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {startBrowserHarness,seedViewerProject} = require('./browser-harness.cjs');

async function fixture(h,{legacy=false,skip=false,cloud=false}={}) {
  for (const id of ['range-a','range-b']) await seedViewerProject(h.page,h.baseURL,{id});
  await h.page.addScriptTag({url:h.baseURL+'/lib/normalization-ui.js'});
  await h.page.evaluate(async flags=>{
    await ProjectStorage.putFolder({id:'species',name:'Marmoset',parentId:null});
    await ProjectStorage.putFolder({id:'plane',name:'Coronal',parentId:'species',normalizationGroupId:'range-group'});
    await ProjectStorage.putFolder({id:'child',name:'Child',parentId:'plane'});
    const entries=[];
    for (const id of ['range-a','range-b']) {
      const project=await ProjectStorage.getProject(id);
      project.folderId=id==='range-a'?'plane':'child'; project.displayName=id;
      project.normalizationBinding={groupId:'range-group',folderPath:['Marmoset','Coronal'],memberId:id};
      if (flags.skip && id==='range-b') project.molecules=project.molecules.filter(m=>m.key!=='MSI_D4-5-HT');
      const rasters=await Normalization.loadRasters(project,{storage:ProjectStorage});
      const suggestion=Normalization.suggestSimpleMapping(project,rasters);
      entries.push({project,rasters,mapping:Normalization.suggestMapping(project.molecules),simpleMapping:suggestion});
    }
    const config={id:'range-profile',revision:4,mode:'simple',batchId:'batch',prepId:'prep',quality:'provisional',
      coordinateMatchConfirmed:true,comparabilityConfirmed:true,qc:{minD4:0,saturationD4:1000,minCoverage:0.8,enforceCoverage:false},
      reference:{kind:'whole_tissue',projectIds:flags.skip?['range-a']:['range-a','range-b'],roiNames:[]},calibration:null,
      scope:{type:'folder-depth',depth:2,includeDescendants:true,groupId:'range-group',folderPath:['Marmoset','Coronal'],memberIds:['range-a','range-b']},
      otsuSourceRoles:['ht','da'],otsuSourceKeys:{'range-a':['MSI_5-HT'],'range-b':['MSI_5-HT']}};
    const output=flags.legacy?Normalization.createProfiles(entries,config):Normalization.createSimpleProfiles(entries,config);
    for (const entry of entries) {
      const p=entry.project;p.normalization=output.profiles.find(item=>item.projectId===p.id).normalization;
      DisplayRange.prepareProject(p);
      DisplayRange.setManual(p,'MSI_5-HT','normalized',0.1,20);
      DisplayRange.setManual(p,'MSI_5-HT','raw',2,70);
      DisplayRange.setStrategy(p,'MSI_DA','normalized','common');
      p.valueDisplay.mode=flags.skip && p.id==='range-b'?'raw':'normalized';
      p.valueDisplay.customDisplayNote='preserve';
      p.otsu={applied:true,strength:0.4,manualThreshold:5,sourceKeys:['MSI_5-HT']};
      await ProjectStorage.putProject(p);
    }
    window.__rangeCloudAttempts={};window.__rangeCloudPayloads=[];
    window.__openRangeMaster=async()=>{
      const refreshScope=async()=>({projects:await ProjectStorage.listProjects(),folders:await ProjectStorage.listFolders(),currentFolderId:'plane'});
      NormalizationUI.open(Object.assign(await refreshScope(),{storage:ProjectStorage,refreshScope,loadProject:p=>ProjectStorage.getProject(p.id),
        saveCloud:flags.cloud?async p=>{
          window.__rangeCloudPayloads.push(JSON.parse(JSON.stringify(p)));
          const n=window.__rangeCloudAttempts[p.id]=(window.__rangeCloudAttempts[p.id]||0)+1;
          if (p.id==='range-b'&&n===1) throw new Error('synthetic display sync conflict');
        }:undefined}));
    };
    window.__scientificState=async()=>{
      const out={};
      for(const p of await ProjectStorage.listProjects()) {
        const rasters=await Normalization.loadRasters(p,{storage:ProjectStorage}),ev=Normalization.evaluate(p,rasters);
        const corrected={},raw={};
        for(const [key,ch] of Object.entries(ev.channels)) corrected[key]=ch.values?Array.from(new Uint32Array(ch.values.buffer)):null;
        for(const [key,r] of Object.entries(rasters)) raw[key]=Array.from(new Uint32Array(r.values.buffer));
        out[p.id]={normalization:p.normalization,binding:p.normalizationBinding,roi:p.roi,otsu:p.otsu,molecules:p.molecules,corrected,raw};
      }
      return out;
    };
    await window.__openRangeMaster();
  },{legacy,skip,cloud});
  await h.page.locator('#normalization-display-refresh').waitFor();
}
async function refresh(page) {
  await page.locator('#normalization-display-refresh').click();
  await page.waitForFunction(()=>/共通表示レンジを 2 件で更新しました/.test(document.getElementById('normalization-status').textContent));
  await page.waitForFunction(()=>!document.getElementById('normalization-close').disabled);
}

for (const legacy of [false,true]) test('Display-only group refresh preserves '+(legacy?'v2':'v3')+' scientific profiles, Float32 values, ROI and Otsu', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  try {
    await fixture(h,{legacy});
    const before=await page.evaluate(()=>window.__scientificState());
    // Unsaved form changes cannot leak into this independent display operation.
    await page.locator('[name=minD4]').evaluate(el=>{el.value='999999';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.evaluate(()=>{Normalization.createProfiles=Normalization.createSimpleProfiles=()=>{throw new Error('display update must not rebuild profiles');};});
    await refresh(page);
    assert.deepEqual(await page.evaluate(()=>window.__scientificState()),before);
    const saved=await page.evaluate(()=>ProjectStorage.listProjects());
    const first=saved[0].valueDisplay.groupRangeSnapshot;
    assert.deepEqual(first.memberIds,['range-a','range-b']);assert.equal(first.quantile,0.99);
    for(const p of saved) {
      assert.deepEqual(p.valueDisplay.groupRangeSnapshot,first);
      assert.equal(p.valueDisplay.mode,'normalized');assert.equal(p.valueDisplay.customDisplayNote,'preserve');
      assert.equal(p.layerDisplay['MSI_5-HT'].displayRanges.normalized.strategy,'manual');
      assert.deepEqual(p.layerDisplay['MSI_5-HT'].displayRanges.normalized.manual,{min:0.1,max:20});
      assert.equal(p.layerDisplay.MSI_DA.displayRanges.normalized.strategy,'common');
    }
    await refresh(page);
    assert.deepEqual(await page.evaluate(()=>window.__scientificState()),before);
    assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

for (const legacy of [false,true]) test('A new '+(legacy?'detailed':'simple')+' correction defaults each normalized molecule to individual while preserving raw manual ranges and enabling immediate group refresh', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  try {
    await fixture(h,{legacy});
    if (legacy) {
      page.on('dialog',dialog=>dialog.accept());
      await page.locator('[name=comparability]').check();
      await page.locator('#normalization-preview').click();
      await page.waitForFunction(()=>!document.getElementById('normalization-save').disabled);
      await page.locator('#normalization-save').click();
    } else await page.locator('#normalization-simple-apply').click();
    await page.waitForFunction(()=>/2 件をこの PC に保存しました/.test(document.getElementById('normalization-status').textContent));
    await page.waitForFunction(()=>!document.getElementById('normalization-close').disabled);
    const projects=await page.evaluate(()=>ProjectStorage.listProjects());
    for(const p of projects) {
      assert.equal(p.valueDisplay.mode,'normalized');assert.equal(p.valueDisplay.scale,'individual');
      assert.equal(p.normalization.revision,5);assert.equal(p.valueDisplay.rangeVersion,1);
      assert.equal(p.valueDisplay.groupRangeSnapshot.members.every(m=>m.revision===5),true);
      for(const m of p.molecules) assert.equal(p.layerDisplay[m.key].displayRanges.normalized.strategy,'individual');
      assert.deepEqual(p.layerDisplay['MSI_5-HT'].displayRanges.raw.manual,{min:2,max:70});
    }
    const before=await page.evaluate(()=>window.__scientificState());await refresh(page);
    assert.deepEqual(await page.evaluate(()=>window.__scientificState()),before);assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('A skipped section stays in the display inventory but contributes no corrected pixels', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  try {
    await fixture(h,{skip:true});const before=await page.evaluate(()=>window.__scientificState());await refresh(page);
    const p=await page.evaluate(()=>ProjectStorage.getProject('range-b')),snapshot=p.valueDisplay.groupRangeSnapshot;
    assert.equal(p.valueDisplay.mode,'raw');assert.equal(snapshot.members.find(m=>m.memberId==='range-b').skipped,true);
    assert.deepEqual(snapshot.memberIds,['range-a','range-b']);
    for(const range of Object.values(snapshot.ranges)) assert.deepEqual(range.memberIds,['range-a']);
    assert.deepEqual(await page.evaluate(()=>window.__scientificState()),before);assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

for (const legacy of [false,true]) test('Display-only '+(legacy?'detailed':'simple')+' cloud retry survives form edits and resends only failed members with unchanged snapshots', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  try {
    await fixture(h,{cloud:true,legacy});const before=await page.evaluate(()=>window.__scientificState());await refresh(page);
    assert.match(await page.locator('#normalization-status').innerText(),/クラウド同期 1\/2 件/);
    assert.equal(await page.locator('#normalization-display-cloud').isEnabled(),true);
    assert.equal(await page.locator(legacy?'#normalization-cloud':'#normalization-simple-cloud').isDisabled(),true);
    await page.locator('[name=minD4]').evaluate(el=>{el.value='1';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.locator('#normalization-display-cloud').click();
    await page.waitForFunction(()=>/クラウド同期 2\/2 件/.test(document.getElementById('normalization-status').textContent));
    await page.waitForFunction(()=>!document.getElementById('normalization-close').disabled);
    assert.deepEqual(await page.evaluate(()=>window.__rangeCloudAttempts),{'range-a':1,'range-b':2});
    const payloads=await page.evaluate(()=>window.__rangeCloudPayloads.filter(p=>p.id==='range-b'));
    assert.deepEqual(payloads[0],payloads[1]);assert.deepEqual(await page.evaluate(()=>window.__scientificState()),before);
    assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('A raw blob changed without a project timestamp cannot update a group display snapshot', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  try {
    await fixture(h);
    const before=await page.evaluate(async()=>{
      const p=await ProjectStorage.getProject('range-b'),blob=await ProjectStorage.getBlob(p.molecules[0].blobId);
      const values=new Float32Array(await blob.blob.arrayBuffer());values[0]=123;
      await ProjectStorage.putBlob(Object.assign({},blob,{blob:new Blob([values.buffer],{type:'application/octet-stream'})}));
      return ProjectStorage.listProjects();
    });
    await page.locator('#normalization-display-refresh').click();
    await page.waitForFunction(()=>/生値が変更されています/.test(document.getElementById('normalization-status').textContent));
    assert.deepEqual(await page.evaluate(()=>ProjectStorage.listProjects()),before);assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('Changed group membership blocks display refresh without creating a partial snapshot', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  try {
    await fixture(h);
    const before=await page.evaluate(async()=>{
      await ProjectStorage.patchProjectFields('range-b',{folderId:'species'});return ProjectStorage.listProjects();
    });
    await page.locator('#normalization-display-refresh').click();
    await page.waitForFunction(()=>/フォルダー構成・所属データが変更/.test(document.getElementById('normalization-status').textContent));
    assert.deepEqual(await page.evaluate(()=>ProjectStorage.listProjects()),before);assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('Concurrent changes between verification and the display save transaction preserve every newer field', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  try {
    await fixture(h);
    await page.evaluate(()=>{
      const save=ProjectStorage.putProjectsIfUnchanged.bind(ProjectStorage);
      ProjectStorage.putProjectsIfUnchanged=async(updates,guard)=>{
        await ProjectStorage.patchProjectFields('range-b',{displayName:'newer viewer edit'});
        window.__rangeBeforeCas=await ProjectStorage.listProjects();return save(updates,guard);
      };
    });
    await page.locator('#normalization-display-refresh').click();
    await page.waitForFunction(()=>/データが変更されました/.test(document.getElementById('normalization-status').textContent));
    assert.deepEqual(await page.evaluate(()=>ProjectStorage.listProjects()),await page.evaluate(()=>window.__rangeBeforeCas));
    assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});
