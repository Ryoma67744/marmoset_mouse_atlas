'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {startBrowserHarness, seedViewerProject} = require('./browser-harness.cjs');

async function masterFixture(h) {
  for (const id of ['master-a','master-b']) await seedViewerProject(h.page,h.baseURL,{id});
  await h.page.evaluate(async () => {
    await ProjectStorage.putFolder({id:'species',name:'Marmoset',parentId:null});
    await ProjectStorage.putFolder({id:'coronal',name:'Coronal',parentId:'species'});
    sessionStorage.setItem('marmoset:currentFolder','coronal');
    for (const id of ['master-a','master-b']) {
      const p = await ProjectStorage.getProject(id);
      p.displayName = id;
      p.folderId = 'coronal';
      delete p.normalization;
      if (id==='master-b') for (const m of p.molecules) {
        const values = await ProjectStorage.getValueRaster(m.blobId);
        for (let i=0;i<values.length;i++) values[i]*=2;
        m.blobId = await ProjectStorage.putValueRaster(values);
      }
      await ProjectStorage.putProject(p);
    }
  });
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route=>route.fulfill({contentType:'application/javascript',body:'window.CLOUD_CONFIG = {};'}));
  await h.page.goto(h.baseURL + '/');
  await h.page.addStyleTag({content:'.hidden{display:none!important}'});
  await h.page.waitForFunction(()=>document.querySelectorAll('#project-list input.sel').length===2);
}

async function configure(h, {groupId='coronal',count=2,referenceName='master-a'}={}) {
  const page=h.page;
  await page.locator('#normalization-settings').click();
  if (await page.locator('#normalization-group').inputValue() !== groupId) await page.locator('#normalization-group').selectOption(groupId);
  assert.equal(await page.locator('#normalization-group').inputValue(),groupId);
  assert.equal(await page.locator('[data-group-project]').count(),count,'entire selected group, not the whole atlas');
  await page.locator('#normalization-load').click();
  await page.locator('#normalization-form').waitFor();
  await page.locator('[name=batchId]').fill('test-acquisition-spray');
  await page.locator('[name=prepId]').fill('test-preparation');
  await page.locator('[name=minD4]').fill('0');
  await page.locator('[name=saturationD4]').fill('1000');
  await page.locator('[name=referenceKind]').selectOption('whole_tissue');
  await page.locator('[name=comparability]').check();
  await page.locator('[name=otsu_ht]').check();
  await page.locator('[name=otsu_da]').check();
  await page.locator('#normalization-preview').click();
  await page.waitForFunction(()=>/固定基準データ/.test(document.getElementById('normalization-status').textContent));
  assert.match(await page.locator('#normalization-status').innerText(),/固定基準データ/);
  await page.locator('#normalization-form tbody tr').filter({hasText:referenceName}).locator('input[type=checkbox]').check();
}

async function rawBits(page) {
  return page.evaluate(async () => {
    const result={};
    for (const p of await ProjectStorage.listProjects()) for (const m of p.molecules) {
      const values=await ProjectStorage.getValueRaster(m.blobId);
      result[p.id+':'+m.key]=Array.from(new Uint32Array(values.buffer));
    }
    return result;
  });
}

