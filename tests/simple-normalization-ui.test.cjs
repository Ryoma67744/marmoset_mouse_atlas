'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {startBrowserHarness,seedViewerProject} = require('./browser-harness.cjs');

async function fixture(h,{badStandard=false,ambiguous=false,cloud=false,legacy=false,refreshFailsAfterSave=false,missingStandard=false,allMissing=false,ambiguousHt=false,nonNumericStandard=false}={}) {
  for (const id of ['simple-a','simple-b']) await seedViewerProject(h.page,h.baseURL,{id});
  await h.page.addScriptTag({url:h.baseURL + '/lib/normalization-ui.js'});
  return h.page.evaluate(async flags => {
    await ProjectStorage.putFolder({id:'species',name:'Marmoset',parentId:null});
    await ProjectStorage.putFolder({id:'plane',name:'Coronal',parentId:'species'});
    await ProjectStorage.putFolder({id:'child',name:'Child',parentId:'plane'});
    for (const p of await ProjectStorage.listProjects()) {
      p.displayName = p.id; p.folderId = p.id === 'simple-a' ? 'plane' : 'child';
      if (!flags.legacy) delete p.normalization;
      const d4 = p.molecules.find(m=>m.key === 'MSI_D4-5-HT');
      if (p.id === 'simple-b') d4.blobId = await ProjectStorage.putValueRaster(new Float32Array(8).fill(flags.badStandard ? 0 : 4));
      const values = new Float32Array([0,2,NaN,4,6,8,10,12]);
      p.molecules.push({key:'MSI_Glutamate',name:'Glutamate',blobId:await ProjectStorage.putValueRaster(values),stats:MSIRaster.deriveBakeStats(values)});
      if (flags.ambiguous && p.id === 'simple-a') p.molecules.push(Object.assign({},d4,{key:'MSI_D4_alternative',name:'d4-5-HT'}));
      if (flags.allMissing || (flags.missingStandard && p.id === 'simple-b')) p.molecules = p.molecules.filter(m=>m.key !== d4.key);
      if (flags.ambiguousHt) p.molecules.push(Object.assign({},p.molecules.find(m=>m.key === 'MSI_5-HT'),{key:'MSI_HT_alternative',name:'5-HT'}));
      if (flags.nonNumericStandard && p.id === 'simple-b') delete d4.blobId;
      await ProjectStorage.putProject(p);
    }
    window.__simpleCloudAttempts = {};
    window.__openSimple = async () => {
      const refreshScope = async () => {
        const projects=await ProjectStorage.listProjects();
        if (flags.refreshFailsAfterSave && projects.some(p=>p.normalization && p.normalization.schemaVersion===3)) throw new Error('synthetic offline listing');
        return {projects,folders:await ProjectStorage.listFolders(),currentFolderId:'plane'};
      };
      NormalizationUI.open(Object.assign(await refreshScope(),{storage:ProjectStorage,refreshScope,loadProject:p=>ProjectStorage.getProject(p.id),
        saveCloud:flags.cloud ? async p => {
          const attempts = window.__simpleCloudAttempts;
          attempts[p.id] = (attempts[p.id] || 0) + 1;
          if (p.id === 'simple-b' && attempts[p.id] === 1) throw new Error('synthetic cloud conflict');
        } : undefined}));
    };
    await window.__openSimple();
    const bits = {};
    for (const p of await ProjectStorage.listProjects()) for (const m of p.molecules) {
      if (m.blobId) {
        const values = await ProjectStorage.getValueRaster(m.blobId);
        bits[p.id + ':' + m.key] = Array.from(new Uint32Array(values.buffer));
      }
    }
    return {projects:await ProjectStorage.listProjects(),bits};
  },{badStandard,ambiguous,cloud,legacy,refreshFailsAfterSave,missingStandard,allMissing,ambiguousHt,nonNumericStandard});
}
async function waitSimple(page) { await page.locator('#normalization-simple-form').waitFor(); }
async function apply(page) {
  await page.locator('#normalization-simple-apply').click();
  await page.waitForFunction(()=>/2 件をこの PC に保存しました/.test(document.getElementById('normalization-status').textContent));
  await page.waitForFunction(()=>!document.getElementById('normalization-close').disabled);
}

