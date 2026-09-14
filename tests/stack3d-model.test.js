'use strict';
// Synthetic numerical fixtures only. No source measurement data or browser is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function app() {
  const c = { console, Float32Array, Float64Array, Uint8Array, ArrayBuffer, DataView, Date };
  c.window = c;
  vm.createContext(c);
  for (const file of ['msi.js', 'normalization-scope.js', 'normalization.js', 'display-range.js', 'section-display.js', 'stack3d.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), c, { filename: file });
  }
  return c;
}
const plain = value => JSON.parse(JSON.stringify(value));
const bits = values => Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('hex');

function fixture(c) {
  const entries = [
    { id: 'first', name: 'Cor_1_2', factor: 1 },
    { id: 'second', name: 'Cor_1_10', factor: 2 },
    { id: 'missing-standard', name: 'Cor_10_1', factor: 3, skip: true },
  ].map(({ id, name, factor, skip }) => {
    const project = { id, displayName: name, updatedAt: 'saved-revision-' + id,
      grid: { W: 3, H: 2, umPerPxX: 25, umPerPxY: 50 }, images: {},
      rotation: { all: id === 'first' ? 94 : 0, msi: 0, he: 0 },
      valueDisplay: { mode: 'normalized', scaleMode: 'individual' },
      layerDisplay: {}, molecules: [] };
    const rasters = {};
    const definitions = { da: ['DA', [-0, 4, 6, 8, 10, NaN]], ne: ['NE', [0, 8, 12, 16, 20, NaN]],
      ht: ['5-HT', [0, 2, 3, 4, 5, NaN]], standard: ['D4-5-HT', [2, 2, 2, 2, 2, NaN]] };
    for (const [key, [moleculeName, source]] of Object.entries(definitions)) {
      if (key === 'standard' && skip) continue;
      project.molecules.push({ key, name: moleculeName, blobId: id + ':' + key });
      rasters[key] = { W: 3, H: 2, values: Float32Array.from(source, x => x * factor) };
    }
    return { project, rasters };
  });
  const result = c.Normalization.createSimpleProfiles(entries, {
    id: 'synthetic-stack', revision: 1,
    scope: { type: 'folder-depth', depth: 2, includeDescendants: true, groupId: 'synthetic-group',
      folderPath: ['Synthetic', 'Coronal'], memberIds: entries.map(e => e.project.id) },
  });
  assert.equal(result.canSave, true);
  result.profiles.forEach((row, i) => { entries[i].project.normalization = row.normalization; });
  const data = Object.fromEntries(entries.flatMap(e => e.project.molecules.map(m => [m.blobId, e.rasters[m.key].values])));
  return { entries, storage: { getValueRaster: async id => data[id] } };
}

test('numeric Cor order ignores missing identifiers and advances ordinal Z only for loaded sections', async () => {
  const c = app(), f = fixture(c);
  const later = { ...f.entries[0].project, id: 'later', displayName: 'Cor_2_1' };
  const bad = { ...f.entries[0].project, id: 'unreadable', displayName: 'Cor_2_9', grid: { W: 0, H: 2 } };
  const input = [f.entries[2].project, later, f.entries[1].project, bad, f.entries[0].project,
    { id: 'sagittal', displayName: 'Sag_1_1' }, { id: 'malformed', displayName: 'Cor_1_2unknown' }];
  const before = plain(input), progress = [];
  assert.deepEqual(plain(c.Stack3D.sortCoronal(input).map(p => p.displayName)), ['Cor_1_2', 'Cor_1_10', 'Cor_2_1', 'Cor_2_9', 'Cor_10_1']);
  assert.deepEqual(plain(c.Stack3D.naturalCor('Cor_001-02 (copy)')), { group: 1, section: 2, canonical: 'Cor_1_2' });
  assert.equal(c.Stack3D.naturalCor('Cor_1_2unknown'), null);
  const sections = await c.Stack3D.loadSections(input, { storage: f.storage, onProgress: event => progress.push(event) });
  assert.deepEqual(plain(sections.map(s => [s.id, s.index, s.zIndex])), [['first', 0, 0], ['second', 1, 1], ['later', 2, 2], ['missing-standard', 3, 3]]);
  assert.equal(sections.errors.length, 1);
  assert.equal(sections.errors[0].id, 'unreadable');
  assert.match(sections.errors[0].message, /グリッド/);
  assert.equal(progress.at(-1).completed, 5);
  assert.equal(progress.at(-1).loaded, 4);
  assert.deepEqual(plain(input), before, 'loading and sorting cannot modify project metadata');
});

