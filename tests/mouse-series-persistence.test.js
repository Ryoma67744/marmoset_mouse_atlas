'use strict';

// Exercise the portable ZIP boundary with synthetic data, without user files,
// browser storage, a network connection, or a cloud account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const JSZip = require(process.env.ATLAS_TEST_JSZIP || 'jszip');
const plain = value => JSON.parse(JSON.stringify(value));
const names = ['GABA-DPP', 'Histamine-DPP', 'Dopamine-DPP', 'Norepinephrine-DPP', 'Serotonin-DPP', 'Serotonin-d4-DPP'];

function fixture() {
  const c = { console, JSZip, Float32Array, Float64Array, Uint8Array, Blob };
  c.window = c; vm.createContext(c);
  for (const file of ['msi.js', 'zipio.js', 'series-import.js', 'cloud.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), c, { filename: file });
  }
  const rasters = {}, projects = new Map(), committed = [], removed = [];
  let serial = 0;
  const storage = {
    uid: prefix => prefix + '-' + ++serial,
    listProjects: async () => Array.from(projects.values()),
    getProject: async id => projects.get(id),
    listFolders: async () => [],
    getValueRaster: async id => rasters[id],
    putValueRaster: async values => { const id = 'raster-' + ++serial; rasters[id] = values; return id; },
    commitImportedProject: async (project, options) => {
      assert.equal(options.expectedUpdatedAt, null);
      if (storage.failOnSection && project.atlas?.sectionNumber === storage.failOnSection) throw new Error('synthetic commit failure');
      project.updatedAt = 'revision-' + ++serial;
      projects.set(project.id, project); committed.push(project.id); return project;
    },
    deleteProject: async (id, options) => {
      assert.equal(options.expectedUpdatedAt, projects.get(id).updatedAt, 'rollback uses the imported revision');
      const old = projects.get(id); projects.delete(id); removed.push(id);
      await storage.deleteUnreferencedBlobs(old.molecules.map(m => m.blobId));
    },
    deleteUnreferencedBlobs: async ids => {
      const used = new Set(Array.from(projects.values()).flatMap(p => p.molecules.map(m => m.blobId)));
      for (const id of ids) if (!used.has(id)) delete rasters[id];
    },
  };
  function mouse(number) {
    const project = {
      id: 'source-' + number, displayName: 'Mouse_' + number, folderPath: ['Mouse', 'tissue_1set'],
      plane: 'coronal', orientation: 'coronal', sliceId: String(number),
      atlas: { species: 'mouse', seriesId: 'mouse_tissue_1set', seriesName: 'tissue_1set', specimenId: 'tissue_1set',
        sectionNumber: number, sourceCandidateId: number === 11 ? 'C028' : 'C' + number,
        coordinateMode: 'pixel', physicalSectionSpacing: null, displaySpacing: 2,
        sourceFile: 'synthetic.parquet', sourceSha256: 'f'.repeat(64), sourcePointCount: 4,
        sourceCoordinateGridStep: 150, sourceCoordinateUnit: null,
        extraction: { status: 'prototype', method: 'sum_fixed_window', configSha256: 'e'.repeat(64),
          backgroundSubtraction: false, internalStandardNormalization: false } },
      grid: { W: 3, H: 2, umPerPxX: null, umPerPxY: null },
      rotation: { all: 0, he: 0, msi: 0 }, images: {},
      stack3d: { coordinateMode: 'pixel', offsetXPx: -2.125, offsetYPx: 3.5, rotationDeg: -17.25 },
      molecules: names.map((name, i) => {
        const blobId = 'source-' + number + '-' + i;
        // Numeric zero and unmeasured NaN must survive as different states.
        rasters[blobId] = new Float32Array([-0, 0, 1 / 3 + i, NaN, 7.75 + i, NaN]);
        return { key: 'm' + i, name, analyteId: name, blobId,
          extraction: { method: 'sum_fixed_window', columns: ['mz_' + i], lowerMzInclusive: 318 + i,
            upperMzInclusive: 318.01 + i, outputDtype: 'float32' } };
      }),
      valueDisplay: { mode: 'raw', scale: 'individual' }, visibleLayers: ['m0'],
      viewerTransform: { tx: 4, ty: -3, scale: 2 },
    };
    return project;
  }
  return { c, rasters, projects, committed, removed, storage, mouse };
}

async function archive(f, projects, changeIndex) {
  const outer = new JSZip(), index = {
    format: 'mouse_atlas_series_v1', version: 1,
    atlas: { seriesId: 'mouse_tissue_1set', species: 'mouse', coordinateMode: 'pixel' }, projects: [],
  };
  for (const project of projects) {
    const filename = project.displayName + '.zip';
    const blob = await f.c.ZipIO.exportProject(project, { storage: f.storage }, { strict: true });
    outer.file(filename, await blob.arrayBuffer());
    index.projects.push({ path: filename, sectionNumber: project.atlas.sectionNumber,
      sourceCandidateId: project.atlas.sourceCandidateId });
  }
  if (changeIndex) changeIndex(index);
  outer.file('series.json', JSON.stringify(index));
  return outer.generateAsync({ type: 'uint8array' });
}

test('mouse ZIP roundtrip preserves source provenance, unknown units, rigid placement and six distinct exact rasters', async () => {
  const f = fixture(), source = f.mouse(11), before = plain(source);
  const bytesBefore = source.molecules.map(m => Buffer.from(f.rasters[m.blobId].buffer));
  const zip = await f.c.ZipIO.exportProject(source, { storage: f.storage }, { strict: true });
  const restored = (await f.c.ZipIO.importZip(await zip.arrayBuffer(), { storage: f.storage })).project;
  for (const key of ['atlas', 'grid', 'stack3d', 'rotation', 'visibleLayers', 'valueDisplay', 'viewerTransform']) {
    assert.deepEqual(plain(restored[key]), before[key], key);
  }
  assert.deepEqual(plain(restored.molecules.map(m => m.analyteId)), names);
  restored.molecules.forEach((m, i) => {
    assert.deepEqual(plain(m.extraction), source.molecules[i].extraction);
    assert.deepEqual(Buffer.from(f.rasters[m.blobId].buffer), bytesBefore[i]);
    assert.ok(Object.is(f.rasters[m.blobId][0], -0));
    assert.ok(Number.isNaN(f.rasters[m.blobId][3]));
  });
  assert.deepEqual(plain(source), before, 'export and import leave the source project exact');
  source.molecules.forEach((m, i) => assert.deepEqual(Buffer.from(f.rasters[m.blobId].buffer), bytesBefore[i]));

  const state = f.c.Cloud.stateOf(restored), metadata = f.c.Cloud.metaOf(restored);
  assert.deepEqual(plain(state.atlas), before.atlas);
  assert.deepEqual(plain(metadata.atlas), before.atlas);
  assert.equal(metadata.grid.umPerPxX, null); assert.equal(metadata.grid.umPerPxY, null);
  const remote = { grid: { ...restored.grid } };
  f.c.Cloud.applyState(remote, plain(state));
  assert.deepEqual(plain(remote.atlas), before.atlas);
  assert.deepEqual(plain(remote.stack3d), before.stack3d);
  const legacy = { rotation: { all: 94 }, stack3d: { offsetXUm: 1 } };
  assert.equal(Object.hasOwn(f.c.Cloud.stateOf(legacy), 'atlas'), false,
    'legacy cloud hashes must not gain an absent species field');
});

test('series import orders explicit sections and preserves the existing marmoset project', async () => {
  const f = fixture(), a = f.mouse(11), b = f.mouse(1), progress = [];
  const old = { id: 'legacy', displayName: 'Cor_1_1', molecules: [] };
  f.projects.set(old.id, old);
  const bytes = await archive(f, [a, b]);
  const result = await f.c.AtlasSeriesImport.importFile(bytes, { storage: f.storage,
    onProgress: value => progress.push(value.completed) });
  assert.deepEqual(plain(result.projects.map(p => p.atlas.sectionNumber)), [1, 11]);
  assert.equal(result.projects[1].atlas.sourceCandidateId, 'C028');
  assert.deepEqual(progress, [1, 2]);
  assert.equal(f.projects.get('legacy'), old);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.series.seriesId, 'mouse_tissue_1set');
  assert.equal(f.projects.size, 3);
});

