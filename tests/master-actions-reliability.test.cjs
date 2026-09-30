'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startBrowserHarness } = require('./browser-harness.cjs');

const ROWS = 'master-actions-rows', CONTROL = 'master-actions-control', CALLS = 'master-actions-calls';
const DELETIONS = 'marmoset:pendingDeletion:', FOLDERS = 'marmoset:pendingFolderChange:';

// Real Master, IndexedDB and serializers, with an isolated synthetic server.
// No credentials, user data or production network requests are used.
async function fixture(h, { folders = false, offline = false } = {}) {
  const cloud = await fs.readFile(path.join(__dirname, '../lib/cloud.js'), 'utf8');
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};'
  }));
  await h.context.route(h.baseURL + '/lib/cloud.js', route => route.fulfill({
    contentType: 'application/javascript', body: cloud + `
    (() => {
      const read = key => JSON.parse(localStorage.getItem(key) || '{}');
      const log = call => { const calls = JSON.parse(localStorage.getItem('${CALLS}') || '[]'); calls.push(call); localStorage.setItem('${CALLS}',JSON.stringify(calls)); };
      const check = () => { const c = read('${CONTROL}'); if (c.auth === false) { const e = new Error('Synthetic login required'); e.status = 401; throw e; } if (c.offline) throw new Error('Synthetic offline'); };
      Cloud.configured = () => true;
      Cloud.signedIn = () => read('${CONTROL}').auth !== false;
      Cloud.listProjects = async () => { log({kind:'list'}); check(); return Object.values(read('${ROWS}')); };
      Cloud.getProject = async id => { log({kind:'get',id}); check(); return read('${ROWS}')[id] || null; };
      Cloud.patchRowIfUnchanged = async (id, patch, expected) => {
        check(); log({kind:'patch',id,expected}); const rows = read('${ROWS}'), row = rows[id];
        if (!row || row.updated_at !== expected) return null;
        Object.assign(row,structuredClone(patch)); row.updated_at = new Date(Date.parse(expected)+1000).toISOString();
        localStorage.setItem('${ROWS}',JSON.stringify(rows)); return structuredClone(row);
      };
      Cloud.removeRowIfUnchanged = async (id, expected) => {
        log({kind:'delete',id,expected}); check();
        if (read('${CONTROL}').failDelete === id) throw new Error('Synthetic deletion failed');
        if (window.__holdBeforeDelete) { window.__deleteWaiting = true; await new Promise(resolve => window.__releaseDelete = resolve); }
        const rows = read('${ROWS}'), row = rows[id];
        if (!row || row.updated_at !== expected) return null;
        delete rows[id]; localStorage.setItem('${ROWS}',JSON.stringify(rows));
        if (window.__holdAfterDelete) { window.__deleteWaiting = true; await new Promise(resolve => window.__releaseDelete = resolve); }
        if (read('${CONTROL}').loseResponse === id) throw new Error('Synthetic response lost');
        return structuredClone(row);
      };
      Cloud.removeBundle = async bundle => { check(); log({kind:'remove-bundle',bundle}); };
      Cloud.removeRow = async () => { throw new Error('Unconditional deletion is forbidden'); };
      Cloud.downloadBundle = async () => { throw new Error('Raw data must not be downloaded by these tests'); };
    })();`
  }));
  await h.page.goto(h.baseURL + '/__test_seed');
  await h.page.addScriptTag({ url: h.baseURL + '/lib/cloud.js' });
  const before = await h.page.evaluate(async ({ rowsKey, controlKey, folders, offline }) => {
    if (folders) {
      await ProjectStorage.putFolder({id:'species',name:'Marmoset',parentId:null});
      await ProjectStorage.putFolder({id:'coronal',name:'Coronal',parentId:'species'});
      sessionStorage.setItem('marmoset:currentFolder','species');
    }
    const rows = {}, before = {};
    for (const id of ['one','two']) {
      const blobId = await ProjectStorage.putValueRaster(new Float32Array([11,22]));
      const p = {id,displayName:'Synthetic '+id,folderId:folders ? 'coronal' : null,grid:{W:2,H:1},
        molecules:[{key:'MSI_5-HT',name:'5-HT',blobId}],images:{},
        roi:{roi_items:{all:[{poly_msi:[[0,0],[2,0],[2,1],[0,1]]}]},roi_names:{all:'Saved ROI'},palette:{},roi_show_flags:{}},
        cloudUpdatedAt:'2026-01-01T00:00:00.000Z',cloudBundlePath:'synthetic/'+id+'.zip'};
      p.cloudStateHash = Cloud.hashState(Cloud.stateOf(p));
      await ProjectStorage.putProject(p);
      rows[id] = {id,display_name:p.displayName,folder_path:folders ? ['Marmoset','Coronal'] : [],
        state:Cloud.stateOf(p),meta:Cloud.metaOf(p),updated_at:p.cloudUpdatedAt,bundle_path:p.cloudBundlePath};
      before[id] = {blobId,project:p};
    }
    localStorage.setItem(rowsKey,JSON.stringify(rows));
    localStorage.setItem(controlKey,JSON.stringify({offline}));
    return before;
  }, { rowsKey: ROWS, controlKey: CONTROL, folders, offline });
  await h.page.goto(h.baseURL + '/');
  await h.page.locator(folders ? '#project-list [data-act="enter"]' : '#project-list [data-act="open"]').first().waitFor();
  return before;
}

