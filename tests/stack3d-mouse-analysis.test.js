'use strict';
// Synthetic measured pixels only: no imported data or persistent storage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ANALYTES = ['GABA-DPP', 'Histamine-DPP', 'Dopamine-DPP', 'Norepinephrine-DPP', 'Serotonin-DPP', 'Serotonin-d4-DPP'];
const plain = value => JSON.parse(JSON.stringify(value));
const bits = values => Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('hex');
function app() {
  const c = { console, Float32Array, Float64Array, Uint8Array, ArrayBuffer, DataView, Date, setTimeout };
  c.window = c; vm.createContext(c);
  for (const file of ['msi.js', 'normalization-scope.js', 'normalization.js', 'display-range.js', 'section-display.js',
    'stack3d.js', 'roi-distribution.js', 'intensity-axis.js', 'stack3d-analysis.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), c, { filename: file });
  }
  return c;
}
function entry(c, number, values = [0, 2, 8, NaN], d4 = [2, 2, 2, NaN], options = {}) {
  const W = values.length;
  assert.equal(d4.length, W);
  const project = { id: 'mouse-' + number, displayName: `Mouse ${number} · C${String(number).padStart(3, '0')}`,
    plane: 'coronal', images: {}, rotation: {}, roi: { roi_items: {}, roi_names: {} },
    atlas: { species: 'mouse', seriesId: 'mouse_tissue_1set', specimenId: 'tissue_1set', sourceSha256: 'f'.repeat(64),
      sectionNumber: number, sourceCandidateId: 'C' + number, coordinateMode: 'pixel', physicalSectionSpacing: null },
    grid: { W, H: 1, umPerPxX: null, umPerPxY: null },
    molecules: ANALYTES.map((name, index) => ({ key: (options.keyPrefix || 'm') + index, name, analyteId: name, blobId: `${number}:${index}` })) };
  const rasters = {};
  project.molecules.forEach((molecule, index) => {
    rasters[molecule.key] = { W, H: 1, values: Float64Array.from(index === 5 ? d4 : values.map(value => value * (index + 1))) };
  });
  project.normalization = c.Normalization.createPixelRatioProfile(project, rasters, {
    id: 'independent-profile-' + number, revision: number, standardKey: project.molecules[5].key,
    targetKeys: project.molecules.slice(0, 5).map(molecule => molecule.key),
    standardApplication: { method: 'uniform_spray', confirmed: true, source: 'synthetic test' }
  });
  return { project, rasters };
}
function sections(c, entries) {
  return entries.map(item => c.Stack3D.createSection(item.project, item.rasters, { folders: [], projects: entries.map(item => item.project) }));
}
function request(changes = {}) {
  return { mode: 'by-section', sampleScope: 'all-measured', channels: ['GABA-DPP'], valueMode: 'raw', ...changes };
}
const first = result => result.channels[0].groups[0];

test('48 unannotated mouse sections expose all six distinct channels and preserve stable section IDs', async () => {
  const c = app(), source = Array.from({ length: 48 }, (_, i) => entry(c, i + 1)), loaded = sections(c, source);
  const projectsBefore = JSON.stringify(source.map(item => item.project));
  const rawBefore = source.map(item => Object.values(item.rasters).map(raster => bits(raster.values)));
  assert.deepEqual(plain(c.Stack3DAnalysis.regionCatalog(loaded)), []);
  const result = await c.Stack3DAnalysis.analyze(loaded, { mode: 'by-section', sampleScope: 'all-measured', valueMode: 'raw' });
  assert.equal(result.sampleScope, 'all-measured'); assert.deepEqual(plain(result.roiNames), []);
  assert.equal(result.selection.count, 48);
  assert.deepEqual(plain(result.channels.map(channel => channel.key)), ANALYTES);
  for (const channel of result.channels) {
    assert.equal(channel.groups.length, 48); assert.equal(channel.unit, 'Intensity (a.u.)');
    assert.deepEqual(plain(channel.groups.map(group => group.sectionId)), source.map(item => item.project.id));
    channel.groups.forEach((group, index) => {
      assert.equal(group.key, source[index].project.id); assert.equal(group.name, source[index].project.displayName);
      assert.equal(group.roiName, null); assert.equal(group.sampleScope, 'all-measured');
      assert.equal(group.distribution.n, 3); assert.equal(group.counts.nGeometry, 3);
    });
  }
  assert.equal(JSON.stringify(source.map(item => item.project)), projectsBefore);
  assert.deepEqual(source.map(item => Object.values(item.rasters).map(raster => bits(raster.values))), rawBefore);
  loaded.forEach(section => { assert.equal(section.umPerPxX, null); assert.equal(section.umPerPxY, null); });
});

test('all measured pixels include zeros and negatives, ignore NaN/infinity and do not depend on ROI or display placement', async () => {
  const c = app(), source = entry(c, 1, [0, -2, 8, NaN, Infinity], [2, 2, 2, NaN, NaN]);
  source.project.roi = { roi_items: { unrelated: [{ poly_msi: [[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]] }] },
    roi_names: { unrelated: 'Unrelated anatomical annotation' }, roi_show_flags: { unrelated: false } };
  const loaded = sections(c, [source]), result = await c.Stack3DAnalysis.analyze(loaded, request());
  const group = first(result);
  assert.equal(group.distribution.n, 3); assert.equal(group.distribution.median, 0);
  assert.equal(group.distribution.min, -2); assert.equal(group.statistics.mean, 2);
  assert.equal(group.counts.nGeometry, 3); assert.equal(group.counts.nMeasured, 3);
  loaded[0].offsetXPx = 100; loaded[0].rotationDeg = 180;
  source.project.roi.roi_items = {};
  const again = first(await c.Stack3DAnalysis.analyze(loaded, request()));
  assert.deepEqual(plain(again.distribution), plain(group.distribution));
  await assert.rejects(c.Stack3DAnalysis.analyze(loaded, request({ sampleScope: 'tissue' })), /画素/);
  await assert.rejects(c.Stack3DAnalysis.analyze(loaded, request({ channels: ['invented molecule'] })), /分子/);
});

test('unconfigured ROI mode still requires an ROI and never silently substitutes whole measured pixels', async () => {
  const c = app(), loaded = sections(c, [entry(c, 1)]);
  const result = await c.Stack3DAnalysis.analyze(loaded, { mode: 'selected', channels: ['GABA-DPP'], valueMode: 'raw' });
  assert.equal(result.sampleScope, 'roi'); assert.equal(result.channels[0].groups.length, 0);
  await assert.rejects(c.Stack3DAnalysis.analyze(loaded, request({ sampleScope: 'roi' })), /ROI/);
});

test('same-series isotope ratios compare across independent profiles, keys and raster sizes without a fabricated scope or pitch', async () => {
  const c = app(), source = [
    entry(c, 1, [0, 2, 8, NaN], [2, 2, 2, NaN]),
    entry(c, 2, [12, 30], [3, 5], { keyPrefix: 'other' })
  ], loaded = sections(c, source);
  assert.notEqual(source[0].project.normalization.id, source[1].project.normalization.id);
  assert.notEqual(source[0].project.normalization.rawFingerprint, source[1].project.normalization.rawFingerprint);
  const result = await c.Stack3DAnalysis.analyze(loaded, request({ channels: ANALYTES.slice(0, 5), valueMode: 'normalized' }));
  for (const [index, channel] of result.channels.entries()) {
    assert.equal(channel.compatibility.status, 'COMPATIBLE');
    assert.equal(channel.unit, `${ANALYTES[index]} / Serotonin-d4-DPP ratio`);
    assert.equal(channel.groups[0].distribution.median, index + 1);
    assert.equal(channel.groups[1].distribution.median, 5 * (index + 1));
    assert.equal(channel.groups[0].counts.nIncluded, 3); assert.equal(channel.groups[1].counts.nIncluded, 2);
    assert.equal(channel.groups[0].status, 'PROVISIONAL');
  }
  loaded.forEach(section => {
    assert.equal(section.evaluation.profile.scope, null); assert.equal(section.evaluation.profile.section, null);
    assert.equal(section.umPerPxX, null); assert.equal(section.umPerPxY, null);
  });
  const pooled = first(await c.Stack3DAnalysis.analyze(loaded, request({ valueMode: 'normalized', mode: 'pooled' })));
  assert.equal(pooled.distribution.n, 5); assert.equal(pooled.distribution.median, 4);
  assert.equal(pooled.statistics.mean, 3);
  assert.ok(pooled.warnings.includes('PIXEL_WEIGHTED'));
});

test('missing correction, all-invalid standard and raw-QC standard never fall back to raw values or disappear as missing groups', async () => {
  const c = app(), source = [
    entry(c, 1, [0, 2, 8, NaN], [2, 2, 2, NaN]),
    entry(c, 2, [999, 999], [0, 0]),
    entry(c, 3, [999, 999], [2, 2]),
    entry(c, 4, [NaN, NaN], [NaN, NaN])
  ];
  delete source[2].project.normalization;
  const loaded = sections(c, source);
  const result = await c.Stack3DAnalysis.analyze(loaded, request({ valueMode: 'normalized', channels: ['GABA-DPP', 'Serotonin-d4-DPP'] }));
  assert.equal(result.channels[0].groups.length, 4);
  assert.equal(result.channels[0].groups[0].distribution.n, 3);
  for (const group of result.channels[0].groups.slice(1)) {
    assert.equal(group.distribution, null); assert.equal(group.statistics.mean, null); assert.equal(group.counts.nIncluded, 0);
    assert.ok(group.exclusions.some(row => row.code === 'NORMALIZATION_UNAVAILABLE'));
  }
  assert.equal(result.channels[0].groups[1].counts.nMeasured, 2);
  assert.ok(result.channels[0].groups[1].exclusions[0].reasonCodes.includes('D4_LOW_SIGNAL'));
  for (const group of result.channels[1].groups) {
    assert.equal(group.distribution, null); assert.equal(group.counts.nIncluded, 0);
  }
  assert.ok(result.channels[1].groups[0].exclusions[0].reasonCodes.includes('RAW_QC'));
  const raw = await c.Stack3DAnalysis.analyze(loaded, request({ channels: ['Serotonin-d4-DPP'] }));
  assert.equal(first(raw).distribution.median, 2); assert.equal(raw.channels[0].groups[1].distribution.median, 0);
});

test('same-pixel correction excludes invalid denominators only; arbitrarily small positive d4 and measured zero remain', async () => {
  const c = app(), source = entry(c, 1,
    [0, 6, 9, 12, 1, 8, NaN], [2, 0, -1, NaN, 1e-9, 4, 2]);
  const loaded = sections(c, [source]);
  const group = first(await c.Stack3DAnalysis.analyze(loaded, request({ valueMode: 'normalized' })));
  assert.equal(group.counts.nMeasured, 6); assert.equal(group.counts.nValid, 3);
  assert.equal(group.distribution.n, 3); assert.equal(group.distribution.min, 0); assert.equal(group.distribution.median, 2);
  assert.equal(group.distribution.max, 1 / source.rasters.m5.values[4]);
  const mask = new Uint8Array(source.project.grid.W).fill(1);
  const expected = c.Normalization.quantifyRoi(source.project, source.rasters, loaded[0].evaluation, mask,
    { distribution: { mode: 'normalized', keys: ['m0'] } })[0];
  const { aboveAutoCount, ...distribution } = group.distribution;
  assert.deepEqual(plain(distribution), plain(expected.distribution));
  assert.deepEqual(plain(group.statistics), plain(expected.normalized));
});

test('incompatible isotope ratio identity or protocol blocks shared-axis and pooled comparisons while preserving raw inspection', async () => {
  const changes = {
    series: section => { section.project.atlas.seriesId = 'another-series'; },
    specimen: section => { section.project.atlas.specimenId = 'another-mouse'; },
    dataset: section => { section.project.atlas.sourceSha256 = '0'.repeat(64); },
    missingSeries: section => { delete section.project.atlas.seriesId; },
    version: section => { section.evaluation.profile.methodVersion = 'other-method'; },
    schema: section => { section.evaluation.profile.schemaVersion = 3; },
    target: section => { section.evaluation.profile.targets[0].analyteId = 'Histamine-DPP'; },
    standard: section => { section.evaluation.profile.standardAnalyteId = 'Different-d4'; },
    unit: section => { section.evaluation.channels.m0.unit = 'concentration'; },
    qc: section => { section.evaluation.profile.qc.minD4 = 1; },
    unconfirmed: section => { section.evaluation.profile.standardApplication.confirmed = false; },
    application: section => { section.evaluation.profile.standardApplication.method = 'unknown'; },
    stale: section => { section.evaluation.profile.rawFingerprint = 'stale'; },
    scope: section => { section.evaluation.profile.scope = { groupId: 'fake-scope' }; }
  };
  for (const [name, change] of Object.entries(changes)) {
    const c = app(), loaded = sections(c, [entry(c, 1), entry(c, 2)]);
    change(loaded[1]);
    for (const mode of ['by-section', 'pooled']) {
      const result = await c.Stack3DAnalysis.analyze(loaded, request({ mode, valueMode: 'normalized' }));
      assert.equal(result.channels[0].status, 'BLOCKED', `${name}: ${mode}`);
      assert.ok(result.channels[0].groups.every(group => !group.distribution && !group.counts.nIncluded), `${name}: no shared-axis data`);
      assert.deepEqual(plain(result.channels[0].plot.autoDomain), [0, 1]);
    }
    assert.ok(first(await c.Stack3DAnalysis.analyze(loaded, request())).distribution, `${name}: raw remains inspectable`);
  }
});

test('missing molecular data retains a section slot and all-measured geometry without inventing a zero', async () => {
  const c = app(), source = [entry(c, 1), entry(c, 2)];
  source[1].project.molecules = source[1].project.molecules.filter(molecule => molecule.key !== 'm0');
  delete source[1].project.normalization;
  delete source[1].rasters.m0;
  const result = await c.Stack3DAnalysis.analyze(sections(c, source), request());
  assert.equal(result.channels[0].groups.length, 2);
  const missing = result.channels[0].groups[1];
  assert.equal(missing.sectionId, 'mouse-2'); assert.equal(missing.counts.nGeometry, 3);
  assert.equal(missing.distribution, null); assert.equal(missing.statistics.mean, null);
  assert.equal(missing.exclusions[0].code, 'CHANNEL_MISSING');
});

test('full measured-value quantiles and source buffers survive worker transfer and sampling', async () => {
  const c = app(), values = Array.from({ length: 5001 }, (_, index) => index), source = entry(c, 1, values, values.map(() => 2));
  const loaded = sections(c, [source]), before = Object.values(source.rasters).map(raster => bits(raster.values));
  let calls = 0;
  const result = await c.Stack3DAnalysis.analyze(loaded, request({ valueMode: 'normalized' }), {
    maxPoints: 12, summarize: async (data, options) => {
      calls++; assert.notEqual(data.buffer, source.rasters.m0.values.buffer);
      assert.notEqual(data.buffer, loaded[0].evaluation.channels.m0.values.buffer);
      const transferred = structuredClone(data, { transfer: [data.buffer] });
      return c.RoiDistribution.summarize(transferred, options);
    }
  });
  const group = first(result);
  assert.equal(calls, 1); assert.equal(group.distribution.n, 5001); assert.equal(group.distribution.points.length, 12);
  assert.equal(group.distribution.median, 1250); assert.equal(group.distribution.q1, 625); assert.equal(group.distribution.q3, 1875);
  assert.equal(group.statistics.mean, 1250);
  assert.deepEqual(Object.values(source.rasters).map(raster => bits(raster.values)), before);
  assert.equal(Object.hasOwn(group.distribution, 'upperTailValues'), false);
});
