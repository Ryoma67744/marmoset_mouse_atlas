'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const XLSX = require('xlsx');

function app() {
  const context = {XLSX, Float32Array, Uint8Array, console};
  context.window = context;
  vm.createContext(context);
  for (const name of ['ingest.js','msi.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../lib',name),'utf8'),context,{filename:name});
  return context;
}
function assertMissingRaster(c, rows) {
  const raster = c.MSIRaster.rasterFromRows(rows);
  assert.deepEqual(Array.from(raster.xs), [0,1,2]);
  assert.deepEqual(Array.from(raster.ys), [0,1]);
  assert.deepEqual(Array.from(raster.values), [0,NaN,NaN,NaN,5.25,NaN]);
  assert.equal(c.MSIRaster.deriveBakeStats(raster.values).n, 2, 'blank pixels must not count as measured signal');
}

test('CSV and TSV preserve missing edge coordinates, reject empty coordinates, and keep measured zero', () => {
  const c = app();
  const records = [
    ['x','y','v'],['0','0','0'],['1','0',''],['2','0',' N/A '],
    ['0','1','NaN'],['1','1','5.25'],['2','1','   '],
    ['',2,42],[3,'',42],[' NA ',3,42],['false',3,42],
  ];
  for (const sep of [',','\t']) {
    const rows = c.Ingest.rowsFromText(records.map(r=>r.join(sep)).join('\n')).rows;
    assert.equal(rows.length, 6);
    assertMissingRaster(c,rows);
  }
});

test('CSV quoted blank and N/A stay missing while quoted zero remains zero', () => {
  const c = app();
  const rows = c.Ingest.rowsFromText('x,y,v,note\n0,0,"0","has,comma"\n1,0,"",blank\n2,0," N/A ",missing\n0,1,NULL,missing\n1,1,"5.25",value\n2,1,"   ",blank').rows;
  assertMissingRaster(c,rows);
});

test('real SheetJS workbook roundtrip treats blanks as missing for values and coordinates', () => {
  const c = app();
  assert.equal(XLSX.version, '0.18.5');
  const sheet = XLSX.utils.aoa_to_sheet([
    ['x','y','value'],[0,0,0],[1,0,''],[2,0,' N/A '],[0,1,null],[1,1,5.25],[2,1,'   '],
    [null,2,42],[3,null,42],[false,3,42],[4,4,true]
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,sheet,'Data');
  const bytes = XLSX.write(workbook,{bookType:'xlsx',type:'array'});
  const parsed = c.Ingest.workbookFromArrayBuffer(bytes);
  const rows = c.Ingest.rowsFromWorkbook(parsed,{sheet:'Data',col_x:'A',col_y:'B',col_v:'C',data_start_row:2});
  // A boolean value with valid coordinates is missing signal, not measured 1.
  const booleanRow = rows.find(r=>r.x===4);
  assert.ok(Number.isNaN(booleanRow.v));
  assertMissingRaster(c,rows.filter(r=>r.x!==4));
});

test('Analyte and whitespace TXT retain missing terminal pixels without shifting measured coordinates', () => {
  const c = app();
  for (const raw of [
    'x y v\n0 0 0\n1 0 NA\n2 0 N/A\n0 1 NaN\n1 1 5.25\n2 1',
    'Analyte (converted from imzML)\nwindows: 100-200\n150\n151\n0 0 0 0\n1 1 0 NA\n2 2 0 N/A\n3 0 1 NaN\n4 1 1 5.25\n5 2 1'
  ]) assertMissingRaster(c,c.Ingest.rowsFromText(raw).rows);
});

test('missing duplicate observations neither dilute nor poison finite duplicate intensities', () => {
  const c = app();
  const rows = c.Ingest.rowsFromText('x,y,v\n0,0,\n0,0,0\n0,0,NA\n0,0,2\n1,0,\n2,0,-0').rows;
  const raster = c.MSIRaster.rasterFromRows(rows);
  assert.deepEqual(Array.from(raster.values),[1,NaN,-0]);
  assert.equal(new Uint32Array(raster.values.buffer)[2], 0x80000000, 'a finite negative zero is not changed');
});
