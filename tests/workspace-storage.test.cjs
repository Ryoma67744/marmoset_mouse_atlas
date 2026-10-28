'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');

async function ready(h, workspaceId) {
  if (workspaceId !== undefined) await h.page.addInitScript(id => { window.ATLAS_OFFLINE_WORKSPACE_ID = id; }, workspaceId);
  await h.page.goto(h.baseURL + '/__test_seed');
  await h.page.evaluate(() => {
    window.workspaceFixture = () => {
      // Include exact NaN payload and signed zero bits: JSON/CSV conversion must
      // never stand between the snapshot and these scientific arrays.
      const bits = new Uint32Array([0, 0x80000000, 0x7fc00123, 0x3fc00000]);
      return {
        projects: [{ id: 'section-a', displayName: 'Section A', folderId: 'group', grid: { W: 2, H: 2 },
          molecules: [{ key: 'MSI_DA', name: 'DA', blobId: 'raw' }], images: { HE_Stain: { blobId: 'he' } },
          normalization: { id: 'profile', scope: { groupId: 'group-uuid', memberIds: ['section-a'] }, reference: { projectIds: ['section-a'] } },
          normalizationBinding: { groupId: 'group-uuid', memberId: 'section-a', folderPath: ['Study', 'Group'] },
          roi: { roi_names: { r1: 'ROI A' }, roi_items: { r1: [{ poly_msi: [[0, 0], [1, 0], [1, 1]] }] } },
          stack3d: { offsetXUm: 2, offsetYUm: 3, rotationDeg: 45 }, layerDisplay: { HE_Stain: { rawRange: undefined } },
          scientificSpecials: { value: NaN, signedZero: -0 }, createdAt: 'original-created', updatedAt: 'original-revision',
          cloudUpdatedAt: 'server-time', cloudPending: true, cloudStateHash: 'hash', cloudBundlePath: 'private/path', __view: 'derived' }],
        folders: [{ id: 'root', name: 'Study', parentId: null }, { id: 'group', name: 'Group', parentId: 'root', normalizationGroupId: 'group-uuid' },
          { id: 'empty', name: 'Empty folder', parentId: 'root' }],
        blobs: [{ id: 'raw', blob: new Blob([bits.buffer], { type: 'application/octet-stream' }), mime: 'application/octet-stream', filename: 'raster.f32' },
          { id: 'he', blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), mime: 'image/png', filename: 'HE.png' }],
      };
    };
    window.workspaceStoreCounts = async () => {
      const names = (await indexedDB.databases()).map(db => db.name);
      const name = names.find(value => value === 'marmoset-atlas-offline-' + window.ATLAS_OFFLINE_WORKSPACE_ID) || 'marmoset-atlas';
      const db = await new Promise((resolve, reject) => { const req = indexedDB.open(name); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      try {
        return await new Promise((resolve, reject) => {
          const counts = {}, tx = db.transaction(['projects', 'folders', 'blobs'], 'readonly');
          for (const key of ['projects', 'folders', 'blobs']) { const req = tx.objectStore(key).count(); req.onsuccess = () => { counts[key] = req.result; }; }
          tx.oncomplete = () => resolve(counts); tx.onabort = () => reject(tx.error);
        });
      } finally { db.close(); }
    };
  });
}

test('workspace snapshot uses one consistent transaction and preserves scientific bytes, IDs, and empty folders without cloud state', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await ready(h);
    const result = await h.page.evaluate(async () => {
      const source = workspaceFixture();
      for (const folder of source.folders) await ProjectStorage.putFolder(folder);
      for (const blob of source.blobs) await ProjectStorage.putBlob(blob);
      await ProjectStorage.putBlob({ id: 'orphan', blob: new Blob(['staging']), mime: 'text/plain', filename: 'staging.txt' });
      for (const project of source.projects) await ProjectStorage.putProject(project);
      const originalTransaction = IDBDatabase.prototype.transaction, transactions = [];
      IDBDatabase.prototype.transaction = function (names, mode, ...rest) { transactions.push({ names: Array.from(names), mode }); return originalTransaction.call(this, names, mode, ...rest); };
      let snapshot;
      try { snapshot = await ProjectStorage.exportWorkspaceSnapshot(); } finally { IDBDatabase.prototype.transaction = originalTransaction; }
      const original = await ProjectStorage.getProject('section-a');
      const target = snapshot.projects[0];
      return { transactions, projectIds: snapshot.projects.map(p => p.id), folderIds: snapshot.folders.map(f => f.id), blobIds: snapshot.blobs.map(b => b.id).sort(),
        bits: Array.from(new Uint32Array(await snapshot.blobs.find(b => b.id === 'raw').blob.arrayBuffer())),
        imageBytes: Array.from(new Uint8Array(await snapshot.blobs.find(b => b.id === 'he').blob.arrayBuffer())),
        kept: target.normalizationBinding, scope: target.normalization.scope, roi: target.roi, layout: target.stack3d,
        groupId: snapshot.folders.find(f => f.id === 'group').normalizationGroupId,
        removed: Object.keys(target).filter(key => /^cloud[A-Z]|^__/.test(key)), originalStillHasCloud: original.cloudPending,
        nan: Number.isNaN(target.scientificSpecials.value), signedZero: Object.is(target.scientificSpecials.signedZero, -0),
        undefinedPresent: Object.hasOwn(target.layerDisplay.HE_Stain, 'rawRange') };
    });
    assert.deepEqual(result.transactions, [{ names: ['projects', 'folders', 'blobs'], mode: 'readonly' }]);
    assert.deepEqual(result.projectIds, ['section-a']);
    assert.deepEqual(result.folderIds.sort(), ['empty', 'group', 'root']);
    assert.deepEqual(result.blobIds, ['he', 'raw']);
    assert.deepEqual(result.bits, [0, 0x80000000, 0x7fc00123, 0x3fc00000]);
    assert.deepEqual(result.imageBytes, [137, 80, 78, 71]);
    assert.equal(result.groupId, 'group-uuid');
    assert.equal(result.kept.memberId, 'section-a');
    assert.deepEqual(result.scope.memberIds, ['section-a']);
    assert.equal(result.roi.roi_names.r1, 'ROI A');
    assert.equal(result.layout.rotationDeg, 45);
    assert.deepEqual(result.removed, []);
    assert.equal(result.originalStillHasCloud && result.nan && result.signedZero && result.undefinedPresent, true);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('workspace restore preserves records atomically and detaches caller mutations before opening the database', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await ready(h, 'restore-example');
    const result = await h.page.evaluate(async () => {
      const source = workspaceFixture(), events = [];
      ProjectStorage.subscribeChanges(change => events.push(change));
      const pending = ProjectStorage.restoreWorkspaceSnapshot(source);
      source.projects[0].displayName = 'Mutated after call'; source.folders.length = 0; source.blobs.length = 0;
      const counts = await pending;
      const project = await ProjectStorage.getProject('section-a'), snapshot = await ProjectStorage.exportWorkspaceSnapshot();
      return { counts, storeCounts: await workspaceStoreCounts(), displayName: project.displayName, updatedAt: project.updatedAt,
        profile: project.normalization, group: project.normalizationBinding, removed: Object.keys(project).filter(k => /^cloud[A-Z]|^__/.test(k)), events,
        bits: Array.from(new Uint32Array(await snapshot.blobs.find(b => b.id === 'raw').blob.arrayBuffer())) };
    });
    assert.deepEqual(result.counts, { projectCount: 1, folderCount: 3, blobCount: 2 });
    assert.deepEqual(result.storeCounts, { projects: 1, folders: 3, blobs: 2 });
    assert.equal(result.displayName, 'Section A');
    assert.equal(result.updatedAt, 'original-revision');
    assert.equal(result.profile.scope.groupId, 'group-uuid');
    assert.equal(result.group.memberId, 'section-a');
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.events, [{ projectIds: ['section-a'], folderIds: ['root', 'group', 'empty'] }]);
    assert.deepEqual(result.bits, [0, 0x80000000, 0x7fc00123, 0x3fc00000]);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('workspace restore rejects duplicate IDs, invalid references/cycles and incomplete binary records before making any writes', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await ready(h);
    const result = await h.page.evaluate(async () => {
      await ProjectStorage.listProjects();
      const cases = [
        () => null,
        s => { s.projects = {}; return s; },
        s => { s.folders = null; return s; },
        s => { s.blobs = [null]; return s; },
        s => { s.projects.push(s.projects[0]); return s; },
        s => { s.folders.push(s.folders[0]); return s; },
        s => { s.blobs.push(s.blobs[0]); return s; },
        s => { s.projects[0].folderId = 'absent'; return s; },
        s => { s.folders[0].parentId = 'absent'; return s; },
        s => { s.folders[0].parentId = 'group'; return s; },
        s => { s.folders[0].parentId = 'root'; return s; },
        s => { s.projects[0].molecules = null; return s; },
        s => { s.projects[0].molecules[0].blobId = 'absent'; return s; },
        s => { delete s.projects[0].molecules[0].blobId; return s; },
        s => { s.projects[0].images = []; return s; },
        s => { s.projects[0].images.HE_Stain = null; return s; },
        s => { s.blobs[0].blob = new Uint8Array(16); return s; },
        s => { s.blobs[0].blob = new Blob([new Uint8Array(12)]); return s; },
        s => { s.blobs[1].blob = new Blob([]); return s; },
      ];
      const failures = [];
      for (const make of cases) {
        try { await ProjectStorage.restoreWorkspaceSnapshot(make(workspaceFixture())); failures.push(false); }
        catch (error) { failures.push(error.code === 'INVALID_WORKSPACE'); }
      }
      const invalidCounts = await workspaceStoreCounts();
      const empty = await ProjectStorage.restoreWorkspaceSnapshot({ projects: [{ id: 'empty-project', molecules: [], images: {} }], folders: [], blobs: [] });
      return { failures, invalidCounts, empty };
    });
    assert.equal(result.failures.length, 19);
    assert.equal(result.failures.every(Boolean), true);
    assert.deepEqual(result.invalidCounts, { projects: 0, folders: 0, blobs: 0 });
    assert.deepEqual(result.empty, { projectCount: 1, folderCount: 0, blobCount: 0 });
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('workspace export refuses missing and truncated scientific files instead of producing a partial snapshot', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await ready(h);
    const result = await h.page.evaluate(async () => {
      const source = workspaceFixture();
      for (const folder of source.folders) await ProjectStorage.putFolder(folder);
      await ProjectStorage.putProject(source.projects[0]);
      let missing = false, truncated = false;
      try { await ProjectStorage.exportWorkspaceSnapshot(); } catch (error) { missing = /ファイルがありません/.test(error.message); }
      for (const blob of source.blobs) await ProjectStorage.putBlob(blob);
      await ProjectStorage.putBlob({ id: 'raw', blob: new Blob([new Uint8Array(8)]) });
      try { await ProjectStorage.exportWorkspaceSnapshot(); } catch (error) { truncated = /長さが一致/.test(error.message); }
      return { missing, truncated, projectStillExists: !!await ProjectStorage.getProject('section-a') };
    });
    assert.deepEqual(result, { missing: true, truncated: true, projectStillExists: true });
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('workspace restore checks all stores under one write lock and rolls back collisions and failed writes', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await ready(h);
    const result = await h.page.evaluate(async () => {
      const blocked = [];
      for (const kind of ['project', 'folder', 'blob']) {
        await ProjectStorage.clearAll();
        if (kind === 'project') await ProjectStorage.putProject({ id: 'existing' });
        if (kind === 'folder') await ProjectStorage.putFolder({ id: 'existing', name: 'Existing' });
        if (kind === 'blob') await ProjectStorage.putBlob({ id: 'existing', blob: new Blob(['existing']) });
        try { await ProjectStorage.restoreWorkspaceSnapshot(workspaceFixture()); blocked.push(false); }
        catch (error) { blocked.push(error.code === 'WORKSPACE_NOT_EMPTY'); }
      }
      await ProjectStorage.clearAll();
      const events = [];
      ProjectStorage.subscribeChanges(change => events.push(change));
      const originalAdd = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (...args) { if (this.name === 'blobs') throw new Error('Synthetic disk failure'); return originalAdd.apply(this, args); };
      let failed = false;
      try { await ProjectStorage.restoreWorkspaceSnapshot(workspaceFixture()); } catch (error) { failed = /Synthetic disk failure/.test(error.message); }
      finally { IDBObjectStore.prototype.add = originalAdd; }
      const afterFailure = await workspaceStoreCounts(), eventsAfterFailure = events.length;
      const concurrent = await Promise.allSettled([ProjectStorage.restoreWorkspaceSnapshot(workspaceFixture()), ProjectStorage.restoreWorkspaceSnapshot(workspaceFixture())]);
      const beforeCollision = await workspaceStoreCounts();
      const collisionSource = workspaceFixture(); collisionSource.projects[0].id = 'new-project';
      let collision = false;
      try { await ProjectStorage.restoreWorkspaceSnapshot(collisionSource, { onlyIfEmpty: false }); } catch (_) { collision = true; }
      return { blocked, failed, afterFailure, eventsAfterFailure, concurrent: concurrent.map(r => r.status), rejectedCode: concurrent.find(r => r.status === 'rejected').reason.code,
        beforeCollision, afterCollision: await workspaceStoreCounts(), collision, newProjectExists: !!await ProjectStorage.getProject('new-project') };
    });
    assert.deepEqual(result.blocked, [true, true, true]);
    assert.equal(result.failed, true);
    assert.deepEqual(result.afterFailure, { projects: 0, folders: 0, blobs: 0 });
    assert.equal(result.eventsAfterFailure, 0);
    assert.deepEqual(result.concurrent.sort(), ['fulfilled', 'rejected']);
    assert.equal(result.rejectedCode, 'WORKSPACE_NOT_EMPTY');
    assert.equal(result.collision, true);
    assert.equal(result.newProjectExists, false);
    assert.deepEqual(result.beforeCollision, result.afterCollision);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('offline workspace databases and commit channels isolate bundles and invalid IDs use the hosted namespace', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    async function open(id) {
      const page = await h.context.newPage();
      await page.addInitScript(value => {
        window.ATLAS_OFFLINE_WORKSPACE_ID = value;
        const Original = BroadcastChannel;
        window.openedChannels = [];
        window.BroadcastChannel = class extends Original { constructor(name) { super(name); openedChannels.push(name); } };
      }, id);
      await page.goto(h.baseURL + '/__test_seed');
      await page.evaluate(() => { window.events = []; ProjectStorage.subscribeChanges(change => events.push(change)); });
      return page;
    }
    const hosted = await open(null), first = await open('copy-A'), sibling = await open('copy-A'), other = await open('copy-B'), invalid = await open('../bad id');
    await hosted.evaluate(() => ProjectStorage.putProject({ id: 'hosted-project' }));
    await first.evaluate(() => ProjectStorage.putProject({ id: 'offline-project' }));
    await sibling.waitForFunction(() => events.some(e => e.projectIds.includes('offline-project')));
    const [hostedRows, firstRows, siblingRows, otherRows, invalidRows] = await Promise.all([hosted, first, sibling, other, invalid].map(page => page.evaluate(() => ProjectStorage.listProjects())));
    assert.deepEqual(hostedRows.map(p => p.id), ['hosted-project']);
    assert.deepEqual(firstRows.map(p => p.id), ['offline-project']);
    assert.deepEqual(siblingRows.map(p => p.id), ['offline-project']);
    assert.deepEqual(otherRows, []);
    assert.deepEqual(invalidRows.map(p => p.id), ['hosted-project']);
    assert.deepEqual(await first.evaluate(() => openedChannels), ['marmoset-atlas-commits-offline-copy-A']);
    assert.deepEqual(await invalid.evaluate(() => openedChannels), ['marmoset-atlas-commits']);
    assert.equal(await other.evaluate(() => events.some(e => e.projectIds.includes('offline-project'))), false);
    const versions = await hosted.evaluate(async () => Object.fromEntries((await indexedDB.databases()).map(db => [db.name, db.version])));
    assert.equal(versions['marmoset-atlas'], 2);
    assert.equal(versions['marmoset-atlas-offline-copy-A'], 3);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('offline restore marker commits with all records, rolls back on marker write failure, and survives ordinary deletions', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await ready(h, 'durable-marker');
    const result = await h.page.evaluate(async () => {
      const before = await ProjectStorage.hasWorkspaceRestore();
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'workspaceMeta') throw new Error('Synthetic marker write failure');
        return originalPut.apply(this, args);
      };
      let error;
      try { await ProjectStorage.restoreWorkspaceSnapshot(workspaceFixture()); } catch (e) { error = e.message; }
      finally { IDBObjectStore.prototype.put = originalPut; }
      const failedMarker = await ProjectStorage.hasWorkspaceRestore(), failedCounts = await workspaceStoreCounts();
      await ProjectStorage.restoreWorkspaceSnapshot(workspaceFixture());
      const committedMarker = await ProjectStorage.hasWorkspaceRestore();
      await ProjectStorage.deleteProject('section-a');
      for (const folder of await ProjectStorage.listFolders()) await ProjectStorage.deleteFolder(folder.id);
      const afterDeletionMarker = await ProjectStorage.hasWorkspaceRestore();
      const snapshot = await ProjectStorage.exportWorkspaceSnapshot();
      return { before, error, failedMarker, failedCounts, committedMarker, afterDeletionMarker, snapshot };
    });
    assert.equal(result.before, false); assert.match(result.error, /marker write failure/);
    assert.equal(result.failedMarker, false);
    assert.deepEqual(result.failedCounts, { projects: 0, folders: 0, blobs: 0 });
    assert.equal(result.committedMarker, true); assert.equal(result.afterDeletionMarker, true);
    assert.deepEqual(result.snapshot, { projects: [], folders: [], blobs: [] });
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