test('Simple folder correction automatically loads descendants and saves generic channels in one action without experimental IDs', {timeout:60000}, async()=>{
  const h = await startBrowserHarness(),page=h.page;
  const dialogs=[];page.on('dialog',dialog=>{dialogs.push(dialog.message());dialog.dismiss();});
  try {
    const before=await fixture(h);await waitSimple(page);
    assert.equal(await page.locator('[data-simple-project]').count(),2);
    assert.equal(await page.locator('#normalization-simple-advanced').getAttribute('open'),null);
    assert.match(await page.locator('#normalization-destination').innerText(),/保存先：この PC$/);
    assert.equal(await page.locator('[name=profileId]').count(),0);
    await apply(page);
    const after=await page.evaluate(async()=>{
      const out=[],bits={};
      for (const p of await ProjectStorage.listProjects()) {
        const rasters=await Normalization.loadRasters(p,{storage:ProjectStorage});
        const ev=Normalization.evaluate(p,rasters);
        for (const m of p.molecules) bits[p.id+':'+m.key]=Array.from(new Uint32Array(rasters[m.key].values.buffer));
        out.push({p,glutamate:Array.from(ev.channels.MSI_Glutamate.values),ht:Array.from(ev.channels['MSI_5-HT'].values)});
      }
      return {out,bits};
    });
    assert.deepEqual(after.bits,before.bits);
    for(const {p} of after.out){
      assert.equal(p.normalization.schemaVersion,3);assert.equal(p.normalization.mode,'simple');
      assert.equal(p.normalization.batchId,'');assert.equal(p.normalization.prepId,'');
      assert.equal(p.normalization.comparabilityConfirmed,false);assert.equal(p.normalization.coordinateMatchConfirmed,false);
      assert.equal(p.normalization.qc.enforceCoverage,false);assert.equal(p.normalization.qc.saturationD4,null);
      assert.deepEqual(p.normalization.reference.projectIds,['simple-a','simple-b']);
      assert.equal(p.normalization.reference.kind,'d4_measured');assert.equal(p.normalization.section.Dref,3);
      assert.equal(p.normalization.targets.find(t=>t.key==='MSI_Glutamate').method,'section_scale');
      assert.equal(p.normalization.targets.find(t=>t.key==='MSI_5-HT').method,'pixel_ratio');
      assert.equal(p.valueDisplay.mode,'normalized');assert.equal(p.otsu.applied,false);
    }
    assert.equal(after.out.find(o=>o.p.id==='simple-a').p.normalization.section.k,1.5);
    assert.equal(after.out.find(o=>o.p.id==='simple-b').p.normalization.section.k,0.75);
    assert.deepEqual(after.out.find(o=>o.p.id==='simple-a').glutamate,[0,3,NaN,6,9,12,15,18]);
    assert.deepEqual(dialogs,[]);assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('Simple correction refuses an invalid d4 reference without silently dropping a section or saving profiles', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  try {
    const before=await fixture(h,{badStandard:true});await waitSimple(page);
    await page.locator('#normalization-simple-apply').click();
    await page.locator('#normalization-simple-blocked').waitFor();
    await page.waitForFunction(()=>!document.getElementById('normalization-close').disabled);
    assert.equal(await page.locator('[data-simple-output]').count(),2);
    assert.match(await page.locator('[data-simple-output="simple-b"]').innerText(),/simple-b/);
    assert.deepEqual(await page.evaluate(()=>ProjectStorage.listProjects()),before.projects);
    assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('Missing standards are marked before apply, saved as raw without affecting references, and corrected after an actual standard is added', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page,dialogs=[];
  page.on('dialog',dialog=>{dialogs.push(dialog.message());dialog.dismiss();});
  try {
    const before=await fixture(h,{missingStandard:true});await waitSimple(page);
    assert.match(await page.locator('#normalization-simple-summary').innerText(),/補正予定 1件 ／ 内部標準なしでスキップ 1件/);
    assert.equal(await page.locator('[name=standard_1]').inputValue(),'');
    assert.match(await page.locator('[name=standard_1] option:checked').textContent(),/内部標準なし（補正をスキップ）/);
    assert.match(await page.locator('[data-simple-application="1"]').textContent(),/内部標準なし・未補正（生値表示）/);
    assert.equal(await page.locator('[name=ht_1]').isDisabled(),true);
    assert.equal(await page.locator('[name=simple_ref_1]').isDisabled(),true);
    assert.equal(await page.locator('[name=simple_ref_1]').isChecked(),false);
    assert.equal(await page.locator('[data-target-entry="1"]').evaluateAll(els=>els.every(el=>el.disabled)),true);
    await apply(page);
    const first=await page.evaluate(async()=>{
      const projects=await ProjectStorage.listProjects(),bits={};
      for(const p of projects) for(const m of p.molecules) {
        const values=await ProjectStorage.getValueRaster(m.blobId);
        bits[p.id+':'+m.key]=Array.from(new Uint32Array(values.buffer));
      }
      return {projects,bits};
    });
    assert.deepEqual(first.bits,before.bits);
    const active=first.projects.find(p=>p.id==='simple-a'),skipped=first.projects.find(p=>p.id==='simple-b');
    assert.equal(active.normalization.section.Dref,2);assert.equal(active.normalization.section.k,1);
    assert.equal(skipped.valueDisplay.mode,'raw');assert.equal(skipped.normalization.section.k,null);
    assert.deepEqual(skipped.normalization.application,{status:'skipped',reasonCode:'INTERNAL_STANDARD_MISSING'});
    assert.deepEqual(skipped.normalization.reference.projectIds,['simple-a']);
    assert.deepEqual(skipped.normalization.scope.memberIds,['simple-a','simple-b']);
    assert.deepEqual(skipped.normalization.targets,[]);
    assert.match(await page.locator('#normalization-status').innerText(),/補正 1件 ／ 内部標準なしでスキップ 1件/);
    assert.match(await page.locator('[data-simple-output="simple-b"]').innerText(),/内部標準なし・未補正（生値表示）/);
    await page.locator('#normalization-close').click();await page.evaluate(()=>window.__openSimple());await waitSimple(page);
    assert.equal(await page.locator('#normalization-replacement').count(),0);
    assert.equal(await page.locator('[name=standard_1]').inputValue(),'');
    await apply(page);
    assert.equal(await page.evaluate(async()=>(await ProjectStorage.getProject('simple-b')).normalization.revision),2);
    await page.locator('#normalization-close').click();
    await page.evaluate(async()=>{
      const p=await ProjectStorage.getProject('simple-b');
      const values=new Float32Array(8).fill(4);
      p.molecules.push({key:'MSI_D4-5-HT',name:'D4-5-HT',blobId:await ProjectStorage.putValueRaster(values),stats:MSIRaster.deriveBakeStats(values)});
      await ProjectStorage.putProject(p);await window.__openSimple();
    });
    await waitSimple(page);
    assert.equal(await page.locator('[name=standard_1]').inputValue(),'MSI_D4-5-HT');
    assert.equal(await page.locator('[name=simple_ref_1]').isChecked(),true);
    assert.equal(await page.locator('[data-target-entry="1"][data-target-key="MSI_Glutamate"]').isChecked(),true);
    await apply(page);
    const restored=await page.evaluate(()=>ProjectStorage.getProject('simple-b'));
    assert.equal(restored.normalization.application,undefined);assert.equal(restored.valueDisplay.mode,'normalized');
    assert.equal(restored.normalization.id,skipped.normalization.id);assert.equal(restored.normalization.revision,3);
    assert.equal(restored.normalization.section.Dref,3);assert.equal(restored.normalization.section.k,0.75);
    await page.locator('#normalization-close').click();
    await page.evaluate(async()=>{
      const p=await ProjectStorage.getProject('simple-b');p.molecules=p.molecules.filter(m=>m.key!=='MSI_D4-5-HT');
      await ProjectStorage.putProject(p);await window.__openSimple();
    });
    await waitSimple(page);assert.equal(await page.locator('[name=standard_1]').inputValue(),'');await apply(page);
    const removed=await page.evaluate(()=>ProjectStorage.getProject('simple-b'));
    assert.equal(removed.valueDisplay.mode,'raw');assert.equal(removed.normalization.application.status,'skipped');
    assert.equal(removed.normalization.mapping.ht,null);assert.equal(removed.normalization.mapping.d4,null);
    assert.equal(removed.normalization.revision,4);assert.deepEqual(removed.normalization.reference.projectIds,['simple-a']);
    assert.deepEqual(dialogs,[]);assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('An entirely standard-free folder needs no HT disambiguation or reference ROI and saves explicit uncorrected records', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  try {
    await fixture(h,{allMissing:true,ambiguousHt:true});await waitSimple(page);
    assert.match(await page.locator('#normalization-simple-summary').innerText(),/補正予定 0件 ／ 内部標準なしでスキップ 2件/);
    assert.equal(await page.locator('[name=ht_0]').isDisabled(),true);
    assert.equal(await page.locator('[name=ht_1]').isDisabled(),true);
    await page.locator('#normalization-simple-advanced > summary').click();
    await page.locator('[name=referenceKind]').selectOption('roi');
    await apply(page);
    const projects=await page.evaluate(()=>ProjectStorage.listProjects());
    for(const p of projects) {
      assert.equal(p.valueDisplay.mode,'raw');assert.equal(p.normalization.application.status,'skipped');
      assert.deepEqual(p.normalization.reference.projectIds,[]);assert.deepEqual(p.normalization.reference.roiNames,[]);
      assert.equal(p.normalization.section.Ds,null);assert.equal(p.normalization.section.Dref,null);assert.equal(p.normalization.section.k,null);
    }
    assert.match(await page.locator('#normalization-status').innerText(),/補正 0件 ／ 内部標準なしでスキップ 2件/);
    assert.match(await page.locator('#normalization-simple-result').innerText(),/補正値・係数を算出せず/);
    assert.doesNotMatch(await page.locator('#normalization-simple-result').innerText(),/飽和未確認の相対補正/);
    assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('An explicitly chosen custom numeric standard overrides true absence and restores its correction controls', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  try {
    await fixture(h,{missingStandard:true});await waitSimple(page);
    await page.locator('#normalization-mapping > summary').click();
    await page.locator('[name=standard_1]').selectOption('MSI_Glutamate');
    assert.match(await page.locator('#normalization-simple-summary').innerText(),/補正予定 2件 ／ 内部標準なしでスキップ 0件/);
    assert.equal(await page.locator('[name=ht_1]').isEnabled(),true);
    assert.equal(await page.locator('[name=simple_ref_1]').isChecked(),true);
    assert.equal(await page.locator('[data-target-entry="1"][data-target-key="MSI_Glutamate"]').isDisabled(),true);
    assert.equal(await page.locator('[data-target-entry="1"][data-target-key="MSI_NE"]').isChecked(),true);
    await apply(page);
    const p=await page.evaluate(()=>ProjectStorage.getProject('simple-b'));
    assert.equal(p.normalization.application,undefined);assert.equal(p.normalization.mapping.d4,'MSI_Glutamate');
    assert.equal(p.valueDisplay.mode,'normalized');assert.deepEqual(p.normalization.reference.projectIds,['simple-a','simple-b']);
    assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('A declared standard without a numeric raster cannot be mislabeled absent or silently skipped', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  try {
    const before=await fixture(h,{nonNumericStandard:true});await waitSimple(page);
    assert.match(await page.locator('#normalization-simple-summary').innerText(),/スキップ 0件/);
    assert.doesNotMatch(await page.locator('[name=standard_1]').innerHTML(),/補正をスキップ/);
    await page.locator('#normalization-simple-apply').click();
    await page.waitForFunction(()=>/simple-b：内部標準/.test(document.getElementById('normalization-status').textContent));
    assert.deepEqual(await page.evaluate(()=>ProjectStorage.listProjects()),before.projects);assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('Choosing a custom standard for a skipped section requires resolving its previously irrelevant HT ambiguity', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  try {
    await fixture(h,{allMissing:true,ambiguousHt:true});await waitSimple(page);
    assert.equal(await page.locator('[name=ht_1]').inputValue(),'__unresolved__');
    assert.equal(await page.locator('[name=ht_1]').isDisabled(),true);
    await page.locator('#normalization-mapping > summary').click();
    await page.locator('[name=standard_1]').selectOption('MSI_Glutamate');
    assert.equal(await page.locator('[name=ht_1]').isEnabled(),true);
    await page.locator('#normalization-simple-apply').click();
    await page.waitForFunction(()=>/simple-b：5-HT の候補/.test(document.getElementById('normalization-status').textContent));
    assert.equal(await page.evaluate(async()=>(await ProjectStorage.listProjects()).some(p=>p.normalization)),false);
    await page.locator('[name=ht_1]').selectOption('MSI_5-HT');await apply(page);
    const p=await page.evaluate(()=>ProjectStorage.getProject('simple-b'));
    assert.equal(p.normalization.mapping.ht,'MSI_5-HT');assert.equal(p.normalization.application,undefined);
    assert.deepEqual(p.normalization.reference.projectIds,['simple-b']);assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('Ambiguous isotope standards require one explicit choice while identified standards remain excluded', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  try {
    await fixture(h,{ambiguous:true});await waitSimple(page);
    assert.notEqual(await page.locator('#normalization-mapping').getAttribute('open'),null);
    await page.locator('#normalization-simple-apply').click();
    await page.waitForFunction(()=>/simple-a：内部標準/.test(document.getElementById('normalization-status').textContent));
    assert.equal(await page.evaluate(async()=>(await ProjectStorage.listProjects()).filter(p=>p.normalization).length),0);
    await page.locator('[name=standard_0]').selectOption('MSI_D4-5-HT');
    await apply(page);
    const p=await page.evaluate(()=>ProjectStorage.getProject('simple-a'));
    assert.equal(p.normalization.mapping.d4,'MSI_D4-5-HT');
    assert.equal(p.normalization.targets.some(t=>t.key==='MSI_D4_alternative'),false);
    assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('Advanced v3 settings, target choices and frozen Otsu sources survive reopen with automatic revision increment', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  try {
    await fixture(h);await waitSimple(page);
    await page.locator('#normalization-simple-advanced > summary').click();
    await page.locator('[name=batchId]').fill('real-batch');await page.locator('[name=prepId]').fill('real-prep');
    await page.locator('[name=minD4]').fill('0.5');await page.locator('[name=saturationD4]').fill('1000');
    await page.locator('[name=minCoverage]').fill('0.6');await page.locator('[name=enforceCoverage]').check();
    await page.locator('[name=referenceKind]').selectOption('qc');await page.locator('[name=simple_ref_1]').uncheck();
    await page.locator('[name=quality]').selectOption('validated');await page.locator('[name=validationEvidence]').fill('actual validation record');
    await page.locator('[name=comparability]').check();await page.locator('[name=coordinateMatch]').check();
    await page.locator('[data-target-entry="0"][data-target-key="MSI_NE"]').uncheck();
    await page.locator('summary').filter({hasText:'表示設定：Otsu'}).click();
    await page.locator('[data-otsu-entry="0"][data-otsu-key="MSI_Glutamate"]').check();
    await apply(page);
    const first=await page.evaluate(()=>ProjectStorage.getProject('simple-a'));
    assert.equal(first.normalization.mode,'advanced');
    assert.deepEqual(first.normalization.otsuSourceKeys,['MSI_Glutamate']);
    await page.locator('#normalization-close').click();await page.evaluate(()=>window.__openSimple());await waitSimple(page);
    assert.equal(await page.locator('[name=batchId]').inputValue(),'real-batch');assert.equal(await page.locator('[name=minCoverage]').inputValue(),'0.6');
    assert.equal(await page.locator('[name=enforceCoverage]').isChecked(),true);assert.equal(await page.locator('[name=simple_ref_1]').isChecked(),false);
    assert.equal(await page.locator('[name=quality]').inputValue(),'validated');
    assert.equal(await page.locator('[name=validationEvidence]').inputValue(),'actual validation record');
    assert.equal(await page.locator('[data-target-entry="0"][data-target-key="MSI_NE"]').isChecked(),false);
    assert.equal(await page.locator('[data-otsu-entry="0"][data-otsu-key="MSI_Glutamate"]').isChecked(),true);
    await apply(page);
    const second=await page.evaluate(()=>ProjectStorage.getProject('simple-a'));
    assert.equal(second.normalization.id,first.normalization.id);assert.equal(second.normalization.revision,2);
    assert.deepEqual(second.normalization.qc,first.normalization.qc);assert.deepEqual(second.normalization.targets,first.normalization.targets);
    assert.deepEqual(second.normalization.otsuSourceKeys,first.normalization.otsuSourceKeys);
    assert.equal(second.normalization.quality,'validated');assert.equal(second.normalization.validationEvidence,'actual validation record');
    await page.locator('#normalization-simple-advanced > summary').click();await page.locator('[name=minD4]').fill('0.6');await apply(page);
    const third=await page.evaluate(()=>ProjectStorage.getProject('simple-a'));
    assert.equal(third.normalization.id,first.normalization.id);assert.equal(third.normalization.revision,3,'same-dialog recalculation also increments the current profile');
    assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('A failed postcommit listing preserves explicit local success and still allows failed-only cloud retry', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  try {
    await fixture(h,{cloud:true,refreshFailsAfterSave:true});await waitSimple(page);await apply(page);
    assert.match(await page.locator('#normalization-status').innerText(),/クラウド同期 1\/2 件/);
    assert.match(await page.locator('#normalization-status').innerText(),/対象一覧を再確認できませんでした/);
    assert.equal(await page.evaluate(async()=>(await ProjectStorage.listProjects()).every(p=>p.normalization.schemaVersion===3)),true);
    await page.locator('#normalization-simple-cloud').click();
    await page.waitForFunction(()=>/クラウド同期 2\/2 件/.test(document.getElementById('normalization-status').textContent));
    assert.deepEqual(await page.evaluate(()=>window.__simpleCloudAttempts),{'simple-a':1,'simple-b':2});assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('Absolute calibration requires explicit real conditions and a complete validated curve while relative defaults need none', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  try {
    await fixture(h);await waitSimple(page);await page.locator('#normalization-simple-advanced > summary').click();
    await page.locator('summary').filter({hasText:'5-HT 絶対定量の検量線'}).click();await page.locator('[name=calibrationEnabled]').check();
    await page.locator('#normalization-simple-apply').click();
    await page.waitForFunction(()=>/絶対定量には/.test(document.getElementById('normalization-status').textContent));
    assert.equal(await page.evaluate(async()=>(await ProjectStorage.listProjects()).some(p=>p.normalization)),false);
    for (const [name,value] of Object.entries({batchId:'real-batch',prepId:'real-prep',saturationD4:'1000',calibrationId:'actual-curve',unit:'fmol/mm²',slope:'2',intercept:'0',lloq:'0',uloq:'1000',responseMin:'0',responseMax:'1000',calibrationSource:'actual calibration study'})) await page.locator('[name='+name+']').fill(value);
    for(const name of ['comparability','coordinateMatch','calibrationConfirmed']) await page.locator('[name='+name+']').check();
    await apply(page);
    const p=await page.evaluate(()=>ProjectStorage.getProject('simple-a'));
    assert.equal(p.normalization.calibration.id,'actual-curve');assert.equal(p.normalization.calibration.batchId,'real-batch');
    assert.equal(p.normalization.calibration.validated,true);assert.equal(p.normalization.calibration.slope,2);assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('Simple cloud auto-sync preserves local completion and retries only failed members', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  try {
    await fixture(h,{cloud:true});await waitSimple(page);
    assert.match(await page.locator('#normalization-destination').innerText(),/クラウド（自動同期）/);
    await apply(page);
    assert.match(await page.locator('#normalization-status').innerText(),/クラウド同期 1\/2 件/);
    assert.equal(await page.locator('#normalization-simple-cloud').isEnabled(),true);
    await page.locator('#normalization-simple-cloud').click();
    await page.waitForFunction(()=>/クラウド同期 2\/2 件/.test(document.getElementById('normalization-status').textContent));
    await page.waitForFunction(()=>!document.getElementById('normalization-close').disabled);
    assert.deepEqual(await page.evaluate(()=>window.__simpleCloudAttempts),{'simple-a':1,'simple-b':2});
    assert.equal(await page.locator('#normalization-simple-cloud').isDisabled(),true);
    assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('Simple apply detects a concurrent edit and preserves both its latest fields and the untouched group', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  try {
    await fixture(h);await waitSimple(page);
    const before=await page.evaluate(async()=>{
      await ProjectStorage.patchProjectFields('simple-b',{displayName:'newer other-tab name'});
      return ProjectStorage.listProjects();
    });
    await page.locator('#normalization-simple-apply').click();
    await page.waitForFunction(()=>/更新されたデータ/.test(document.getElementById('normalization-status').textContent));
    assert.deepEqual(await page.evaluate(()=>ProjectStorage.listProjects()),before);assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('Existing legacy profiles stay in their detailed form until an explicit confirmed switch and new save', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page;
  let accept=false;page.on('dialog',dialog=>accept ? dialog.accept() : dialog.dismiss());
  try {
    const before=await fixture(h,{legacy:true});await page.locator('#normalization-form').waitFor();
    await page.locator('#normalization-use-simple').click();
    assert.equal(await page.locator('#normalization-simple-form').count(),0);
    assert.deepEqual(await page.evaluate(()=>ProjectStorage.listProjects()),before.projects);
    accept=true;await page.locator('#normalization-use-simple').click();await waitSimple(page);
    assert.deepEqual(await page.evaluate(()=>ProjectStorage.listProjects()),before.projects);
    await apply(page);
    assert.equal(await page.evaluate(async()=>(await ProjectStorage.listProjects()).every(p=>p.normalization.schemaVersion===3)),true);
    assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});

test('Mixed v3 scientific settings under one ID and revision require an explicit whole-group replacement', {timeout:60000}, async()=>{
  const h=await startBrowserHarness(),page=h.page,dialogs=[];
  page.on('dialog',dialog=>{dialogs.push(dialog.message());dialog.dismiss();});
  try {
    await fixture(h);await waitSimple(page);await apply(page);await page.locator('#normalization-close').click();
    const before=await page.evaluate(async()=>{
      const p=await ProjectStorage.getProject('simple-b');
      p.normalization.mode='advanced';
      await ProjectStorage.saveProjectIfUnchanged(p,p.updatedAt);
      await window.__openSimple();return ProjectStorage.listProjects();
    });
    await waitSimple(page);await page.locator('#normalization-replacement').waitFor();
    await page.locator('#normalization-simple-apply').click();
    assert.equal(dialogs.length,1);assert.match(dialogs[0],/既存の基準・対象分子・QC条件が変わります/);
    assert.deepEqual(await page.evaluate(()=>ProjectStorage.listProjects()),before);assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});
