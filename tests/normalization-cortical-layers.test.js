'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/normalization-cortical-reference-baseline.json'), 'utf8'));
const copy = value => JSON.parse(JSON.stringify(value));

function setup() {
  const context = { window: {}, Float32Array, Float64Array, Uint8Array, ArrayBuffer, DataView, Date };
  vm.createContext(context);
  for (const file of ['msi.js', 'normalization-scope.js', 'normalization.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8'), context, { filename: file });
  }
  const N = context.window.Normalization, project = copy(baseline.project), { W, H } = project.grid;
  const rasters = Object.fromEntries(Object.entries(baseline.raw).map(([key, values]) => [key, { W, H, values: new Float32Array(values) }]));
  return { N, context, entry: { project, rasters, mapping: N.suggestMapping(project.molecules) } };
}
function configuration(entry, roiNames, simple, kind = 'roi') {
  const config = { id: 'layer-reference-test', revision: 1, batchId: 'run-a', prepId: 'prep-a', quality: 'provisional',
    coordinateMatchConfirmed: true, comparabilityConfirmed: true,
    qc: { minD4: 0, saturationD4: 1000, minCoverage: 0.5 },
    reference: { kind, projectIds: [entry.project.id], roiNames }, calibration: null, otsuSourceRoles: [] };
  if (simple) config.scope = { type: 'folder-depth', depth: 2, includeDescendants: true,
    groupId: 'group', folderPath: ['Marmoset', 'Coronal'], memberIds: [entry.project.id] };
  return config;
}
function create(N, entry, roiNames, simple = false, kind = 'roi') {
  const config = configuration(entry, roiNames, simple, kind);
  return (simple ? N.createSimpleProfiles([entry], config) : N.createProfiles([entry], config)).profiles[0].normalization;
}

test('detailed and simple normalization use the exclusive Layer 2 band, including QC ROI references', () => {
  for (const simple of [false, true]) for (const kind of ['roi', 'qc']) {
    const { N, entry } = setup(), before = JSON.stringify(entry.project);
    const profile = create(N, entry, ['Layer 2'], simple, kind);
    assert.equal(profile.section.Ds, 3.5);
    assert.equal(profile.section.nGeometry, 2);
    assert.equal(profile.section.nMeasured, 2);
    assert.equal(profile.section.nValid, 2);
    assert.equal(profile.section.k, 1);
    assert.equal(JSON.stringify(entry.project), before, 'profile calculation must not mutate or save source ROI data');
    assert.deepEqual(Array.from(entry.rasters.d.values), baseline.raw.d);
    entry.project.normalization = profile;
    const evaluated = N.evaluate(entry.project, entry.rasters);
    assert.ok(!evaluated.reasonCodes.includes('NORMALIZATION_PROFILE_STALE'));
    assert.deepEqual(Array.from(evaluated.channels.h.values), new Array(15).fill(10));
  }
});

test('Layer 6 is a reference candidate without a saved Layer 6 polygon and accepted layer aliases resolve identically', () => {
  const { N, entry } = setup();
  assert.ok(!Object.values(entry.project.roi.roi_names).includes('Layer 6'));
  const profile = create(N, entry, ['Layer 6']);
  assert.equal(profile.section.Ds, 11.5);
  assert.equal(profile.section.nGeometry, 2);
  for (const name of ['Layer2', 'layer 2', 'Ｌａｙｅｒ ２']) {
    assert.equal(create(N, entry, [name]).section.Ds, 3.5);
  }
  entry.project.roi.roi_names.l2 = 'Layer2';
  assert.equal(create(N, entry, ['Layer 2']).section.Ds, 3.5);
});

test('v2.46.0 cumulative Layer reference profiles become stale without changing saved factors or raw values', () => {
  for (const kind of ['detailed', 'simple']) {
    const { N, entry } = setup();
    entry.project.normalization = copy(baseline.legacyProfiles[kind]);
    const saved = JSON.stringify(entry.project.normalization);
    assert.equal(entry.project.normalization.section.Ds, 10);
    const result = N.evaluate(entry.project, entry.rasters);
    assert.ok(result.reasonCodes.includes('NORMALIZATION_PROFILE_STALE'));
    assert.equal(result.channels.a.values, null);
    assert.equal(result.channels.h.values, null);
    assert.equal(JSON.stringify(entry.project.normalization), saved);
    assert.deepEqual(Array.from(entry.rasters.d.values), baseline.raw.d);
  }
});

