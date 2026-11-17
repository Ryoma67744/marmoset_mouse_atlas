'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const XLSX = require('xlsx');
const JSZip = require('jszip');

function fixture() {
  const c = { console, XLSX, JSZip, Float32Array, Float64Array, Uint8Array, Blob };
  c.window = c;
  vm.createContext(c);
  for (const file of ['msi.js', 'normalization-scope.js', 'normalization.js', 'display-range.js', 'otsu.js', 'zipio.js', 'excelio.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), c, { filename: file });
  }
  // A 15-pixel row has six known two-pixel layers and three white-matter
  // pixels. The deliberately cumulative source polygons contain 15, 13,
  // 11, 9, 7, 5 and 3 pixels, so a union/fallback bug is unambiguous.
  const rectangle = first => [{ poly_msi: [[first - 0.5, -0.5], [14.5, -0.5], [14.5, 0.5], [first - 0.5, 0.5]] }];
  const roi = { roi_items: { whole: rectangle(0), wm: rectangle(12) },
    roi_names: { whole: 'Occipital lobe whole', wm: 'White matter' }, palette: {}, roi_show_flags: {} };
  for (let layer = 1; layer <= 5; layer++) {
    roi.roi_items['boundary' + layer] = rectangle(layer * 2);
    roi.roi_names['boundary' + layer] = 'Layer ' + layer;
  }
  const data = { h: Float32Array.from({ length: 15 }, (_, i) => i * 10), d: new Float32Array(15).fill(2) };
  const project = { id: 'cortical-example', displayName: 'Cor_2_2', grid: { W: 15, H: 1 }, images: {},
    molecules: [{ key: 'h', name: '5-HT', blobId: 'h' }, { key: 'd', name: 'd4-5-HT', blobId: 'd' }],
    roi, otsu: { applied: false }, valueDisplay: { mode: 'normalized' }, rotation: { all: 90 } };
  const rasters = Object.fromEntries(Object.entries(data).map(([key, values]) => [key, { W: 15, H: 1, values }]));
  project.normalization = c.Normalization.createPixelRatioProfile(project, rasters, {
    id: 'layer-profile', revision: 1, standardKey: 'd', targetKeys: ['h'],
    standardApplication: { method: 'uniform_spray', confirmed: true, source: 'test' },
  });
  let serial = 0;
  const storage = { getValueRaster: async key => data[key],
    putValueRaster: async values => { const key = 'restored-' + ++serial; data[key] = values; return key; },
    uid: prefix => 'restored-' + prefix,
    commitImportedProject: async restored => restored };
  return { c, project, data, storage };
}

function read(result) { return XLSX.read(Buffer.from(result.bytes), { type: 'buffer' }); }
function rows(book, name) { return XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: null }); }
function objects(book, name) { return XLSX.utils.sheet_to_json(book.Sheets[name], { defval: null }); }

test('real CSV and XLSX give each pixel one cortical layer and quantify those exact raw/normalized pixels', async () => {
  const { c, project, data, storage } = fixture();
  const original = JSON.stringify(project);
  const rawBits = Buffer.from(data.h.buffer).toString('hex');
  const table = await c.ZipIO.prepareProjectTable(project, { storage });
  const csv = c.ZipIO.projectTableToCsv(table).trim().split('\n').map(line => line.split(','));
  const book = read(await c.ExcelIO.buildProjectXlsx(project, { storage }));
  const raw = rows(book, 'Data'), normalized = rows(book, 'Normalized_Data');
  const summaries = objects(book, 'ROI_Quantification').filter(row => row['Molecule key'] === 'h');
  assert.equal(raw[0].filter(name => /^Layer [1-6]$/.test(name)).length, 6);
  assert.equal(summaries.length, 8, 'six layers, Whole and White matter; no cumulative duplicate rows');
  for (let x = 0; x < 15; x++) {
    let assigned = 0;
    for (let layer = 1; layer <= 6; layer++) {
      const name = 'Layer ' + layer;
      const expected = x >= (layer - 1) * 2 && x < layer * 2 ? 1 : 0;
      const actual = raw[x + 1][raw[0].indexOf(name)];
      assert.equal(actual, expected, `${name} at x=${x}`);
      assert.equal(normalized[x + 1][normalized[0].indexOf(name)], expected);
      assert.equal(csv[x + 1][csv[0].indexOf(name)], String(expected));
      assigned += actual;
    }
    assert.equal(assigned, x < 12 ? 1 : 0, 'layers are disjoint and exclude white matter');
    assert.equal(raw[x + 1][2], x * 10, 'raw signal is neither rescaled nor clipped');
    assert.equal(normalized[x + 1][2], x * 5);
  }
  for (let layer = 1; layer <= 6; layer++) {
    const row = summaries.find(row => row['ROI name'] === 'Layer ' + layer);
    assert.equal(row['Raw mean'], (layer - 1) * 20 + 5);
    assert.equal(row['Raw SD (population)'], 5);
    assert.equal(row['Raw n'], 2);
    assert.equal(row['Normalized mean'], ((layer - 1) * 20 + 5) / 2);
    assert.equal(row['Normalized n'], 2);
    assert.equal(row['Geometry pixels'], 2);
    assert.equal(row['Geometry status'], 'VALID');
    assert.equal(row['ROI kind'], 'cortical-layer');
    assert.equal(row['ROI rule version'], 'cortical-difference-v1');
    assert.ok(row['Source ROI keys']);
    assert.match(row['ROI definition'], /−/);
  }
  assert.equal(summaries.find(row => row['ROI name'] === 'White matter')['Raw mean'], 130);
  assert.equal(JSON.stringify(project), original, 'export must not migrate source ROIs or saved normalization');
  assert.equal(Buffer.from(data.h.buffer).toString('hex'), rawBits);
});

