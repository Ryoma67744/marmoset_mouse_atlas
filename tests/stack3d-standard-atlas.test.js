'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function app() {
  const c = { console, SectionDisplay: { COLORS: {} } }; c.window = c; vm.createContext(c);
  for (const file of ['stack3d.js', 'stack3d-standard-atlas.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), c, { filename: file });
  return c;
}
const copy = value => JSON.parse(JSON.stringify(value));
const near = (a, b, tolerance = 1e-10) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
function fixture(c, { id = 'saved-1', name = 'Cor_1_2', atlasSlice = 46, theta = 17, pitchY = 150 } = {}) {
  const project = { id, displayName: name, grid: { W: 4, H: 3, umPerPxX: 100, umPerPxY: pitchY },
    rotation: { all: 90, he: 13, msi: 4 }, world_coords: { T_he_to_msi: [[0.25, 0, 1], [0, 0.25, 2], [0, 0, 1]] },
    stack3d: { offsetXUm: 123, offsetYUm: -345, rotationDeg: 8 } };
  const section = { id, name, project, ...c.Stack3D.geometry(project) };
  const angle = theta * Math.PI / 180, sx = 2, sy = pitchY / 50;
  const row = { projectId: id, name, source: { grid: copy(project.grid), rotation: copy(project.rotation),
    T_he_to_msi: copy(project.world_coords.T_he_to_msi) }, atlasSlice, method: 'provisional-landmarks', qc: { status: 'requires-review' },
    rawMSIToAtlas: [[sx * Math.cos(angle), -sy * Math.sin(angle), 235], [sx * Math.sin(angle), sy * Math.cos(angle), 301], [0, 0, 1]] };
  return { section, row };
}
function dataset(rows) { return { schemaVersion: 1, id: 'marmoset-bma2023-v1', reference: { name: 'BMA2023' }, sections: rows }; }

test('Atlas physical pose maps every raw MSI corner exactly, with one pose for HE/MSI and reference depth kept as metadata', () => {
  const c = app(), f = fixture(c), source = copy(f.section.project), d = dataset([f.row]);
  const legacy = copy(c.Stack3D.scenePlacement(f.section)), prepared = c.Stack3DStandardAtlas.prepare([f.section], d);
  assert.equal(prepared.available, true); assert.equal(prepared.matched, 1);
  c.Stack3DStandardAtlas.apply([f.section], prepared, 'atlas');
  const p = c.Stack3D.scenePlacement(f.section), M = f.row.rawMSIToAtlas;
  assert.deepEqual(copy(c.Stack3D.scenePlacement(f.section, true)), copy(p));
  near(p.ordinalZ, 0); near(f.section.standardAtlasPose.atlasZMm, (46 - 314) * 0.05); near(p.angleDeg, -17);
  assert.equal(Object.hasOwn(p, 'zMm'), false);
  for (const u of [0, 0.5, 4]) for (const v of [0, 0.5, 3]) {
    const x = (u - 2) * 0.1, y = (1.5 - v) * 0.15, angle = p.angleDeg * Math.PI / 180;
    const scene = [p.x + x * Math.cos(angle) - y * Math.sin(angle), p.y + x * Math.sin(angle) + y * Math.cos(angle)];
    const atlas = [M[0][0] * u + M[0][1] * v + M[0][2], M[1][0] * u + M[1][1] * v + M[1][2]];
    near(scene[0], (atlas[0] - 360) * 0.05); near(scene[1], (360 - atlas[1]) * 0.05);
  }
  assert.deepEqual(copy(f.section.project), source, 'source project remains byte-for-byte equivalent');
  c.Stack3DStandardAtlas.apply([f.section], prepared, 'legacy');
  assert.equal(Object.hasOwn(f.section, 'standardAtlasPose'), false);
  assert.deepEqual(copy(c.Stack3D.scenePlacement(f.section)), legacy);
});

test('source matching requires IDs, exact names, grid, rotation and HE warp; all loaded sections must match', () => {
  const c = app(), a = fixture(c), b = fixture(c, { id: 'saved-2', name: 'Cor_2_3', atlasSlice: 165 });
  const d = dataset([a.row, b.row]);
  const changes = [
    s => { s.id = s.project.id = 'foreign-import'; },
    s => { s.name = s.project.displayName = 'Cor_1_2 (copy)'; },
    s => { s.project.grid.umPerPxX = 101; },
    s => { s.project.rotation.all += 90; },
    s => { s.project.world_coords.T_he_to_msi[0][2] += 0.1; },
    s => { s.sceneWidth += 1; },
    s => { s.project.atlas = { seriesId: 'other', species: 'marmoset' }; },
    s => { s.coordinateMode = 'pixel'; },
  ];
  for (const change of changes) {
    const s = copy(a.section); change(s);
    const p = c.Stack3DStandardAtlas.prepare([s, b.section], d);
    assert.equal(p.available, false); assert.equal(p.matched, 1); assert.match(p.reason, /2切片.*1切片/);
    assert.throws(() => c.Stack3DStandardAtlas.apply([s, b.section], p, 'atlas'), /一致/);
    assert.equal(Object.hasOwn(b.section, 'standardAtlasPose'), false, 'no partial assignment');
  }
  const subset = c.Stack3DStandardAtlas.prepare([b.section], d);
  assert.equal(subset.available, true);
  c.Stack3DStandardAtlas.apply([b.section], subset, 'atlas');
  near(b.section.standardAtlasPose.ordinalZ, 0.5);
  assert.equal(b.section.standardAtlasPose.displayIndex, 1); assert.equal(b.section.standardAtlasPose.displayCount, 2);
  near(b.section.standardAtlasPose.atlasZMm, (165 - 314) * 0.05, 1e-9);
  assert.equal(c.Stack3DStandardAtlas.prepare([], d).available, false);
});

test('malformed, reflected, sheared and magnified matrices cannot become an Atlas preset', () => {
  const c = app();
  const changes = [
    r => { r.rawMSIToAtlas[0][2] = Infinity; },
    r => { r.rawMSIToAtlas[1][1] = NaN; },
    r => { r.rawMSIToAtlas[0][0] = '2'; },
    r => { r.rawMSIToAtlas[2][0] = 0.1; },
    r => { r.rawMSIToAtlas[0][1] += 0.02; },
    r => { for (const row of r.rawMSIToAtlas.slice(0, 2)) row[0] *= -1; },
    r => { for (const row of r.rawMSIToAtlas.slice(0, 2)) { row[0] *= 1.003; row[1] *= 1.003; } },
    r => { r.source.T_he_to_msi[1] = [0, 0, 0]; },
    r => { r.atlasSlice = null; },
    r => { r.atlasSlice = 720; },
    r => { r.atlasSlice = 721; },
  ];
  for (const change of changes) {
    const f = fixture(c); change(f.row);
    const p = c.Stack3DStandardAtlas.prepare([f.section], dataset([f.row]));
    assert.equal(p.available, false); assert.equal(p.byId.size, 0); assert.ok(p.reason);
  }
  const f = fixture(c);
  assert.equal(c.Stack3DStandardAtlas.prepare([f.section], dataset([f.row, f.row])).available, false);
  assert.equal(c.Stack3DStandardAtlas.prepare([f.section, f.section], dataset([f.row])).available, false);
  for (const reference of [{ nativeGrid: [720, 600] }, { pixelSpacingMm: 0.1 }, { sliceSpacingMm: 0.1 },
    { imageOriginPx: [359.5, 360] }, { imageOriginPx: [360] }, { relativeSliceOrigin: 284 },
    { physicalScale: 1.003 }, { specimenHemisphere: 'left' }, { nativeImageSide: 'right' }]) {
    assert.equal(c.Stack3DStandardAtlas.prepare([f.section], { ...dataset([f.row]), reference }).available, false);
  }
});

test('prepared poses are immutable, recheck source at switch time, and do not change on subset or hidden selection', () => {
  const c = app(), f = fixture(c), d = dataset([f.row]), p = c.Stack3DStandardAtlas.prepare([f.section], d);
  d.sections[0].rawMSIToAtlas[0][2] += 100;
  assert.throws(() => { p.byId.get(f.section.id).x = 99; }, TypeError);
  const expected = p.byId.get(f.section.id).x;
  c.Stack3DStandardAtlas.apply([f.section], p, 'atlas'); near(f.section.standardAtlasPose.x, expected);
  c.Stack3DStandardAtlas.apply([f.section], p, 'legacy');
  f.section.project.world_coords.T_he_to_msi[0][2] += 1;
  assert.throws(() => c.Stack3DStandardAtlas.apply([f.section], p, 'atlas'), /一致/);
  assert.equal(Object.hasOwn(f.section, 'standardAtlasPose'), false);
  assert.throws(() => c.Stack3D.scenePlacement({ ...f.section, standardAtlasPose: { x: 0, y: 0, angleDeg: 0, ordinalZ: NaN } }), /不正/);
});

test('uniform depth follows full natural sample order despite duplicate, reversed, or widely separated Atlas slices', () => {
  const c = app(), names = ['Cor_1_2', 'Cor_1_10', 'Cor_2_1', 'Cor_9_4', 'Cor_10_1'];
  const slices = [300, 300, 299, 710, 10];
  const fixtures = names.map((name, i) => fixture(c, { id: 'order-' + i, name, atlasSlice: slices[i], theta: i * 7 - 13 }));
  const sections = fixtures.map(f => f.section), rows = fixtures.map(f => f.row);
  const shuffled = dataset([rows[3], rows[1], rows[4], rows[0], rows[2]]), source = copy(shuffled);
  const prepared = c.Stack3DStandardAtlas.prepare([...sections].reverse(), shuffled);
  assert.equal(prepared.available, true);
  c.Stack3DStandardAtlas.apply(sections, prepared, 'atlas');
  const poses = sections.map(s => copy(s.standardAtlasPose));
  for (const [i, pose] of poses.entries()) {
    assert.equal(pose.displayIndex, i); assert.equal(pose.displayCount, 5); near(pose.ordinalZ, i - 2);
    near(pose.atlasZMm, (slices[i] - 314) * 0.05);
    for (const spacing of [0.595, 1.2]) if (i) near((pose.ordinalZ - poses[i - 1].ordinalZ) * spacing, spacing);
  }
  // Neither input order, a subset, nor a different reference s changes XY,
  // orientation, or the full-stack display rank assigned to each specimen.
  const subset = c.Stack3DStandardAtlas.prepare([sections[4], sections[1]], dataset([...rows].reverse()));
  assert.equal(subset.available, true);
  c.Stack3DStandardAtlas.apply([sections[4], sections[1]], subset, 'atlas');
  assert.deepEqual(copy(sections[4].standardAtlasPose), poses[4]);
  assert.deepEqual(copy(sections[1].standardAtlasPose), poses[1]);
  const otherReferences = copy(shuffled); otherReferences.sections.forEach((r, i) => { r.atlasSlice = 100 + i; });
  const otherPrepared = c.Stack3DStandardAtlas.prepare(sections, otherReferences);
  c.Stack3DStandardAtlas.apply(sections, otherPrepared, 'atlas');
  sections.forEach((section, i) => {
    const pose = section.standardAtlasPose;
    for (const key of ['x', 'y', 'angleDeg', 'ordinalZ']) near(pose[key], poses[i][key]);
  });
  assert.deepEqual(shuffled, source, 'preset source matrices and metadata remain unchanged');
});

test('provided raw fingerprints invalidate replacement measurements but allow display/normalization metadata changes', () => {
  const c = app(), f = fixture(c);
  f.section.sourceFingerprint = f.row.source.rawFingerprint = 'f32-v1:measurement-fixture';
  const d = dataset([f.row]), prepared = c.Stack3DStandardAtlas.prepare([f.section], d);
  assert.equal(prepared.available, true);
  f.section.project.normalization = { revision: 2 }; f.section.project.valueDisplay = { mode: 'normalized' };
  c.Stack3DStandardAtlas.apply([f.section], prepared, 'atlas');
  c.Stack3DStandardAtlas.apply([f.section], prepared, 'legacy');
  f.section.sourceFingerprint = 'f32-v1:replacement-fixture';
  assert.equal(c.Stack3DStandardAtlas.prepare([f.section], d).available, false);
  assert.throws(() => c.Stack3DStandardAtlas.apply([f.section], prepared, 'atlas'), /一致/);
  delete f.section.sourceFingerprint;
  assert.equal(c.Stack3DStandardAtlas.prepare([f.section], d).available, false);
});
