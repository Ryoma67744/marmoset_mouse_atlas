'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function app() {
  const c = { console, Float32Array, Float64Array, Uint8Array, ArrayBuffer, DataView, Date, setTimeout };
  c.window = c; vm.createContext(c);
  for (const file of ['msi.js', 'normalization-scope.js', 'normalization.js', 'display-range.js', 'section-display.js',
    'stack3d.js', 'roi-distribution.js', 'intensity-axis.js', 'stack3d-analysis.js', 'stack3d-alignment.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), c, { filename: file });
  return c;
}
const plain = value => JSON.parse(JSON.stringify(value));
const square = (left, top, right, bottom) => [[left - .5, top - .5], [right + .5, top - .5], [right + .5, bottom + .5], [left - .5, bottom + .5]];
function fixture() {
  const roi = { roi_items: {}, roi_names: {}, roi_show_flags: {}, palette: {} };
  for (let boundary = 0; boundary <= 6; boundary++) {
    const key = 'b' + boundary;
    roi.roi_items[key] = [{ poly_msi: square(boundary, boundary, 14 - boundary, 14 - boundary) }];
    roi.roi_names[key] = boundary === 0 ? 'Occipital lobe whole' : boundary === 6 ? 'White mater' : 'Layer' + boundary;
  }
  return roi;
}
function projectFixture(c) {
  const roi = fixture(), W = 15, H = 15;
  const values = new Float32Array(W * H), d4 = new Float32Array(W * H).fill(2);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) values[y * W + x] = 10 * (1 + Math.min(x, y, 14 - x, 14 - y));
  values[0] = 0; values[1] = NaN; d4[16] = 0;
  const project = { id: 'cortical-fixture', displayName: 'Cor_test', grid: { W, H, umPerPxX: 50, umPerPxY: 75 },
    roi, images: {}, rotation: {}, molecules: [{ key: 'da', name: 'DA' }, { key: 'd4', name: 'D4-5-HT' }] };
  const rasters = { da: { W, H, values }, d4: { W, H, values: d4 } };
  project.normalization = c.Normalization.createPixelRatioProfile(project, rasters, {
    id: 'cortical-ratio', revision: 1, standardKey: 'd4', targetKeys: ['da'],
    standardApplication: { method: 'uniform_spray', confirmed: true }
  });
  return { project, rasters };
}
const layers = (c, roi) => c.MSIRaster.roiDefinitions(roi).filter(definition => definition.kind === 'cortical-layer');

test('six effective layers are exact disjoint differences; source annotations and names are unchanged', () => {
  const c = app(), roi = fixture(), before = plain(roi), definitions = c.MSIRaster.roiDefinitions(roi);
  assert.equal(definitions.length, 8);
  const derived = layers(c, roi), membership = new Uint8Array(225), expected = [56, 48, 40, 32, 24, 16];
  assert.deepEqual(plain(derived.map(d => d.name)), ['Layer 1', 'Layer 2', 'Layer 3', 'Layer 4', 'Layer 5', 'Layer 6']);
  derived.forEach((definition, index) => {
    const result = c.MSIRaster.roiMask(definition, 15, 15);
    assert.equal(result.available, true); assert.equal(result.nGeometry, expected[index]);
    assert.deepEqual(plain(definition.sourceKeys), ['b' + index, 'b' + (index + 1)]);
    assert.equal(definition.polys.length, 0, 'union-only callers cannot mistake two contours for a layer');
    assert.equal(c.MSIRaster.roiContours(definition).length, 2);
    for (let i = 0; i < membership.length; i++) membership[i] += result.mask[i];
  });
  for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++)
    assert.equal(membership[y * 15 + x], x >= 6 && x <= 8 && y >= 6 && y <= 8 ? 0 : 1);
  assert.equal(membership.reduce((sum, value) => sum + value, 0), 216);
  assert.deepEqual(plain(roi), before);
});

test('aliases, saved visibility and multiple polygons use a single shared boundary mask', () => {
  const c = app(), roi = fixture();
  roi.roi_names.b0 = ' Whole '; roi.roi_names.b2 = 'LAYER 2'; roi.roi_names.b3 = 'Ｌａｙｅｒ３'; roi.roi_names.b6 = 'White matter';
  roi.roi_items.b1.push(structuredClone(roi.roi_items.b1[0])); roi.roi_show_flags.b1 = false;
  const derived = layers(c, roi);
  assert.equal(derived[0].visible, false);
  assert.equal(c.MSIRaster.roiMask(derived[0], 15, 15).nGeometry, 56, 'overlapping source polygons are not counted twice');
  roi.roi_show_flags.__cortical_layer__1 = true;
  assert.equal(layers(c, roi)[0].visible, true);
});

