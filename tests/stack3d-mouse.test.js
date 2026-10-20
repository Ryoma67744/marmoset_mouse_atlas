'use strict';
// Synthetic fixtures verify coordinate units and molecule identities; no user
// data, network, cloud, or persistent browser storage is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function app() {
  const c = { console, Float32Array, Float64Array, Uint8Array, ArrayBuffer, DataView, Date };
  c.window = c; vm.createContext(c);
  for (const file of ['msi.js', 'normalization-scope.js', 'normalization.js', 'display-range.js',
    'section-display.js', 'stack3d.js', 'stack3d-alignment.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), c, { filename: file });
  }
  return c;
}
const plain = x => JSON.parse(JSON.stringify(x));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
function project(number = 11, sourceCandidateId = 'C028') {
  return { id: 'mouse-' + number, displayName: `Mouse ${number} · ${sourceCandidateId}`, plane: 'coronal',
    atlas: { species: 'mouse', seriesId: 'mouse_tissue_1set', seriesName: 'tissue_1set', specimenId: 'tissue_1set',
      sectionNumber: number, sourceCandidateId, coordinateMode: 'pixel', physicalSectionSpacing: null, displaySpacing: 2 },
    grid: { W: 4, H: 3, umPerPxX: null, umPerPxY: null }, molecules: [], images: {}, world_coords: {},
    rotation: { all: 0, msi: 0, he: 0 },
    stack3d: { coordinateMode: 'pixel', offsetXPx: 2, offsetYPx: -3, rotationDeg: 90 } };
}

test('confirmed mouse order is metadata-based and does not consume or rewrite legacy Cor names', () => {
  const c = app(), earlier = project(10, 'C009'), target = project(), later = project(12, 'C016');
  const input = [later, target, earlier], before = plain(input);
  assert.deepEqual(plain(c.Stack3D.sortCoronal(input).map(p => [p.atlas.sectionNumber, p.atlas.sourceCandidateId])),
    [[10, 'C009'], [11, 'C028'], [12, 'C016']]);
  assert.deepEqual(plain(input), before);
  assert.equal(c.Stack3D.naturalCor({ ...target, plane: 'sagittal' }), null);
  assert.equal(c.Stack3D.naturalCor({ ...target, atlas: { ...target.atlas, sectionNumber: 1.5 } }), null);
  assert.deepEqual(plain(c.Stack3D.seriesOf(target)), { id: 'mouse_tissue_1set', name: 'tissue_1set', species: 'mouse', coordinateMode: 'pixel' });
  assert.deepEqual(plain(c.Stack3D.seriesOf({ displayName: 'Cor_2_3' })),
    { id: 'legacy_marmoset', name: 'Marmoset', species: 'marmoset', coordinateMode: 'physical' });
  assert.deepEqual(plain(c.Stack3D.sortCoronal(['Cor_2_1', 'Cor_1_10', 'Cor_1_2'])), ['Cor_1_2', 'Cor_1_10', 'Cor_2_1']);
});

test('pixel geometry preserves missing physical calibration and applies the saved CCW world transform', () => {
  const c = app(), p = project(), before = plain(p), d = c.Stack3D.geometry(p);
  assert.equal(d.coordinateMode, 'pixel'); assert.equal(d.unitLabel, 'px');
  assert.equal(d.umPerPxX, null); assert.equal(d.umPerPxY, null);
  assert.equal(d.widthMm, undefined); assert.equal(d.heightMm, undefined);
  assert.deepEqual([d.sceneWidth, d.sceneHeight, d.scenePitchX, d.scenePitchY], [4, 3, 1, 1]);
  assert.equal(d.angleDeg, 0, 'there is no legacy 180 degree correction for pixel images');
  assert.deepEqual(plain(c.Stack3D.previewPitch(d)), { x: 1, y: 1 });
  const placement = c.Stack3D.scenePlacement(d);
  assert.deepEqual(plain(placement), { x: 2, y: -3, angleDeg: 90 });
  // An asymmetric sample at image pixel (0,0) has centre (-1.5,+1).
  // A 90° CCW turn followed by (2,-3) must place it at (1,-4.5).
  const theta = placement.angleDeg * Math.PI / 180;
  close(Math.cos(theta) * -1.5 - Math.sin(theta) * 1 + placement.x, 1);
  close(Math.sin(theta) * -1.5 + Math.cos(theta) * 1 + placement.y, -4.5);
  assert.deepEqual(plain(p), before, 'opening geometry never writes a fake umPerPx to the project');
  assert.throws(() => c.Stack3D.geometry({ ...p, stack3d: { coordinateMode: 'physical' } }), /座標単位/);
  assert.throws(() => c.Stack3D.geometry({ grid: p.grid }), /画素サイズ/, 'legacy missing-pitch validation remains strict');
});

