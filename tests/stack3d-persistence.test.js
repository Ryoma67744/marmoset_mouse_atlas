'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const JSZip = require(process.env.ATLAS_TEST_JSZIP || 'jszip');
const plain = value => JSON.parse(JSON.stringify(value));

function app() {
  const c = { console, JSZip, Float32Array, Float64Array, Uint8Array, Blob };
  c.window = c;
  vm.createContext(c);
  for (const file of ['msi.js', 'zipio.js', 'cloud.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), c, { filename: file });
  }
  return c;
}
function fixture() {
  const data = { raw: new Float32Array([-0, 0, 1 / 3, NaN, 9.75, -4]) };
  const project = { id: 'synthetic-coronal', displayName: 'Cor_1_4', folderPath: [],
    grid: { W: 3, H: 2, umPerPxX: 25, umPerPxY: 50 }, images: {},
    molecules: [{ key: 'da', name: 'DA', blobId: 'raw' }],
    stack3d: { offsetXUm: 250, offsetYUm: -175, rotationDeg: 13.5 },
    rotation: { all: 94, msi: 0, he: 0 },
    viewerTransform: { tx: 123, ty: -456, scale: 7 },
    roi: { roi_items: { cortex: [{ poly_msi: [[0, 0], [3, 0], [3, 2]] }] } },
    normalization: { id: 'immutable-snapshot', section: { k: 1.25 } } };
  let serial = 0;
  const storage = { getValueRaster: async id => data[id],
    putValueRaster: async values => { const id = 'restored-' + ++serial; data[id] = values; return id; },
    uid: () => 'restored-project', commitImportedProject: async p => p };
  return { project, data, storage };
}

test('cloud state shares 3D placement independently of per-device camera and removes absent authoritative placement', () => {
  const c = app(), { project } = fixture();
  const initialState = plain(c.Cloud.stateOf(project));
  assert.deepEqual(initialState.stack3d, project.stack3d);
  assert.equal(initialState.viewerTransform, undefined);
  const originalHash = c.Cloud.hashState(initialState);
  project.viewerTransform.scale = 50;
  assert.equal(c.Cloud.hashState(c.Cloud.stateOf(project)), originalHash, 'camera movement cannot dirty shared placement');
  project.stack3d.rotationDeg += 1;
  assert.notEqual(c.Cloud.hashState(c.Cloud.stateOf(project)), originalHash, 'placement changes must participate in cloud conflict detection');
  const target = { id: 'new-device', viewerTransform: { tx: 0, ty: 0, scale: 1 } };
  c.Cloud.applyState(target, initialState);
  assert.deepEqual(plain(target.stack3d), initialState.stack3d);
  c.Cloud.replaceState(target, { rotation: initialState.rotation });
  assert.equal(Object.hasOwn(target, 'stack3d'), false, 'old cloud rows intentionally lacking placement must clear a stale local placement');
  assert.deepEqual(target.viewerTransform, { tx: 0, ty: 0, scale: 1 });
});

test('real ZIP roundtrip preserves placement, saved rotation and exact raw float32 values', async () => {
  const c = app(), f = fixture(), before = plain(f.project);
  const archive = await c.ZipIO.exportProject(f.project, { storage: f.storage });
  const imported = await c.ZipIO.importZip(await archive.arrayBuffer(), { storage: f.storage });
  assert.deepEqual(plain(imported.project.stack3d), f.project.stack3d);
  assert.deepEqual(plain(imported.project.rotation), f.project.rotation);
  assert.deepEqual(plain(imported.project.normalization), f.project.normalization);
  assert.deepEqual(plain(imported.project.roi), f.project.roi);
  const after = f.data[imported.project.molecules[0].blobId];
  assert.deepEqual(Buffer.from(after.buffer), Buffer.from(f.data.raw.buffer));
  assert.deepEqual(plain(f.project), before);
});

test('authoritative cloud state overrides embedded ZIP placement and legacy archives retain default placement', async () => {
  const c = app(), f = fixture();
  const archive = await c.ZipIO.exportProject(f.project, { storage: f.storage });
  const state = plain(c.Cloud.stateOf(f.project));
  state.stack3d = { offsetXUm: -750, offsetYUm: 800, rotationDeg: -27 };
  const latest = (await c.ZipIO.importZip(await archive.arrayBuffer(), { storage: f.storage, state,
    cloudMetadata: { cloudUpdatedAt: 'latest' } })).project;
  assert.deepEqual(plain(latest.stack3d), state.stack3d);
  delete state.stack3d;
  const cleared = (await c.ZipIO.importZip(await archive.arrayBuffer(), { storage: f.storage, state,
    cloudMetadata: { cloudUpdatedAt: 'newer-without-placement' } })).project;
  assert.equal(cleared.stack3d == null, true, 'remote deletion cannot restore obsolete placement from a bundle');
  delete f.project.stack3d;
  const legacyArchive = await c.ZipIO.exportProject(f.project, { storage: f.storage });
  const legacy = (await c.ZipIO.importZip(await legacyArchive.arrayBuffer(), { storage: f.storage })).project;
  assert.equal(legacy.stack3d == null, true);
  assert.equal(Object.hasOwn(legacy, 'stack3d'), false, 'legacy import must not add a null placement and dirty the cloud state hash');
});
