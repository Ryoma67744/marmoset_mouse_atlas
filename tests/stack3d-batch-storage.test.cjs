'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');

async function seed(h) {
  await h.page.goto(h.baseURL + '/__test_seed');
  await h.page.evaluate(async () => {
    const values = new Float32Array([0, -0, NaN, -1.25, 4, 100]);
    const blobId = await ProjectStorage.putValueRaster(values);
    window.batchOriginalBits = Array.from(new Uint8Array(values.buffer));
    window.batchOriginals = [];
    for (const id of ['batch-a', 'batch-b', 'batch-reference']) {
      const project = { id, displayName: id, grid: { W: 3, H: 2 }, folderId: 'original-folder',
        molecules: [{ key: 'MSI_DA', blobId, name: 'DA' }], images: { HE_Stain: { blobId: 'he-kept' } },
        roi: { roi_items: { cortex: [{ poly_msi: [[0, 0], [2, 0], [2, 1]] }] }, roi_names: { cortex: 'Cortex' } },
        normalization: { id: 'd4-profile', section: { k: 1.75 } }, normalizationBinding: { groupId: 'group-kept' },
        rotation: { all: 180, msi: 0 }, world_coords: { x: [100, 200, 300], y: [100, 250] },
        valueDisplay: { mode: 'normalized', scale: 'common' }, cloudUpdatedAt: 'cloud-kept',
        stack3d: { schemaVersion: 1, offsetXUm: 10, offsetYUm: 20, rotationDeg: 3 },
        createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2050-01-01T00:00:00.000Z' };
      await ProjectStorage.putProject(project);
      batchOriginals.push(structuredClone(project));
    }
    window.batchPlacements = () => [
      { id: 'batch-b', offsetXUm: -210.5, offsetYUm: 340, rotationDeg: -2.5 },
      { id: 'batch-a', offsetXUm: 80, offsetYUm: -170, rotationDeg: 4.75 },
    ];
    window.batchReferences = () => batchOriginals.map(({ id, updatedAt }) => ({ id, updatedAt }));
  });
}

test('batch placements preserve every non-placement field and raw byte, notify once after commit, and return target order', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await seed(h);
    const result = await h.page.evaluate(async () => {
      const placements = batchPlacements(), options = { expectedProjectRevisions: batchReferences() };
      const snapshot = JSON.stringify({ placements, options, batchOriginals });
      const events = [], committedReads = [];
      const unsubscribe = ProjectStorage.subscribeChanges(event => {
        events.push(event);
        committedReads.push(Promise.all(event.projectIds.map(id => ProjectStorage.getProject(id))));
      });
      const saved = await ProjectStorage.saveStack3DPlacements(placements, options);
      const seen = await Promise.all(committedReads);
      unsubscribe();
      const after = await Promise.all(batchOriginals.map(project => ProjectStorage.getProject(project.id)));
      const unchangedFields = project => { const { stack3d, updatedAt, ...rest } = project; return rest; };
      return { savedIds: saved.map(project => project.id), placements: saved.map(project => project.stack3d), events,
        committed: seen.flat().map(project => ({ id: project.id, stack3d: project.stack3d })),
        preserved: after.every((project, index) => JSON.stringify(unchangedFields(project)) === JSON.stringify(unchangedFields(batchOriginals[index]))),
        advanced: after.slice(0, 2).every((project, index) => Date.parse(project.updatedAt) > Date.parse(batchOriginals[index].updatedAt)),
        referenceUnchanged: JSON.stringify(after[2]) === JSON.stringify(batchOriginals[2]),
        inputsUnchanged: snapshot === JSON.stringify({ placements, options, batchOriginals }),
        originalBits: batchOriginalBits,
        savedBits: Array.from(new Uint8Array((await ProjectStorage.getValueRaster(after[0].molecules[0].blobId)).buffer)) };
    });
    assert.deepEqual(result.savedIds, ['batch-b', 'batch-a']);
    assert.deepEqual(result.placements, [
      { schemaVersion: 1, offsetXUm: -210.5, offsetYUm: 340, rotationDeg: -2.5 },
      { schemaVersion: 1, offsetXUm: 80, offsetYUm: -170, rotationDeg: 4.75 },
    ]);
    assert.deepEqual(result.events, [{ projectIds: ['batch-b', 'batch-a'], folderIds: [] }]);
    assert.deepEqual(result.committed.map(project => project.stack3d), result.placements);
    assert.equal(result.preserved && result.advanced && result.referenceUnchanged && result.inputsUnchanged, true);
    assert.deepEqual(result.savedBits, result.originalBits);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('late changes or deletion of any reference reject the entire placement transaction', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await seed(h);
    const result = await h.page.evaluate(async () => {
      const results = [];
      for (const action of ['changed-reference', 'deleted-reference', 'changed-target', 'deleted-target']) {
        // Restore a fresh independent baseline for every racing transaction.
        for (const project of batchOriginals) await ProjectStorage.putProject(structuredClone(project));
        const before = await Promise.all(batchOriginals.map(project => ProjectStorage.getProject(project.id)));
        const references = before.map(({ id, updatedAt }) => ({ id, updatedAt }));
        const targetId = action.endsWith('target') ? 'batch-a' : 'batch-reference';
        const changed = structuredClone(before.find(project => project.id === targetId));
        changed.roi = { newest: true };
        changed.updatedAt = new Date(Date.parse(changed.updatedAt) + 1).toISOString();
        const originalTransaction = IDBDatabase.prototype.transaction;
        let armed = true, error = null;
        const notifications = [];
        const unsubscribe = ProjectStorage.subscribeChanges(event => notifications.push(event));
        IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
          if (armed && names === 'projects' && mode === 'readwrite') {
            armed = false;
            // Queue a competing writer immediately before the batch write lock.
            const competing = originalTransaction.call(this, names, mode, ...rest);
            const store = competing.objectStore('projects');
            if (action.startsWith('deleted')) store.delete(targetId); else store.put(changed);
          }
          return originalTransaction.call(this, names, mode, ...rest);
        };
        try { await ProjectStorage.saveStack3DPlacements(batchPlacements(), { expectedProjectRevisions: references }); }
        catch (failure) { error = { code: failure.code, message: failure.message }; }
        finally { IDBDatabase.prototype.transaction = originalTransaction; unsubscribe(); }
        const after = await Promise.all(before.map(project => ProjectStorage.getProject(project.id)));
        results.push({ action, error, notifications,
          unchangedOthers: after.every((project, index) => before[index].id === targetId || JSON.stringify(project) === JSON.stringify(before[index])),
          competingChangePreserved: action.startsWith('deleted') ? !after.find(project => project?.id === targetId) :
            JSON.stringify(after.find(project => project?.id === targetId)) === JSON.stringify(changed) });
      }
      return results;
    });
    for (const item of result) {
      assert.equal(item.error?.code, 'LOCAL_CONFLICT', item.action);
      assert.match(item.error.message, /更新または削除/);
      assert.equal(item.unchangedOthers && item.competingChangePreserved, true, item.action);
      assert.deepEqual(item.notifications, [], item.action);
    }
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('a later placement write failure rolls back earlier writes and sends no commit notification', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await seed(h);
    const result = await h.page.evaluate(async () => {
      const originalPut = IDBObjectStore.prototype.put;
      const notifications = [];
      const unsubscribe = ProjectStorage.subscribeChanges(event => notifications.push(event));
      let writes = 0, error = '';
      IDBObjectStore.prototype.put = function (project, ...rest) {
        if (this.name === 'projects' && ++writes === 2) throw new DOMException('Synthetic second write failure', 'DataCloneError');
        return originalPut.call(this, project, ...rest);
      };
      try { await ProjectStorage.saveStack3DPlacements(batchPlacements(), { expectedProjectRevisions: batchReferences() }); }
      catch (failure) { error = failure.message; }
      finally { IDBObjectStore.prototype.put = originalPut; unsubscribe(); }
      const after = await Promise.all(batchOriginals.map(project => ProjectStorage.getProject(project.id)));
      return { error, writes, notifications, unchanged: JSON.stringify(after) === JSON.stringify(batchOriginals) };
    });
    assert.match(result.error, /second write failure/);
    assert.equal(result.writes, 2);
    assert.equal(result.unchanged, true);
    assert.deepEqual(result.notifications, []);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('batch placement input validation rejects missing, duplicate, inherited and nonfinite values without writes', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await seed(h);
    const result = await h.page.evaluate(async () => {
      const valid = batchPlacements()[0], refs = batchReferences();
      const badPlacements = [null, {}, [], Array(1), [null], [[]], [{ ...valid, id: '' }], [{ ...valid, id: ' ' }],
        [{ ...valid, id: 1 }], [valid, { ...valid }], [{ ...valid, offsetXUm: '10' }],
        [{ ...valid, offsetXUm: null }], [{ ...valid, offsetXUm: NaN }], [{ ...valid, offsetYUm: Infinity }],
        [{ ...valid, rotationDeg: -Infinity }], [{ id: valid.id, offsetXUm: 1, rotationDeg: 0 }], [Object.create(valid)]];
      const badOptions = [undefined, {}, { expectedProjectRevisions: null }, { expectedProjectRevisions: {} },
        { expectedProjectRevisions: [] }, { expectedProjectRevisions: Array(1) }, { expectedProjectRevisions: [null] },
        { expectedProjectRevisions: [{ id: ' ', updatedAt: refs[0].updatedAt }] },
        { expectedProjectRevisions: [{ id: valid.id, updatedAt: '' }] },
        { expectedProjectRevisions: [{ id: valid.id, updatedAt: 1 }] },
        { expectedProjectRevisions: [refs[0], refs[0]] }, { expectedProjectRevisions: [refs[0]] },
        { expectedProjectRevisions: [Object.create(refs[1])] }, Object.create({ expectedProjectRevisions: refs })];
      const errors = [], notifications = [];
      const unsubscribe = ProjectStorage.subscribeChanges(event => notifications.push(event));
      for (const placements of badPlacements) {
        try { await ProjectStorage.saveStack3DPlacements(placements, { expectedProjectRevisions: refs }); errors.push(null); }
        catch (error) { errors.push(error.message); }
      }
      for (const options of badOptions) {
        try { await ProjectStorage.saveStack3DPlacements([valid], options); errors.push(null); }
        catch (error) { errors.push(error.message); }
      }
      unsubscribe();
      const after = await Promise.all(batchOriginals.map(project => ProjectStorage.getProject(project.id)));
      return { errors, count: badPlacements.length + badOptions.length, notifications, unchanged: JSON.stringify(after) === JSON.stringify(batchOriginals) };
    });
    assert.equal(result.errors.length, result.count);
    assert.equal(result.errors.every(message => typeof message === 'string' && message.length > 0), true);
    assert.equal(result.unchanged, true);
    assert.deepEqual(result.notifications, []);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('batch save snapshots placement and reference inputs before its first asynchronous operation', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await seed(h);
    const result = await h.page.evaluate(async () => {
      const placements = batchPlacements(), references = batchReferences();
      const options = { expectedProjectRevisions: references };
      const expected = structuredClone(placements);
      const pending = ProjectStorage.saveStack3DPlacements(placements, options);
      placements[0].id = 'other-id'; placements[0].offsetXUm = Infinity; placements[1].rotationDeg = 999;
      placements.splice(0, placements.length);
      references[0].updatedAt = 'stale'; references[1].id = 'other-reference'; references.splice(0, references.length);
      options.expectedProjectRevisions = [];
      const saved = await pending;
      return { expected, saved: saved.map(project => ({ id: project.id, offsetXUm: project.stack3d.offsetXUm,
        offsetYUm: project.stack3d.offsetYUm, rotationDeg: project.stack3d.rotationDeg })) };
    });
    assert.deepEqual(result.saved, result.expected);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
