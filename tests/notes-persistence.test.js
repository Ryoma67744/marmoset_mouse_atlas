'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const JSZip = require(process.env.ATLAS_TEST_JSZIP || 'jszip');
const plain = value => JSON.parse(JSON.stringify(value));
const emptyNotes = () => ({ version: 1, atlasUrl: '', geneAtlasUrl: '', others: [] });

function app() {
  const c = { console, JSZip, Float32Array, Float64Array, Uint8Array, Blob,
    AbortController, setTimeout, clearTimeout };
  c.window = c;
  vm.createContext(c);
  for (const file of ['msi.js', 'zipio.js', 'cloud.js', 'project-sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), c, { filename: file });
  }
  return c;
}
function fixture() {
  const data = { raw: new Float32Array([-0, 0, 1 / 3, NaN, 9.75, -4]) };
  const project = { id: 'synthetic-section', displayName: 'Cor_1_4', folderPath: [],
    grid: { W: 3, H: 2, umPerPxX: 25, umPerPxY: 50 }, images: {},
    molecules: [{ key: 'da', name: 'DA', blobId: 'raw' }],
    rotation: { all: 94, msi: 0, he: 0 },
    roi: { roi_items: { cortex: [{ poly_msi: [[0, 0], [3, 0], [3, 2]] }] } },
    normalization: { id: 'immutable-snapshot', section: { k: 1.25 } },
    notes: { version: 1, atlasUrl: 'https://example.org/atlas?section=1&view=2',
      geneAtlasUrl: 'https://example.org/gene#DA', others: [
        { id: 'note-2', label: '参考資料', url: '', text: '日本語のメモ\n2行目 <script>は文字列</script>' },
        { id: 'note-1', label: '', url: 'https://example.org/other', text: '' },
      ] } };
  let serial = 0;
  const storage = { getValueRaster: async id => data[id],
    putValueRaster: async values => { const id = 'restored-' + ++serial; data[id] = values; return id; },
    uid: () => 'restored-project', commitImportedProject: async p => p };
  return { project, data, storage };
}
function syncFixture() {
  const c = app(), f = fixture();
  let serial = 0;
  let local = { ...plain(f.project), updatedAt: 'local-0', cloudUpdatedAt: 'remote-0',
    cloudBundlePath: 'section/bundle-1.zip', cloudRev: 1, cloudDisplayName: f.project.displayName };
  local.cloudStateHash = c.Cloud.hashSyncState(c.Cloud.stateOf(local));
  let row = { id: local.id, display_name: local.displayName, updated_at: local.cloudUpdatedAt,
    bundle_path: local.cloudBundlePath, bundle_rev: local.cloudRev, folder_path: [],
    state: plain(c.Cloud.stateOf(local)) };
  const calls = { patch: 0, download: 0 };
  const storage = {
    getProject: async () => plain(local), listFolders: async () => [],
    patchProjectFields: async (id, fields, options) => {
      assert.equal(options.expectedUpdatedAt, local.updatedAt, 'local acknowledgement must use revision guard');
      Object.assign(local, plain(fields), { updatedAt: 'local-' + ++serial });
      return plain(local);
    },
    commitImportedProject: async (project, options) => {
      assert.equal(options.expectedUpdatedAt, local.updatedAt);
      local = { ...plain(project), updatedAt: 'local-' + ++serial };
      return plain(local);
    },
  };
  const cloud = { ...c.Cloud, configured: () => true, signedIn: () => true,
    getProject: async () => plain(row),
    downloadBundle: async () => { calls.download++; throw new Error('Notes must not download image data'); },
    patchRowIfUnchanged: async (id, patch, expected) => {
      calls.patch++;
      if (expected !== row.updated_at) return null;
      row = { ...row, ...plain(patch), updated_at: 'remote-' + ++serial };
      return plain(row);
    },
  };
  return { c, calls, cloud, storage, options: { cloud, storage },
    get local() { return local; }, get row() { return row; },
    edit(notes) { local.notes = plain(notes); local.updatedAt = 'local-' + ++serial; },
  };
}

test('real ZIP roundtrip retains URLs, Unicode multiline notes, row IDs and order without changing scientific data', async () => {
  const c = app(), f = fixture(), before = plain(f.project);
  const archive = await c.ZipIO.exportProject(f.project, { storage: f.storage });
  const imported = (await c.ZipIO.importZip(await archive.arrayBuffer(), { storage: f.storage })).project;
  assert.deepEqual(plain(imported.notes), before.notes);
  for (const key of ['roi', 'normalization', 'rotation']) assert.deepEqual(plain(imported[key]), before[key]);
  assert.deepEqual(Buffer.from(f.data[imported.molecules[0].blobId].buffer), Buffer.from(f.data.raw.buffer));
  assert.deepEqual(plain(f.project), before, 'export and import must not mutate the source dataset');
});

test('legacy datasets and ZIPs retain absence of notes without changing their cloud baseline on read', async () => {
  const c = app(), f = fixture();
  delete f.project.notes;
  const before = plain(f.project), hash = c.Cloud.hashSyncState(c.Cloud.stateOf(f.project));
  const archive = await c.ZipIO.exportProject(f.project, { storage: f.storage });
  const imported = (await c.ZipIO.importZip(await archive.arrayBuffer(), { storage: f.storage })).project;
  assert.equal(Object.hasOwn(imported, 'notes'), false);
  assert.equal(Object.hasOwn(c.Cloud.stateOf(imported), 'notes'), false);
  assert.equal(c.Cloud.hashSyncState(c.Cloud.stateOf(f.project)), hash);
  assert.deepEqual(plain(f.project), before);
});

test('explicit note deletion survives ZIP roundtrip and overrides an older bundled note', async () => {
  const c = app(), f = fixture();
  const older = await c.ZipIO.exportProject(f.project, { storage: f.storage });
  const state = plain(c.Cloud.stateOf(f.project));
  state.notes = emptyNotes();
  const cleared = (await c.ZipIO.importZip(await older.arrayBuffer(), { storage: f.storage,
    state, cloudMetadata: { cloudUpdatedAt: 'newer-cleared-notes' } })).project;
  assert.deepEqual(plain(cleared.notes), emptyNotes());
  const archive = await c.ZipIO.exportProject(cleared, { storage: f.storage });
  const restored = (await c.ZipIO.importZip(await archive.arrayBuffer(), { storage: f.storage })).project;
  assert.deepEqual(plain(restored.notes), emptyNotes());
  delete state.notes;
  const legacyRemote = (await c.ZipIO.importZip(await older.arrayBuffer(), { storage: f.storage,
    state, cloudMetadata: { cloudUpdatedAt: 'remote-without-notes' } })).project;
  assert.equal(Object.hasOwn(legacyRemote, 'notes'), false, 'authoritative absence cannot resurrect stale notes from a bundle');
});

test('notes participate in cloud state comparison and changes are identified as メモ', () => {
  const f = syncFixture(), otherDataset = plain(f.local);
  f.edit({ ...f.local.notes, atlasUrl: 'https://example.org/updated-atlas' });
  const status = f.c.ProjectSync.localStatus(f.local, { ...f.options, remoteRow: f.row });
  assert.equal(status.status, 'local-edits');
  assert.deepEqual(Array.from(status.changedFields), ['notes']);
  assert.match(status.reason, /メモ/);
  assert.notEqual(f.cloud.hashSyncState(f.cloud.stateOf(f.local)), f.local.cloudStateHash);
  assert.deepEqual(otherDataset.notes, f.row.state.notes, 'editing one dataset cannot change another');
});

test('cloud save of empty notes is acknowledged and refreshes another device without replacing raw data', async () => {
  const f = syncFixture(), before = plain(f.local);
  f.edit(emptyNotes());
  const saved = await f.c.ProjectSync.saveState(plain(f.local), f.options);
  assert.equal(f.c.ProjectSync.statusOf(saved).status, 'saved');
  assert.deepEqual(f.row.state.notes, emptyNotes());
  assert.equal(f.c.ProjectSync.localStatus(saved, { ...f.options, remoteRow: f.row }).status, 'current');
  assert.equal(f.calls.patch, 1);
  let secondDevice = before;
  const secondStorage = { getProject: async () => plain(secondDevice), listFolders: async () => [],
    commitImportedProject: async (project, options) => {
      assert.equal(options.expectedUpdatedAt, secondDevice.updatedAt);
      secondDevice = plain(project); return plain(secondDevice);
    } };
  const refreshed = await f.c.ProjectSync.ensureLocal(before.id, { cloud: f.cloud, storage: secondStorage });
  assert.equal(f.c.ProjectSync.statusOf(refreshed).status, 'updated');
  assert.deepEqual(plain(refreshed.notes), emptyNotes());
  assert.deepEqual(plain(refreshed.molecules), before.molecules);
  assert.deepEqual(plain(refreshed.normalization), before.normalization);
  assert.equal(f.calls.download, 0);
});

test('editing notes during a cloud save keeps the new draft visibly unsynced', async () => {
  const f = syncFixture(), send = f.cloud.patchRowIfUnchanged;
  const sent = { ...f.local.notes, atlasUrl: 'https://example.org/sent' };
  const draft = { ...sent, geneAtlasUrl: 'https://example.org/later-draft' };
  f.edit(sent);
  f.cloud.patchRowIfUnchanged = async (...args) => {
    const row = await send(...args);
    f.edit(draft);
    return row;
  };
  const saved = await f.c.ProjectSync.saveState(plain(f.local), f.options);
  const status = f.c.ProjectSync.statusOf(saved);
  assert.equal(status.status, 'saved-local-edits');
  assert.match(status.reason, /メモ/);
  assert.deepEqual(Array.from(status.changedFields), ['notes']);
  assert.deepEqual(f.row.state.notes, sent);
  assert.deepEqual(f.local.notes, draft);
});

test('remote notes edited by another device block a stale cloud overwrite and retain the local draft', async () => {
  const f = syncFixture();
  const draft = { ...f.local.notes, atlasUrl: 'https://example.org/local-draft' };
  f.edit(draft);
  f.row.state.notes.geneAtlasUrl = 'https://example.org/remote-edit';
  f.row.updated_at = 'remote-newer';
  await assert.rejects(f.c.ProjectSync.saveState(plain(f.local), f.options), /最新の設定/);
  assert.deepEqual(f.local.notes, draft);
  assert.equal(f.row.state.notes.geneAtlasUrl, 'https://example.org/remote-edit');
  assert.equal(f.calls.patch, 0);
});