test('stored Layer3 selections migrate only when an effective cortical layer exists', async () => {
  const c = app(), entry = projectFixture(c), section = c.Stack3D.createSection(entry.project, entry.rasters);
  const definitions = c.Stack3D.roiDefinitions(section);
  const selected = c.Stack3D.normalizeRoiSelection({ regions: ['Layer3'], selectionVersion: 2 }, definitions);
  assert.deepEqual(plain(selected.regions), ['Layer 3']);
  assert.equal(c.MSIRaster.roiCanonicalName('Layer6', [{ name: 'Layer6', kind: 'normal' }]), 'Layer6');
  const result = await c.Stack3DAnalysis.analyze([section], { mode: 'selected', roiNames: ['Ｌａｙｅｒ３'], channels: ['DA'], valueMode: 'raw' });
  assert.equal(result.channels[0].groups[0].roiName, 'Layer 3');
  assert.equal(result.channels[0].groups[0].distribution.median, 30);
});

test('missing, malformed and ambiguous boundaries never fall back to cumulative regions', () => {
  for (const problem of ['missing', 'invalid', 'ambiguous']) {
    const c = app(), roi = fixture();
    if (problem === 'missing') delete roi.roi_items.b3;
    if (problem === 'invalid') roi.roi_items.b3[0].poly_msi[0][0] = NaN;
    if (problem === 'ambiguous') { roi.roi_items.duplicate = structuredClone(roi.roi_items.b3); roi.roi_names.duplicate = 'Layer 3'; }
    const derived = layers(c, roi);
    for (const index of [2, 3]) {
      const result = c.MSIRaster.roiMask(derived[index], 15, 15);
      assert.equal(result.available, false); assert.equal(result.nGeometry, null);
      assert.equal(result.mask.some(Boolean), false);
      assert.ok(result.reasonCodes.includes('ROI_BOUNDARY_' + problem.toUpperCase()));
    }
    for (const index of [0, 1, 4, 5]) assert.equal(c.MSIRaster.roiMask(derived[index], 15, 15).available, true);
  }
});

test('a crossing anywhere in the known boundary chain blocks all layers, while ordinary ROIs remain usable', () => {
  const c = app(), roi = fixture(); roi.roi_items.b3 = [{ poly_msi: square(1, 4, 13, 10) }];
  const definitions = c.MSIRaster.roiDefinitions(roi);
  for (const definition of definitions.filter(d => d.kind === 'cortical-layer')) {
    const result = c.MSIRaster.roiMask(definition, 15, 15);
    assert.equal(result.available, false); assert.ok(result.reasonCodes.includes('ROI_LAYER_NOT_NESTED'));
    assert.ok(result.geometryQc.outsidePixels > 0);
  }
  assert.equal(c.MSIRaster.roiMask(definitions.find(d => d.key === 'b0'), 15, 15).nGeometry, 225);
});

test('normal ROIs retain name grouping and union semantics without creating cortical layers', () => {
  const c = app(), roi = { roi_items: { a: [{ poly_msi: square(0, 0, 2, 2) }], b: [{ poly_msi: square(1, 1, 3, 3) }] },
    roi_names: { a: ' Region ', b: 'Region' } };
  const definitions = c.MSIRaster.roiDefinitions(roi, { groupByName: true });
  assert.equal(definitions.length, 1); assert.equal(definitions[0].kind, 'normal');
  assert.equal(c.MSIRaster.roiMask(definitions[0], 4, 4).nGeometry, 14);
});

test('a saved Layer 6 name collision cannot reintroduce a cumulative region through display or export', () => {
  const c = app(), roi = fixture();
  roi.roi_items.conflict = [{ poly_msi: square(0, 0, 14, 14) }]; roi.roi_names.conflict = 'Layer 6';
  const conflicts = c.MSIRaster.roiDefinitions(roi).filter(definition => definition.name === 'Layer 6');
  assert.equal(conflicts.length, 2);
  for (const definition of conflicts) {
    const area = c.MSIRaster.roiMask(definition, 15, 15);
    assert.equal(area.available, false); assert.equal(area.mask.some(Boolean), false);
    assert.ok(area.reasonCodes.includes('ROI_LAYER_NAME_CONFLICT'));
  }
});