test('physical anisotropic XY and saved 94 degree orientation exclude camera pan and zoom', () => {
  const c = app(), f = fixture(c), p = f.entries[0].project;
  p.stack3d = { offsetXUm: 125, offsetYUm: -250, rotationDeg: 12 };
  p.viewerTransform = { tx: 50000, ty: -9000, scale: 18 };
  const shape = c.Stack3D.geometry(p);
  assert.equal(shape.widthMm, 0.075);
  assert.equal(shape.heightMm, 0.1);
  assert.equal(shape.angleDeg, -86);
  assert.equal(shape.heAngleDeg, -86);
  assert.equal(shape.offsetXUm, 125);
  assert.equal(shape.offsetYUm, -250);
  assert.equal(shape.rotationDeg, 12);
  p.viewerTransform = { tx: 0, ty: 0, scale: 1 };
  assert.deepEqual(plain(c.Stack3D.geometry(p)), plain(shape));
  const oldGrid = { ...p, grid: { W: 3, H: 2 }, world_coords: { msi_um_per_px: { x: 100, y: 200 } } };
  assert.equal(c.Stack3D.geometry(oldGrid).widthMm, 0.3);
  assert.equal(c.Stack3D.geometry(oldGrid).heightMm, 0.4);
  assert.throws(() => c.Stack3D.geometry({ grid: { W: 3, H: 2 } }), /画素サイズ/);
  assert.throws(() => c.Stack3D.geometry({ grid: { W: 1.5, H: 2, umPerPxX: 25, umPerPxY: 25 } }), /グリッド/);
});

test('explicit NE takes priority over NA alias and isotope standards cannot become analyte channels', () => {
  const c = app();
  const molecules = [{ key: 'na', name: 'NA' }, { key: 'ne', name: 'NE' }, { key: 'd4', name: 'D4-5-HT' },
    { key: 'da', name: 'Dopamine' }, { key: 'ht', name: 'Serotonin' }];
  const channels = c.Stack3D.channelMap(molecules);
  assert.deepEqual(plain(Object.fromEntries(Object.entries(channels).map(([key, m]) => [key, m.key]))), { DA: 'da', NE: 'ne', '5-HT': 'ht' });
  assert.equal(c.Stack3D.channelMap([{ key: 'na', name: 'NA' }]).NE.key, 'na');
  assert.throws(() => c.Stack3D.channelMap([{ key: 'a', name: 'Dopamine' }, { key: 'b', name: 'Dopamine' }]), /複数/);
});

test('normalized common ranges exclude skipped sections while raw values and 2D state remain exact', async () => {
  const c = app(), f = fixture(c);
  const metadata = plain(f.entries.map(e => e.project));
  const rawBefore = f.entries.map(e => Object.fromEntries(Object.entries(e.rasters).map(([key, r]) => [key, bits(r.values)])));
  const sections = await c.Stack3D.loadSections(f.entries.map(e => e.project), { storage: f.storage });
  assert.equal(sections.errors.length, 0);
  const commonRaw = c.Stack3D.computeCommonRanges(sections, 'raw');
  const commonCorrected = c.Stack3D.computeCommonRanges(sections, 'normalized');
  const omitted = sections.find(s => s.id === 'missing-standard');
  assert.equal(omitted.evaluation.status, 'SKIPPED');
  for (const analyte of ['DA', 'NE', '5-HT']) {
    assert.equal(omitted.channels[analyte].normalized, null);
    assert.deepEqual(plain(commonRaw[analyte].memberIds), ['first', 'second', 'missing-standard']);
    assert.deepEqual(plain(commonCorrected[analyte].memberIds), ['first', 'second']);
    assert.equal(commonCorrected[analyte].mode, 'normalized');
    const one = sections[0].channels[analyte].normalized, two = sections[1].channels[analyte].normalized;
    assert.ok(one && two);
    assert.deepEqual(Array.from(one), Array.from(two), 'fixed internal-standard profiles produce equal synthetic corrected arrays');
  }
  assert.deepEqual(f.entries.map(e => Object.fromEntries(Object.entries(e.rasters).map(([key, r]) => [key, bits(r.values)]))), rawBefore);
  assert.deepEqual(plain(f.entries.map(e => e.project)), metadata);
  c.Stack3D.releaseSection(sections[0]);
  assert.equal(sections[0].rasters, null);
  assert.deepEqual(plain(c.Stack3D.computeCommonRanges(sections, 'raw').DA.memberIds), ['second', 'missing-standard']);
});

test('a registered missing analyte is reported and cancellation stops loading without source writes', async () => {
  const c = app(), f = fixture(c);
  const incomplete = { ...f.storage, getValueRaster: async id => id === 'first:ne' ? null : f.storage.getValueRaster(id) };
  const sections = await c.Stack3D.loadSections(f.entries.map(e => e.project), { storage: incomplete });
  assert.equal(sections.errors.length, 1);
  assert.equal(sections.errors[0].id, 'first');
  assert.deepEqual(plain(sections.map(s => s.zIndex)), [0, 1]);
  await assert.rejects(c.Stack3D.loadSections(f.entries.map(e => e.project), { storage: f.storage, signal: { aborted: true } }), /中止/);
});
