'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
const JSZip = require(process.env.ATLAS_TEST_JSZIP || 'jszip');
const source = fs.readFileSync(path.join(__dirname, '../lib/offline-workspace.js'), 'utf8');

function api() {
  const context = { JSZip, crypto, Blob, TextEncoder, TextDecoder, Uint8Array, Uint32Array, ArrayBuffer, DataView, console };
  context.window = context;
  vm.runInNewContext(source, context);
  return context.OfflineWorkspace;
}
function fixture() {
  // Includes a noncanonical NaN payload, negative zero and an exact Float32 bit pattern.
  const raw = new Uint32Array([0, 0x80000000, 0x7fc12345, 0x3f9e0652]);
  return {
    projects: [{ id: 'section-original', displayName: '切片 ±', folderId: 'child', grid: { W: 2, H: 2 },
      molecules: [{ key: 'DA', blobId: 'raster' }], images: { HE_Stain: { blobId: 'he' } },
      rois: [{ name: '=ROI', points: [[0.25, 1.5], [2.75, 3.125]] }],
      normalization: { scale: 1.23456789012345, sourceIds: ['section-original'] },
      normalizationBinding: { groupId: 'group', memberId: 'member', originalMemberIds: ['member'] },
      uncommon: { notSet: undefined, missing: NaN, upper: Infinity, lower: -Infinity, zero: -0 } }],
    folders: [{ id: 'root', parentId: null, name: '動物', normalizationGroupId: 'group' },
      { id: 'child', parentId: 'root', name: '切片' }, { id: 'empty', parentId: 'root', name: '空フォルダ' }],
    blobs: [{ id: 'raster', blob: new Blob([raw.buffer]), mime: 'application/octet-stream', filename: 'raw.f32' },
      { id: 'he', blob: new Blob([new Uint8Array([0, 255, 128, 7, 42])]), mime: 'image/tiff', filename: '染色.tif' }],
  };
}
async function archive() { return api().encode(fixture(), { workspaceId: 'workspace-test', appVersion: '2.test' }); }
async function unzip(blob) { return JSZip.loadAsync(await blob.arrayBuffer()); }
async function zipBlob(zip, options) { return new Blob([await zip.generateAsync({ type: 'uint8array', compression: 'STORE', ...options })]); }
async function editManifest(blob, edit) {
  const zip = await unzip(blob), value = JSON.parse(await zip.file('manifest.json').async('string'));
  edit(value); zip.file('manifest.json', JSON.stringify(value), { createFolders: false });
  return zipBlob(zip);
}

test('workspace round-trip preserves original binary bits, IDs, scientific metadata, and empty folders', async () => {
  const input = fixture(), progress = [], writer = api();
  const encoded = await writer.encode(input, { workspaceId: 'workspace-test', appVersion: '2.test', onProgress: p => progress.push(p.phase) });
  const { snapshot, manifest } = await writer.decode(encoded, { onProgress: p => progress.push(p.phase) });
  assert.equal(manifest.format, writer.FORMAT);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.workspaceId, 'workspace-test');
  assert.equal(manifest.appVersion, '2.test');
  assert.deepEqual(JSON.parse(JSON.stringify(manifest.counts)), { projects: 1, folders: 3, blobs: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.projects)), JSON.parse(JSON.stringify(input.projects)));
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.folders)), input.folders);
  const uncommon = snapshot.projects[0].uncommon;
  assert.ok(Object.hasOwn(uncommon, 'notSet'));
  assert.equal(uncommon.notSet, undefined);
  assert.ok(Number.isNaN(uncommon.missing));
  assert.equal(uncommon.upper, Infinity);
  assert.equal(uncommon.lower, -Infinity);
  assert.ok(Object.is(uncommon.zero, -0));
  for (let i = 0; i < input.blobs.length; i++) {
    assert.equal(snapshot.blobs[i].id, input.blobs[i].id);
    assert.equal(snapshot.blobs[i].filename, input.blobs[i].filename);
    assert.equal(snapshot.blobs[i].mime, input.blobs[i].mime);
    assert.deepEqual(Buffer.from(await snapshot.blobs[i].blob.arrayBuffer()), Buffer.from(await input.blobs[i].blob.arrayBuffer()));
    assert.match(manifest.blobs[i].sha256, /^[a-f0-9]{64}$/);
  }
  assert.ok(progress.includes('encode') && progress.includes('decode'));
  assert.equal(input.projects[0].uncommon.notSet, undefined, 'encoding must not mutate the source');
});