async function setControl(page, patch) {
  await page.evaluate(({ key, patch }) => localStorage.setItem(key,JSON.stringify({...JSON.parse(localStorage.getItem(key)),...patch})), {key:CONTROL,patch});
}
async function state(page, id, blobId) {
  return page.evaluate(async ({ id, blobId, rowsKey, deletionPrefix, callsKey }) => ({
    local:await ProjectStorage.getProject(id) || null,
    blob:!!await ProjectStorage.getBlob(blobId),
    remote:JSON.parse(localStorage.getItem(rowsKey))[id] || null,
    operation:JSON.parse(localStorage.getItem(deletionPrefix+encodeURIComponent(id)) || 'null'),
    calls:JSON.parse(localStorage.getItem(callsKey) || '[]')
  }), { id,blobId,rowsKey:ROWS,deletionPrefix:DELETIONS,callsKey:CALLS });
}
function row(page, id) { return page.locator('#project-list > div').filter({has:page.locator('input.sel[value="'+id+'"]')}); }
async function clickDelete(page, id) {
  page.once('dialog', dialog => dialog.accept());
  await row(page,id).locator('[data-act="delete"]').click();
}
async function waitResult(page, id) {
  await page.locator('[data-deletion-result="'+id+'"]').waitFor();
  await page.waitForFunction(() => !document.getElementById('deletion-status').textContent.includes('削除を確認・処理中'));
}
async function renameFolder(page) {
  page.once('dialog', dialog => dialog.accept('Coronal renamed'));
  await page.locator('#project-list [data-act="rename"]').click();
  await page.locator('#folder-sync-retry').waitFor();
}

for (const action of ['retry','revert']) {
  test('folder '+action+' checks fresh connectivity after an offline load without reloading', {timeout:60000}, async () => {
    const h = await startBrowserHarness();
    try {
      const before = await fixture(h,{folders:true,offline:true});
      await renameFolder(h.page);
      await setControl(h.page,{offline:false});
      if (action === 'revert') h.page.once('dialog',dialog=>dialog.accept());
      await h.page.locator('#folder-sync-'+action).click();
      await h.page.waitForFunction(prefix => !Object.keys(localStorage).some(key=>key.startsWith(prefix)),FOLDERS);
      const result = await state(h.page,'one',before.one.blobId);
      assert.deepEqual(result.remote.folder_path,['Marmoset',action==='retry'?'Coronal renamed':'Coronal']);
      assert.deepEqual(result.local.roi,before.one.project.roi);
      assert.equal(result.blob,true);
      assert.deepEqual(h.errors,[]);
    } finally { await h.close(); }
  });
}

test('offline folder retry makes one attempt, retains intents and re-enables controls', {timeout:60000}, async () => {
  const h = await startBrowserHarness();
  try {
    await fixture(h,{folders:true,offline:true}); await renameFolder(h.page);
    const count = await h.page.evaluate(key=>JSON.parse(localStorage.getItem(key)).filter(c=>c.kind==='list').length,CALLS);
    await h.page.locator('#folder-sync-retry').click();
    await h.page.waitForFunction(()=>document.getElementById('global-error').textContent.includes('Synthetic offline'));
    assert.equal(await h.page.locator('#folder-sync-retry').isEnabled(),true);
    assert.equal(await h.page.evaluate(key=>JSON.parse(localStorage.getItem(key)).filter(c=>c.kind==='list').length,CALLS),count+1);
    assert.equal(await h.page.evaluate(prefix=>Object.keys(localStorage).filter(key=>key.startsWith(prefix)).length,FOLDERS),2);
  } finally { await h.close(); }
});

