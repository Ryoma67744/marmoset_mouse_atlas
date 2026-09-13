'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');

async function setup(h) {
  await h.page.goto(h.baseURL + '/__test_seed');
  await h.page.addScriptTag({ url: h.baseURL + '/lib/cloud.js' });
  await h.page.addScriptTag({ url: h.baseURL + '/lib/project-sync.js' });
  await h.page.evaluate(async () => {
    const s = ProjectStorage;
    await s.putFolder({ id: 'species', name: 'Marmoset', parentId: null });
    await s.putFolder({ id: 'coronal', name: 'Coronal', parentId: 'species', normalizationGroupId: 'old-group' });
    window.testRows = {};
    for (const id of ['a', 'b']) {
      const values = new Float32Array([0, 2, NaN, -0]);
      const blobId = await s.putValueRaster(values);
      const p = { id, displayName: id, folderId: 'coronal', molecules: [{ key: 'MSI_D4', name: 'D4', blobId }],
        grid: { W: 2, H: 2 }, roi: { names: ['original'] },
        normalization: { id: 'profile-' + id, revision: 1, schemaVersion: 2,
          scope: { type: 'folder-depth', depth: 2, groupId: 'old-group', folderPath: ['Marmoset', 'Coronal'], memberIds: ['a', 'b'] },
          section: { Ds: 4, k: 2 }, reference: { Dref: 8 } },
        normalizationBinding: { groupId: 'old-group', memberId: id, folderPath: ['Marmoset', 'Coronal'] },
        cloudRev: 1, cloudBundlePath: id + '/bundle-1.zip', cloudUpdatedAt: '2026-01-01T00:00:00.000Z' };
      p.cloudStateHash = Cloud.hashState(Cloud.stateOf(p)); await s.putProject(p);
      testRows[id] = { id, display_name: id, folder_path: ['Marmoset', 'Coronal'], bundle_rev: 1,
        bundle_path: p.cloudBundlePath, updated_at: p.cloudUpdatedAt, state: structuredClone(Cloud.stateOf(p)), meta: Cloud.metaOf(p) };
    }
    Cloud.configured = () => true; Cloud.signedIn = () => true;
    Cloud.getProject = async id => structuredClone(testRows[id]);
    Cloud.listProjects = async () => structuredClone(Object.values(testRows));
    Cloud.patchRowIfUnchanged = async (id, patch, expected) => {
      if (testRows[id].updated_at !== expected) return null;
      Object.assign(testRows[id], structuredClone(patch), { updated_at: '2026-01-03T00:00:00.000Z' });
      return structuredClone(testRows[id]);
    };
  });
}

test('shared sync + IndexedDB adopts new profiles and safely migrates stale folder UUID across cached siblings', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await setup(h);
    const result = await h.page.evaluate(async () => {
      const before = await ProjectStorage.getProject('a');
      const bitsBefore = Array.from(new Uint32Array((await ProjectStorage.getValueRaster(before.molecules[0].blobId)).buffer));
      for (const row of Object.values(testRows)) {
        row.updated_at = '2026-01-02T00:00:00.000Z';
        row.state.normalizationBinding.groupId = 'repaired-group';
        row.state.normalization = structuredClone(row.state.normalization);
        row.state.normalization.id = 'repaired-' + row.id;
        row.state.normalization.scope.groupId = 'repaired-group';
        row.state.normalization.revision = 2;
      }
      const a = await ProjectSync.ensureLocal('a');
      const bBeforeRead = await ProjectStorage.getProject('b');
      const b = await ProjectSync.ensureLocal('b');
      const bitsAfter = Array.from(new Uint32Array((await ProjectStorage.getValueRaster(a.molecules[0].blobId)).buffer));
      return { profileA: a.normalization.id, profileB: b.normalization.id, k: a.normalization.section.k,
        folderGroup: (await ProjectStorage.getFolder('coronal')).normalizationGroupId,
        siblingBindingBeforeRead: bBeforeRead.normalizationBinding.groupId,
        siblingBaselineBeforeRead: bBeforeRead.cloudUpdatedAt,
        siblingProfileBeforeRead: bBeforeRead.normalization.id,
        bitsBefore, bitsAfter, clean: Cloud.hashState(Cloud.stateOf(a)) === a.cloudStateHash };
    });
    assert.equal(result.profileA, 'repaired-a'); assert.equal(result.profileB, 'repaired-b');
    assert.equal(result.folderGroup, 'repaired-group'); assert.equal(result.siblingBindingBeforeRead, 'repaired-group');
    assert.equal(result.siblingBaselineBeforeRead, '2026-01-01T00:00:00.000Z');
    assert.equal(result.siblingProfileBeforeRead, 'profile-b'); assert.equal(result.k, 2);
    assert.deepEqual(result.bitsBefore, result.bitsAfter); assert.equal(result.clean, true);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('old Master name edit followed by Viewer save preserves the remote normalization with real IndexedDB', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await setup(h);
    const result = await h.page.evaluate(async () => {
      testRows.a.updated_at = '2026-01-02T00:00:00.000Z';
      testRows.a.state.normalization.id = 'newer-remote-profile';
      await ProjectStorage.patchProjectFields('a', { displayName: 'renamed' });
      await ProjectSync.patchMetadata('a', { display_name: 'renamed' });
      const p = await ProjectStorage.getProject('a');
      let error = '';
      try { await ProjectSync.saveState(p); } catch (e) { error = e.message; }
      return { error, localBaseline: p.cloudUpdatedAt, remoteProfile: testRows.a.state.normalization.id,
        localProfile: p.normalization.id, name: p.displayName };
    });
    assert.match(result.error, /クラウドの内容が更新/);
    assert.equal(result.localBaseline, '2026-01-01T00:00:00.000Z');
    assert.equal(result.remoteProfile, 'newer-remote-profile'); assert.equal(result.localProfile, 'profile-a');
    assert.equal(result.name, 'renamed'); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('a pending in-memory Viewer edit aborts the final IndexedDB remote-state transaction', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await setup(h);
    const result = await h.page.evaluate(async () => {
      testRows.a.updated_at = '2026-01-02T00:00:00.000Z'; testRows.a.state.normalization.id = 'new-profile';
      let checks = 0, message = '';
      try { await ProjectSync.ensureLocal('a', { canApplyRemote: () => ++checks === 1 }); }
      catch (e) { message = e.message; }
      return { checks, message, profile: (await ProjectStorage.getProject('a')).normalization.id };
    });
    assert.ok(result.checks >= 2); assert.match(result.message, /編集中/); assert.equal(result.profile, 'profile-a');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
