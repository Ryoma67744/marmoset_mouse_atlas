'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');

test('species filtering hides project rows without hiding folder contents from deletion warnings', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
      contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};'
    }));
    await page.goto(h.baseURL + '/__test_seed');
    await page.evaluate(async () => {
      for (const folder of [
        { id: 'shared', name: 'Shared', parentId: null },
        { id: 'legacy-only', name: 'Marmoset only', parentId: null },
      ]) await ProjectStorage.putFolder(folder);
      for (const project of [
        { id: 'legacy-shared', displayName: 'Cor_1_1', folderId: 'shared' },
        { id: 'legacy-only', displayName: 'Cor_1_2', folderId: 'legacy-only' },
        { id: 'mouse', displayName: 'Mouse 1', folderId: 'shared',
          atlas: { species: 'mouse', seriesId: 'mouse_tissue_1set', sectionNumber: 1 } },
      ]) await ProjectStorage.putProject({ ...project, grid: { W: 1, H: 1 }, molecules: [], images: {} });
    });
    const before = await page.evaluate(async () => ({
      projects: await ProjectStorage.listProjects(), folders: await ProjectStorage.listFolders()
    }));
    await page.goto(h.baseURL + '/index.html?series=mouse_tissue_1set');
    await page.locator('#project-list input.sel[value="mouse"]').waitFor();
    assert.deepEqual(await page.locator('#project-list input.sel').evaluateAll(nodes => nodes.map(node => node.value)), ['mouse']);
    await page.locator('.tree-node[title="すべて"]').click();
    const shared = page.locator('#project-list > div').filter({ has: page.locator('[data-act="enter"]', { hasText: 'Shared' }) });
    const legacy = page.locator('#project-list > div').filter({ has: page.locator('[data-act="enter"]', { hasText: 'Marmoset only' }) });
    assert.match(await shared.innerText(), /2 件/);
    assert.match(await legacy.innerText(), /1 件/);
    for (const [row, count] of [[shared, 2], [legacy, 1]]) {
      const dialogSeen = page.waitForEvent('dialog');
      const click = row.locator('[data-act="delete"]').click();
      const dialog = await dialogSeen;
      assert.ok(dialog.message().includes(`中身 (${count} 件)`), dialog.message());
      await dialog.dismiss();
      await click;
    }
    await legacy.locator('[data-act="enter"]').click();
    assert.match(await page.locator('#project-list').innerText(), /選択したAtlasのデータがありません/);
    assert.doesNotMatch(await page.locator('#project-list').innerText(), /このフォルダは空/);
    const after = await page.evaluate(async () => ({
      projects: await ProjectStorage.listProjects(), folders: await ProjectStorage.listFolders()
    }));
    assert.deepEqual(after, before, 'filtering and dismissing folder deletion cannot change any project or folder');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
