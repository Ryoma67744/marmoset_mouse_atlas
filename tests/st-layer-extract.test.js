'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const XLSX = require('xlsx');
const { create } = require('../comparison/layer-data.js');
const { buildWorkbook, buildCsv } = require('../comparison/layer-extract.js');

function selection(layers) {
  const groups = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'V1'];
  const genes = ['HTR2A', 'gene,"quoted"', 'ZERO'];
  const manifest = {
    format: 'marmoset-layer-summary-v1', section: 'T503', genes, nBins: 15, groups,
    counts: [2, 2, 2, 3, 3, 3, 8], scope: 'T503 cortex', normalization: 'per-bin CP10k including zeros',
    sourceUrl: 'https://example.org/T503.h5ad', sourceSha256: 'test_source', dataSha256: 'test_summary',
  };
  const n = groups.length * genes.length;
  const bytes = Buffer.alloc(10 * n);
  const cell = groups.indexOf('L4');
  bytes.writeDoubleLE(1.125000000012345, 8 * cell);
  bytes.writeUInt16LE(2, 8 * n + 2 * cell);
  return { data: create(manifest, bytes), section: manifest.section, layers,
    msiSection: 'Cor_2_3', molecule: '5-HT', msiRows: [
      { region: 'L4', median: 0, measuredPixels: 6, geometryPixels: 8, missingPixels: 2, status: 'ok', roiId: 'saved' },
      { region: 'L5', median: null, status: 'missing_roi', reason: 'missing boundary' },
    ] };
}

const fields = ['gene', 'mean_cp10k', 'detected_bins', 'total_bins', 'detection_pct'];

test('selected layer CSV keeps full-precision values, zero rows, IDs, quoting and a UTF-8 BOM', async () => {
  const bytes = Buffer.from(await buildCsv(selection(['L4'])).arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const rows = bytes.subarray(3).toString('utf8').trimEnd().split('\r\n');
  assert.equal(rows[0], ['st_section', 'layer', ...fields].join(','));
  assert.equal(rows[1], 'T503,L4,HTR2A,1.125000000012345,2,3,' + 100 * 2 / 3);
  assert.equal(rows[2], 'T503,L4,"gene,""quoted""",0,0,3,0');
  assert.equal(rows[3], 'T503,L4,ZERO,0,0,3,0');
  assert.equal(rows.length, 4);
});

test('all layers export separately, with native denominators, provenance and missing MSI values', async t => {
  const c = selection(['L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
  const lines = (await buildCsv(c).text()).trimEnd().split('\r\n');
  assert.equal(lines.length, 1 + 6 * 3);
  assert.deepEqual(lines.slice(1).map(l => l.split(',')[1]), c.layers.flatMap(l => Array(3).fill(l)));
  const previous = globalThis.XLSX;
  globalThis.XLSX = XLSX;
  t.after(() => { if (previous === undefined) delete globalThis.XLSX; else globalThis.XLSX = previous; });
  const book = XLSX.read(buildWorkbook(c), { type: 'array' });
  assert.deepEqual(book.SheetNames, [...c.layers, 'Metadata', 'MSI_ROI']);
  const read = name => XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: null });
  assert.deepEqual(read('L4')[0], fields);
  assert.deepEqual(read('L4')[1], ['HTR2A', 1.125000000012345, 2, 3, 100 * 2 / 3]);
  assert.deepEqual(read('L1')[1], ['HTR2A', 0, 0, 2, 0]);
  assert.equal(read('L4').length, c.data.genes.length + 1);
  const meta = Object.fromEntries(read('Metadata').slice(1));
  assert.equal(meta.source_sha256, 'test_source');
  assert.equal(meta.normalization, c.data.meta.normalization);
  const msi = XLSX.utils.sheet_to_json(book.Sheets.MSI_ROI, { defval: null });
  assert.equal(msi.find(r => r.layer === 'L4').median_au, 0);
  assert.equal(msi.find(r => r.layer === 'L5').median_au, null);
  assert.equal(msi.find(r => r.layer === 'L5').status, 'missing_roi');
});

test('selection validates section and layer identity before export', () => {
  assert.throws(() => buildCsv(selection(['V1'])), /皮質層/);
  assert.throws(() => buildCsv(selection(['L1', 'L1'])), /皮質層/);
  assert.throws(() => buildCsv({ ...selection(['L1']), section: 'T420' }), /切片/);
});
