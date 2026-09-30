'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

const IDS = Array.from({ length: 5 }, (_, index) => 'reliable-stack-' + index);

async function seed(h, { dirtyIds = [] } = {}) {
  for (const id of IDS) await seedViewerProject(h.page, h.baseURL, { id });
  await h.page.addScriptTag({ url: h.baseURL + '/lib/cloud.js' });
  const rows = await h.page.evaluate(async ({ ids, dirtyIds }) => {
    const rows = [];
    for (let index = 0; index < ids.length; index++) {
      const p = await ProjectStorage.getProject(ids[index]);
      p.displayName = 'Cor_8_' + (index + 1);
      p.grid = { W: 8, H: 8, umPerPxX: 100, umPerPxY: 150 };
      p.rotation = { all: 180, msi: 0, he: 0 };
      p.stack3d = { schemaVersion: 1, offsetXUm: 0, offsetYUm: [0, 500, -400, 450, 0][index], rotationDeg: [0, 5, -4, 3, 0][index] };
      p.valueDisplay = { mode: 'raw', scale: 'common' }; delete p.normalization;
      p.roi = { roi_items: {}, roi_names: {}, palette: {}, roi_show_flags: {} };
      for (const [j, [x, y]] of [[1, 1], [5, 1], [2, 5], [5, 5]].entries()) {
        const key = 'r' + j;
        p.roi.roi_names[key] = 'Region ' + j; p.roi.roi_show_flags[key] = true;
        p.roi.palette[key] = [80 + j * 40, 200, 255 - j * 40];
        p.roi.roi_items[key] = [{ poly_msi: [[x - .5, y - .5], [x + .5, y - .5], [x + .5, y + .5], [x - .5, y + .5]] }];
      }
      for (const molecule of p.molecules) {
        const values = Float32Array.from({ length: 64 }, (_, k) => molecule.key === 'MSI_D4-5-HT' ? 2 : 1 + k % 13);
        molecule.blobId = await ProjectStorage.putValueRaster(values); molecule.stats = MSIRaster.deriveBakeStats(values);
      }
      const state = structuredClone(Cloud.stateOf(p));
      const row = { id: p.id, display_name: p.displayName, updated_at: 'remote-1', bundle_path: p.id + '/synthetic.zip',
        bundle_rev: 1, state, meta: Cloud.metaOf(p) };
      Object.assign(p, { cloudBundlePath: row.bundle_path, cloudRev: row.bundle_rev, cloudUpdatedAt: row.updated_at,
        cloudStateHash: Cloud.hashState(state), cloudDisplayName: p.displayName, cloudPending: false });
      if (dirtyIds.includes(p.id)) p.stack3d.offsetXUm = 25;
      await ProjectStorage.putProject(p); rows.push(row);
    }
    return rows;
  }, { ids: IDS, dirtyIds });
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};'
  }));
  return rows;
}

async function open(h) {
  await h.page.goto(h.baseURL + '/stack3d/index.html?project=' + IDS[2]);
  await h.page.waitForFunction(() => window.__stack3dReady && Atlas3D.sections.length === 5);
  await h.page.locator('#placement-details').evaluate(element => { element.open = true; });
}

async function placements(page) {
  return page.evaluate(() => Atlas3D.sections.map(section => ({ id: section.id, offsetXUm: section.offsetXUm,
    offsetYUm: section.offsetYUm, rotationDeg: section.rotationDeg })));
}

async function adoptedBatch(page) {
  await page.locator('#batch-calculate').click();
  await page.waitForFunction(() => !document.getElementById('batch-result').hidden && !document.getElementById('batch-preview').disabled);
  await page.locator('#batch-preview').click();
  await page.waitForFunction(() => !document.getElementById('batch-adopt').disabled);
  await page.locator('#batch-adopt').click();
  await page.waitForFunction(() => !document.getElementById('batch-save').disabled);
}