test('empty workspaces remain valid, including a folder-only workspace', async () => {
  const input = { projects: [], folders: [{ id: 'empty', name: 'Empty', parentId: null }], blobs: [] };
  const result = await api().decode(await api().encode(input));
  assert.equal(result.snapshot.projects.length, 0);
  assert.equal(result.snapshot.folders[0].id, 'empty');
  assert.match(result.manifest.workspaceId, /^[a-f0-9-]{36}$/);
});

test('workspace validates SHA-256 even when modified entries have valid ZIP CRCs', async () => {
  const zip = await unzip(await archive());
  zip.file('blobs/00000001.bin', new Uint8Array(16), { createFolders: false });
  await assert.rejects(api().decode(await zipBlob(zip)), /SHA-256/);
});

test('workspace checks metadata hashes before interpreting or restoring projects', async () => {
  const zip = await unzip(await archive());
  const text = await zip.file('metadata.json').async('string');
  zip.file('metadata.json', text.replace('section-original', 'section-modified'), { createFolders: false });
  await assert.rejects(api().decode(await zipBlob(zip)), /サイズ|SHA-256/);
});

test('workspace rejects future formats and inconsistent counts', async () => {
  const blob = await archive();
  for (const edit of [m => { m.version = 2; }, m => { m.format = 'different'; }]) {
    await assert.rejects(api().decode(await editManifest(blob, edit)), /形式またはバージョン/);
  }
  await assert.rejects(api().decode(await editManifest(blob, m => { m.counts.blobs++; })), /件数/);
  await assert.rejects(api().decode(await editManifest(blob, m => { m.counts.projects++; })), /件数/);
});

test('workspace rejects missing binary entries and undeclared extras', async () => {
  const zip = await unzip(await archive());
  zip.remove('blobs/00000001.bin');
  await assert.rejects(api().decode(await zipBlob(zip)), /件数|参照先/);
  zip.file('unexpected.txt', 'extra');
  await assert.rejects(api().decode(await zipBlob(zip)), /予期しない/);
});

test('workspace rejects path traversal before JSZip can normalize it', async () => {
  const zip = await unzip(await archive());
  zip.file('../escape.txt', 'escape', { createFolders: false });
  await assert.rejects(api().decode(await zipBlob(zip)), /パス/);
});

test('workspace rejects duplicate entry paths before JSZip can overwrite them', async () => {
  const zip = await unzip(await archive());
  zip.file('blobs/00000003.bin', new Uint8Array(5), { createFolders: false });
  const bytes = Buffer.from(await (await zipBlob(zip)).arrayBuffer());
  const needle = Buffer.from('blobs/00000003.bin');
  let position = -1;
  while ((position = bytes.indexOf(needle, position + 1)) >= 0) bytes.write('blobs/00000002.bin', position);
  await assert.rejects(api().decode(new Blob([bytes])), /重複/);
});

test('workspace rejects compressed payloads, malformed sizes, and accidental byte damage', async () => {
  const blob = await archive(), zip = await unzip(blob);
  await assert.rejects(api().decode(await zipBlob(zip, { compression: 'DEFLATE' })), /圧縮形式/);
  const bytes = Buffer.from(await blob.arrayBuffer());
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const huge = Buffer.from(bytes); huge.writeUInt32LE(api().LIMITS.entry + 1, central + 24);
  await assert.rejects(api().decode(new Blob([huge])), /サイズ/);
  const damaged = Buffer.from(bytes);
  damaged[30 + damaged.readUInt16LE(26) + damaged.readUInt16LE(28) + 3] ^= 1;
  await assert.rejects(api().decode(new Blob([damaged])), /CRC/);
});

test('workspace rejects dangling references, duplicate IDs, wrong raster sizes, and folder cycles', async () => {
  const missing = fixture(); missing.blobs.pop();
  await assert.rejects(api().encode(missing), /参照先/);
  const duplicate = fixture(); duplicate.projects.push(duplicate.projects[0]);
  await assert.rejects(api().encode(duplicate), /重複/);
  const truncated = fixture(); truncated.blobs[0].blob = new Blob([new Uint8Array(4)]);
  await assert.rejects(api().encode(truncated), /ラスタの長さ/);
  const cycle = fixture(); cycle.folders[0].parentId = 'child';
  await assert.rejects(api().encode(cycle), /循環/);
  const missingFolder = fixture(); missingFolder.projects[0].folderId = 'gone';
  await assert.rejects(api().encode(missingFolder), /フォルダ/);
  const missingImage = fixture(); missingImage.projects[0].images.ATLAS = null;
  await assert.rejects(api().encode(missingImage), /参照先/);
});

