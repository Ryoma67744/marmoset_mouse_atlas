'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const JSZip = require(process.env.ATLAS_TEST_JSZIP || 'jszip');

function app() {
  const c = { console, JSZip, Float32Array, Float64Array, Uint8Array, Blob };
  c.window = c;
  vm.createContext(c);
  for (const file of ['msi.js', 'zipio.js', 'cloud.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), c, { filename: file });
  }
  return c;
}

function fixture(schemaVersion = 2) {
  const values = new Float32Array([0, 2, NaN, -0]);
  const project = {
    id: 'original-member', displayName: 'folder-persistence', folderPath: ['Marmoset', 'Coronal', 'Section'],
    grid: { W: 2, H: 2 }, molecules: [{ key: 'd', name: 'D4-5-HT', blobId: 'd' }], images: {},
    normalization: {
      id: 'profile-1', schemaVersion, revision: 1,
      scope: { type: 'folder-depth', depth: 2, includeDescendants: true, groupId: 'group-coronal',
        folderPath: ['Marmoset', 'Coronal'], memberIds: ['original-member', 'missing-sibling'] },
      reference: { projectIds: ['missing-sibling'], Dref: 30 }, section: { Ds: 20, k: 1.5 },
      commonRanges: { da: [0, 100] },
    },
    normalizationBinding: { groupId: 'group-coronal', folderPath: ['Marmoset', 'Coronal'], memberId: 'original-member' },
  };
  if (schemaVersion === 3) Object.assign(project.normalization, {
    methodVersion: '2.0.0', mode: 'simple', mapping: { ht: 'h', d4: 'd', da: null, ne: null },
    targets: [{ key: 'h', method: 'pixel_ratio', analyteId: '5-HT', rangeScope: 'group' },
      { key: 'generic', method: 'section_scale', analyteId: 'Glutamate', rangeScope: 'group' }],
    excludedKeys: ['d'], qc: { minD4: 0, saturationD4: null, minCoverage: 0.8, enforceCoverage: false },
    commonRanges: { '5-HT': [0, 2], Glutamate: [0, 60] },
    reference: { kind: 'd4_measured', projectIds: ['original-member', 'missing-sibling'], Dref: 30 },
  });
  const calls = [];
  const storage = {
    getValueRaster: async () => values,
    putValueRaster: async imported => { calls.push(['raster', imported]); return 'new-raster'; },
    ensureFolderPath: async names => { calls.push(['path', names]); return 'new-leaf-folder'; },
    restoreNormalizationGroup: async (id, groupId) => { calls.push(['group', id, groupId]); },
    commitImportedProject: async (imported, options) => {
      imported.folderId = await storage.ensureFolderPath(options.folderPath);
      if (imported.normalizationBinding && imported.normalizationBinding.groupId) await storage.restoreNormalizationGroup(imported.folderId, imported.normalizationBinding.groupId);
      calls.push(['project', imported.id]);
      return imported;
    },
    deleteBlob: async id => { calls.push(['cleanup', id]); },
    uid: () => 'new-local-member',
  };
  return { project, storage, calls, values };
}

for (const schemaVersion of [2, 3]) test(`schema ${schemaVersion} ZIP subset restore preserves exact profile, raw bits and portable member binding`, async () => {
  const c = app(), f = fixture(schemaVersion);
  const before = JSON.stringify(f.project.normalization);
  const zip = await c.ZipIO.exportProject(f.project, { storage: f.storage });
  const restored = await c.ZipIO.importZip(await zip.arrayBuffer(), { storage: f.storage });
  assert.equal(restored.project.id, 'new-local-member');
  assert.equal(restored.project.folderId, 'new-leaf-folder');
  assert.equal(JSON.stringify(restored.project.normalization), before);
  assert.equal(JSON.stringify(restored.project.normalizationBinding), JSON.stringify(f.project.normalizationBinding));
  assert.deepEqual(f.calls.map(call => call[0]), ['raster', 'path', 'group', 'project']);
  assert.deepEqual(f.calls[2], ['group', 'new-leaf-folder', 'group-coronal']);
  assert.deepEqual(Buffer.from(f.calls[0][1].buffer), Buffer.from(f.values.buffer));
});

test('ZIP identity conflict cleans its staged raw data and never commits a project', async () => {
  const c = app(), f = fixture();
  const before = JSON.stringify(f.project);
  f.storage.restoreNormalizationGroup = async () => { throw new Error('ZIP の補正グループIDが保存先フォルダーと一致しません'); };
  const zip = await c.ZipIO.exportProject(f.project, { storage: f.storage });
  await assert.rejects(c.ZipIO.importZip(await zip.arrayBuffer(), { storage: f.storage }), /グループID.*一致しません/);
  assert.deepEqual(f.calls.map(call => call[0]), ['raster', 'path', 'cleanup']);
  assert.equal(JSON.stringify(f.project), before);
});

test('cloud import applies current folder/binding before an obsolete bundle can restore its old group', async () => {
  const c = app(), f = fixture();
  const zip = await c.ZipIO.exportProject(f.project, { storage: f.storage });
  const binding = { groupId: 'group-sagittal', folderPath: ['Marmoset', 'Sagittal'], memberId: 'original-member' };
  const restored = await c.ZipIO.importZip(await zip.arrayBuffer(), { storage: f.storage,
    folderPath: ['Marmoset', 'Sagittal', 'New section'], state: { normalizationBinding: binding }, displayName: 'Current cloud name',
  });
  assert.equal(JSON.stringify(f.calls[1][1]), JSON.stringify(['Marmoset', 'Sagittal', 'New section']));
  assert.deepEqual(f.calls[2], ['group', 'new-leaf-folder', 'group-sagittal']);
  assert.equal(restored.project.displayName, 'Current cloud name');
  assert.equal(restored.project.normalizationBinding.groupId, 'group-sagittal');
  assert.equal(restored.project.normalization.scope.groupId, 'group-coronal');
  assert.equal(restored.project.normalization.section.k, 1.5);
});

for (const schemaVersion of [2, 3]) test(`schema ${schemaVersion} cloud round trip preserves calculation provenance and detects a moved member`, () => {
  const c = app(), f = fixture(schemaVersion);
  const state = c.Cloud.stateOf(f.project), restored = {};
  c.Cloud.applyState(restored, state);
  assert.equal(JSON.stringify(restored.normalization), JSON.stringify(f.project.normalization));
  assert.equal(JSON.stringify(restored.normalizationBinding), JSON.stringify(f.project.normalizationBinding));
  const before = c.Cloud.hashState(state);
  restored.normalizationBinding = { groupId: 'group-sagittal', folderPath: ['Marmoset', 'Sagittal'], memberId: 'original-member' };
  assert.notEqual(c.Cloud.hashState(c.Cloud.stateOf(restored)), before);
  const meta = c.Cloud.metaOf(restored);
  assert.equal(meta.normalization.groupId, 'group-coronal');
  assert.equal(meta.normalization.memberCount, 2);
  assert.equal(meta.normalizationBinding.groupId, 'group-sagittal');
  assert.equal(meta.normalization.status, 'GROUP_MEMBERSHIP_CHANGED');
  assert.equal(restored.normalization.section.k, 1.5);
  if (schemaVersion === 3) {
    assert.equal(meta.normalization.mode, 'simple');
    assert.equal(meta.normalization.standardKey, 'd');
    assert.equal(JSON.stringify(meta.normalization.targets), JSON.stringify(f.project.normalization.targets));
  }
});

test('authoritative cloud state omitting a profile does not resurrect archived normalization', async () => {
  const c = app(), f = fixture();
  const archive = await c.ZipIO.exportProject(f.project, { storage: f.storage });
  const restored = await c.ZipIO.importZip(await archive.arrayBuffer(), { storage: f.storage,
    state: { valueDisplay: { mode: 'raw' } }, folderPath: ['Marmoset', 'Coronal'],
    cloudMetadata: { cloudUpdatedAt: 'remote-current', cloudStateHash: 'current-state' },
  });
  assert.equal(restored.project.normalization, null);
  assert.equal(restored.project.normalizationBinding, undefined);
  assert.equal(restored.project.valueDisplay.mode, 'raw');
  assert.equal(restored.project.cloudUpdatedAt, 'remote-current');
});

test('cloud state and metadata retain an explicit uncorrected skip and hash it separately from an unset profile', () => {
  const c = app(), f = fixture(3);
  f.project.normalization.application = { status: 'skipped', reasonCode: 'INTERNAL_STANDARD_MISSING' };
  f.project.normalization.mapping = { ht: null, d4: null, da: null, ne: null };
  f.project.normalization.targets = [];
  f.project.normalization.section = { Ds: null, Dref: null, k: null, status: 'SKIPPED', reasonCodes: ['INTERNAL_STANDARD_MISSING'] };
  f.project.valueDisplay = { mode: 'raw', scale: 'common' };
  const state = c.Cloud.stateOf(f.project), restored = {};
  c.Cloud.applyState(restored, state);
  assert.equal(JSON.stringify(restored.normalization), JSON.stringify(f.project.normalization));
  assert.equal(restored.valueDisplay.mode, 'raw');
  assert.equal(JSON.stringify(c.Cloud.metaOf(restored).normalization.application), JSON.stringify(f.project.normalization.application));
  assert.equal(c.Cloud.metaOf(restored).normalization.status, 'SKIPPED');
  const skippedHash = c.Cloud.hashState(state);
  delete restored.normalization.application;
  assert.notEqual(c.Cloud.hashState(c.Cloud.stateOf(restored)), skippedHash, 'a lost skip marker must create a state mismatch');
  restored.normalization = null;
  assert.notEqual(c.Cloud.hashState(c.Cloud.stateOf(restored)), skippedHash, 'an unconfigured project differs from a deliberately recorded skip');
});