test('Master previews fixed factors before explicit atomic save and preserves raw data', {timeout:90000}, async () => {
  const h=await startBrowserHarness(), page=h.page;
  let accept=false;
  page.on('dialog',dialog=>accept?dialog.accept():dialog.dismiss());
  try {
    await masterFixture(h);
    const before=await rawBits(page);
    await configure(h);
    await page.locator('#normalization-preview').click();
    await page.waitForFunction(()=>!document.getElementById('normalization-save').disabled);
    assert.equal(await page.evaluate(async()=> (await ProjectStorage.listProjects()).filter(p=>p.normalization).length),0);
    assert.match(await page.locator('#normalization-preview-result').innerText(),/CALIBRATION_MISSING/);
    await page.locator('#normalization-save').click();
    assert.equal(await page.evaluate(async()=> (await ProjectStorage.listProjects()).filter(p=>p.normalization).length),0,'No cancels local save');
    accept=true;
    await page.locator('#normalization-save').click();
    await page.waitForFunction(()=> /2 件をこの PC に保存しました/.test(document.getElementById('normalization-status').textContent));
    const results=await page.evaluate(async()=> {
      const result={};
      for (const p of await ProjectStorage.listProjects()) {
        const rasters=await Normalization.loadRasters(p,{storage:ProjectStorage});
        const e=Normalization.evaluate(p,rasters);
        result[p.id]={profile:p.normalization,mode:p.valueDisplay.mode,otsu:p.otsu.applied,reasons:e.reasonCodes,
          ratio:e.channels['MSI_5-HT'].values && Array.from(e.channels['MSI_5-HT'].values),da:e.channels.MSI_DA.values && Array.from(e.channels.MSI_DA.values)};
      }
      return result;
    });
    assert.ok(results['master-a'] && results['master-a'].profile,JSON.stringify(results));
    assert.ok(results['master-b'] && results['master-b'].profile,JSON.stringify(results));
    assert.equal(results['master-a'].profile.section.k,1);
    assert.equal(results['master-a'].profile.schemaVersion,2);
    assert.deepEqual(results['master-a'].profile.scope.folderPath,['Marmoset','Coronal']);
    assert.equal(results['master-a'].profile.scope.groupId,results['master-b'].profile.scope.groupId);
    assert.equal(results['master-b'].profile.section.k,0.5);
    assert.ok(results['master-a'].ratio,JSON.stringify(results['master-a'].reasons));
    assert.ok(results['master-b'].ratio,JSON.stringify(results['master-b'].reasons));
    assert.deepEqual(results['master-a'].ratio,results['master-b'].ratio);
    assert.deepEqual(results['master-a'].da,results['master-b'].da);
    assert.deepEqual(results['master-a'].profile.commonRanges,results['master-b'].profile.commonRanges);
    assert.equal(results['master-b'].otsu,false);
    assert.equal(results['master-b'].mode,'normalized');
    assert.deepEqual(await rawBits(page),before);
    assert.equal(await page.locator('#normalization-cloud').isDisabled(),true,'unconfigured cloud is not called');
    await page.locator('#normalization-close').click();
    assert.equal(await page.locator('#normalization-settings').isDisabled(),false);
    assert.match(await page.locator('#project-list').innerText(),/補正:/);
    assert.deepEqual(h.errors,[]);
  } finally { await h.close(); }
});

