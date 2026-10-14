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
    'stack3d.js', 'roi-distribution.js', 'intensity-axis.js', 'stack3d-analysis.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), c, { filename: file });
  }
  return c;
}
const plain = value => JSON.parse(JSON.stringify(value));
const bits = values => Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('hex');
const ring = (left, right) => [[left - 0.5, -0.5], [right + 0.5, -0.5], [right + 0.5, 0.5], [left - 0.5, 0.5]];
function entry(id, values, options = {}) {
  const W = values.length, project = { id, displayName: options.name || 'Cor_1_' + id, updatedAt: 'original',
    grid: { W, H: 1, umPerPxX: options.pitch || 25, umPerPxY: 25 }, images: {}, rotation: {},
    molecules: [{ key: 'da', name: 'DA', blobId: id + ':da' }],
    roi: { roi_items: { region: [{ poly_msi: ring(0, W - 1) }] }, roi_names: { region: 'Region' }, roi_show_flags: { region: true } } };
  const rasters = { da: { W, H: 1, values: Float32Array.from(values) } };
  if (options.d4) {
    project.molecules.push({ key: 'd4', name: 'D4-5-HT', blobId: id + ':d4' });
    rasters.d4 = { W, H: 1, values: Float32Array.from(options.d4) };
  }
  if (options.ht) {
    project.molecules.push({ key: 'ht', name: '5-HT', blobId: id + ':ht' });
    rasters.ht = { W, H: 1, values: Float32Array.from(options.ht) };
  }
  return { project, rasters };
}
function corrected(c, entries, overrides = {}) {
  const ids = entries.map(item => item.project.id);
  const config = Object.assign({ id: 'same-profile', revision: 1,
    scope: { type: 'folder-depth', depth: 2, includeDescendants: true, groupId: 'same-group', folderPath: ['Species', 'Series'], memberIds: ids } }, overrides);
  const made = c.Normalization.createSimpleProfiles(entries, config);
  assert.equal(made.canSave, true);
  made.profiles.forEach((row, i) => {
    entries[i].project.normalization = row.normalization;
    entries[i].project.normalizationBinding = { groupId: config.scope.groupId, memberId: ids[i], folderPath: config.scope.folderPath.slice() };
  });
  return made;
}
function sections(c, entries) {
  return entries.map(item => c.Stack3D.createSection(item.project, item.rasters, { projects: entries.map(item => item.project) }));
}
function request(sectionIds, changes = {}) {
  return Object.assign({ mode: 'pooled', sectionIds, roiNames: ['Region'], channels: ['DA'], valueMode: 'raw' }, changes);
}
const one = result => result.channels[0].groups[0];

test('selection is inclusive, arbitrary, deduplicated, dynamic and rejects incomplete/out-of-range input', () => {
  const c = app(), list = Array.from({ length: 72 }, (_, i) => ({ id: 's' + i }));
  const range = c.Stack3DAnalysis.parseSelection('5–20', list);
  assert.equal(range.count, 16); assert.equal(range.sectionIds[0], 's4'); assert.equal(range.sectionIds.at(-1), 's19');
  assert.equal(c.Stack3DAnalysis.parseSelection('5-20, 24, 30–35', list).count, 23);
  assert.deepEqual(plain(c.Stack3DAnalysis.parseSelection('3, 1–3, 72', list).numbers), [1, 2, 3, 72]);
  for (const text of ['', '5-', '20–5', '0', '73', '1.5', '5,', '2 x 3', '999999999999999999999']) assert.throws(() => c.Stack3DAnalysis.parseSelection(text, list));
});