test('individual delete preserves local edits and blobs when the remote revision changes', {timeout:60000}, async () => {
  const h = await startBrowserHarness();
  try {
    const before = await fixture(h);
    await h.page.evaluate(async key=>{
      await ProjectStorage.patchProjectFields('one',{roi:{roi_names:{all:'Unsynced ROI'}}});
      const rows=JSON.parse(localStorage.getItem(key));rows.one.updated_at='2026-01-01T00:00:05.000Z';localStorage.setItem(key,JSON.stringify(rows));
    },ROWS);
    await clickDelete(h.page,'one'); await waitResult(h.page,'one');
    const result = await state(h.page,'one',before.one.blobId);
    assert.equal(result.local.roi.roi_names.all,'Unsynced ROI'); assert.equal(result.blob,true); assert.ok(result.remote);
    assert.equal(result.calls.filter(c=>c.kind==='delete').length,0);
    assert.match(await h.page.locator('#deletion-status').innerText(),/クラウドで更新/);
  } finally { await h.close(); }
});

test('bulk delete reports partial completion and retries only the failed original target', {timeout:60000}, async () => {
  const h = await startBrowserHarness();
  try {
    const before=await fixture(h); await setControl(h.page,{failDelete:'two'});
    await row(h.page,'one').locator('.sel').check(); await row(h.page,'two').locator('.sel').check();
    h.page.once('dialog',dialog=>dialog.accept()); await h.page.locator('#bulk-delete').click(); await waitResult(h.page,'two');
    let one=await state(h.page,'one',before.one.blobId),two=await state(h.page,'two',before.two.blobId);
    assert.equal(one.local,null);assert.equal(one.remote,null);assert.equal(one.blob,false);
    assert.ok(two.local);assert.ok(two.remote);assert.equal(two.blob,true);
    assert.match(await h.page.locator('#deletion-status').innerText(),/完了 1 件 \/ 未完了 1 件/);
    await setControl(h.page,{failDelete:null});
    await h.page.locator('[data-delete-retry="two"]').click();await waitResult(h.page,'two');
    two=await state(h.page,'two',before.two.blobId); assert.equal(two.local,null);assert.equal(two.remote,null);
    assert.equal(two.calls.filter(c=>c.kind==='delete'&&c.id==='one').length,1);
  } finally { await h.close(); }
});

test('conditional delete rejection during a request retains the local project', {timeout:60000}, async () => {
  const h=await startBrowserHarness();
  try {
    const before=await fixture(h);await h.page.evaluate(()=>window.__holdBeforeDelete=true);
    await clickDelete(h.page,'one');await h.page.waitForFunction(()=>window.__deleteWaiting);
    await h.page.evaluate(key=>{const rows=JSON.parse(localStorage.getItem(key));rows.one.updated_at='2026-01-01T00:00:05.000Z';localStorage.setItem(key,JSON.stringify(rows));window.__releaseDelete();},ROWS);
    await waitResult(h.page,'one');const result=await state(h.page,'one',before.one.blobId);
    assert.ok(result.local);assert.ok(result.remote);assert.equal(result.blob,true);assert.equal(result.operation.phase,'prepared');
  }finally{await h.close();}
});

test('unknown remote outcome preserves local data and resolves once after a reload', {timeout:60000}, async () => {
  const h=await startBrowserHarness();
  try {
    const before=await fixture(h);await setControl(h.page,{loseResponse:'one'});
    await clickDelete(h.page,'one');await waitResult(h.page,'one');
    let result=await state(h.page,'one',before.one.blobId);
    assert.equal(result.remote,null);assert.ok(result.local);assert.equal(result.blob,true);assert.equal(result.operation.phase,'prepared');
    await h.page.reload();await h.page.locator('[data-delete-retry="one"]').click();await waitResult(h.page,'one');
    result=await state(h.page,'one',before.one.blobId);
    assert.equal(result.local,null);assert.equal(result.blob,false);assert.equal(result.operation,null);
    assert.equal(result.calls.filter(c=>c.kind==='delete'&&c.id==='one').length,1);
  }finally{await h.close();}
});

