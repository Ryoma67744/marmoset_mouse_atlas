'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');

async function ready(h) {
  await h.page.goto(h.baseURL + '/__test_seed');
  for (const script of ['/node_modules/jszip/dist/jszip.min.js', '/lib/cloud.js', '/lib/zipio.js']) {
    await h.page.addScriptTag({ url: h.baseURL + script });
  }
}

test('ordinary field patches preserve newer profiles, CAS pins absence, and notifications follow committed writes across tabs', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await ready(h);
    const second = await h.context.newPage();
    await second.goto(h.baseURL + '/__test_seed');
    await second.evaluate(() => {
      window.received = [];
      ProjectStorage.subscribeChanges(async event => {
        for (const id of event.projectIds) received.push({ id, value: (await ProjectStorage.getProject(id))?.displayName });
      });
    });
    const result = await h.page.evaluate(async () => {
      const s = ProjectStorage;
      const old = await s.saveProjectIfUnchanged({ id: 'p', displayName: 'Original', normalization: { id: 'old' }, roi: { exact: [1, 2] } }, null);
      const changed = structuredClone(old); changed.normalization = { id: 'new' };
      await s.saveProjectIfUnchanged(changed, old.updatedAt);
      const patched = await s.patchProjectFields('p', { displayName: 'Renamed' });
      let stale = false, forbidden = false, absent = false;
      try { await s.saveProjectIfUnchanged(old, old.updatedAt); } catch (e) { stale = e.code === 'LOCAL_CONFLICT'; }
      try { await s.patchProjectFields('p', { normalization: null }); } catch (e) { forbidden = true; }
      try { await s.saveProjectIfUnchanged({ id: 'p', normalization: null }, null); } catch (e) { absent = e.code === 'LOCAL_CONFLICT'; }
      const folderId = await s.ensureFolderPath(['Marmoset', 'Coronal']);
      await s.restoreNormalizationGroup(folderId, 'new-group-id');
      const renamedFolder = await s.patchFolderFields(folderId, { name: 'Renamed group' });
      return { folderIdentity: renamedFolder.normalizationGroupId, profile: patched.normalization.id, roi: patched.roi, stale, forbidden, absent,
        timestampAdvanced: changed.updatedAt !== old.updatedAt, saved: await s.getProject('p') };
    });
    assert.equal(result.profile, 'new');
    assert.equal(result.folderIdentity, 'new-group-id');
    assert.deepEqual(result.roi, { exact: [1, 2] });
    assert.equal(result.stale && result.forbidden && result.absent && result.timestampAdvanced, true);
    assert.equal(result.saved.displayName, 'Renamed');
    await second.waitForFunction(() => received.some(item => item.id === 'p' && item.value === 'Renamed'));
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('ZIP replacement racing a new profile rolls back folders and staged blobs while preserving exact existing raw bytes', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await ready(h);
    const result = await h.page.evaluate(async () => {
      const s = ProjectStorage;
      const values = new Float32Array([0, -0, NaN, 3.5]);
      const blobId = await s.putValueRaster(values);
      const old = await s.saveProjectIfUnchanged({ id: 'p', displayName: 'Existing', grid: { W: 2, H: 2 },
        molecules: [{ key: 'd', name: 'D4-5-HT', blobId }], images: {}, normalization: { id: 'kept' } }, null);
      const incoming = Object.assign({}, old, { folderPath: ['New root', 'New folder'], normalization: null });
      const archive = await ZipIO.exportProject(incoming, { storage: s });
      const originalPut = s.putValueRaster.bind(s), staged = [];
      let release, started;
      const signal = new Promise(resolve => { started = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      s.putValueRaster = async array => { const id = await originalPut(array); staged.push(id); started(); await gate; return id; };
      const pending = ZipIO.importZip(archive, { storage: s, id: 'p', expectedUpdatedAt: old.updatedAt, expectedFolders: [] }).then(() => '', error => error.message);
      await signal;
      const fresh = await s.getProject('p'); fresh.normalization = { id: 'newer-profile', section: { k: 1.75 } };
      await s.saveProjectIfUnchanged(fresh, fresh.updatedAt);
      release();
      const error = await pending;
      s.putValueRaster = originalPut;
      const after = await s.getProject('p');
      const stagedRemain = await Promise.all(staged.map(id => s.getBlob(id)));
      return { error, profile: after.normalization.id, folders: await s.listFolders(), stagedRemain: stagedRemain.filter(Boolean).length,
        beforeBits: Array.from(new Uint8Array(values.buffer)), afterBits: Array.from(new Uint8Array((await s.getValueRaster(blobId)).buffer)),
        blobId: after.molecules[0].blobId, originalBlob: blobId };
    });
    assert.match(result.error, /更新/);
    assert.equal(result.profile, 'newer-profile');
    assert.deepEqual(result.folders, []);
    assert.equal(result.stagedRemain, 0);
    assert.deepEqual(result.beforeBits, result.afterBits);
    assert.equal(result.blobId, result.originalBlob);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('import final transaction checks absent projects and folder revisions, and aborts folder creation on project write failure', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await ready(h);
    const result = await h.page.evaluate(async () => {
      const s = ProjectStorage;
      await s.saveProjectIfUnchanged({ id: 'race', displayName: 'Created concurrently', normalization: { id: 'keep' } }, null);
      let absent = false, foldersChanged = false, abort = false, pendingEdit = false, pendingMove = false;
      try { await s.commitImportedProject({ id: 'race' }, { expectedUpdatedAt: null, expectedFolders: [], folderPath: ['A', 'B'] }); }
      catch (e) { absent = e.code === 'LOCAL_CONFLICT'; }
      await s.putFolder({ id: 'outside', name: 'Added during download' });
      try { await s.commitImportedProject({ id: 'new' }, { expectedUpdatedAt: null, expectedFolders: [], folderPath: ['A', 'B'] }); }
      catch (e) { foldersChanged = e.code === 'LOCAL_CONFLICT'; }
      try { await s.commitImportedProject({ id: 'ui-edit' }, { expectedUpdatedAt: null, folderPath: ['A', 'B'], canApplyRemote: () => false }); }
      catch (e) { pendingEdit = e.code === 'LOCAL_CONFLICT'; }
      try { await s.commitImportedProject({ id: 'late-move' }, { expectedUpdatedAt: null, folderPath: ['A', 'B'], pendingFolderChanges: () => ({ 'late-move': { path: ['C'] } }) }); }
      catch (e) { pendingMove = e.code === 'LOCAL_CONFLICT'; }
      const before = JSON.stringify(await s.listFolders());
      try { await s.commitImportedProject({ id: 'invalid', functionCannotBeCloned() {} }, { expectedUpdatedAt: null, folderPath: ['A', 'B'] }); }
      catch (e) { abort = true; }
      return { absent, foldersChanged, abort, pendingEdit, pendingMove, foldersUnchanged: before === JSON.stringify(await s.listFolders()),
        invalidExists: !!(await s.getProject('invalid')), profile: (await s.getProject('race')).normalization.id };
    });
    assert.equal(result.absent && result.foldersChanged && result.abort && result.pendingEdit && result.pendingMove && result.foldersUnchanged, true);
    assert.equal(result.invalidExists, false);
    assert.equal(result.profile, 'keep');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('authoritative cloud UUID repair changes mutable identity only and refuses dirty siblings', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await ready(h);
    const result = await h.page.evaluate(async () => {
      const s = ProjectStorage;
      const folderId = await s.ensureFolderPath(['Marmoset', 'Coronal']);
      await s.restoreNormalizationGroup(folderId, 'old-group');
      for (const id of ['a', 'b']) {
        const project = { id, folderId, displayName: id, normalization: { schemaVersion: 2, id: 'old-profile', scope: { groupId: 'old-group', memberIds: ['a', 'b'] }, section: { k: 2 } },
          normalizationBinding: { groupId: 'old-group', memberId: id, folderPath: ['Marmoset', 'Coronal'] }, cloudUpdatedAt: 'old-time' };
        project.cloudStateHash = Cloud.hashState(Cloud.stateOf(project));
        await s.saveProjectIfUnchanged(project, null);
      }
      const a = await s.getProject('a'), b = await s.getProject('b'), oldProfileB = JSON.stringify(b.normalization);
      const authority = [a, b].map(project => {
        const state = structuredClone(Cloud.stateOf(project));
        state.normalizationBinding.groupId = 'new-group';
        state.normalization = { id: 'remote-new-profile', section: { k: 3 }, scope: { groupId: 'new-group' } };
        return { id: project.id, state, folder_path: ['Marmoset', 'Coronal'], updated_at: 'new-time' };
      });
      const incoming = structuredClone(a); incoming.normalizationBinding.groupId = 'new-group';
      incoming.normalization = authority[0].state.normalization;
      const dirty = await s.patchProjectFields('b', { roi: { unsaved: true } });
      let rejected = false;
      try { await s.commitImportedProject(incoming, { expectedUpdatedAt: a.updatedAt, folderPath: ['Marmoset', 'Coronal'], authoritativeRows: authority }); }
      catch (e) { rejected = /未同期/.test(e.message); }
      const identityAfterRejection = (await s.getFolder(folderId)).normalizationGroupId;
      await s.saveProjectIfUnchanged(b, dirty.updatedAt);
      await s.commitImportedProject(incoming, { expectedUpdatedAt: a.updatedAt, folderPath: ['Marmoset', 'Coronal'], authoritativeRows: authority });
      const afterB = await s.getProject('b');
      return { rejected, identityAfterRejection, identityAfter: (await s.getFolder(folderId)).normalizationGroupId,
        siblingBinding: afterB.normalizationBinding.groupId, siblingSnapshotUnchanged: JSON.stringify(afterB.normalization) === oldProfileB,
        siblingRevision: afterB.cloudUpdatedAt, siblingClean: Cloud.hashState(Cloud.stateOf(afterB)) === afterB.cloudStateHash };
    });
    assert.equal(result.rejected, true);
    assert.equal(result.identityAfterRejection, 'old-group');
    assert.equal(result.identityAfter, 'new-group');
    assert.equal(result.siblingBinding, 'new-group');
    assert.equal(result.siblingSnapshotUnchanged, true);
    assert.equal(result.siblingRevision, 'old-time');
    assert.equal(result.siblingClean, true);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('guarded merge preserves concurrent source profiles and cleanup keeps blobs still referenced by another project', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await ready(h);
    const result = await h.page.evaluate(async () => {
      const s = ProjectStorage, blobId = await s.putValueRaster(new Float32Array([1, 2]));
      const a = await s.saveProjectIfUnchanged({ id: 'a', molecules: [{ blobId }], normalization: { id: 'a-profile' } }, null);
      const b = await s.saveProjectIfUnchanged({ id: 'b', molecules: [{ blobId }], normalization: { id: 'b-profile' } }, null);
      await s.patchProjectFields('b', { displayName: 'newer' });
      let rejected = false;
      try { await s.commitProjectMerge(a, { expectedRevisions: [{ id: 'a', updatedAt: a.updatedAt }, { id: 'b', updatedAt: b.updatedAt }] }); }
      catch (e) { rejected = e.code === 'LOCAL_CONFLICT'; }
      await s.deleteProject('a');
      await s.deleteUnreferencedBlobs([blobId]);
      return { rejected, profileB: (await s.getProject('b')).normalization.id, sharedRetained: !!(await s.getBlob(blobId)) };
    });
    assert.equal(result.rejected && result.sharedRetained, true);
    assert.equal(result.profileB, 'b-profile');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