test('2D numerical summaries use layer member pixels, retaining measured zero and excluding missing/invalid ratios', () => {
  const c = app(), entry = projectFixture(c), before = plain(entry.project);
  const bits = Buffer.from(entry.rasters.da.values.buffer).toString('hex'), evaluation = c.Normalization.evaluate(entry.project, entry.rasters);
  const derived = layers(c, entry.project.roi), first = c.MSIRaster.roiMask(derived[0], 15, 15);
  const row = c.Normalization.quantifyRoi(entry.project, entry.rasters, evaluation, first.mask,
    { distribution: { keys: ['da'], mode: 'raw' } })[0];
  assert.equal(row.nGeometry, 56); assert.equal(row.nMeasured, 55); assert.equal(row.nValid, 55);
  assert.equal(row.raw.mean, 540 / 55); assert.equal(row.normalized.mean, 270 / 55);
  assert.equal(row.distribution.median, 10); assert.equal(row.distribution.min, 0);
  const second = c.Normalization.quantifyRoi(entry.project, entry.rasters, evaluation, c.MSIRaster.roiMask(derived[1], 15, 15).mask)[0];
  assert.equal(second.nGeometry, 48); assert.equal(second.nMeasured, 48); assert.equal(second.nValid, 47);
  assert.equal(second.raw.mean, 20); assert.equal(second.normalized.mean, 10);
  assert.deepEqual(plain(entry.project), before); assert.equal(Buffer.from(entry.rasters.da.values.buffer).toString('hex'), bits);
});

test('3D raw and ratio statistics match the exact same layer masks and expose provenance', async () => {
  const c = app(), entry = projectFixture(c), section = c.Stack3D.createSection(entry.project, entry.rasters), before = plain(entry.project);
  const request = { mode: 'selected', sectionIds: [section.id], roiNames: ['Layer 1', 'Layer 2', 'Layer 6'], channels: ['DA'], valueMode: 'raw' };
  const raw = await c.Stack3DAnalysis.analyze([section], request);
  assert.deepEqual(plain(raw.channels[0].groups.map(group => group.counts.nIncluded)), [55, 48, 16]);
  assert.deepEqual(plain(raw.channels[0].groups.map(group => group.distribution.median)), [10, 20, 60]);
  assert.equal(raw.channels[0].groups[0].roiKind, 'cortical-layer');
  assert.equal(raw.channels[0].groups[0].roiDefinition, 'Whole − Layer 1');
  assert.deepEqual(plain(raw.channels[0].groups[0].sourceRoiKeys), ['b0', 'b1']);
  assert.equal(raw.layerDefinitions.length, 6);
  const ratio = await c.Stack3DAnalysis.analyze([section], { ...request, valueMode: 'normalized' });
  assert.deepEqual(plain(ratio.channels[0].groups.map(group => group.counts.nIncluded)), [55, 47, 16]);
  assert.deepEqual(plain(ratio.channels[0].groups.map(group => group.distribution.median)), [5, 10, 30]);
  assert.deepEqual(plain(entry.project), before);
  const catalog = c.Stack3DAnalysis.regionCatalog([section]);
  assert.equal(catalog.filter(row => row.name === 'Layer 1').length, 1);
});

test('3D detects edits to either boundary or another boundary involved in containment QC', async () => {
  const c = app(), entry = projectFixture(c), section = c.Stack3D.createSection(entry.project, entry.rasters);
  const request = { mode: 'selected', roiNames: ['Layer 1'], channels: ['DA'], valueMode: 'raw' };
  const initial = await c.Stack3DAnalysis.analyze([section], request);
  assert.equal(initial.channels[0].groups[0].counts.nIncluded, 55);
  entry.project.roi.roi_items.b1 = [{ poly_msi: square(2, 1, 12, 13) }];
  const changed = await c.Stack3DAnalysis.analyze([section], request);
  assert.equal(changed.channels[0].groups[0].counts.nIncluded, 81);
  entry.project.roi.roi_items.b4 = [{ poly_msi: square(0, 0, 14, 14) }];
  const invalid = await c.Stack3DAnalysis.analyze([section], request), group = invalid.channels[0].groups[0];
  assert.equal(group.distribution, null); assert.equal(group.statistics.mean, null);
  assert.ok(group.geometryReasonCodes.includes('ROI_LAYER_NOT_NESTED'));
  assert.ok(group.exclusions.some(item => item.code === 'ROI_GEOMETRY_UNAVAILABLE'));
  assert.equal(group.geometryAvailable, false);
  for (const key of ['nGeometry', 'nMeasured', 'nValid', 'nIncluded']) assert.equal(group.counts[key], null);
});