test('local cleanup retry never repeats a confirmed remote deletion against a recreated row', {timeout:60000}, async () => {
  const h=await startBrowserHarness();
  try {
    const before=await fixture(h);
    await h.page.evaluate(()=>{ProjectStorage.deleteProject=async()=>{throw new Error('Synthetic local cleanup failed');};});
    await clickDelete(h.page,'one');await waitResult(h.page,'one');
    let result=await state(h.page,'one',before.one.blobId);
    assert.equal(result.remote,null);assert.ok(result.local);assert.equal(result.operation.phase,'remote-deleted');
    await h.page.evaluate(({key,source})=>{const rows=JSON.parse(localStorage.getItem(key));rows.one={...source,id:'one',display_name:'Recreated',updated_at:'2026-01-02T00:00:00.000Z',bundle_path:'synthetic/new.zip'};localStorage.setItem(key,JSON.stringify(rows));}, {key:ROWS,source:{folder_path:[],state:{},meta:{}}});
    await h.page.reload();await h.page.locator('[data-delete-retry="one"]').click();await waitResult(h.page,'one');
    result=await state(h.page,'one',before.one.blobId);
    assert.equal(result.local,null);assert.equal(result.remote.display_name,'Recreated');assert.equal(result.operation,null);
    assert.equal(result.calls.filter(c=>c.kind==='delete'&&c.id==='one').length,1);
  }finally{await h.close();}
});

test('concurrent local edits survive remote success and repeated cleanup attempts', {timeout:60000}, async () => {
  const h=await startBrowserHarness();
  try {
    const before=await fixture(h);await h.page.evaluate(()=>window.__holdAfterDelete=true);
    await clickDelete(h.page,'one');await h.page.waitForFunction(()=>window.__deleteWaiting);
    const other=await h.context.newPage();await other.goto(h.baseURL+'/__test_seed');
    await other.evaluate(()=>ProjectStorage.patchProjectFields('one',{roi:{roi_names:{all:'New concurrent ROI'}}}));
    await h.page.evaluate(()=>window.__releaseDelete());await waitResult(h.page,'one');
    let result=await state(h.page,'one',before.one.blobId);
    assert.equal(result.remote,null);assert.equal(result.local.roi.roi_names.all,'New concurrent ROI');assert.equal(result.blob,true);
    await h.page.locator('[data-delete-retry="one"]').click();await waitResult(h.page,'one');
    result=await state(h.page,'one',before.one.blobId);assert.equal(result.local.roi.roi_names.all,'New concurrent ROI');
    h.page.once('dialog',dialog=>dialog.accept());await h.page.locator('[data-delete-cancel="one"]').click();
    await h.page.waitForFunction(prefix=>!localStorage.getItem(prefix+'one'),DELETIONS);
    result=await state(h.page,'one',before.one.blobId);assert.ok(result.local);assert.equal(result.remote,null);
    assert.equal(result.calls.filter(c=>c.kind==='delete'&&c.id==='one').length,1);assert.deepEqual(h.errors,[]);
  }finally{await h.close();}
});

for (const reason of ['journal','locks','auth']) {
  test('delete fails safely before remote mutation when '+reason+' is unavailable', {timeout:60000}, async () => {
    const h=await startBrowserHarness();
    try {
      const before=await fixture(h);
      if(reason==='journal') await h.page.evaluate(prefix=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith(prefix))throw new Error('Synthetic journal unavailable');return original.call(this,key,value);};},DELETIONS);
      if(reason==='locks') await h.page.evaluate(()=>Object.defineProperty(navigator,'locks',{value:undefined}));
      if(reason==='auth') await setControl(h.page,{auth:false});
      await clickDelete(h.page,'one');await waitResult(h.page,'one');
      const result=await state(h.page,'one',before.one.blobId);
      assert.ok(result.local);assert.ok(result.remote);assert.equal(result.blob,true);
      assert.equal(result.calls.filter(c=>c.kind==='delete').length,0);
      if(reason==='auth') assert.equal(await h.page.locator('#cloud-gate').isVisible(),true);
    }finally{await h.close();}
  });
}