test('ROI catalog uses NFC and trim, includes hidden ROIs, and keeps case/side names separate', () => {
  const c = app(), a = entry('1', [1, 2]);
  a.project.roi.roi_names.region = '  Cafe\u0301  ';
  a.project.roi.roi_show_flags.region = false;
  a.project.roi.roi_items.other = [{ poly_msi: ring(0, 0) }]; a.project.roi.roi_names.other = 'café';
  const b = entry('2', [3]); b.project.roi.roi_names.region = 'Café';
  const catalog = c.Stack3DAnalysis.regionCatalog(sections(c, [a, b]));
  assert.equal(catalog.length, 2);
  assert.equal(catalog.find(row => row.name === 'Café').sectionCount, 2);
  assert.equal(catalog.find(row => row.name === 'café').sectionCount, 1);
});

test('pooled distribution uses all pixels, not means/medians of sections, with population SD', async () => {
  const c = app(), source = [entry('1', [0, 0, 0, 0]), entry('2', [100])], loaded = sections(c, source);
  const before = source.map(item => bits(item.rasters.da.values)), original = JSON.stringify(source.map(item => item.project));
  const group = one(await c.Stack3DAnalysis.analyze(loaded, request(['1', '2'])));
  assert.equal(group.distribution.n, 5); assert.equal(group.distribution.median, 0);
  assert.equal(group.distribution.whiskerHigh, 96); assert.equal(group.distribution.upperTailCount, 1);
  assert.equal(group.statistics.mean, 20); assert.equal(group.statistics.sd, 40);
  assert.equal(group.counts.includedSections, 2); assert.equal(group.counts.nIncluded, 5);
  assert.ok(group.warnings.includes('PIXEL_WEIGHTED'));
  assert.deepEqual(source.map(item => bits(item.rasters.da.values)), before);
  assert.equal(JSON.stringify(source.map(item => item.project)), original);
});

test('same-name polygons are unioned within a section; catalog visibility and 3D placement do not change analysis', async () => {
  const c = app(), a = entry('1', [1, 2, 3, 4]);
  a.project.roi.roi_items.region = [{ poly_msi: ring(0, 2) }];
  a.project.roi.roi_items.second = [{ poly_msi: ring(1, 3) }];
  a.project.roi.roi_names.second = ' Region '; a.project.roi.roi_show_flags.second = false;
  const loaded = sections(c, [a]);
  let calls = 0; const original = c.Normalization.quantifyRoi;
  c.Normalization.quantifyRoi = (...args) => { calls++; return original(...args); };
  const first = one(await c.Stack3DAnalysis.analyze(loaded, request(['1'])));
  assert.equal(first.distribution.n, 4); assert.equal(first.distribution.median, 2.5); assert.equal(calls, 1);
  loaded[0].offsetXUm = 500; loaded[0].rotationDeg = 95; loaded[0].sourceRevision = 'placement-save';
  a.project.roi.roi_show_flags.region = false;
  const next = one(await c.Stack3DAnalysis.analyze(loaded, request(['1'])));
  assert.deepEqual(plain(next.distribution), plain(first.distribution)); assert.equal(calls, 1);
  a.project.roi.roi_items.region[0].poly_msi = ring(0, 0); a.project.roi.roi_items.second = [];
  assert.equal(one(await c.Stack3DAnalysis.analyze(loaded, request(['1']))).distribution.n, 1);
  assert.equal(calls, 2);
});

test('missing ROI and missing values stay unavailable, never become zero observations', async () => {
  const c = app(), a = entry('1', [0, NaN, -3, Infinity]), b = entry('2', [7]), d = entry('3', [NaN]);
  b.project.roi.roi_items = {};
  const result = await c.Stack3DAnalysis.analyze(sections(c, [a, b, d]), request(['1', '2', '3']));
  const group = one(result);
  assert.equal(group.counts.targetSections, 3); assert.equal(group.counts.roiSections, 2); assert.equal(group.counts.includedSections, 1);
  assert.equal(group.distribution.n, 2); assert.equal(group.distribution.median, -1.5);
  assert.equal(group.status, 'PARTIAL');
  assert.ok(group.exclusions.some(row => row.sectionId === '2' && row.code === 'ROI_MISSING'));
  assert.ok(group.exclusions.some(row => row.sectionId === '3' && row.code === 'NO_MEASURED_PIXELS'));
  const unavailable = one(await c.Stack3DAnalysis.analyze(sections(c, [d]), request(['3'])));
  assert.equal(unavailable.distribution, null); assert.equal(unavailable.statistics.mean, null);
});