test('a missing boundary exports unavailable layer cells and reasons without cumulative fallback or zero filling', async () => {
  const { c, project, storage } = fixture();
  delete project.roi.roi_items.boundary2;
  delete project.roi.roi_names.boundary2;
  const result = await c.ExcelIO.buildProjectXlsx(project, { storage });
  const book = read(result), raw = rows(book, 'Data'), normalized = rows(book, 'Normalized_Data');
  const summaries = objects(book, 'ROI_Quantification').filter(row => row['Molecule key'] === 'h');
  for (const name of ['Layer 2', 'Layer 3']) {
    assert.ok(raw[0].includes(name), 'missing layers keep their columns');
    for (const row of raw.slice(1)) assert.equal(row[raw[0].indexOf(name)], null);
    for (const row of normalized.slice(1)) assert.equal(row[normalized[0].indexOf(name)], null);
    const row = summaries.find(row => row['ROI name'] === name);
    for (const field of ['Raw mean', 'Raw n', 'Normalized mean', 'Normalized n', 'Geometry pixels']) assert.equal(row[field], null);
    assert.equal(row['Status'], 'UNAVAILABLE');
    assert.equal(row['Geometry status'], 'UNAVAILABLE');
    assert.match(row['Reason codes'], /MISSING/);
    assert.ok(row['Reason']);
    assert.ok(result.warnings.some(warning => warning.includes(name)));
  }
  assert.equal(summaries.find(row => row['ROI name'] === 'Layer 4')['Raw mean'], 65, 'an independent complete layer remains measurable');
  const table = await c.ZipIO.prepareProjectTable(project, { storage });
  const csv = c.ZipIO.projectTableToCsv(table).trim().split('\n').map(line => line.split(','));
  for (const name of ['Layer 2', 'Layer 3']) {
    for (const row of csv.slice(1)) assert.equal(row[csv[0].indexOf(name)], '');
  }
});

test('restore ZIP records the analytical rule while preserving original ROI polygons and reproducing numeric exports', async () => {
  const { c, project, storage } = fixture();
  const before = read(await c.ExcelIO.buildProjectXlsx(project, { storage }));
  const blob = await c.ZipIO.exportProject(project, { storage });
  const archive = await JSZip.loadAsync(await blob.arrayBuffer());
  const manifest = JSON.parse(await archive.file('Cor_2_2.json').async('string'));
  assert.deepEqual(manifest.roi, JSON.parse(JSON.stringify(project.roi)));
  assert.equal(manifest.roiAnalysis.ruleVersion, 'cortical-difference-v1');
  assert.equal(manifest.roiAnalysis.layers.length, 6);
  assert.deepEqual(manifest.roiAnalysis.layers[0].outerKeys, ['whole']);
  assert.deepEqual(manifest.roiAnalysis.layers[0].innerKeys, ['boundary1']);
  assert.ok(manifest.roiAnalysis.layers.every(layer => layer.available));
  const restored = (await c.ZipIO.importZip(await blob.arrayBuffer(), { storage })).project;
  assert.deepEqual(JSON.parse(JSON.stringify(restored.roi)), JSON.parse(JSON.stringify(project.roi)));
  const after = read(await c.ExcelIO.buildProjectXlsx(restored, { storage }));
  for (const sheet of ['Data', 'Normalized_Data', 'ROI_Quantification']) {
    assert.deepEqual(rows(after, sheet), rows(before, sheet), sheet + ' must survive restoration exactly');
  }
});

test('ordinary same-name ROIs still export their union once, including overlap and real zero', async () => {
  const { c, project, storage } = fixture();
  const polygon = (first, last) => [{ poly_msi: [[first - 0.5, -0.5], [last + 0.5, -0.5], [last + 0.5, 0.5], [first - 0.5, 0.5]] }];
  project.roi = { roi_items: { left: polygon(0, 5), right: polygon(4, 9) },
    roi_names: { left: 'Region', right: ' Region ' } };
  const book = read(await c.ExcelIO.buildProjectXlsx(project, { storage }));
  const raw = rows(book, 'Data'), normalized = rows(book, 'Normalized_Data');
  assert.equal(raw[0].filter(name => name === 'Region').length, 1);
  assert.ok(!raw[0].some(name => /^Layer /.test(name)), 'no layer names means no automatically added layers');
  const row = objects(book, 'ROI_Quantification').find(row => row['Molecule key'] === 'h');
  assert.equal(row['Raw n'], 10, 'overlap is not counted twice');
  assert.equal(row['Raw mean'], 45);
  assert.equal(row['Normalized mean'], 22.5);
  assert.equal(raw[1][2], 0, 'measured zero remains a numeric signal');
  assert.equal(raw[1][raw[0].indexOf('Region')], 1);
  assert.equal(normalized[1][normalized[0].indexOf('Region')], 1);
  assert.equal(row['ROI kind'], 'normal');
  assert.equal(row['Source ROI keys'], 'left | right');
});
