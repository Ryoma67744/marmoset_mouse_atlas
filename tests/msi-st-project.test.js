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
  for (const file of ['lib/msi.js', 'lib/msi-st-pairs.js', 'comparison/msi-project.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
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

function corticalFixture() {
  const f = fixture(), rectangle = inset => [{ poly_msi: [[inset - .5, -.5], [14.5 - inset, -.5], [14.5 - inset, .5], [inset - .5, .5]] }];
  f.project.grid = { W: 15, H: 1 };
  f.project.roi = { roi_items: { whole: rectangle(0), wm: rectangle(6) },
    roi_names: { whole: 'Occipital lobe whole', wm: 'White mater' }, palette: {}, roi_show_flags: {} };
  for (let layer = 1; layer <= 5; layer++) {
    f.project.roi.roi_items['b' + layer] = rectangle(layer);
    f.project.roi.roi_names['b' + layer] = layer === 3 ? 'Layer3' : 'Layer ' + layer;
  }
  for (const molecule of f.project.molecules) f.rasters[molecule.name] = Float32Array.from({ length: 15 }, (_, i) => i);
  return f;
}

test('MSI–ST comparison uses six exact difference regions without altering saved ROI or signal', async () => {
  const f = corticalFixture(), before = JSON.stringify(f.project);
  const result = await f.load(), rois = result.roiData.sections.Cor_13_6.rois;
  const layers = rois.filter(roi => roi.kind === 'cortical-layer');
  assert.equal(layers.length, 6); assert.equal(rois.length, 8);
  assert.deepEqual(plain(layers.map(roi => roi.name)), [1, 2, 3, 4, 5, 6].map(i => 'Layer ' + i));
  assert.deepEqual(plain(layers.map(roi => roi.areaPixels)), [2, 2, 2, 2, 2, 2]);
  assert.deepEqual(plain(layers.map(roi => roi.measuredCount)), [2, 2, 2, 2, 2, 2]);
  assert.ok(layers.every(roi => roi.available && roi.areaPath && roi.nativePolygons.length === 2));
  assert.equal(layers[0].definition, 'Whole − Layer 1');
  assert.equal(layers[5].definition, 'Layer 5 − White matter');
  assert.equal(JSON.stringify(f.project), before);
  assert.deepEqual(Array.from(f.rasters['5-HT']), Array.from({ length: 15 }, (_, i) => i));
});

test('MSI–ST comparison leaves unavailable layer areas blank and keeps other data usable', async () => {
  for (const invalid of [false, true]) {
    const f = corticalFixture();
    if (invalid) f.project.roi.roi_items.b2[0].poly_msi[0] = [NaN, 0];
    else delete f.project.roi.roi_items.b2;
    const result = await f.load(), layers = result.roiData.sections.Cor_13_6.rois.filter(roi => roi.kind === 'cortical-layer');
    for (const index of [1, 2]) {
      assert.equal(layers[index].available, false);
      assert.equal(layers[index].areaPixels, null); assert.equal(layers[index].measuredCount, null);
      assert.equal(layers[index].areaPath, '');
      assert.ok(layers[index].reasonCodes.includes(invalid ? 'ROI_BOUNDARY_INVALID' : 'ROI_BOUNDARY_MISSING'));
    }
    assert.equal(layers[0].areaPixels, 2); assert.equal(layers[5].areaPixels, 2);
    assert.equal(result.msiValues.sections.Cor_13_6.measuredCount, 15);
  }
});