test('selected and by-section modes preserve ordinal order and expose per-section statistics', async () => {
  const c = app(), loaded = sections(c, [entry('1', [0, 10]), entry('2', [20])]);
  const comparison = await c.Stack3DAnalysis.analyze(loaded, request(['2', '1'], { mode: 'by-section' }));
  assert.deepEqual(plain(comparison.selection.sectionIds), ['1', '2']);
  assert.deepEqual(plain(comparison.channels[0].groups.map(group => [group.sectionId, group.statistics.mean])), [['1', 5], ['2', 20]]);
  const selected = await c.Stack3DAnalysis.analyze(loaded, request(['2'], { mode: 'selected' }));
  assert.equal(selected.selection.count, 1); assert.equal(one(selected).sectionId, '2');
  assert.equal(one(selected).distribution.median, 20);
  await assert.rejects(c.Stack3DAnalysis.analyze(loaded, request(['3'])), /切片/);
  await assert.rejects(c.Stack3DAnalysis.analyze(loaded, request(['1'], { mode: 'by-section', roiNames: [] })), /ROI/);
});

test('missing molecular channel retains ROI geometry counts but contributes no observations', async () => {
  const c = app(), a = entry('1', [7, 9]); a.project.molecules[0].name = 'NE';
  const group = one(await c.Stack3DAnalysis.analyze(sections(c, [a]), request(['1'])));
  assert.equal(group.counts.roiSections, 1); assert.equal(group.counts.nGeometry, 2);
  assert.equal(group.counts.nMeasured, 0); assert.equal(group.distribution, null);
  assert.equal(group.exclusions[0].code, 'CHANNEL_MISSING');
});

test('common normalized reference permits different legitimate section factors and matches 2D ROI statistics', async () => {
  const c = app(), source = [entry('1', [6, 8], { d4: [2, 4], ht: [10, 20] }), entry('2', [12, 16], { d4: [4, 8], ht: [20, 40] })];
  corrected(c, source); const loaded = sections(c, source);
  assert.notEqual(loaded[0].evaluation.section.k, loaded[1].evaluation.section.k);
  const group = one(await c.Stack3DAnalysis.analyze(loaded, request(['1', '2'], { valueMode: 'normalized' })));
  assert.equal(group.compatibility.status, 'COMPATIBLE'); assert.equal(group.distribution.n, 4);
  assert.equal(group.statistics.mean, 10.5); assert.equal(group.statistics.sd, 1.5);
  const mask = new Uint8Array(2).fill(1);
  const expected = c.Normalization.quantifyRoi(source[0].project, source[0].rasters, loaded[0].evaluation, mask,
    { distribution: { mode: 'normalized', keys: ['da'] } }).find(row => row.key === 'da');
  const single = one(await c.Stack3DAnalysis.analyze(loaded, request(['1'], { mode: 'selected', valueMode: 'normalized' })));
  const { aboveAutoCount, ...singleStatistics } = single.distribution;
  assert.deepEqual(plain(singleStatistics), plain(expected.distribution));
  assert.equal(aboveAutoCount, 0);
  assert.deepEqual(plain(single.statistics), plain(expected.normalized));
});

