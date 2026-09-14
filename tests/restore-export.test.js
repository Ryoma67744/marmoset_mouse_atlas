'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const JSZip = require(process.env.ATLAS_TEST_JSZIP || 'jszip');

function fixture() {
  const c = { console: { warn() {} }, JSZip, Float32Array, Uint8Array, Blob };
  c.window = c;
  vm.createContext(c);
  for (const file of ['msi.js', 'zipio.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), c, { filename: file });
  }
  const data = { raw: new Float32Array([0, -0, 1.23456789, NaN]) };
  const blobs = {};
  let serial = 0;
  const project = {
    id: 'original', displayName: 'section', grid: { W: 2, H: 2 },
    molecules: [{ key: 'DA', name: 'DA', blobId: 'raw' }], images: {},
  };
  const storage = {
    getValueRaster: async id => data[id] || null,
    putValueRaster: async values => { const id = 'raster-' + ++serial; data[id] = values; return id; },
    getBlob: async id => blobs[id] || null,
    putBlob: async rec => { const id = 'image-' + ++serial; blobs[id] = rec; return id; },
    uid: () => 'restored',
    commitImportedProject: async imported => imported,
  };
  return { c, project, storage, data, blobs };
}

async function unpack(blob) {
  return JSZip.loadAsync(await blob.arrayBuffer());
}

test('strict restoration export rejects an absent or truncated registered raster', async () => {
  const f = fixture();
  delete f.data.raw;
  await assert.rejects(f.c.ZipIO.exportProject(f.project, { storage: f.storage }, { strict: true }), /生値ラスタが見つからない/);
  f.data.raw = new Float32Array([1, 2]);
  await assert.rejects(f.c.ZipIO.exportProject(f.project, { storage: f.storage }, { strict: true }), /ラスタ長.*一致しません/);
});

test('strict restoration export rejects declared images with absent references, absent bytes or empty originals', async () => {
  const f = fixture();
  for (const image of [null, { filename: 'HE.tif' }]) {
    f.project.images.HE = image;
    await assert.rejects(f.c.ZipIO.exportProject(f.project, { storage: f.storage }, { strict: true }), /登録済み画像.*保存先/);
  }
  f.project.images.HE = { blobId: 'he', filename: 'HE.tif' };
  for (const rec of [null, {}, { blob: new Blob([]) }]) {
    f.blobs.he = rec;
    await assert.rejects(f.c.ZipIO.exportProject(f.project, { storage: f.storage }, { strict: true }), /HE\.tif.*原本/);
  }
});

test('default restoration export preserves its legacy handling of missing rasters and images', async () => {
  const f = fixture();
  delete f.data.raw;
  f.project.images.HE = { blobId: 'missing', filename: 'missing.tif' };
  const zip = await unpack(await f.c.ZipIO.exportProject(f.project, { storage: f.storage }));
  const manifest = JSON.parse(await zip.file('section.json').async('string'));
  assert.deepEqual(manifest.images, {});
  assert.equal(manifest.molecules.length, 1);
  assert.equal(await zip.file(manifest.data.path).async('string'), 'x,y,DA\n');
});

test('strict restoration export permits unregistered optional images and preserves float32 raw values', async () => {
  const f = fixture();
  const blob = await f.c.ZipIO.exportProject(f.project, { storage: f.storage }, { strict: true });
  const restored = (await f.c.ZipIO.importZip(await blob.arrayBuffer(), { storage: f.storage })).project;
  assert.equal(restored.molecules.length, 1);
  assert.deepEqual(Buffer.from(f.data[restored.molecules[0].blobId].buffer), Buffer.from(f.data.raw.buffer));
  assert.deepEqual(Object.keys(restored.images), []);
});

test('restoration ZIP gives same-name and sanitized image names unique paths and restores every original', async () => {
  const f = fixture();
  const inputs = [
    ['HE_1', 'scan.tif', 'first original'],
    ['HE_2', 'scan.tif', 'second original'],
    ['HE_3', 'SCAN.TIF', 'case-sensitive original'],
    ['HE_4', 'scan__2.tif', 'suffix-like original'],
    ['HE_5', 'scan a.tif', 'space original'],
    ['HE_6', 'scan?a.tif', 'question-mark original'],
    ['ATLAS', 'scan.tif', 'atlas original'],
    ['IMMUNO', 'scan.tif', 'immuno original'],
  ];
  for (const [key, filename, contents] of inputs) {
    f.project.images[key] = { blobId: key, filename, mime: 'image/tiff' };
    // Node JSZip accepts byte arrays at the same binary serialization boundary
    // where the browser accepts its IndexedDB Blob records.
    f.blobs[key] = { blob: new Uint8Array(Buffer.from(contents)), mime: 'image/tiff' };
  }
  const snapshot = JSON.stringify(f.project);
  const archive = await f.c.ZipIO.exportProject(f.project, { storage: f.storage }, { strict: true });
  const zip = await unpack(archive);
  const manifest = JSON.parse(await zip.file('section.json').async('string'));
  const paths = Object.values(manifest.images).map(im => im.path);
  assert.equal(new Set(paths.map(value => value.toLowerCase())).size, inputs.length);
  assert.equal(manifest.images.HE_1.path, 'HE/scan.tif');
  assert.equal(manifest.images.ATLAS.path, 'Atlas/scan.tif');
  assert.equal(manifest.images.IMMUNO.path, 'Immuno/scan.tif');
  for (const [key, filename, contents] of inputs) {
    assert.equal(manifest.images[key].filename, filename);
    assert.equal(await zip.file(manifest.images[key].path).async('string'), contents);
  }
  const restored = (await f.c.ZipIO.importZip(await archive.arrayBuffer(), { storage: f.storage })).project;
  assert.deepEqual(Object.keys(restored.images), inputs.map(item => item[0]));
  for (const [key, filename, contents] of inputs) {
    assert.equal(restored.images[key].filename, filename);
    assert.equal(await f.blobs[restored.images[key].blobId].blob.text(), contents);
  }
  assert.equal(JSON.stringify(f.project), snapshot);
});