test('Master invalidates edited previews and prevents a concurrent project overwrite', {timeout:90000}, async () => {
  const h=await startBrowserHarness(),page=h.page;
  page.on('dialog',dialog=>dialog.accept());
  try {
    await masterFixture(h);
    await configure(h);
    await page.locator('#normalization-preview').click();
    await page.waitForFunction(()=>!document.getElementById('normalization-save').disabled);
    await page.locator('[name=minD4]').fill('0.1');
    assert.equal(await page.locator('#normalization-save').isDisabled(),true);
    await page.locator('#normalization-preview').click();
    await page.waitForFunction(()=>!document.getElementById('normalization-save').disabled);
    await page.evaluate(async()=> {
      const p=await ProjectStorage.getProject('master-b');
      p.displayName='changed in another tab';
      await ProjectStorage.putProject(p);
    });
    await page.locator('#normalization-save').click();
    await page.waitForFunction(()=>/更新されたデータ/.test(document.getElementById('normalization-status').textContent));
    assert.equal(await page.evaluate(async()=> (await ProjectStorage.listProjects()).filter(p=>p.normalization).length),0,'no partial profile batch is committed');
    assert.equal(await page.evaluate(async()=> (await ProjectStorage.getProject('master-b')).displayName),'changed in another tab');
    assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('IndexedDB profile batch compare-and-swap aborts every write on conflict', {timeout:60000}, async()=>{
  const h=await startBrowserHarness();
  try {
    await h.page.goto(h.baseURL+'/__test_seed');
    const result=await h.page.evaluate(async()=>{
      const a={id:'a',displayName:'original A'},b={id:'b',displayName:'original B'};
      await ProjectStorage.putProject(a); await ProjectStorage.putProject(b);
      const expectedA=a.updatedAt,expectedB=b.updatedAt;
      let rejected=false;
      try {await ProjectStorage.putProjectsIfUnchanged([
        {project:{...a,displayName:'should rollback'},expectedUpdatedAt:expectedA},
        {project:{...b,displayName:'should not write'},expectedUpdatedAt:'older revision'}
      ]);}catch{rejected=true;}
      const after=[await ProjectStorage.getProject('a'),await ProjectStorage.getProject('b')];
      await ProjectStorage.putProjectsIfUnchanged([
        {project:{...a,displayName:'new A'},expectedUpdatedAt:expectedA},
        {project:{...b,displayName:'new B'},expectedUpdatedAt:expectedB}
      ]);
      return {rejected,after:after.map(p=>p.displayName),success:(await ProjectStorage.listProjects()).map(p=>p.displayName).sort()};
    });
    assert.equal(result.rejected,true);
    assert.deepEqual(result.after,['original A','original B']);
    assert.deepEqual(result.success,['new A','new B']);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('Master cloud batch reports partial synchronization and can retry without altering factors', {timeout:90000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  page.on('dialog',dialog=>dialog.accept());
  try {
    await masterFixture(h);
    await page.evaluate(async()=>{
      window.__cloudRows={}; window.__cloudFailures=1; window.__cloudSequence=0;
      for(const p of await ProjectStorage.listProjects()) {
        p.cloudUpdatedAt='2026-01-01T00:00:00.000Z'; p.cloudBundlePath='synthetic/'+p.id+'.zip';
        p.cloudStateHash=Cloud.hashState(Cloud.stateOf(p));
        await ProjectStorage.putProject(p);
        window.__cloudRows[p.id]={id:p.id,display_name:p.displayName,folder_path:['Marmoset','Coronal'],meta:Cloud.metaOf(p),state:Cloud.stateOf(p),updated_at:p.cloudUpdatedAt,bundle_path:p.cloudBundlePath};
      }
      Cloud.configured=()=>true; Cloud.signedIn=()=>true;
      Cloud.listProjects=async()=>structuredClone(Object.values(window.__cloudRows));
      Cloud.getProject=async id=>structuredClone(window.__cloudRows[id]||null);
      Cloud.patchRowIfUnchanged=async(id,patch,expected)=>{
        if(id==='master-b' && window.__cloudFailures>0) {window.__cloudFailures--;throw new Error('synthetic offline failure');}
        const row=window.__cloudRows[id];
        if(row.updated_at!==expected) return null;
        Object.assign(row,structuredClone(patch));
        row.updated_at=new Date(Date.UTC(2026,0,1,0,0,++window.__cloudSequence)).toISOString();
        return structuredClone(row);
      };
    });
    await configure(h);
    await page.locator('#normalization-preview').click();
    await page.waitForFunction(()=>!document.getElementById('normalization-save').disabled);
    await page.locator('#normalization-save').click();
    await page.waitForFunction(()=>/2 件をこの PC に保存しました/.test(document.getElementById('normalization-status').textContent));
    const before=await page.evaluate(async()=> (await ProjectStorage.listProjects()).map(p=>[p.id,p.normalization.section.k,p.normalization.calculationFingerprint]).sort());
    await page.locator('#normalization-cloud').click();
    await page.waitForFunction(()=>/クラウド同期 1\/2 件/.test(document.getElementById('normalization-status').textContent));
    assert.match(await page.locator('#normalization-status').innerText(),/未完了.*[\s\S]*synthetic offline failure/);
    assert.equal(await page.locator('#normalization-cloud').isDisabled(),false);
    await page.locator('#normalization-cloud').click();
    await page.waitForFunction(()=>/クラウド同期 2\/2 件/.test(document.getElementById('normalization-status').textContent));
    assert.equal(await page.locator('#normalization-cloud').isDisabled(),true);
    const after=await page.evaluate(async()=> (await ProjectStorage.listProjects()).map(p=>[p.id,p.normalization.section.k,p.normalization.calculationFingerprint]).sort());
    assert.deepEqual(after,before);
    const remote=await page.evaluate(()=> Object.values(window.__cloudRows).map(row=>[row.state.normalization.id,row.state.normalization.revision]));
    assert.deepEqual(remote[0],remote[1]);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('second-level groups include nested data and remain numerically and durably independent', {timeout:90000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  page.on('dialog',dialog=>dialog.accept());
  try {
    await masterFixture(h);
    await seedViewerProject(page,h.baseURL,{id:'sagittal-c'});
    await seedViewerProject(page,h.baseURL,{id:'ungrouped'});
    await page.evaluate(async()=>{
      await ProjectStorage.putFolder({id:'nested',name:'Animal 1',parentId:'coronal'});
      await ProjectStorage.putFolder({id:'sagittal',name:'Sagittal',parentId:'species'});
      await ProjectStorage.putFolder({id:'top-coronal',name:'Coronal',parentId:null});
      for(const [id,folderId] of [['master-b','nested'],['sagittal-c','sagittal'],['ungrouped','top-coronal']]) {
        const p=await ProjectStorage.getProject(id); p.folderId=folderId;p.displayName=id;delete p.normalization;
        await ProjectStorage.putProject(p);
      }
    });
    await page.goto(h.baseURL+'/');
    await page.waitForFunction(()=>document.querySelector('#project-list input.sel'));
    const before=await rawBits(page);
    await configure(h);
    await page.locator('#normalization-preview').click();
    await page.waitForFunction(()=>!document.getElementById('normalization-save').disabled);
    await page.locator('#normalization-save').click();
    await page.waitForFunction(()=>/2 件をこの PC に保存しました/.test(document.getElementById('normalization-status').textContent));
    const coronal=await page.evaluate(async()=>JSON.stringify((await ProjectStorage.getProject('master-a')).normalization));
    assert.equal(await page.evaluate(async()=>!!(await ProjectStorage.getProject('sagittal-c')).normalization),false);
    assert.equal(await page.evaluate(async()=>!!(await ProjectStorage.getProject('ungrouped')).normalization),false);
    await page.locator('#normalization-close').click();
    await configure(h,{groupId:'sagittal',count:1,referenceName:'sagittal-c'});
    await page.locator('#normalization-preview').click();
    await page.waitForFunction(()=>!document.getElementById('normalization-save').disabled);
    await page.locator('#normalization-save').click();
    await page.waitForFunction(()=>/1 件をこの PC に保存しました/.test(document.getElementById('normalization-status').textContent));
    assert.equal(await page.evaluate(async()=>JSON.stringify((await ProjectStorage.getProject('master-a')).normalization)),coronal);
    const ids=await page.evaluate(async()=>[(await ProjectStorage.getProject('master-a')).normalization.scope.groupId,(await ProjectStorage.getProject('sagittal-c')).normalization.scope.groupId]);
    assert.notEqual(ids[0],ids[1]);
    assert.deepEqual(await rawBits(page),before);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('folder-only change after preview prevents the entire group save', {timeout:90000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  page.on('dialog',dialog=>dialog.accept());
  try {
    await masterFixture(h);await configure(h);
    await page.locator('#normalization-preview').click();
    await page.waitForFunction(()=>!document.getElementById('normalization-save').disabled);
    await page.evaluate(async()=>{const f=await ProjectStorage.getFolder('species');f.name='Renamed in another tab';await ProjectStorage.putFolder(f);});
    await page.locator('#normalization-save').click();
    await page.waitForFunction(()=>/フォルダー構成/.test(document.getElementById('normalization-status').textContent));
    assert.equal(await page.evaluate(async()=>(await ProjectStorage.listProjects()).some(p=>p.normalization)),false);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

test('folder rename synchronizes cloud-only descendants and conflicts have an explicit retry', {timeout:90000},async()=>{
  const h=await startBrowserHarness(),page=h.page;
  page.on('dialog',dialog=>dialog.type()==='prompt'?dialog.accept('Coronal renamed'):dialog.accept());
  try {
    await masterFixture(h);
    await page.evaluate(async()=>{
      const rows={};
      for(const p of await ProjectStorage.listProjects()) {
        p.cloudUpdatedAt='2026-01-01T00:00:00.000Z';p.cloudBundlePath='mock/'+p.id;
        p.cloudStateHash=Cloud.hashState(Cloud.stateOf(p));await ProjectStorage.putProject(p);
        rows[p.id]={id:p.id,display_name:p.displayName,folder_path:['Marmoset','Coronal'],state:Cloud.stateOf(p),meta:Cloud.metaOf(p),updated_at:p.cloudUpdatedAt,bundle_path:p.cloudBundlePath};
      }
      await ProjectStorage.deleteProjectRecord('master-b');
      window.__folderRows=rows;window.__folderCalls=[];window.__folderFail=true;
      Cloud.configured=()=>true;Cloud.signedIn=()=>true;
      Cloud.listProjects=async()=>structuredClone(Object.values(rows));
      Cloud.patchRowIfUnchanged=async(id,patch,expected)=>{
        window.__folderCalls.push(id);
        if(id==='master-b'&&window.__folderFail)throw new Error('synthetic offline');
        if(rows[id].updated_at!==expected)return null;
        Object.assign(rows[id],structuredClone(patch));rows[id].updated_at=new Date(Date.parse(rows[id].updated_at)+1000).toISOString();
        return structuredClone(rows[id]);
      };
    });
    // Opening setup refreshes authoritative metadata without downloading cloud-only data.
    await page.locator('#normalization-settings').click();
    // Close and navigate to the parent where the child folder has a rename button.
    await page.locator('#normalization-close').click();
    await page.locator('#folder-tree .tree-node').filter({hasText:/Marmoset/}).click();
    await page.locator('#project-list [data-act=rename]').click();
    await page.waitForFunction(()=>window.__folderCalls.includes('master-b'));
    await page.waitForFunction(()=>window.__folderRows['master-a'].folder_path[1]==='Coronal renamed');
    await page.locator('#folder-sync-retry').waitFor();
    await page.evaluate(()=>{window.__folderFail=false;window.__folderRows['master-b'].updated_at='2026-02-01T00:00:00.000Z';window.__folderRows['master-b'].state.externalNote='new remote state';});
    await page.locator('#folder-sync-retry').click();
    await page.waitForFunction(()=>window.__folderRows['master-b'].folder_path[1]==='Coronal renamed');
    assert.equal(await page.evaluate(()=>window.__folderRows['master-b'].state.externalNote),'new remote state');
    assert.equal(await page.evaluate(async()=>!!await ProjectStorage.getProject('master-b')),false,'metadata-only relocation must not create an empty local project');
    assert.deepEqual(await page.evaluate(()=>window.__folderRows['master-a'].folder_path),['Marmoset','Coronal renamed']);
    assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});