test('normalized pooling excludes skipped sections without raw fallback and exposes exclusions', async () => {
  const c = app(), source = [entry('1', [6, 8], { d4: [2, 4] }), entry('2', [1000, 2000])];
  corrected(c, source); const loaded = sections(c, source);
  const group = one(await c.Stack3DAnalysis.analyze(loaded, request(['1', '2'], { valueMode: 'normalized' })));
  assert.equal(group.distribution.n, 2); assert.equal(group.statistics.mean, 7); assert.equal(group.counts.includedSections, 1);
  assert.ok(group.exclusions.some(row => row.sectionId === '2' && row.reasonCodes.includes('INTERNAL_STANDARD_MISSING')));
  assert.equal(one(await c.Stack3DAnalysis.analyze(loaded, request(['2'], { mode: 'selected', valueMode: 'normalized' }))).distribution, null);
});

test('ROI-level strict QC suppresses finite normalized values rather than pooling them', async () => {
  const c = app(), source = [entry('1', [2, 2, 2, 2, 2, 2, 2, 2], { d4: [2, 0, 0, 2, 2, 2, 2, 2], ht: [10, 10, 10, 10, 10, 10, 10, 10] })];
  corrected(c, source, { qc: { minD4: 0, saturationD4: null, minCoverage: 0.75, enforceCoverage: true } });
  source[0].project.roi.roi_items.region = [{ poly_msi: ring(0, 3) }];
  const loaded = sections(c, source), channel = loaded[0].evaluation.channels.ht;
  assert.ok(channel.values && channel.values.some(Number.isFinite));
  const group = one(await c.Stack3DAnalysis.analyze(loaded, request(['1'], { channels: ['5-HT'], valueMode: 'normalized' })));
  assert.equal(group.distribution, null); assert.equal(group.counts.nValid, 2); assert.equal(group.counts.nIncluded, 0);
  assert.ok(group.exclusions.some(row => row.reasonCodes.includes('INSUFFICIENT_VALID_COVERAGE')));
});

test('normalized group/reference/version/legacy incompatibility blocks pooled and common-axis comparisons', async () => {
  for (const mutation of ['group', 'reference', 'version', 'legacy', 'scope']) {
    const c = app(), source = [entry('1', [6, 8], { d4: [2, 4] }), entry('2', [12, 16], { d4: [4, 8] })];
    corrected(c, source); const loaded = sections(c, source);
    const profile = loaded[1].evaluation.profile;
    if (mutation === 'group') profile.scope.groupId = 'another';
    if (mutation === 'reference') profile.section.Dref = 90;
    if (mutation === 'version') profile.revision++;
    if (mutation === 'legacy') delete profile.scope;
    if (mutation === 'scope') loaded[1].scope = { status: 'MIXED' };
    for (const mode of ['pooled', 'by-section']) {
      const result = await c.Stack3DAnalysis.analyze(loaded, request(['1', '2'], { valueMode: 'normalized', mode }));
      assert.equal(result.channels[0].status, 'BLOCKED', mutation + ' ' + mode);
      assert.ok(result.channels[0].groups.every(group => !group.distribution && group.counts.nIncluded === 0));
    }
    assert.ok(one(await c.Stack3DAnalysis.analyze(loaded, request(['1', '2'], { valueMode: 'raw' }))).distribution);
  }
});

test('large samples preserve full statistics; Worker hook receives a dedicated transferable copy', async () => {
  const c = app(), data = Array.from({ length: 3001 }, (_, i) => i), source = [entry('1', data)], loaded = sections(c, source);
  const original = bits(source[0].rasters.da.values);
  let calls = 0;
  const result = await c.Stack3DAnalysis.analyze(loaded, request(['1']), { summarize: async (values, options) => {
    calls++; assert.notEqual(values.buffer, source[0].rasters.da.values.buffer);
    const transferred = structuredClone(values, { transfer: [values.buffer] });
    return c.RoiDistribution.summarize(transferred, options);
  } });
  const group = one(result);
  assert.equal(calls, 1); assert.equal(group.distribution.n, 3001); assert.equal(group.distribution.points.length, 2000);
  assert.equal(group.distribution.median, 1500); assert.equal(group.distribution.whiskerHigh, 2970);
  assert.equal(group.statistics.mean, 1500); assert.equal(bits(source[0].rasters.da.values), original);
  assert.equal(group.distribution.aboveAutoCount, 0);
  assert.equal(Object.hasOwn(group.distribution, 'upperTailValues'), false);
});