async function configureTransport(page, rows, { concurrentId = null, failedId = null } = {}) {
  // Only the remote transport is replaced. The real ProjectSync.saveState,
  // IndexedDB transactions, controls, and storage notifications remain active.
  await page.evaluate(({ rows, concurrentId, failedId }) => {
    window.__remoteRows = Object.fromEntries(rows.map(row => [row.id, row]));
    window.__cloudCalls = []; window.__concurrentId = concurrentId; window.__failedId = failedId;
    window.Cloud = { ...Cloud, configured: () => true, signedIn: () => true,
      getProject: async id => structuredClone(window.__remoteRows[id]),
      listProjects: async () => Object.values(window.__remoteRows).map(row => structuredClone(row)),
      patchRowIfUnchanged: async (id, patch, expected) => {
        window.__cloudCalls.push(id);
        if (id === window.__failedId) throw new Error('Synthetic cloud failure');
        const row = window.__remoteRows[id]; if (row.updated_at !== expected) return null;
        Object.assign(row, structuredClone(patch), { updated_at: row.updated_at + '-saved' });
        if (id === window.__concurrentId) {
          window.__concurrentId = null;
          const current = await ProjectStorage.getProject(id);
          await ProjectStorage.patchProjectFields(id, { stack3d: { ...current.stack3d, offsetXUm: 1234 } });
        }
        return structuredClone(row);
      }
    };
    Atlas3D.selectSection(Atlas3D.selected);
  }, { rows, concurrentId, failedId });
}

async function warningNames(page) {
  return page.locator('#sync-details').evaluate(element => element.textContent.split('\n').filter(Boolean).map(line => line.split(':')[0]).sort());
}

