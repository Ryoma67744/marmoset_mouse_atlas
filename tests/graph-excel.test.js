'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const XLSX = require('xlsx');
const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'excelio.js'), 'utf8');

function writer(rowLimit) {
  const window = { XLSX, APP_VERSION: 'test-version' };
  vm.runInNewContext(rowLimit ? source.replace('const EXCEL_MAX_ROWS = 1048576;', 'const EXCEL_MAX_ROWS = ' + rowLimit + ';') : source, { window });
  return window.ExcelIO.buildGraphStatsXlsx;
}

function open(result) {
  return XLSX.read(Buffer.from(result.bytes), { type: 'buffer' });
}

function cell(sheet, header, row) {
  const headers = XLSX.utils.sheet_to_json(sheet, { header: 1 })[0];
  const col = headers.indexOf(header);
  assert.ok(col >= 0, header);
  return sheet[XLSX.utils.encode_cell({ r: row, c: col })];
}

test('graph Excel round-trip preserves numeric precision, zero, negative values and independent SD/units', () => {
  const input = Object.freeze({
    roiName: '=ROI(1)', moleculeName: '+5-HT', sectionName: '001', roiKey: '0007', channelKey: 'MSI_1', sectionId: '0001',
    median: 0, mean: 1.23456789012345, sd: 3.45678901234567, q1: -2.25, q3: 4.5,
    min: -10, p99: 90.125, max: 100, n: 7, nValid: 7, nMeasured: 9, nGeometry: 12,
    targetSections: 1, roiSections: 1, includedSections: 1, order: 2,
    valueMode: 'raw', unit: 'a.u.', mode: 'selected', sortOrder: 'mean', status: 'VALID', reason: '',
  });
  const result = writer()({ rows: Object.freeze([input]), metadata: { source: '2D', projectId: '0001', count: 7, stale: false } }, { exportedAt: '2026-10-28T00:00:00.000Z' });
  assert.equal(result.rowCount, 1);
  assert.equal(result.exportedAt, '2026-10-28T00:00:00.000Z');
  const book = open(result), sheet = book.Sheets.Statistics;
  assert.deepEqual(book.SheetNames, ['Statistics', 'Conditions']);
  for (const [header, expected] of Object.entries({
    '中央値': 0, '平均値': input.mean, '標準偏差': input.sd, '第1四分位数': -2.25, '第3四分位数': 4.5,
    '最小値': -10, 'P99': 90.125, '最大値': 100, '集計画素数': 7, '有効画素数': 7,
    '測定画素数': 9, 'ROI画素数': 12, '対象切片数': 1, 'ROI存在切片数': 1, '採用切片数': 1, '表示順': 2,
  })) {
    const value = cell(sheet, header, 1);
    assert.equal(value.t, 'n', header + ' must be an Excel number');
    assert.equal(value.v, expected, header + ' must retain original precision');
    assert.equal(value.f, undefined);
  }
  for (const [header, expected] of Object.entries({ 'ROI名': '=ROI(1)', '分子名': '+5-HT', '切片名': '001', 'ROIキー': '0007', '切片ID': '0001', '単位': 'a.u.' })) {
    const value = cell(sheet, header, 1);
    assert.equal(value.t, 's');
    assert.equal(value.v, expected);
    assert.equal(value.f, undefined, 'names must not become formulas');
  }
  assert.ok(sheet['!autofilter']);
  const metadata = Object.fromEntries(XLSX.utils.sheet_to_json(book.Sheets.Conditions, { header: 1 }).slice(1));
  assert.equal(metadata['アプリバージョン'], 'test-version');
  assert.equal(metadata.projectId, '0001');
  assert.equal(metadata.count, 7);
  assert.equal(metadata.stale, false);
});

test('graph Excel leaves unavailable numeric statistics blank without converting strings or zero-filling', () => {
  const values = [null, undefined, NaN, Infinity, -Infinity, '1.5 ± 0.2', '0', '12%', '—'];
  const rows = values.map((value, index) => ({ roiName: 'ROI ' + index, mean: value, median: value, sd: value, n: 0, status: 'UNAVAILABLE', reason: '欠測', order: index + 1 }));
  const sheet = open(writer()({ rows })).Sheets.Statistics;
  values.forEach((_, index) => {
    for (const header of ['平均値', '中央値', '標準偏差']) assert.equal(cell(sheet, header, index + 1), undefined);
    assert.equal(cell(sheet, '集計画素数', index + 1).v, 0);
    assert.equal(cell(sheet, '状態', index + 1).v, 'UNAVAILABLE');
    assert.equal(cell(sheet, '理由', index + 1).v, '欠測');
    assert.equal(cell(sheet, '表示順', index + 1).v, index + 1, 'keep caller order, including unavailable rows');
  });
});

test('graph Excel splits statistics and section provenance at the worksheet row limit', () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ roiName: 'ROI ' + index, mean: index / 3, roiKey: 'roi-' + index }));
  const sections = rows.map((row, index) => ({ sectionId: '00' + index, sectionName: '=section' + index, roiKey: row.roiKey, channelKey: 'MSI_1', status: index ? 'EXCLUDED' : 'INCLUDED', reason: index ? 'ROI_MISSING' : '' }));
  const book = open(writer(3)({ rows, sections }));
  assert.deepEqual(book.SheetNames, ['Statistics_001', 'Statistics_002', 'Statistics_003', 'Conditions', 'Sections_001', 'Sections_002', 'Sections_003']);
  const data = book.SheetNames.filter(name => name.startsWith('Statistics')).flatMap(name => XLSX.utils.sheet_to_json(book.Sheets[name]));
  assert.deepEqual(data.map(row => row['ROI名']), rows.map(row => row.roiName));
  assert.deepEqual(data.map(row => row['平均値']), rows.map(row => row.mean));
  const memberships = book.SheetNames.filter(name => name.startsWith('Sections')).flatMap(name => XLSX.utils.sheet_to_json(book.Sheets[name]));
  assert.deepEqual(memberships.map(row => row['切片ID']), sections.map(row => row.sectionId));
  assert.equal(memberships[1]['理由'], 'ROI_MISSING');
  assert.equal(book.Sheets.Sections_001.B2.t, 's');
  assert.equal(book.Sheets.Sections_001.B2.f, undefined);
});

test('graph Excel rejects absent results and reports a missing XLSX dependency clearly', () => {
  assert.throws(() => writer()({ rows: [] }), /出力できるグラフ/);
  assert.throws(() => writer()(null), /出力できるグラフ/);
  const window = {};
  vm.runInNewContext(source, { window });
  assert.throws(() => window.ExcelIO.buildGraphStatsXlsx({ rows: [{}] }), /SheetJS/);
});