test('automatic-axis counts are exact above the final shared axis and independent of point sampling', async () => {
  const c = app();
  const low = [...Array(990).fill(10), 11, 12, 20, 30, 40, 50, 60, 70, 1000, 2000];
  const high = [...Array(990).fill(100), ...Array(5).fill(120), ...Array(5).fill(10000)];
  const source = [entry('1', low), entry('2', high)];
  source[0].project.roi.roi_names.region = 'A'; source[1].project.roi.roi_names.region = 'B';
  const loaded = sections(c, source), before = source.map(item => bits(item.rasters.da.values));
  const options = request(['1', '2'], { roiNames: ['A', 'B'] });
  const compact = await c.Stack3DAnalysis.analyze(loaded, options, { maxPoints: 2 });
  const detailed = await c.Stack3DAnalysis.analyze(loaded, options, { maxPoints: 2000 });
  const channel = compact.channels[0], upper = channel.plot.autoDomain[1];
  assert.ok(upper >= Math.max(...channel.groups.map(group => group.distribution.whiskerHigh)));
  for (const [index, values] of [low, high].entries()) {
    const distribution = channel.groups[index].distribution;
    assert.equal(distribution.aboveAutoCount, values.filter(value => value > upper).length);
    assert.equal(distribution.aboveAutoCount, detailed.channels[0].groups[index].distribution.aboveAutoCount);
    assert.equal(Object.hasOwn(distribution, 'upperTailValues'), false);
    assert.ok(distribution.sampled);
  }
  assert.ok(channel.groups[0].distribution.aboveAutoCount < channel.groups[0].distribution.upperTailCount,
    'P99 tail count is not mistaken for the count above a shared rounded upper bound');
  assert.deepEqual(source.map(item => bits(item.rasters.da.values)), before);
});

test('zero-heavy automatic plots keep outliers in statistics and count them without expanding the P99 axis', async () => {
  const c = app(), source = [entry('1', [...Array(999).fill(0), 1e10])];
  const result = await c.Stack3DAnalysis.analyze(sections(c, source), request(['1']));
  assert.deepEqual(plain(result.channels[0].plot.autoDomain), [0, 1]);
  assert.equal(one(result).distribution.aboveAutoCount, 1);
  assert.equal(one(result).distribution.n, 1000);
  assert.equal(one(result).statistics.mean, 1e7);
  assert.equal(one(result).distribution.max, 1e10);
  assert.equal(Object.hasOwn(one(result).distribution, 'upperTailValues'), false);
});

test('disjoint pooled ROIs still share an axis and cannot hide incompatible normalized sources', async () => {
  const c = app(), source = [entry('1', [6, 8], { d4: [2, 4] }), entry('2', [12, 16], { d4: [4, 8] })];
  source[0].project.roi.roi_names.region = 'A'; source[1].project.roi.roi_names.region = 'B';
  corrected(c, source); const loaded = sections(c, source);
  loaded[1].evaluation.profile.scope.groupId = 'another';
  const result = await c.Stack3DAnalysis.analyze(loaded, request(['1', '2'], { roiNames: ['A', 'B'], valueMode: 'normalized' }));
  assert.equal(result.channels[0].status, 'BLOCKED');
  assert.ok(result.channels[0].groups.every(group => group.distribution === null && group.counts.nIncluded === 0));
  assert.ok(result.channels[0].groups.every(group => group.exclusions.some(row => row.reasonCodes.includes('NORMALIZATION_INCOMPATIBLE'))));
  assert.deepEqual(plain(result.channels[0].plot.autoDomain), [0, 1], 'blocked groups do not set the displayed axis');
  assert.ok(!JSON.stringify(result).includes('upperTailValues'), 'temporary tails never become retained output');
});