test('adopted batch survives declined detail navigation, and leaving only discards after confirmation', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); await open(h);
    const stored = await page.evaluate(() => ProjectStorage.listProjects()), original = await placements(page);
    await adoptedBatch(page); const adopted = await placements(page);
    assert.notDeepEqual(adopted, original);
    const dirty = await page.locator('.dirty-dot').count(); assert.ok(dirty > 1);
    const dismiss = page.waitForEvent('dialog').then(async dialog => {
      assert.equal(dialog.type(), 'beforeunload'); await dialog.dismiss();
    });
    await page.locator('#open-section').click({ noWaitAfter: true }); await dismiss;
    assert.match(page.url(), /stack3d/);
    assert.deepEqual(await placements(page), adopted);
    assert.equal(await page.locator('.dirty-dot').count(), dirty);
    assert.equal(await page.locator('#batch-save').isEnabled(), true);
    assert.deepEqual(await page.evaluate(() => ProjectStorage.listProjects()), stored);
    const accept = page.waitForEvent('dialog').then(async dialog => { assert.equal(dialog.type(), 'beforeunload'); await dialog.accept(); });
    await page.locator('#open-section').click({ noWaitAfter: true }); await accept;
    await page.waitForURL('**/viewer/index.html?project=' + IDS[2] + '&from=stack3d');
    await open(h);
    assert.deepEqual(await placements(page), original);
    assert.deepEqual(await page.evaluate(() => ProjectStorage.listProjects()), stored);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('individual cloud save keeps unseen concurrent placement out of the render baseline and blocks stale writes', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    const rows = await seed(h, { dirtyIds: [IDS[2]] }); await open(h);
    await configureTransport(page, rows, { concurrentId: IDS[2] });
    const before = await page.evaluate(async id => ProjectStorage.getProject(id), IDS[2]);
    await page.locator('#save-cloud').click();
    await page.waitForFunction(() => Atlas3D.sourceChanged && /再読込/.test(document.getElementById('notice').textContent));
    const result = await page.evaluate(async () => {
      const section = Atlas3D.sections[Atlas3D.selected], stored = await ProjectStorage.getProject(section.id);
      return { shown: section.offsetXUm, baseline: section.project.stack3d.offsetXUm,
        stored, cloud: window.__remoteRows[section.id].state.stack3d.offsetXUm };
    });
    assert.equal(result.shown, 25); assert.equal(result.baseline, 25);
    assert.equal(result.stored.stack3d.offsetXUm, 1234); assert.equal(result.cloud, 25);
    await page.waitForFunction(() => document.getElementById('save-placement').disabled && document.getElementById('save-cloud').disabled);
    // Even a stale queued/programmatic click must not overwrite the newer pose.
    await page.locator('#save-placement').dispatchEvent('click');
    assert.equal(await page.evaluate(async id => (await ProjectStorage.getProject(id)).stack3d.offsetXUm, IDS[2]), 1234);
    await page.waitForFunction(() => !document.getElementById('sync-warning').hidden);
    assert.deepEqual(await warningNames(page), ['Cor_8_3']);
    for (const key of ['grid', 'molecules', 'roi', 'rotation', 'valueDisplay']) assert.deepEqual(result.stored[key], before[key]);
    await page.locator('#reload').click();
    await page.waitForFunction(() => window.__stack3dReady && !Atlas3D.sourceChanged && Atlas3D.sections[Atlas3D.selected].offsetXUm === 1234 && !document.getElementById('save-placement').disabled);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('successful individual cloud saves refresh only acknowledged warnings without reloading a draft or view', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    const rows = await seed(h, { dirtyIds: [IDS[0], IDS[2]] }); await open(h); await configureTransport(page, rows);
    // Saving the unchanged selected pose triggers the same local baseline badge
    // refresh used by real placement edits, without any cloud read/import.
    await page.locator('#save-placement').click();
    await page.waitForFunction(() => document.getElementById('sync-details').textContent.split('\n').filter(Boolean).length === 2);
    const view = await page.evaluate(() => Atlas3D.renderer.getView());
    await page.locator('#save-cloud').click();
    await page.waitForFunction(() => document.getElementById('notice').textContent === 'クラウドに保存しました。' && !document.getElementById('save-cloud').disabled);
    assert.deepEqual(await warningNames(page), ['Cor_8_1']);
    await page.evaluate(() => Atlas3D.selectSection(1));
    await page.locator('#offset-x').fill('77'); await page.locator('#offset-x').dispatchEvent('change');
    await page.locator('#offset-x').evaluate(element => element.blur());
    await page.evaluate(() => Atlas3D.selectSection(0));
    await page.locator('#save-cloud').click();
    await page.waitForFunction(() => document.getElementById('sync-warning').hidden && !document.getElementById('save-cloud').disabled);
    const after = await page.evaluate(() => ({ view: Atlas3D.renderer.getView(), draft: Atlas3D.sections[1].offsetXUm,
      dirty: document.querySelectorAll('.dirty-dot').length, selected: Atlas3D.selected }));
    assert.deepEqual(after.view, view); assert.equal(after.draft, 77); assert.equal(after.dirty, 1); assert.equal(after.selected, 0);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('partial batch cloud save removes successful warnings and retries only the unfinished slices', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    const rows = await seed(h); await open(h); await configureTransport(page, rows);
    await adoptedBatch(page); await page.locator('#batch-save').click();
    await page.waitForFunction(() => document.getElementById('batch-result').hidden && !document.getElementById('batch-cloud').hidden);
    await page.waitForFunction(() => !document.getElementById('sync-warning').hidden);
    const dirty = await warningNames(page); assert.ok(dirty.length > 1);
    const failedName = dirty[0], failedId = IDS[Number(failedName.split('_').at(-1)) - 1];
    await page.evaluate(id => { window.__failedId = id; }, failedId);
    await page.locator('#batch-cloud').click();
    await page.waitForFunction(() => !document.getElementById('batch-cloud').disabled && /未完了の1切片/.test(document.getElementById('batch-message').textContent));
    await page.waitForFunction(name => document.getElementById('sync-details').textContent.startsWith(name + ':') && document.getElementById('sync-details').textContent.split('\n').length === 1, failedName);
    assert.deepEqual(await warningNames(page), [failedName]);
    const firstCalls = await page.evaluate(() => [...window.__cloudCalls]); assert.equal(firstCalls.length, dirty.length);
    await page.evaluate(() => { window.__failedId = null; }); await page.locator('#batch-cloud').click();
    await page.waitForFunction(() => document.getElementById('batch-cloud').hidden && document.getElementById('sync-warning').hidden);
    assert.deepEqual(await page.evaluate(() => window.__cloudCalls), [...firstCalls, failedId]);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});


test('notifications from the completed reload do not stale its folder baseline, while later changes still notify', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    const rows = await seed(h); await open(h); await configureTransport(page, rows);
    await page.evaluate(() => {
      const ensureLocal = ProjectSync.ensureLocal;
      ProjectSync.ensureLocal = async function (...args) {
        const project = await ensureLocal.apply(this, args);
        if (!window.__folderImportedDuringReload) {
          window.__folderImportedDuringReload = true;
          await ProjectStorage.putFolder({ id: 'folder-from-sync', name: 'Synced folder', parentId: null });
        }
        return project;
      };
    });
    await page.locator('#reload').click();
    await page.waitForFunction(() => window.__stack3dReady && window.__folderImportedDuringReload);
    assert.equal(await page.evaluate(() => Atlas3D.sourceChanged), false);
    assert.equal(await page.locator('#notice').isVisible(), false);
    await page.evaluate(() => ProjectStorage.putFolder({ id: 'later-folder', name: 'Later folder edit', parentId: null }));
    await page.waitForFunction(() => Atlas3D.sourceChanged);
    assert.match(await page.locator('#notice').innerText(), /登録データが更新/);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});