test('normal ROI and whole-measured fingerprints retain the exact v2.46.0 values', () => {
  const { N, entry } = setup();
  for (const [name, expected] of Object.entries(baseline.fingerprints)) {
    const reference = name === 'whole_tissue' ? { kind: 'whole_tissue', roiNames: ['Layer 2'] } : { kind: 'roi', roiNames: [name] };
    assert.equal(N.referenceGeometryFingerprint(entry.project, reference), expected, name);
  }
  for (const [name, median] of [['Whole', 8], ['White matter', 14], ['Control', 1]]) {
    const profile = create(N, entry, [name]);
    assert.equal(profile.section.Ds, median);
    entry.project.normalization = profile;
    assert.ok(!N.evaluate(entry.project, entry.rasters).reasonCodes.includes('NORMALIZATION_PROFILE_STALE'));
  }
});

test('Layer reference identity follows boundary geometry, not display state or portable ROI identifiers', () => {
  const { N, entry } = setup(), reference = { kind: 'roi', roiNames: ['Layer 2'] };
  const before = N.referenceGeometryFingerprint(entry.project, reference);
  entry.project.roi.palette = { l1: [2, 3, 4, 255] };
  entry.project.roi.roi_show_flags = { l1: false, l2: false };
  entry.project.roi.roi_items.control[0].poly_msi[0][0] = -0.4;
  assert.equal(N.referenceGeometryFingerprint(entry.project, reference), before);
  const roi = entry.project.roi;
  for (const key of Object.keys(roi.roi_items)) {
    roi.roi_items['renamed-' + key] = roi.roi_items[key]; delete roi.roi_items[key];
    roi.roi_names['renamed-' + key] = roi.roi_names[key]; delete roi.roi_names[key];
  }
  assert.equal(N.referenceGeometryFingerprint(entry.project, reference), before);
  roi.roi_items['renamed-l1'][0].poly_msi[0][0] = 2.5;
  roi.roi_items['renamed-l1'][0].poly_msi[3][0] = 2.5;
  assert.notEqual(N.referenceGeometryFingerprint(entry.project, reference), before);
});

test('either adjacent boundary and any changed containment evidence invalidate saved Layer reference factors', () => {
  for (const key of ['l1', 'l2', 'l5']) {
    const { N, entry } = setup();
    entry.project.normalization = create(N, entry, ['Layer 2']);
    entry.project.roi.roi_items[key][0].poly_msi[0][0] += 0.1;
    assert.ok(N.evaluate(entry.project, entry.rasters).reasonCodes.includes('NORMALIZATION_PROFILE_STALE'), key);
  }
});

test('missing, ambiguous and nonnested Layer boundaries never fall back to cumulative references', () => {
  for (const invalid of ['missing', 'ambiguous', 'nonnested']) {
    for (const simple of [false, true]) {
      const { N, entry } = setup(), roi = entry.project.roi;
      if (invalid === 'missing') delete roi.roi_items.l1;
      if (invalid === 'ambiguous') { roi.roi_items.extra = copy(roi.roi_items.l1); roi.roi_names.extra = 'Layer1'; }
      if (invalid === 'nonnested') {
        roi.roi_items.l2[0].poly_msi[0][0] = 0.5; roi.roi_items.l2[0].poly_msi[3][0] = 0.5;
      }
      const profile = create(N, entry, ['Layer 2', 'Control'], simple);
      assert.equal(profile.section.Ds, null, invalid);
      assert.equal(profile.section.k, null, invalid);
      assert.ok(profile.section.reasonCodes.includes('REFERENCE_ROI_INVALID'), invalid);
      if (invalid === 'nonnested') assert.ok(profile.section.reasonCodes.includes('ROI_LAYER_NOT_NESTED'));
    }
  }
});

test('multiple reference regions use their union while a missing shared layer engine fails closed', () => {
  const { N, context, entry } = setup();
  const profile = create(N, entry, ['Layer 2', 'Control', 'Layer 2']);
  assert.equal(profile.section.nGeometry, 3);
  assert.equal(profile.section.Ds, 3);
  delete context.window.MSIRaster.roiDefinitions;
  delete context.window.MSIRaster.roiMask;
  const unavailable = create(N, entry, ['Layer 2']);
  assert.equal(unavailable.section.Ds, null);
  assert.ok(unavailable.section.reasonCodes.includes('REFERENCE_ROI_MISSING'));
});

test('a standalone normal ROI named Layer 6 retains the shared catalog meaning when no cortical boundary series exists', () => {
  const { N, entry } = setup(), roi = entry.project.roi;
  roi.roi_items = { direct: copy(roi.roi_items.control) };
  roi.roi_names = { direct: 'Layer 6' };
  const profile = create(N, entry, ['Layer 6']);
  assert.equal(profile.section.Ds, 1);
  assert.equal(profile.section.nGeometry, 1);
});
