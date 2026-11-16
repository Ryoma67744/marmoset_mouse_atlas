'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const id = 'proj_msygg6w6_kq1bom';
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const names = ['5-HT', 'DA', 'NE', 'D4-5-HT'];
  const values = [
    [0, NaN, 5, NaN, NaN, 8], [NaN, 0, 10, NaN, NaN, NaN],
    [-1, 2, NaN, NaN, NaN, NaN], [1, 2, 3, NaN, NaN, 4],
  ];
  const polygon = [[-.5, -.5], [1.5, -.5], [1.5, 1.5], [-.5, 1.5]];
  const project = { id, displayName: 'Renamed Coronal Section', grid: { W: 3, H: 2, umPerPxX: 100, umPerPxY: 100 },
    rotation: { all: 90, msi: 0 }, updatedAt: 'saved-revision',
    molecules: names.map(name => ({ name, key: 'MSI_' + name, blobId: name })),
    roi: { roi_items: { left: [{ poly_msi: polygon }, { poly_msi: polygon }] }, roi_names: { left: 'Left region' }, palette: { left: [10, 20, 30, 255] }, roi_show_flags: { left: false } },
    normalization: { mode: 'pixel_ratio', irrelevantPrivateSetting: 123 },
  };
  const rasters = Object.fromEntries(names.map((name, i) => [name, Float32Array.from(values[i])])), reads = [];
  const storage = { async getProject(projectId) { reads.push(['project', projectId]); return project; },
    async getValueRaster(blobId) { reads.push(['raster', blobId]); return rasters[blobId] || null; } };
  const context = { URL, URLSearchParams, Float32Array, Uint8Array, console,
    location: { href: 'https://example.com/atlas/comparison/index.html' }, ProjectStorage: storage };
  context.window = context;
  vm.createContext(context);
  for (const file of ['lib/msi-st-pairs.js', 'comparison/msi-project.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  return { context, project, rasters, reads, load: () => context.MsiStProject.load(id) };
}

test('read-only loader preserves raw zeros, missing channels, signed values and exact registered identity', async () => {
  const f = fixture(), projectBefore = JSON.stringify(f.project);
  const bytesBefore = Object.fromEntries(Object.entries(f.rasters).map(([key, raster]) => [key, Buffer.from(raster.buffer).toString('hex')]));
  const result = await f.load(), s = result.msiValues.sections.Cor_13_6;
  assert.deepEqual(plain(s.x), [0, 1, 2, 2]); assert.deepEqual(plain(s.y), [0, 0, 0, 1]);
  assert.deepEqual(plain(s.values['5-HT']), [0, null, 5, 8]);
  assert.deepEqual(plain(s.values.NE), [-1, 2, null, null]);
  assert.equal(s.ranges['5-HT'].zero, 1); assert.equal(s.ranges['5-HT'].missing, 1);
  assert.equal(s.ranges.NE.negative, 1); assert.equal(s.measuredCount, 4);
  assert.equal(s.source.valueMode, 'raw'); assert.equal(s.source.updatedAt, 'saved-revision');
  assert.equal(result.project.id, id); assert.equal(JSON.stringify(f.project), projectBefore);
  for (const [key, raster] of Object.entries(f.rasters)) assert.equal(Buffer.from(raster.buffer).toString('hex'), bytesBefore[key]);
  assert.equal(f.reads.length, 5); assert.ok(f.reads.every(([method]) => ['project', 'raster'].includes(method)));
});

test('ROI and pixels share the native thumbnail transform and overlapping contours count once', async () => {
  const result = await fixture().load(), s = result.msiValues.sections.Cor_13_6, r = result.roiData.sections.Cor_13_6;
  assert.equal(s.width, 3); assert.equal(s.height, 2); assert.equal(s.displayWidth, 2); assert.equal(s.displayHeight, 3);
  assert.deepEqual(plain(s.matrix), [0, -1, 1, 0, 0, 3]);
  assert.deepEqual(plain(r.matrix), plain(s.matrix));
  assert.equal(r.rois[0].measuredCount, 2); assert.equal(r.rois[0].areaPixels, 4); assert.equal(r.rois[0].polygonCount, 2);
  assert.deepEqual(plain(r.rois[0].polygons[0][0]), [-.5, 3.5]);
  assert.deepEqual(plain(r.rois[0].color), [10, 20, 30]); assert.equal(r.rois[0].originalVisible, false);
});

test('unloaded registered project gives individual-page recovery URL without cloud access', async () => {
  const f = fixture(); f.context.ProjectStorage.getProject = async () => null;
  await assert.rejects(f.load(), error => error.code === 'PROJECT_NOT_LOADED' && error.viewerUrl === 'https://example.com/atlas/viewer/index.html?project=' + id + '&from=comparison&newtab=1');
  assert.equal(f.reads.length, 0);
});

test('unregistered and inconsistent project identities never display a different dataset', async () => {
  const f = fixture();
  await assert.rejects(f.context.MsiStProject.load('same-name-copy'), error => error.code === 'UNREGISTERED_PAIR');
  assert.equal(f.reads.length, 0);
  f.project.atlas = { species: 'mouse' };
  await assert.rejects(f.load(), error => error.code === 'PROJECT_MISMATCH');
  assert.equal(f.reads.filter(([method]) => method === 'raster').length, 0);
});

test('missing molecule stays null and malformed saved raster is rejected', async () => {
  const f = fixture(); f.project.molecules = f.project.molecules.filter(molecule => molecule.name !== 'NE');
  const s = (await f.load()).msiValues.sections.Cor_13_6;
  assert.deepEqual(plain(s.values.NE), [null, null, null, null]);
  assert.equal(s.ranges.NE.valid, 0); assert.equal(s.ranges.NE.zero, 0);
  f.rasters['5-HT'] = new Float32Array(2);
  await assert.rejects(f.load(), error => error.code === 'INVALID_RASTER');
});

test('malformed ROI geometry and infinite signals fail explicitly instead of inventing zero values', async () => {
  const f = fixture(); f.project.roi.roi_items.left[0].poly_msi[0] = [NaN, 0];
  await assert.rejects(f.load(), error => error.code === 'INVALID_ROI');
  const infinite = fixture(); infinite.rasters['5-HT'][0] = Infinity;
  await assert.rejects(infinite.load(), error => error.code === 'INVALID_RASTER');
});