test('a confirmed cloud write with unreadable local acknowledgement never rebases or unlocks an unseen pose', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    const rows = await seed(h, { dirtyIds: [IDS[2]] }); await open(h); await configureTransport(page, rows);
    const baseline = await page.evaluate(() => structuredClone(Atlas3D.sections[Atlas3D.selected].project));
    await page.evaluate(() => {
      const getProject = ProjectStorage.getProject, patchRemote = Cloud.patchRowIfUnchanged;
      ProjectStorage.getProject = async function (id) {
        if (window.__rejectPostCloudRead) {
          window.__rejectPostCloudRead = false;
          throw new Error('Synthetic local read failure after confirmed cloud write');
        }
        return getProject.call(this, id);
      };
      Cloud.patchRowIfUnchanged = async function (...args) {
        const row = await patchRemote.apply(this, args);
        const project = await getProject.call(ProjectStorage, args[0]);
        await ProjectStorage.patchProjectFields(project.id, { stack3d: { ...project.stack3d, offsetXUm: 888 } });
        window.__rejectPostCloudRead = true;
        return row;
      };
    });
    await page.locator('#save-cloud').click();
    await page.waitForFunction(() => Atlas3D.sourceChanged && document.getElementById('save-placement').disabled && /手元の保存状態を確認できなかった/.test(document.getElementById('notice').textContent));
    const after = await page.evaluate(async () => {
      const section = Atlas3D.sections[Atlas3D.selected];
      return { baseline: section.project, shown: section.offsetXUm, stored: (await ProjectStorage.getProject(section.id)).stack3d.offsetXUm,
        cloud: window.__remoteRows[section.id].state.stack3d.offsetXUm };
    });
    assert.deepEqual(after.baseline, baseline); assert.equal(after.shown, 25);
    assert.equal(after.stored, 888); assert.equal(after.cloud, 25);
    assert.equal(await page.locator('#save-cloud').isDisabled(), true);
    await page.locator('#save-placement').dispatchEvent('click');
    assert.equal(await page.evaluate(async id => (await ProjectStorage.getProject(id)).stack3d.offsetXUm, IDS[2]), 888);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
