'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');

test('Master describes standalone pixel ratios without a missing group or batch and preserves profiles', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
      contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};'
    }));
    await page.goto(h.baseURL + '/__test_seed');
    await page.evaluate(async () => {
      await ProjectStorage.putFolder({ id: 'mouse-folder', name: 'Mouse', parentId: null });
      await ProjectStorage.putFolder({ id: 'series-folder', name: 'tissue_1set', parentId: 'mouse-folder' });
      const profile = { schemaVersion: 4, mode: 'pixel_ratio', id: 'mouse-d4', revision: 1,
        quality: 'provisional', scope: null, reference: null, calibration: null, section: null,
        mapping: { d4: 'd4' }, targets: ['ht', 'da', 'ne', 'gaba', 'histamine'].map(key => ({ key, method: 'pixel_ratio' })) };
      for (const [id, invalidated] of [['current', false], ['stale', true]]) {
        await ProjectStorage.putProject({ id, displayName: id, folderId: 'series-folder',
          grid: { W: 1, H: 1 }, molecules: [], images: {},
          atlas: { species: 'mouse', seriesId: 'mouse_tissue_1set', sectionNumber: id === 'current' ? 1 : 2 },
          normalization: { ...profile, ...(invalidated ? { invalidated: true } : {}) } });
      }
    });
    const before = await page.evaluate(() => ProjectStorage.listProjects());
    await page.goto(h.baseURL + '/index.html?series=mouse_tissue_1set');
    await page.locator('#project-list input.sel[value="current"]').waitFor();
    const current = await page.locator('#project-list > div').filter({ has: page.locator('input.sel[value="current"]') }).innerText();
    assert.match(current, /補正: 5-HT-d4画素比 \/ 5分子/);
    assert.match(current, /相対信号比（濃度換算なし）/);
    assert.match(current, /同一画素の内部標準を使用（フォルダー参照なし）/);
    assert.match(current, /HE位置合わせ: 対象画像なし/);
    assert.doesNotMatch(current, /undefined|このグループでは未設定|第2階層の対象外|未整合|— 暫定/);
    const stale = await page.locator('#project-list > div').filter({ has: page.locator('input.sel[value="stale"]') }).innerText();
    assert.match(stale, /再設定が必要/, 'actual invalidation must remain visible');
    assert.deepEqual(await page.evaluate(() => ProjectStorage.listProjects()), before, 'summary rendering must not alter profiles or raw project data');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