test('existing series, duplicate numbers and mismatched nested metadata fail before any writes', async () => {
  for (const kind of ['existing', 'duplicate', 'candidate', 'number']) {
    const f = fixture(), a = f.mouse(1), b = f.mouse(11);
    const bytes = await archive(f, [a, b], index => {
      if (kind === 'duplicate') index.projects[1].sectionNumber = 1;
      if (kind === 'candidate') index.projects[1].sourceCandidateId = 'wrong-candidate';
      if (kind === 'number') index.projects[1].sectionNumber = 12;
    });
    if (kind === 'existing') f.projects.set('old-mouse', a);
    const dataIds = Object.keys(f.rasters);
    await assert.rejects(f.c.AtlasSeriesImport.importFile(bytes, { storage: f.storage }),
      /すでに登録|不正・重複|一致しません/);
    assert.deepEqual(f.committed, [], kind);
    assert.deepEqual(Object.keys(f.rasters), dataIds, 'no staging occurred for ' + kind);
  }
});

test('remote-only and partial cloud series prevent duplicate imports before local staging', async () => {
  for (const field of ['meta', 'state']) {
    const f = fixture(), bytes = await archive(f, [f.mouse(1), f.mouse(11)]);
    const before = Object.keys(f.rasters), remote = [
      { id: 'legacy', display_name: 'Cor_1_1', meta: {}, state: {} },
      { id: 'already-uploaded-section', [field]: { atlas: { seriesId: 'mouse_tissue_1set', sectionNumber: 1 } } },
    ];
    const remoteBefore = plain(remote);
    let reads = 0;
    f.c.Cloud = { configured: () => true, signedIn: () => true, listProjects: async () => { reads++; return remote; } };
    await assert.rejects(f.c.AtlasSeriesImport.importFile(bytes, { storage: f.storage }), /クラウドにすでに登録/);
    assert.equal(reads, 1);
    assert.equal(f.projects.size, 0);
    assert.deepEqual(f.committed, []);
    assert.deepEqual(Object.keys(f.rasters), before, 'remote duplicate must not stage rasters');
    assert.deepEqual(remote, remoteBefore, 'inventory read must not change remote rows');
  }
});