test('one legacy section with several ROIs is still a single source, not a mixed normalization group', async () => {
  const c = app(), source = [entry('1', [6, 8], { d4: [2, 4] })];
  source[0].project.roi.roi_names.region = 'A';
  source[0].project.roi.roi_items.second = [{ poly_msi: ring(0, 0) }]; source[0].project.roi.roi_names.second = 'B';
  corrected(c, source); const loaded = sections(c, source); delete loaded[0].evaluation.profile.scope;
  const result = await c.Stack3DAnalysis.analyze(loaded, request(['1'], { roiNames: ['A', 'B'], valueMode: 'normalized' }));
  assert.notEqual(result.channels[0].status, 'BLOCKED');
  assert.equal(result.channels[0].groups.filter(group => group.distribution).length, 2);
});

test('saved scope membership must match even when current folder membership cannot be verified', async () => {
  const c = app(), source = [entry('1', [6, 8], { d4: [2, 4] }), entry('2', [12, 16], { d4: [4, 8] })];
  corrected(c, source); const loaded = sections(c, source);
  loaded.forEach(section => { section.scope = { status: 'CURRENT', membershipVerified: false }; });
  // Reordering the same immutable saved members does not change compatibility.
  loaded[1].evaluation.profile.scope.memberIds.reverse();
  assert.ok(one(await c.Stack3DAnalysis.analyze(loaded, request(['1', '2'], { valueMode: 'normalized' }))).distribution);
  // A differently populated saved batch is not the same normalization snapshot,
  // even if its group, profile ID/revision and fixed references happen to match.
  loaded[1].evaluation.profile.scope.memberIds.push('another-saved-member');
  const blocked = await c.Stack3DAnalysis.analyze(loaded, request(['1', '2'], { valueMode: 'normalized' }));
  assert.equal(blocked.channels[0].status, 'BLOCKED'); assert.equal(one(blocked).distribution, null);
  assert.ok(blocked.channels[0].compatibility.reasonCodes.includes('NORMALIZATION_INCOMPATIBLE'));
});

test('aborted computations never produce a result, including cancellation while summarizing', async () => {
  const c = app(), loaded = sections(c, [entry('1', [1, 2])]), controller = new AbortController();
  controller.abort();
  await assert.rejects(c.Stack3DAnalysis.analyze(loaded, request(['1']), { signal: controller.signal }), { name: 'AbortError' });
  const next = new AbortController();
  await assert.rejects(c.Stack3DAnalysis.analyze(loaded, request(['1']), { signal: next.signal,
    summarize: async values => { next.abort(); return c.RoiDistribution.summarize(values); } }), { name: 'AbortError' });
});

test('cache clears on replacement evaluation/rasters and explicit clear, without source revision dependency', async () => {
  const c = app(), source = entry('1', [1, 2]), loaded = sections(c, [source]);
  let calls = 0; const original = c.Normalization.quantifyRoi;
  c.Normalization.quantifyRoi = (...args) => { calls++; return original(...args); };
  await c.Stack3DAnalysis.analyze(loaded, request(['1']));
  loaded[0].evaluation = c.Normalization.evaluate(source.project, source.rasters);
  await c.Stack3DAnalysis.analyze(loaded, request(['1'])); assert.equal(calls, 2);
  loaded[0].rasters = { da: { W: 2, H: 1, values: new Float32Array([8, 10]) } };
  loaded[0].evaluation = c.Normalization.evaluate(source.project, loaded[0].rasters);
  assert.equal(one(await c.Stack3DAnalysis.analyze(loaded, request(['1']))).statistics.mean, 9); assert.equal(calls, 3);
  c.Stack3DAnalysis.clearCache(); await c.Stack3DAnalysis.analyze(loaded, request(['1'])); assert.equal(calls, 4);
});
