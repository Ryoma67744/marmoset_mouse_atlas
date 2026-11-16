'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const comparison = path.join(__dirname, '../comparison');

function assertNoSavedRoi(value, location) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['nativePolygons', 'poly_msi', 'roi_items', 'roi_names', 'sourceJsonSha256'].includes(key),
      location + ' must not bundle saved user ROI data: ' + key);
    assertNoSavedRoi(child, location + '.' + key);
  }
}

test('public comparison HTML contains no embedded MSI images or saved ROI geometry', () => {
  const html = fs.readFileSync(path.join(comparison, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /data:image\/(?:png|jpe?g|webp|gif);base64,/i,
    'MSI thumbnail bytes must remain in the user browser, not the public HTML');
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\btype=["']application\/json["']/i.test(match[1])) continue;
    const data = JSON.parse(match[2]);
    assertNoSavedRoi(data, 'HTML JSON');
    if (/\bid=["']mx-image-data["']/i.test(match[1])) assert.deepEqual(data, {}, 'no saved MSI thumbnail map');
    if (/\bid=["']mx-roi-data["']/i.test(match[1])) {
      assert.deepEqual(data.sections || {}, {}, 'no saved user ROI sections');
    }
  }
  assert.ok(!fs.readdirSync(comparison).some(name => /\.(?:png|jpe?g|webp|gif|csv|zip)$/i.test(name)),
    'do not accidentally copy MSI export files into the publicly deployed directory');
});

test('compressed comparison bootstrap contains only public ST and gene annotation data', () => {
  const source = fs.readFileSync(path.join(comparison, 'bootstrap.js'), 'utf8');
  const match = source.match(/window\.MARMOSET_BOOTSTRAP\s*=\s*("[^"\r\n]+")/);
  assert.ok(match, 'a reviewable compressed bootstrap assignment is present');
  const payload = JSON.parse(zlib.gunzipSync(Buffer.from(JSON.parse(match[1]), 'base64')).toString('utf8'));
  assert.equal(Object.hasOwn(payload, 'msiValues'), false, 'user MSI values must be read from ProjectStorage');
  const publicKeys = new Set(['provenance', 'genes', 'sections', 'catalogs', 'annotations', 'curated', 'goJapanese']);
  assert.ok(Object.keys(payload).every(key => publicKeys.has(key)), 'new bundled data categories need explicit public-data review');
  assert.equal(payload.sections.length, 6);
  assert.ok(payload.sections.every(section => /^T\d+$/.test(section.id)), 'bundled sections are public ST datasets only');
  assertNoSavedRoi(payload, 'bootstrap');
});
