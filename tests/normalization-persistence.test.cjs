'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');

test('scoped IndexedDB save rejects changed membership/ancestry and commits identity and profiles together', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await h.page.goto(h.baseURL + '/__test_seed');
    await h.page.addScriptTag({ url: h.baseURL + '/lib/normalization-scope.js' });
    const result = await h.page.evaluate(async () => {
      const s = ProjectStorage;
      for (const f of [
        { id: 'root', name: 'Marmoset', parentId: null },
        { id: 'group', name: 'Coronal', parentId: 'root' },
        { id: 'child', name: 'Child', parentId: 'group' },
        { id: 'other', name: 'Sagittal', parentId: 'root' },
      ]) await s.putFolder(f);
      for (const p of [
        { id: 'a', displayName: 'A', folderId: 'group' },
        { id: 'b', displayName: 'B', folderId: 'child' },
      ]) await s.putProject(p);
      const prepare = async () => {
        const projects = await s.listProjects(), folders = await s.listFolders();
        return {
          guard: Object.assign(NormalizationScope.snapshot(projects, folders, 'group'), { groupId: 'fixed-group-id' }),
          updates: projects.filter(p => ['a', 'b'].includes(p.id)).map(p => ({
            project: Object.assign({}, p, { normalization: { id: 'reviewed' } }), expectedUpdatedAt: p.updatedAt,
          })),
        };
      };
      const initial = await prepare();
      await s.putProject({ id: 'late', displayName: 'Added after preview', folderId: 'child' });
      let addedRejected = false;
      try { await s.putProjectsIfUnchanged(initial.updates, initial.guard); } catch (e) { addedRejected = /構成|対象/.test(e.message); }
      await s.deleteProjectRecord('late');
      const renamed = await prepare();
      const ancestor = await s.getFolder('root'); ancestor.name = 'Renamed'; await s.putFolder(ancestor);
      let renameRejected = false;
      try { await s.putProjectsIfUnchanged(renamed.updates, renamed.guard); } catch (e) { renameRejected = /構成|対象/.test(e.message); }
      const afterRejected = {
        groupId: (await s.getFolder('group')).normalizationGroupId || null,
        savedCount: (await s.listProjects()).filter(p => p.normalization).length,
      };
      const ready = await prepare();
      const unrelated = await s.getFolder('other'); unrelated.name = 'Other changed'; await s.putFolder(unrelated);
      await s.putProjectsIfUnchanged(ready.updates, ready.guard);
      const after = { groupId: (await s.getFolder('group')).normalizationGroupId,
        savedCount: (await s.listProjects()).filter(p => p.normalization).length };
      const newGuard = await prepare();
      let partialRejected = false;
      try { await s.putProjectsIfUnchanged(newGuard.updates.slice(0, 1), newGuard.guard); } catch (e) { partialRejected = true; }
      return { addedRejected, renameRejected, afterRejected, after, partialRejected };
    });
    assert.equal(result.addedRejected, true);
    assert.equal(result.renameRejected, true);
    assert.deepEqual(result.afterRejected, { groupId: null, savedCount: 0 });
    assert.deepEqual(result.after, { groupId: 'fixed-group-id', savedCount: 2 });
    assert.equal(result.partialRejected, true);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('ZIP group UUID restoration reuses the second ancestor and rejects conflicting identities', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await h.page.goto(h.baseURL + '/__test_seed');
    await h.page.addScriptTag({ url: h.baseURL + '/lib/normalization-scope.js' });
    const result = await h.page.evaluate(async () => {
      const s = ProjectStorage;
      const folderId = await s.ensureFolderPath(['Marmoset', 'Coronal', 'Child']);
      const restored = await s.restoreNormalizationGroup(folderId, 'portable-group');
      const reused = await s.restoreNormalizationGroup(folderId, 'portable-group');
      let message = '';
      try { await s.restoreNormalizationGroup(folderId, 'different-group'); } catch (e) { message = e.message; }
      const second = await s.ensureFolderPath(['Marmoset', 'Sagittal']);
      await s.putProject({ id: 'restored-earlier', folderId: second, normalizationBinding: {
        groupId: 'existing-binding-group', folderPath: ['Marmoset', 'Sagittal'], memberId: 'portable-member',
      } });
      let inferredConflict = false;
      try { await s.restoreNormalizationGroup(second, 'different-group'); } catch (e) { inferredConflict = true; }
      const folders = await s.listFolders();
      return { restored, reused, message, inferredConflict,
        groupId: folders.find(f => f.name === 'Coronal').normalizationGroupId,
        inferredFolderId: folders.find(f => f.name === 'Sagittal').normalizationGroupId || null,
        leafGroupId: folders.find(f => f.name === 'Child').normalizationGroupId || null };
    });
    assert.equal(result.restored.restored, true);
    assert.equal(result.reused.restored, false);
    assert.match(result.message, /グループID.*一致しません/);
    assert.equal(result.groupId, 'portable-group');
    assert.equal(result.leafGroupId, null);
    assert.equal(result.inferredConflict, true);
    assert.equal(result.inferredFolderId, null);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('explicit guarded group identity repair updates every member and leaves the other folder untouched', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await h.page.goto(h.baseURL + '/__test_seed');
    const result = await h.page.evaluate(async () => {
      const s = ProjectStorage;
      for (const f of [
        { id: 'root', name: 'Marmoset', parentId: null },
        { id: 'a-folder', name: 'Coronal', parentId: 'root', normalizationGroupId: 'duplicated-id' },
        { id: 'b-folder', name: 'Sagittal', parentId: 'root', normalizationGroupId: 'duplicated-id' },
      ]) await s.putFolder(f);
      for (const [id, folderId, label] of [['a', 'a-folder', 'Coronal'], ['b', 'b-folder', 'Sagittal']]) {
        await s.putProject({ id, displayName: id, folderId,
          normalization: { schemaVersion: 2, id: 'old', scope: { groupId: 'duplicated-id' } },
          normalizationBinding: { groupId: 'duplicated-id', folderPath: ['Marmoset', label], memberId: id },
        });
      }
      const oldA = await s.getProject('a');
      const beforeB = JSON.stringify({ folder: await s.getFolder('b-folder'), project: await s.getProject('b') });
      const guard = Object.assign(NormalizationScope.snapshot(await s.listProjects(), await s.listFolders(), 'a-folder'), {
        groupId: 'repaired-id',
      });
      const nextA = structuredClone(oldA);
      nextA.normalization.scope.groupId = 'repaired-id';
      nextA.normalizationBinding.groupId = 'repaired-id';
      const updates = [{ project: nextA, expectedUpdatedAt: oldA.updatedAt }];
      let withoutFlag = false, mismatchedBinding = false;
      try { await s.putProjectsIfUnchanged(updates, guard); } catch (e) { withoutFlag = true; }
      guard.reassignGroupId = true;
      const malformed = structuredClone(updates);
      malformed[0].project.normalizationBinding.groupId = 'duplicated-id';
      try { await s.putProjectsIfUnchanged(malformed, guard); } catch (e) { mismatchedBinding = true; }
      const beforeSuccess = (await s.getFolder('a-folder')).normalizationGroupId;
      await s.putProjectsIfUnchanged(updates, guard);
      const afterA = await s.getProject('a');
      return { withoutFlag, mismatchedBinding, beforeSuccess,
        repairedGroupId: (await s.getFolder('a-folder')).normalizationGroupId,
        profileGroupId: afterA.normalization.scope.groupId,
        bindingGroupId: afterA.normalizationBinding.groupId,
        otherUnchanged: beforeB === JSON.stringify({ folder: await s.getFolder('b-folder'), project: await s.getProject('b') }),
      };
    });
    assert.equal(result.withoutFlag, true);
    assert.equal(result.mismatchedBinding, true);
    assert.equal(result.beforeSuccess, 'duplicated-id');
    assert.equal(result.repairedGroupId, 'repaired-id');
    assert.equal(result.profileGroupId, 'repaired-id');
    assert.equal(result.bindingGroupId, 'repaired-id');
    assert.equal(result.otherUnchanged, true);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