test('journal acknowledgement failure keeps local data and resolves without another remote delete', {timeout:60000}, async () => {
  const h=await startBrowserHarness();
  try {
    const before=await fixture(h);
    await h.page.evaluate(prefix=>{const original=Storage.prototype.setItem;window.__restoreJournal=()=>Storage.prototype.setItem=original;Storage.prototype.setItem=function(key,value){if(key.startsWith(prefix)&&JSON.parse(value).phase==='remote-deleted')throw new Error('Synthetic acknowledgement unavailable');return original.call(this,key,value);};},DELETIONS);
    await clickDelete(h.page,'one');await waitResult(h.page,'one');
    let result=await state(h.page,'one',before.one.blobId);
    assert.equal(result.remote,null);assert.ok(result.local);assert.equal(result.operation.phase,'prepared');
    await h.page.evaluate(()=>window.__restoreJournal());await h.page.locator('[data-delete-retry="one"]').click();await waitResult(h.page,'one');
    result=await state(h.page,'one',before.one.blobId);assert.equal(result.local,null);
    assert.equal(result.calls.filter(c=>c.kind==='delete'&&c.id==='one').length,1);
  }finally{await h.close();}
});

test('storage deletion checks the local revision atomically and preserves shared blobs', {timeout:60000}, async () => {
  const h=await startBrowserHarness();
  try {
    await h.page.goto(h.baseURL+'/__test_seed');
    const result=await h.page.evaluate(async()=>{
      const blobId=await ProjectStorage.putValueRaster(new Float32Array([3,4]));
      for(const id of ['a','b'])await ProjectStorage.putProject({id,displayName:id,molecules:[{key:'MSI_5-HT',blobId}],images:{}});
      const a=await ProjectStorage.getProject('a');
      const current=await ProjectStorage.patchProjectFields('a',{roi:{roi_names:{r:'Concurrent'}}});
      let conflict;try{await ProjectStorage.deleteProject('a',{expectedUpdatedAt:a.updatedAt});}catch(error){conflict=error.code;}
      const retained=!!await ProjectStorage.getProject('a'),blobRetained=!!await ProjectStorage.getBlob(blobId);
      await ProjectStorage.deleteProject('a',{expectedUpdatedAt:current.updatedAt});
      const shared=!!await ProjectStorage.getBlob(blobId),b=await ProjectStorage.getProject('b');
      await ProjectStorage.deleteProject('b',{expectedUpdatedAt:b.updatedAt});
      return{conflict,retained,blobRetained,shared,removed:!await ProjectStorage.getBlob(blobId)};
    });
    assert.deepEqual(result,{conflict:'LOCAL_CONFLICT',retained:true,blobRetained:true,shared:true,removed:true});
  }finally{await h.close();}
});


test('ordinary delete never silently resumes an older journal for a recreated remote row', {timeout:60000}, async()=>{
  const h=await startBrowserHarness();
  try {
    const before=await fixture(h);
    await h.page.evaluate(()=>{ProjectStorage.deleteProject=async()=>{throw new Error('Synthetic cleanup failure');};});
    await clickDelete(h.page,'one'); await waitResult(h.page,'one');
    const original=await state(h.page,'one',before.one.blobId);
    assert.equal(original.operation.phase,'remote-deleted');
    await h.page.evaluate(key=>{
      const rows=JSON.parse(localStorage.getItem(key));
      rows.one={id:'one',display_name:'Recreated',updated_at:'2026-01-02T00:00:00.000Z',bundle_path:'synthetic/recreated.zip',folder_path:[],state:{},meta:{}};
      localStorage.setItem(key,JSON.stringify(rows));
    },ROWS);
    await h.page.reload(); await row(h.page,'one').locator('[data-act="delete"]').waitFor();
    await clickDelete(h.page,'one'); await waitResult(h.page,'one');
    const result=await state(h.page,'one',before.one.blobId);
    assert.ok(result.local); assert.equal(result.blob,true);
    assert.equal(result.remote.display_name,'Recreated');
    assert.equal(result.operation.operationId,original.operation.operationId);
    assert.equal(result.calls.filter(c=>c.kind==='delete'&&c.id==='one').length,1);
    assert.match(await h.page.locator('[data-deletion-result="one"]').textContent(),/今回の削除は実行していません/);
    assert.deepEqual(h.errors,[]);
  } finally { await h.close(); }
});