test('mixed geometry keeps real counts from valid sections, while ordinary absent ROIs retain zero counts', async () => {
  const c = app(), valid = projectFixture(c), invalid = projectFixture(c);
  valid.project.id = 'valid-layer'; invalid.project.id = 'invalid-layer';
  delete invalid.project.roi.roi_items.b1;
  const sections = [valid, invalid].map(entry => c.Stack3D.createSection(entry.project, entry.rasters));
  const request = { mode: 'pooled', roiNames: ['Layer 1'], channels: ['DA'], valueMode: 'raw' };
  const pooled = await c.Stack3DAnalysis.analyze(sections, request), group = pooled.channels[0].groups[0];
  assert.equal(group.geometryAvailable, true); assert.equal(group.status, 'PARTIAL');
  assert.equal(group.counts.nGeometry, 56); assert.equal(group.counts.nMeasured, 55);
  assert.equal(group.counts.nValid, 55); assert.equal(group.counts.nIncluded, 55);
  assert.equal(group.counts.targetSections, 2); assert.equal(group.counts.includedSections, 1);
  assert.ok(group.exclusions.some(item => item.sectionId === 'invalid-layer' && item.code === 'ROI_GEOMETRY_UNAVAILABLE'));
  const absent = await c.Stack3DAnalysis.analyze(sections, { ...request, roiNames: ['Unregistered normal ROI'] });
  const missing = absent.channels[0].groups[0]; assert.equal(missing.geometryAvailable, null);
  for (const key of ['nGeometry', 'nMeasured', 'nValid', 'nIncluded']) assert.equal(missing.counts[key], 0);
});

test('3D ROI centroids use differential layer geometry and skip invalid cortical masks', () => {
  const c = app(), entry = projectFixture(c), section = c.Stack3D.createSection(entry.project, entry.rasters);
  // Shift only the outer edge so the annulus centroid differs from the inner ROI.
  entry.project.roi.roi_items.b0 = [{ poly_msi: square(0, 0, 13, 14) }];
  const definition = layers(c, entry.project.roi)[0], mask = c.MSIRaster.roiMask(definition, 15, 15), centers = c.Stack3DAlignment.centroids(section);
  assert.equal(mask.available, true); assert.equal(mask.nGeometry, 41);
  assert.ok(centers.has('Layer 1')); assert.ok(Math.abs(centers.get('Layer 1').area - 41 * .05 * .075) < 1e-12);
  entry.project.roi.roi_items.b3 = [{ poly_msi: square(0, 0, 14, 14) }];
  const invalid = c.Stack3DAlignment.centroids(section);
  assert.equal(invalid.has('Layer 1'), false); assert.equal(invalid.has('White mater'), true);
});

test('3D selection applies a differential mask to actual output pixels and fails closed for invalid layers', () => {
  const c = app(), entry = projectFixture(c), section = c.Stack3D.createSection(entry.project, entry.rasters);
  const canvas = () => {
    let bytes = new Uint8ClampedArray(225 * 4).fill(255);
    return { width: 15, height: 15, getContext: () => ({ translate() {}, rotate() {}, drawImage() {},
      getImageData: () => ({ data: bytes.slice() }), putImageData: image => { bytes = image.data.slice(); } }) };
  };
  c.document = { createElement: canvas };
  // Native composition is covered elsewhere. Here opaque measured pixels make
  // the selection's exact membership independently observable through alpha.
  c.SectionDisplay = { paintChannel: canvas, mergeChannels: () => ({ canvas: canvas(), previewCanvas: canvas(),
    invalidPixels: 0, measuredPixels: 225, visiblePixels: 225 }) };
  const options = { channels: ['DA'], mode: 'raw', roiSelectionVersion: 2, roiRegions: ['Layer 1'], roiIncludeUnassigned: false };
  const result = c.Stack3D.renderSection(section, options), bytes = result.canvas.getContext('2d').getImageData().data;
  assert.equal(result.visiblePixels, 56);
  assert.equal(bytes[3], 255); assert.equal(bytes[(7 * 15 + 7) * 4 + 3], 0);
  delete entry.project.roi.roi_items.b1;
  const invalid = c.Stack3D.renderSection(section, options);
  assert.equal(invalid.visiblePixels, 0); assert.equal(invalid.status.code, 'PARTIAL');
  assert.ok(invalid.status.reasonCodes.includes('ROI_BOUNDARY_MISSING'));
});