test('workspace rejects prototype keys and unsupported metadata rather than losing values', async () => {
  for (const key of ['__proto__', 'constructor', 'prototype', '__atlas_scalar__']) {
    const input = fixture(); input.projects[0].unsafe = JSON.parse('{"' + key + '":"value"}');
    await assert.rejects(api().encode(input), /キー/);
  }
  const input = fixture(); input.projects[0].unsupported = new Map([['key', 1]]);
  await assert.rejects(api().encode(input), /メタデータ型/);
});

test('workspace honors cancellation before encoding and during verification', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api().encode(fixture(), { signal: controller.signal }), { name: 'AbortError' });
  const next = new AbortController();
  await assert.rejects(api().decode(await archive(), { signal: next.signal, onProgress() { next.abort(); } }), { name: 'AbortError' });
});

test('workspace rejects a missing scientific reference even with recomputed valid hashes', async () => {
  const zip = await unzip(await archive());
  const metadata = JSON.parse(await zip.file('metadata.json').async('string'));
  metadata.projects[0].molecules[0].blobId = 'not-in-the-snapshot';
  const bytes = new TextEncoder().encode(JSON.stringify(metadata));
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  manifest.metadata.size = bytes.length;
  manifest.metadata.sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  zip.file('metadata.json', bytes, { createFolders: false });
  zip.file('manifest.json', JSON.stringify(manifest), { createFolders: false });
  await assert.rejects(api().decode(await zipBlob(zip)), /参照先/);
});

test('workspace bounds input before allocating its buffer and rejects unsafe workspace IDs', async () => {
  await assert.rejects(api().decode({ size: api().LIMITS.archive + 1, arrayBuffer() { throw new Error('must not read'); } }), /512 MiB/);
  for (const id of ['../data', '-starts-with-symbol', 'with spaces', 'x'.repeat(81)]) {
    await assert.rejects(api().encode(fixture(), { workspaceId: id }), /ID が不正/);
  }
});

test('workspace rejects ZIP encryption flags and symbolic links', async () => {
  const blob = await archive(), bytes = Buffer.from(await blob.arrayBuffer());
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const encrypted = Buffer.from(bytes); encrypted.writeUInt16LE(1, central + 8);
  await assert.rejects(api().decode(new Blob([encrypted])), /圧縮形式/);
  const symlink = Buffer.from(bytes); symlink.writeUInt32LE(0xa1ff0000, central + 38);
  await assert.rejects(api().decode(new Blob([symlink])), /シンボリックリンク/);
});

async function template() {
  const zip = new JSZip();
  for (const [name, value] of Object.entries({ 'app/index.html': '<html>Atlas</html>', 'app/lib/offline-config.js': 'window.ATLAS_OFFLINE = null;',
    'runtime/node.exe': 'runtime-test-bytes', 'START_ATLAS.cmd': '@echo off', 'offline/server.cjs': 'server',
    'offline/package-files.json': '{"files":[]}', 'README.txt': 'offline usage', 'LICENSES/test.txt': 'license' })) {
    zip.file(name, value, { createFolders: false });
  }
  return zipBlob(zip);
}

test('app package injects a matching workspace and safely encoded offline bootstrap without altering runtime bytes', async () => {
  const workspace = await archive();
  const result = await api().packageApp(await template(), workspace, { workspaceId: 'workspace-test', appVersion: '2.test</script>' });
  const zip = await unzip(result);
  assert.deepEqual(Buffer.from(await zip.file('app/data/workspace.zip').async('uint8array')), Buffer.from(await workspace.arrayBuffer()));
  assert.equal(await zip.file('runtime/node.exe').async('string'), 'runtime-test-bytes');
  const configText = await zip.file('app/lib/offline-config.js').async('string');
  assert.ok(!configText.includes('</script>'));
  const context = { window: {} }; vm.runInNewContext(configText, context);
  assert.equal(context.window.ATLAS_OFFLINE.enabled, true);
  assert.equal(context.window.ATLAS_OFFLINE_WORKSPACE_ID, 'workspace-test');
  assert.equal(context.window.ATLAS_OFFLINE.workspaceArchive, 'data/workspace.zip');
  assert.equal(zip.file('app/data/app-files.json'), null, 'launcher provides the canonical file manifest');
});

test('app package rejects identity mismatch, unexpected root files, and an embedded workspace template', async () => {
  const workspace = await archive();
  await assert.rejects(api().packageApp(await template(), workspace, { workspaceId: 'different' }), /ID が一致/);
  const source = await unzip(await template());
  source.file('secret.env', 'unexpected');
  await assert.rejects(api().packageApp(await zipBlob(source), workspace), /予期しないパス/);
  source.remove('secret.env'); source.file('app/data/workspace.zip', 'unexpected', { createFolders: false });
  await assert.rejects(api().packageApp(await zipBlob(source), workspace), /データが含まれています/);
});