test('unavailable cloud inventory fails closed and a retry fetches a fresh inventory', async () => {
  for (const failure of ['signed-out', 'offline', 'invalid']) {
    const f = fixture(), bytes = await archive(f, [f.mouse(1), f.mouse(11)]);
    const before = Object.keys(f.rasters);
    let recovered = false, reads = 0;
    f.c.Cloud = {
      configured: () => true,
      signedIn: () => recovered || failure !== 'signed-out',
      listProjects: async () => {
        reads++;
        if (!recovered && failure === 'offline') throw new Error('synthetic unavailable');
        if (!recovered && failure === 'invalid') return null;
        return [{ id: 'legacy-cloud', meta: {}, state: {} }];
      },
    };
    await assert.rejects(f.c.AtlasSeriesImport.importFile(bytes, { storage: f.storage }), /ログイン|読み込みを開始していません/);
    assert.deepEqual(f.committed, []);
    assert.deepEqual(Object.keys(f.rasters), before);
    recovered = true;
    const result = await f.c.AtlasSeriesImport.importFile(bytes, { storage: f.storage });
    assert.equal(result.projects.length, 2);
    assert.equal(reads, failure === 'signed-out' ? 1 : 2, 'retry must check current cloud contents');
    const count = f.committed.length;
    await assert.rejects(f.c.AtlasSeriesImport.importFile(bytes, { storage: f.storage }), /すでに登録.*アップロード/);
    assert.equal(f.committed.length, count, 'retry after import must use existing records, not duplicate them');
  }
});

test('failed later slice rolls back only this import, including staged measurement rasters', async () => {
  const f = fixture(), a = f.mouse(1), b = f.mouse(11);
  const old = { id: 'legacy', displayName: 'Cor_1_2', updatedAt: 'old-revision',
    molecules: [{ blobId: 'legacy-values' }] };
  f.rasters['legacy-values'] = new Float32Array([1, 2]);
  f.projects.set(old.id, old);
  const bytes = await archive(f, [b, a]), before = Object.keys(f.rasters);
  f.storage.failOnSection = 11;
  await assert.rejects(f.c.AtlasSeriesImport.importFile(bytes, { storage: f.storage }), /synthetic commit failure/);
  assert.equal(f.committed.length, 1);
  assert.deepEqual(f.removed, f.committed);
  assert.deepEqual(Array.from(f.projects.values()), [old]);
  assert.deepEqual(Object.keys(f.rasters), before);
});

test('a single-section native archive retains the existing ZIP import path', async () => {
  const f = fixture(), source = f.mouse(11);
  delete source.atlas;
  source.displayName = 'Cor_1_11';
  source.grid.umPerPxX = 25; source.grid.umPerPxY = 50;
  source.stack3d = { offsetXUm: 100, offsetYUm: -50, rotationDeg: 3 };
  const blob = await f.c.ZipIO.exportProject(source, { storage: f.storage });
  f.c.Cloud = { configured: () => true, signedIn: () => false,
    listProjects: async () => { throw new Error('single-section import must not request series inventory'); } };
  const result = await f.c.AtlasSeriesImport.importFile(await blob.arrayBuffer(), { storage: f.storage });
  assert.equal(result.projects.length, 1); assert.equal(result.series, null);
  assert.equal(Object.hasOwn(result.projects[0], 'atlas'), false);
  assert.deepEqual(plain(result.projects[0].stack3d), source.stack3d);
  assert.deepEqual(plain(result.projects[0].grid), source.grid);
});