test('six explicitly mapped DPP channels remain independent, including the labelled serotonin', async () => {
  const c = app(), p = project(), rasters = {}, values = [0, 1, 2, NaN, 4, -1, 6, NaN, 8, 9, 10, NaN];
  for (const [index, analyteId] of Array.from(c.Stack3D.MOUSE_ANALYTES).entries()) {
    const key = 'MSI_' + analyteId;
    p.molecules.push({ key, name: analyteId, analyteId, blobId: key });
    rasters[key] = { W: 4, H: 3, values: Float32Array.from(values, value => value * (index + 1)) };
  }
  const before = plain(p), bits = Object.values(rasters).map(r => Buffer.from(r.values.buffer).toString('hex'));
  const storage = { listFolders: async () => [], getValueRaster: async key => rasters[key].values };
  const sections = await c.Stack3D.loadSections([p], { storage });
  assert.equal(sections.length, 1); assert.equal(sections.errors.length, 0);
  assert.deepEqual(plain(c.Stack3D.analytesFor(sections)), Array.from(c.Stack3D.MOUSE_ANALYTES));
  assert.equal(sections[0].channels['Serotonin-DPP'].key, 'MSI_Serotonin-DPP');
  assert.equal(sections[0].channels['Serotonin-d4-DPP'].key, 'MSI_Serotonin-d4-DPP');
  assert.equal(sections[0].channels['5-HT'], undefined);
  const ranges = c.Stack3D.computeCommonRanges(sections, 'raw');
  assert.equal(Object.keys(ranges).length, 6);
  for (const id of c.Stack3D.MOUSE_ANALYTES) assert.deepEqual(plain(ranges[id].memberIds), [p.id]);
  assert.deepEqual(plain(p), before);
  assert.deepEqual(Object.values(rasters).map(r => Buffer.from(r.values.buffer).toString('hex')), bits);
  assert.throws(() => c.Stack3D.channelMap([p.molecules[0], { ...p.molecules[0], key: 'other' }]), /複数/);
});

test('different series or coordinate systems cannot be pooled into one stack', async () => {
  const c = app(), p = project(), reads = [];
  const storage = { listFolders: async () => [], getValueRaster: async key => { reads.push(key); return null; } };
  for (const other of [
    { id: 'old', displayName: 'Cor_1_1' },
    { ...project(12), atlas: { ...p.atlas, sectionNumber: 12, seriesId: 'other-mouse' } },
    { ...project(12), atlas: { ...p.atlas, sectionNumber: 12, coordinateMode: 'physical' } },
  ]) await assert.rejects(c.Stack3D.loadSections([p, other], { storage }), /異なる系列/);
  assert.equal(reads.length, 0, 'reject mixed units before reading any measured data');
});

test('pixel series never produce millimetre-labelled automatic alignment results', () => {
  const c = app(), p = project(), d = { ...c.Stack3D.geometry(p), project: p };
  const description = c.Stack3DAlignment.describe(d, d, d);
  assert.equal(description.available, false);
  assert.match(description.reason, /画素単位/);
  assert.throws(() => c.Stack3DAlignment.fit(d, [], []), /画素単位/);
});
