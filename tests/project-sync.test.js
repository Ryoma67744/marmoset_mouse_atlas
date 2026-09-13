'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));

function fixture() {
  const c = { console, Blob, WeakMap, Map, Set }; c.window = c;
  vm.createContext(c);
  for (const file of ['cloud.js', 'project-sync.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), c, { filename: file });
  }
  let n = 1;
  let local = { id: 'p', updatedAt: 'local-1', displayName: 'section', folderId: 'f2',
    grid: { W: 2, H: 2 }, molecules: [{ name: 'D4', blobId: 'raw-original' }],
    roi: { names: ['ROI original'] }, normalization: { id: 'profile', revision: 1, section: { k: 2, Ds: 4 } },
    normalizationBinding: { groupId: 'g1', memberId: 'p', folderPath: ['Marmoset', 'Coronal'] },
    cloudUpdatedAt: 'remote-1', cloudBundlePath: 'p/bundle-1.zip', cloudRev: 1 };
  local.cloudStateHash = c.Cloud.hashState(c.Cloud.stateOf(local));
  let row = { id: 'p', updated_at: 'remote-1', display_name: 'section', folder_path: ['Marmoset', 'Coronal'],
    bundle_path: 'p/bundle-1.zip', bundle_rev: 1, state: copy(c.Cloud.stateOf(local)), meta: c.Cloud.metaOf(local) };
  const folders = [{ id: 'f1', name: 'Marmoset', parentId: null },
    { id: 'f2', name: 'Coronal', parentId: 'f1', normalizationGroupId: 'g1' }];
  const calls = { fetch: 0, download: 0, import: 0, patch: 0, commit: 0, unconditional: 0 };
  const storage = {
    getProject: async () => copy(local), listFolders: async () => copy(folders),
    saveProjectIfUnchanged: async (project, expected) => {
      if ((local ? local.updatedAt : null) !== expected) throw new Error('local conflict');
      local = copy(project); local.updatedAt = 'local-' + (++n); return copy(local);
    },
    patchProjectFields: async (id, fields, options) => {
      if (!local || local.updatedAt !== options.expectedUpdatedAt) throw new Error('local conflict');
      Object.assign(local, copy(fields)); local.updatedAt = 'local-' + (++n); return copy(local);
    },
    commitImportedProject: async (project, options) => {
      calls.commit++;
      if ((local ? local.updatedAt : null) !== options.expectedUpdatedAt) throw new Error('local conflict');
      local = copy(project); local.folderId = 'f2'; local.updatedAt = 'local-' + (++n); return copy(local);
    },
  };
  const cloud = Object.assign({}, c.Cloud, {
    configured: () => true, signedIn: () => true,
    getProject: async () => { calls.fetch++; return copy(row); },
    listProjects: async () => row ? [copy(row)] : [],
    downloadBundle: async () => { calls.download++; return new Blob(['mock']); },
    patchRowIfUnchanged: async (id, patch, expected) => {
      calls.patch++;
      if (!row || row.updated_at !== expected) return null;
      row = Object.assign(row, copy(patch), { updated_at: 'remote-' + (++n) }); return copy(row);
    },
    patchRow: async () => { calls.unconditional++; throw new Error('unsafe'); },
  });
  const zip = { importZip: async (blob, options) => {
    calls.import++;
    const project = { id: options.id, displayName: options.displayName, molecules: [{ blobId: 'raw-imported' }] };
    cloud.replaceState(project, copy(options.state)); Object.assign(project, options.cloudMetadata);
    return { project: await storage.commitImportedProject(project, options) };
  } };
  const options = { storage, cloud, zip };
  return { c, storage, cloud, zip, calls, options, folders,
    get local() { return local; }, set local(v) { local = v; },
    get row() { return row; }, set row(v) { row = v; },
    edit(fields) { Object.assign(local, copy(fields)); local.updatedAt = 'local-' + (++n); },
    remoteEdit(stateFields) { Object.assign(row.state, copy(stateFields)); row.updated_at = 'remote-' + (++n); },
  };
}

test('ensureLocal reads current local storage and remote state; stale listing cannot replace newer local profile', async () => {
  const f = fixture();
  f.edit({ normalization: { id: 'new-local-profile', revision: 2, section: { k: 5 } } });
  const result = await f.c.ProjectSync.ensureLocal('p', Object.assign({}, f.options, { remoteRow: { id: 'p', state: {} } }));
  assert.equal(result.normalization.id, 'new-local-profile');
  assert.equal(f.c.ProjectSync.statusOf(result).status, 'local-edits');
  assert.equal(f.calls.fetch, 1); assert.equal(f.calls.commit, 0); assert.equal(f.calls.download, 0);
});

test('clean local cache receives newer remote profile by atomic state-only import and keeps raw blobs', async () => {
  const f = fixture();
  f.remoteEdit({ normalization: { id: 'new-profile', revision: 2, section: { k: 7 } } });
  const result = await f.c.ProjectSync.ensureLocal('p', f.options);
  assert.equal(result.normalization.id, 'new-profile'); assert.equal(result.normalization.section.k, 7);
  assert.equal(result.molecules[0].blobId, 'raw-original'); assert.equal(result.cloudUpdatedAt, f.row.updated_at);
  assert.equal(result.cloudStateHash, f.cloud.hashState(f.row.state));
  assert.equal(f.calls.commit, 1); assert.equal(f.calls.download, 0);
  assert.equal(f.c.ProjectSync.statusOf(result).status, 'updated');
});

test('dirty local ROI survives a conflicting cloud change by default', async () => {
  const f = fixture(); f.edit({ roi: { names: ['local ROI'] } });
  f.remoteEdit({ normalization: { id: 'new-profile', revision: 2 } });
  const result = await f.c.ProjectSync.ensureLocal('p', f.options);
  assert.equal(result.roi.names[0], 'local ROI'); assert.equal(f.calls.commit, 0);
  assert.equal(f.c.ProjectSync.statusOf(result).status, 'conflict');
});

test('server profile disappearance cannot silently delete the surviving local profile', async () => {
  const f = fixture(); delete f.row.state.normalization; f.row.updated_at = 'remote-2';
  const result = await f.c.ProjectSync.ensureLocal('p', f.options);
  assert.equal(result.normalization.id, 'profile'); assert.equal(f.calls.commit, 0);
  assert.equal(f.c.ProjectSync.statusOf(result).status, 'conflict');
});

test('explicit conflict replacement replaces missing state keys and retains raw data', async () => {
  const f = fixture(); delete f.row.state.normalization; f.row.updated_at = 'remote-2';
  const result = await f.c.ProjectSync.ensureLocal('p', Object.assign({}, f.options, { confirmReplace: async () => true }));
  assert.equal(result.normalization, undefined); assert.equal(result.molecules[0].blobId, 'raw-original');
});

test('a local edit during download defeats import CAS and preserves newly saved normalization', async () => {
  const f = fixture(); f.row.bundle_path = 'p/bundle-2.zip'; f.row.bundle_rev = 2; f.row.updated_at = 'remote-2';
  f.cloud.downloadBundle = async () => { f.edit({ normalization: { id: 'saved-during-download', revision: 3 } }); return new Blob(['mock']); };
  await assert.rejects(f.c.ProjectSync.ensureLocal('p', f.options), /local conflict/);
  assert.equal(f.local.normalization.id, 'saved-during-download'); assert.equal(f.local.molecules[0].blobId, 'raw-original');
});

test('an absent-local expectation also blocks a same-ID project created during download', async () => {
  const f = fixture(); const created = copy(f.local); f.local = null;
  f.cloud.downloadBundle = async () => { f.local = created; return new Blob(['mock']); };
  await assert.rejects(f.c.ProjectSync.ensureLocal('p', f.options), /local conflict/);
  assert.equal(f.local.molecules[0].blobId, 'raw-original');
});

test('remote update during ZIP download prevents obsolete snapshot import', async () => {
  const f = fixture(); f.row.bundle_path = 'p/bundle-2.zip'; f.row.bundle_rev = 2; f.row.updated_at = 'remote-2';
  f.cloud.downloadBundle = async () => { f.remoteEdit({ normalization: { id: 'changed-during-download' } }); return new Blob(['mock']); };
  await assert.rejects(f.c.ProjectSync.ensureLocal('p', f.options), /取得中にクラウド/);
  assert.equal(f.calls.import, 0); assert.equal(f.local.normalization.id, 'profile');
});

test('Viewer can prevent remote commit after in-memory edits start during a network request', async () => {
  const f = fixture(); f.remoteEdit({ normalization: { id: 'new-profile' } });
  const result = await f.c.ProjectSync.ensureLocal('p', Object.assign({}, f.options, { canApplyRemote: () => false }));
  assert.equal(f.calls.commit, 0); assert.equal(result.normalization.id, 'profile');
});

test('pending folder moves and offline local reads preserve local state with explicit freshness status', async () => {
  const f = fixture();
  let result = await f.c.ProjectSync.ensureLocal('p', Object.assign({}, f.options, { pendingFolderChanges: { p: { path: ['new'] } } }));
  assert.equal(f.c.ProjectSync.statusOf(result).status, 'pending'); assert.equal(f.calls.fetch, 0);
  f.cloud.getProject = async () => { throw new Error('offline'); };
  result = await f.c.ProjectSync.ensureLocal('p', f.options);
  assert.equal(f.c.ProjectSync.statusOf(result).status, 'offline'); assert.equal(result.normalization.id, 'profile');
});

test('metadata rename does not acknowledge unseen new remote normalization; later Viewer save is refused', async () => {
  const f = fixture();
  f.remoteEdit({ normalization: { id: 'remote-new', revision: 2 } });
  f.edit({ displayName: 'renamed' });
  await f.c.ProjectSync.patchMetadata('p', { display_name: 'renamed' }, f.options);
  assert.equal(f.local.cloudUpdatedAt, 'remote-1'); assert.equal(f.row.state.normalization.id, 'remote-new');
  await assert.rejects(f.c.ProjectSync.saveState(copy(f.local), f.options), /クラウドの内容が更新/);
  assert.equal(f.row.state.normalization.id, 'remote-new'); assert.equal(f.calls.unconditional, 0);
});

test('ordinary save rejects profile loss even with a falsely current legacy timestamp and baseline hash', async () => {
  const f = fixture();
  f.local.normalization = null;
  // Reproduce an old acknowledgement that incorrectly blessed stale contents.
  f.local.cloudUpdatedAt = f.row.updated_at; f.local.cloudStateHash = f.cloud.hashState(f.row.state);
  await assert.rejects(f.c.ProjectSync.saveState(copy(f.local), f.options), /補正設定がクラウドと一致/);
  assert.equal(f.calls.patch, 0); assert.equal(f.row.state.normalization.id, 'profile');
});

test('normalizer can explicitly save new profile after baseline and local revision validation', async () => {
  const f = fixture(); f.edit({ normalization: { id: 'new-profile', revision: 2, section: { k: 8 } } });
  const result = await f.c.ProjectSync.saveState(copy(f.local), Object.assign({}, f.options, { allowNormalizationChange: true }));
  assert.equal(result.normalization.section.k, 8); assert.equal(f.row.state.normalization.id, 'new-profile');
  assert.equal(result.cloudStateHash, f.cloud.hashState(f.row.state));
  assert.equal(result.molecules[0].blobId, 'raw-original');
});

test('edits made while cloud save is in flight are preserved and remain dirty against sent snapshot', async () => {
  const f = fixture(); f.edit({ roi: { names: ['sent ROI'] } });
  const patch = f.cloud.patchRowIfUnchanged;
  f.cloud.patchRowIfUnchanged = async (...args) => {
    const saved = await patch(...args); f.edit({ roi: { names: ['newer local ROI'] } }); return saved;
  };
  const result = await f.c.ProjectSync.saveState(copy(f.local), f.options);
  assert.equal(result.roi.names[0], 'newer local ROI'); assert.equal(f.row.state.roi.names[0], 'sent ROI');
  assert.notEqual(f.cloud.hashState(f.cloud.stateOf(result)), result.cloudStateHash);
  assert.equal(result.cloudStateHash, f.cloud.hashState(f.row.state));
});

test('CAS rejection is not retried with an unconditional remote patch', async () => {
  const f = fixture(); f.edit({ roi: { names: ['changed ROI'] } });
  f.cloud.patchRowIfUnchanged = async () => null;
  await assert.rejects(f.c.ProjectSync.saveState(copy(f.local), f.options), /保存中に別の画面/);
  assert.equal(f.calls.unconditional, 0); assert.equal(f.row.state.roi.names[0], 'ROI original');
});

test('metadata acknowledgement may advance a verified unchanged base while preserving dirty local edits', async () => {
  const f = fixture(); f.edit({ roi: { names: ['local dirty ROI'] }, displayName: 'renamed' });
  await f.c.ProjectSync.patchMetadata('p', { display_name: 'renamed' }, f.options);
  assert.equal(f.local.cloudUpdatedAt, f.row.updated_at); assert.equal(f.local.roi.names[0], 'local dirty ROI');
  assert.notEqual(f.cloud.hashState(f.cloud.stateOf(f.local)), f.local.cloudStateHash);
});

test('normalization UUID repair requests fresh complete group authority before state import', async () => {
  const f = fixture(); f.remoteEdit({ normalizationBinding: { groupId: 'g-new', memberId: 'p', folderPath: ['Marmoset', 'Coronal'] } });
  let authority;
  const commit = f.storage.commitImportedProject;
  f.storage.commitImportedProject = async (p, options) => { authority = options.authoritativeRows; return commit(p, options); };
  const result = await f.c.ProjectSync.ensureLocal('p', f.options);
  assert.equal(authority.length, 1); assert.equal(authority[0].state.normalizationBinding.groupId, 'g-new');
  assert.equal(result.normalizationBinding.groupId, 'g-new'); assert.equal(result.normalization.section.k, 2);
});

test('Cloud conditional update requires a known revision and authoritative state replacement clears missing keys', async () => {
  const f = fixture();
  await assert.rejects(f.c.Cloud.patchRowIfUnchanged('p', { state: {} }, null), /保存元のクラウド版/);
  const candidate = { normalization: { id: 'obsolete' }, roi: {}, localOnly: true };
  f.c.Cloud.replaceState(candidate, { roi: { x: 1 } });
  assert.equal(candidate.normalization, undefined); assert.equal(candidate.roi.x, 1); assert.equal(candidate.localOnly, true);
});

test('sanctioned invalidation of an unchanged profile can be saved; clearing it or changing k cannot', async () => {
  const f = fixture();
  f.local.normalization.invalidated = { code: 'NORMALIZATION_PROFILE_STALE', detail: 'ROI changed', at: 'now' };
  const result = await f.c.ProjectSync.saveState(copy(f.local), f.options);
  assert.equal(result.normalization.invalidated.code, 'NORMALIZATION_PROFILE_STALE');
  delete f.local.normalization.invalidated;
  await assert.rejects(f.c.ProjectSync.saveState(copy(f.local), f.options), /補正設定がクラウドと一致/);
  f.local.normalization.invalidated = { code: 'NORMALIZATION_PROFILE_STALE' };
  f.local.normalization.section.k = 999;
  await assert.rejects(f.c.ProjectSync.saveState(copy(f.local), f.options), /補正設定がクラウドと一致/);
});

test('exact already-saved state can recover a failed acknowledgement without another remote write', async () => {
  const f = fixture(); f.edit({ normalization: { id: 'new-profile', revision: 2 } });
  f.row.state = copy(f.cloud.stateOf(f.local)); f.row.updated_at = 'remote-saved';
  const result = await f.c.ProjectSync.saveState(copy(f.local), Object.assign({}, f.options, { allowNormalizationChange: true }));
  assert.equal(f.calls.patch, 0); assert.equal(result.cloudUpdatedAt, 'remote-saved');
  assert.equal(result.cloudStateHash, f.cloud.hashState(f.row.state));
});

test('explicit cloud:null stays local even when global Cloud is configured', async () => {
  const f = fixture(); f.c.Cloud.configured = () => true; f.c.Cloud.signedIn = () => true;
  f.c.Cloud.getProject = async () => { throw new Error('must not use global cloud'); };
  const result = await f.c.ProjectSync.ensureLocal('p', { storage: f.storage, cloud: null });
  assert.equal(f.c.ProjectSync.statusOf(result).status, 'local-only');
  assert.equal(result.normalization.id, 'profile');
});

test('a Viewer state save preserves remote metadata it did not edit', async () => {
  const f = fixture(); f.row.meta.orientation = 'remote-orientation'; f.row.meta.customNote = 'retained';
  f.edit({ roi: { names: ['edited ROI'] } });
  await f.c.ProjectSync.saveState(copy(f.local), f.options);
  assert.equal(f.row.meta.orientation, 'remote-orientation'); assert.equal(f.row.meta.customNote, 'retained');
  assert.equal(f.row.meta.normalization.id, 'profile');
});

test('Cloud CAS timestamps advance even when client time is behind the previous write', async () => {
  const f = fixture(), expected = '2099-01-01T00:00:00.000Z';
  f.c.CLOUD_CONFIG = { url: 'https://example.invalid', anonKey: 'synthetic' };
  f.c.localStorage = { getItem: key => key.includes('cloudSession') ? JSON.stringify({ access_token: 'synthetic',
    refresh_token: 'synthetic', expires_at: Date.now() + 3600000 }) : '' };
  let requested;
  f.c.fetch = async (url, options) => {
    requested = { url, body: JSON.parse(options.body) };
    return { ok: true, status: 200, json: async () => [requested.body] };
  };
  const result = await f.c.Cloud.patchRowIfUnchanged('p', { state: { roi: {} } }, expected);
  assert.equal(result.updated_at, '2099-01-01T00:00:00.001Z');
  assert.match(requested.url, /updated_at=eq\.2099/);
});

test('offline or failed local rename is preserved while a clean remote rename uses its verified name baseline', async () => {
  const f = fixture(); f.local.cloudDisplayName = 'section'; f.edit({ displayName: 'offline rename' });
  let result = await f.c.ProjectSync.ensureLocal('p', f.options);
  assert.equal(result.displayName, 'offline rename'); assert.equal(f.calls.commit, 0);
  assert.equal(f.c.ProjectSync.statusOf(result).status, 'local-edits');
  f.local.displayName = 'section'; f.row.display_name = 'remote rename'; f.row.updated_at = 'remote-2';
  result = await f.c.ProjectSync.ensureLocal('p', f.options);
  assert.equal(result.displayName, 'remote rename'); assert.equal(result.cloudDisplayName, 'remote rename');
});

test('successful name patch acknowledges only its name when scientific state baseline is stale', async () => {
  const f = fixture(); f.local.cloudDisplayName = 'section';
  f.remoteEdit({ normalization: { id: 'newer remote' } }); f.edit({ displayName: 'renamed' });
  await f.c.ProjectSync.patchMetadata('p', { display_name: 'renamed' }, f.options);
  assert.equal(f.local.cloudDisplayName, 'renamed'); assert.equal(f.local.cloudUpdatedAt, 'remote-1');
  const result = await f.c.ProjectSync.ensureLocal('p', f.options);
  assert.equal(result.normalization.id, 'newer remote'); assert.equal(result.displayName, 'renamed');
});

test('Cloud removal deletes only the exact reviewed revision and rejects missing guards', async () => {
  const f = fixture();
  await assert.rejects(f.c.Cloud.removeRowIfUnchanged('p', null), /削除元のクラウド版/);
  f.c.CLOUD_CONFIG = { url: 'https://example.invalid', anonKey: 'synthetic' };
  f.c.localStorage = { getItem: key => key.includes('cloudSession') ? JSON.stringify({ access_token: 'synthetic',
    refresh_token: 'synthetic', expires_at: Date.now() + 3600000 }) : '' };
  const requests = []; let deleted = true;
  f.c.fetch = async (url, options) => {
    requests.push({ url, method: options.method, prefer: options.headers.Prefer });
    return { ok: true, status: 200, json: async () => deleted ? [{ id: 'p', updated_at: '2026-01-01T00:00:00.000Z' }] : [] };
  };
  const row = await f.c.Cloud.removeRowIfUnchanged('p', '2026-01-01T00:00:00.000Z');
  assert.equal(row.id, 'p'); assert.equal(requests[0].method, 'DELETE');
  assert.equal(requests[0].prefer, 'return=representation'); assert.match(requests[0].url, /id=eq\.p&updated_at=eq\.2026/);
  deleted = false;
  assert.equal(await f.c.Cloud.removeRowIfUnchanged('p', '2026-01-01T00:00:00.000Z'), null);
  assert.equal(requests.length, 2, 'no fallback to an unconditional delete');
});

test('simple-profile cloud save preserves arbitrary targets and requires explicit profile-change authority', async () => {
  const f = fixture();
  const simple = { schemaVersion: 3, methodVersion: '2.0.0', id: 'simple-profile', revision: 2, mode: 'simple',
    mapping: { d4: 'd4', ht: 'ht' }, targets: [
      { key: 'ht', method: 'pixel_ratio', analyteId: '5-HT', rangeScope: 'group' },
      { key: 'g', method: 'section_scale', analyteId: 'Glutamate', rangeScope: 'group' }],
    qc: { minD4: 0, saturationD4: null, minCoverage: 0.8, enforceCoverage: false },
    section: { Ds: 4, k: 2 }, commonRanges: { Glutamate: [0, 200] },
    scope: { type: 'folder-depth', depth: 2, includeDescendants: true, groupId: 'g1',
      folderPath: ['Marmoset', 'Coronal'], memberIds: ['p'] },
  };
  f.edit({ normalization: simple });
  await assert.rejects(f.c.ProjectSync.saveState(copy(f.local), f.options), /補正設定がクラウドと一致/);
  assert.equal(f.calls.patch, 0);
  const saved = await f.c.ProjectSync.saveState(copy(f.local), { ...f.options, allowNormalizationChange: true,
    expectedCloudUpdatedAt: f.local.cloudUpdatedAt });
  assert.deepEqual(copy(f.row.state.normalization), simple);
  assert.deepEqual(copy(saved.normalization), simple);
  assert.deepEqual(copy(f.row.meta.normalization.targets), simple.targets);
  assert.equal(saved.molecules[0].blobId, 'raw-original');
  assert.equal(f.calls.unconditional, 0);
  const rawBlob = saved.molecules[0].blobId;
  f.remoteEdit({ normalization: { ...simple, revision: 3, targets: simple.targets.slice(0, 1) } });
  await assert.rejects(f.c.ProjectSync.saveState(copy(f.local), { ...f.options, allowNormalizationChange: true }), /クラウドの内容が更新/);
  assert.equal(f.calls.patch, 1, 'stale schema 3 state is refused before another write');
  const refreshed = await f.c.ProjectSync.ensureLocal('p', f.options);
  assert.deepEqual(copy(refreshed.normalization), copy(f.row.state.normalization));
  assert.equal(refreshed.molecules[0].blobId, rawBlob);
  assert.equal(f.calls.download, 0);
});
