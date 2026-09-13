'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

// Exercise the real Master saveCloud adapter, profile UI, IndexedDB, state
// serializers, and ProjectSync CAS. Only cloud transport and ZIP byte building
// are synthetic; real ZIP round-trips are covered by export integration tests.
async function fixture(h, failStateOnce = false, absentStandard = false) {
  const source = await fs.readFile(path.join(__dirname, '../lib/cloud.js'), 'utf8');
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};'
  }));
  await h.context.route(h.baseURL + '/lib/cloud.js', route => route.fulfill({
    contentType: 'application/javascript', body: source + `
    (() => {
      const read = (key, fallback = {}) => JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
      const write = (key, value) => localStorage.setItem(key, JSON.stringify(value));
      const log = entry => { const calls = read('simple-master-calls', []); calls.push(entry); write('simple-master-calls', calls); };
      Cloud.configured = () => true;
      Cloud.signedIn = () => true;
      Cloud.listProjects = async () => Object.values(read('simple-master-remote'));
      Cloud.getProject = async id => read('simple-master-remote')[id] || null;
      Cloud.patchRowIfUnchanged = async (id, patch, expected) => {
        const rows = read('simple-master-remote'), row = rows[id];
        log({ kind: 'patch', id, expected, actual: row && row.updated_at, keys: Object.keys(patch) });
        if (!row || row.updated_at !== expected) return null;
        if (id === 'simple-master-b' && patch.state && localStorage.getItem('simple-master-fail-once') === 'yes') {
          localStorage.removeItem('simple-master-fail-once');
          throw new Error('Synthetic transport failure for the second saved profile');
        }
        Object.assign(row, structuredClone(patch));
        row.updated_at = new Date(Date.parse(row.updated_at) + 1000).toISOString();
        write('simple-master-remote', rows);
        if (id === 'simple-master-b' && patch.state && window.__holdSimpleStateAcknowledgement) {
          window.__simpleStatePublished = true;
          await new Promise(resolve => { window.__releaseSimpleStateAcknowledgement = resolve; });
        }
        return structuredClone(row);
      };
      Cloud.bundlePath = (id, revision) => 'synthetic/' + id + '/v' + revision + '.zip';
      Cloud.uploadBundle = async (bundlePath, blob, progress) => {
        log({ kind: 'upload', path: bundlePath, size: blob.size });
        if (progress) progress(1);
      };
      Cloud.removeBundle = async bundlePath => log({ kind: 'remove', path: bundlePath });
      Cloud.downloadBundle = async () => { throw new Error('This operation must preserve the current local raw data'); };
      Cloud.patchRow = async () => { throw new Error('Unconditional cloud writes are forbidden'); };
      Cloud.insertRowIfAbsent = async () => { throw new Error('Both fixtures already have cloud rows'); };
    })();`
  }));
  for (const id of ['simple-master-a', 'simple-master-b']) await seedViewerProject(h.page, h.baseURL, { id });
  await h.page.addScriptTag({ url: h.baseURL + '/lib/cloud.js' });
  const before = await h.page.evaluate(async ({ failStateOnce, absentStandard }) => {
    await ProjectStorage.putFolder({ id: 'species', name: 'Marmoset', parentId: null });
    await ProjectStorage.putFolder({ id: 'coronal', name: 'Coronal', parentId: 'species', normalizationGroupId: 'simple-master-group' });
    sessionStorage.setItem('marmoset:currentFolder', 'coronal');
    const remote = {}, bits = {};
    for (const p of await ProjectStorage.listProjects()) {
      p.displayName = p.id; p.folderId = 'coronal'; p.normalization = null;
      p.normalizationBinding = { groupId: 'simple-master-group', folderPath: ['Marmoset', 'Coronal'], memberId: p.id };
      p.valueDisplay = { mode: 'raw', scale: 'common' }; p.otsu = { applied: false, sourceKeys: [] };
      if (p.id === 'simple-master-b') {
        const standard = p.molecules.find(m => m.key === 'MSI_D4-5-HT');
        standard.blobId = await ProjectStorage.putValueRaster(new Float32Array(8).fill(4));
        if (absentStandard) p.molecules = p.molecules.filter(m => m !== standard);
      }
      const values = new Float32Array([0, 2, NaN, 4, 6, 8, 10, 12]);
      p.molecules.push({ key: 'MSI_Glutamate', name: 'Glutamate', blobId: await ProjectStorage.putValueRaster(values), stats: MSIRaster.deriveBakeStats(values) });
      p.cloudUpdatedAt = '2026-01-01T00:00:00.000Z'; p.cloudRev = 1;
      p.cloudBundlePath = 'synthetic/' + p.id + '/original.zip'; p.cloudDisplayName = p.displayName;
      p.cloudStateHash = Cloud.hashState(Cloud.stateOf(p)); p.cloudPending = p.id === 'simple-master-a';
      await ProjectStorage.putProject(p);
      remote[p.id] = { id: p.id, display_name: p.displayName, folder_path: ['Marmoset', 'Coronal'],
        meta: Cloud.metaOf(p), state: Cloud.stateOf(p), updated_at: p.cloudUpdatedAt,
        bundle_path: p.cloudBundlePath, bundle_rev: p.cloudRev };
      for (const m of p.molecules) {
        const raster = await ProjectStorage.getValueRaster(m.blobId);
        bits[p.id + ':' + m.key] = Array.from(new Uint32Array(raster.buffer, raster.byteOffset, raster.length));
      }
    }
    localStorage.setItem('simple-master-remote', JSON.stringify(remote));
    if (failStateOnce) localStorage.setItem('simple-master-fail-once', 'yes');
    return { bits, remote };
  }, { failStateOnce, absentStandard });
  await h.page.goto(h.baseURL + '/');
  await h.page.waitForFunction(() => document.querySelectorAll('#project-list input.sel').length === 2);
  await h.page.evaluate(() => { ZipIO.exportProject = async () => new Blob(['synthetic raw replacement bundle']); });
  await h.page.locator('#normalization-settings').click();
  await h.page.locator('#normalization-simple-form').waitFor();
  assert.match(await h.page.locator('#normalization-destination').innerText(), /クラウド（自動同期）/);
  assert.equal(await h.page.locator('[data-simple-project]').count(), 2);
  return before;
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const projects = {}, bits = {}, derived = {};
    for (const p of await ProjectStorage.listProjects()) {
      projects[p.id] = p;
      const rasters = await Normalization.loadRasters(p, { storage: ProjectStorage });
      for (const m of p.molecules) {
        const values = rasters[m.key].values;
        bits[p.id + ':' + m.key] = Array.from(new Uint32Array(values.buffer, values.byteOffset, values.length));
      }
      const ev = Normalization.evaluate(p, rasters);
      derived[p.id] = ev.channels.MSI_Glutamate.values ? Array.from(ev.channels.MSI_Glutamate.values) : null;
    }
    return { projects, bits, derived, remote: JSON.parse(localStorage.getItem('simple-master-remote')),
      calls: JSON.parse(localStorage.getItem('simple-master-calls') || '[]') };
  });
}

async function waitSaved(page, count) {
  await page.waitForFunction(count => {
    const text = document.getElementById('normalization-status').textContent;
    return /2 件をこの PC に保存しました/.test(text) && text.includes('クラウド同期 ' + count + '/2 件') &&
      !document.getElementById('normalization-close').disabled;
  }, count);
}

function assertSaved(result, before) {
  assert.deepEqual(result.bits, before.bits);
  const first = result.projects['simple-master-a'], second = result.projects['simple-master-b'];
  assert.equal(first.normalization.schemaVersion, 3); assert.equal(second.normalization.schemaVersion, 3);
  assert.equal(first.normalization.id, second.normalization.id);
  assert.equal(first.normalization.revision, 1); assert.equal(second.normalization.revision, 1);
  assert.equal(first.normalization.section.k, 1.5); assert.equal(second.normalization.section.k, 0.75);
  assert.deepEqual(result.derived['simple-master-a'], [0, 3, NaN, 6, 9, 12, 15, 18]);
  assert.deepEqual(result.derived['simple-master-b'], [0, 1.5, NaN, 3, 4.5, 6, 7.5, 9]);
  for (const p of [first, second]) {
    assert.equal(p.cloudPending, false);
    assert.deepEqual(result.remote[p.id].state.normalization, p.normalization);
    assert.equal(result.remote[p.id].updated_at, p.cloudUpdatedAt);
    assert.equal(p.normalization.targets.find(t => t.key === 'MSI_Glutamate').method, 'section_scale');
  }
  assert.equal(first.cloudRev, 2, 'pending raw data uses the full bundle adapter');
  assert.notEqual(first.cloudBundlePath, before.remote[first.id].bundle_path);
  assert.equal(second.cloudRev, 1, 'an uploaded raw bundle requires only a state patch');
  assert.equal(second.cloudBundlePath, before.remote[second.id].bundle_path);
  assert.equal(result.calls.filter(call => call.kind === 'upload').length, 1);
  assert.ok(result.calls.find(call => call.kind === 'patch' && call.id === first.id && call.keys.includes('bundle_path')));
  const stateOnly = result.calls.filter(call => call.kind === 'patch' && call.id === second.id);
  assert.ok(stateOnly.length > 0 && stateOnly.every(call => !call.keys.includes('bundle_path')));
  assert.ok(result.calls.filter(call => call.kind === 'patch').every(call => call.expected === call.actual));
  assert.equal(result.calls.some(call => call.kind === 'remove'), false);
}

test('actual Master simple apply uploads pending raw data and state-only settings in one folder action', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), dialogs = [];
  h.page.on('dialog', dialog => { dialogs.push(dialog.message()); return dialog.dismiss(); });
  try {
    const before = await fixture(h);
    if (process.env.ATLAS_TEST_SIMPLE_SCREENSHOT) await h.page.screenshot({ path: process.env.ATLAS_TEST_SIMPLE_SCREENSHOT });
    await h.page.locator('#normalization-simple-apply').click();
    await waitSaved(h.page, 2);
    const after = await snapshot(h.page);
    assertSaved(after, before);
    assert.equal(after.calls.filter(call => call.kind === 'patch').length, 2);
    assert.deepEqual(dialogs, []); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('actual Master saves absent-standard skip records with active members and retries only their failed cloud write', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), dialogs = [];
  h.page.on('dialog', dialog => { dialogs.push(dialog.message()); return dialog.dismiss(); });
  try {
    const before = await fixture(h, true, true);
    await h.page.locator('#normalization-simple-apply').click();
    await waitSaved(h.page, 1);
    const partial = await snapshot(h.page);
    const active = partial.projects['simple-master-a'], skipped = partial.projects['simple-master-b'];
    assert.deepEqual(partial.bits, before.bits);
    assert.equal(active.normalization.id, skipped.normalization.id);
    assert.equal(active.normalization.revision, 1);
    assert.equal(skipped.normalization.revision, 1);
    assert.equal(active.valueDisplay.mode, 'normalized');
    assert.equal(skipped.valueDisplay.mode, 'raw');
    assert.deepEqual(skipped.normalization.application, { status: 'skipped', reasonCode: 'INTERNAL_STANDARD_MISSING' });
    assert.equal(active.normalization.application, undefined, 'existing active profile shape is retained');
    for (const p of [active, skipped]) {
      assert.deepEqual(p.normalization.scope.memberIds, ['simple-master-a', 'simple-master-b']);
      assert.deepEqual(p.normalization.reference.projectIds, ['simple-master-a']);
      assert.deepEqual(p.normalization.reference.entries.map(entry => entry.memberId), ['simple-master-a']);
    }
    assert.equal(active.normalization.section.Dref, 2);
    assert.equal(active.normalization.section.k, 1);
    assert.equal(skipped.normalization.section.Ds, null);
    assert.equal(skipped.normalization.section.Dref, null);
    assert.equal(skipped.normalization.section.k, null);
    assert.deepEqual(skipped.normalization.targets, []);
    assert.deepEqual(partial.derived['simple-master-a'], [0, 2, NaN, 4, 6, 8, 10, 12]);
    assert.equal(partial.derived['simple-master-b'], null);
    assert.equal(partial.remote['simple-master-b'].state.normalization, null);
    assert.match(await h.page.locator('#normalization-status').innerText(), /スキップ|未補正/);
    await h.page.locator('#normalization-simple-cloud').click();
    await waitSaved(h.page, 2);
    const after = await snapshot(h.page);
    assert.deepEqual(after.bits, before.bits);
    for (const id of ['simple-master-a', 'simple-master-b']) {
      const p = after.projects[id];
      assert.deepEqual(p.normalization, partial.projects[id].normalization);
      assert.deepEqual(after.remote[id].state.normalization, p.normalization);
      assert.equal(after.remote[id].state.valueDisplay.mode, p.valueDisplay.mode);
      assert.equal(after.remote[id].updated_at, p.cloudUpdatedAt);
    }
    assert.deepEqual(after.remote['simple-master-b'].meta.normalization.application, skipped.normalization.application);
    assert.equal(after.remote['simple-master-b'].meta.normalization.status, 'SKIPPED');
    assert.equal(after.remote['simple-master-a'].meta.normalization.application, undefined);
    assert.equal(after.calls.filter(call => call.kind === 'upload').length, 1);
    assert.equal(after.calls.filter(call => call.kind === 'patch' && call.id === 'simple-master-a').length, 1);
    assert.equal(after.calls.filter(call => call.kind === 'patch' && call.id === 'simple-master-b').length, 2);
    assert.ok(after.calls.filter(call => call.kind === 'patch').every(call => call.expected === call.actual));
    await h.page.locator('#normalization-close').click();
    await h.page.reload();
    await h.page.waitForFunction(() => document.querySelectorAll('#project-list input.sel').length === 2);
    const skippedRow = h.page.locator('#project-list input.sel[value="simple-master-b"]').locator('..');
    assert.match(await skippedRow.innerText(), /内部標準なし.*未補正|未補正.*内部標準なし/);
    const assessments = await h.page.evaluate(async () => {
      const projects = await ProjectStorage.listProjects(), folders = await ProjectStorage.listFolders();
      const group = NormalizationScope.buildGroups(projects, folders).groups.find(g => g.folderId === 'coronal');
      return projects.map(p => ({ id: p.id, ...NormalizationScope.assess(p, group) }));
    });
    for (const assessment of assessments) assert.equal(assessment.status, 'CURRENT');
    await h.page.locator('#normalization-settings').click();
    await h.page.locator('#normalization-simple-form').waitFor();
    assert.equal(await h.page.locator('[data-simple-project]').count(), 2);
    assert.deepEqual(dialogs, [], 'active and intentionally skipped records share one saved group');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('actual Master partial cloud failure preserves local profiles and retries only the failed state write', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), dialogs = [];
  h.page.on('dialog', dialog => { dialogs.push(dialog.message()); return dialog.dismiss(); });
  try {
    const before = await fixture(h, true);
    await h.page.locator('#normalization-simple-apply').click();
    await waitSaved(h.page, 1);
    const partial = await snapshot(h.page);
    assert.equal(partial.projects['simple-master-a'].normalization.schemaVersion, 3);
    assert.equal(partial.projects['simple-master-b'].normalization.schemaVersion, 3);
    assert.equal(partial.remote['simple-master-b'].state.normalization, null);
    await h.page.locator('#normalization-simple-cloud').click();
    await waitSaved(h.page, 2);
    const after = await snapshot(h.page);
    assertSaved(after, before);
    for (const id of ['simple-master-a', 'simple-master-b']) assert.deepEqual(after.projects[id].normalization, partial.projects[id].normalization);
    assert.equal(after.calls.filter(call => call.kind === 'patch' && call.id === 'simple-master-a').length, 1);
    assert.equal(after.calls.filter(call => call.kind === 'patch' && call.id === 'simple-master-b').length, 2);
    assert.deepEqual(dialogs, []); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('actual Master state acknowledgement preserves a newer local profile and reports incomplete synchronization', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), dialogs = [];
  h.page.on('dialog', dialog => { dialogs.push(dialog.message()); return dialog.dismiss(); });
  try {
    const before = await fixture(h);
    await h.page.evaluate(() => { window.__holdSimpleStateAcknowledgement = true; });
    await h.page.locator('#normalization-simple-apply').click();
    await h.page.waitForFunction(() => window.__simpleStatePublished === true);
    const other = await h.context.newPage();
    await other.goto(h.baseURL + '/__test_seed');
    const newerProfile = await other.evaluate(async () => {
      const projects = await ProjectStorage.listProjects();
      const current = projects.find(p => p.id === 'simple-master-b');
      const entries = [];
      for (const project of projects) entries.push({ project,
        rasters: await Normalization.loadRasters(project, { storage: ProjectStorage }),
        simpleMapping: { standardKey: project.normalization.mapping.d4, htKey: project.normalization.mapping.ht,
          targetKeys: project.normalization.targets.map(t => t.key) } });
      const created = Normalization.createSimpleProfiles(entries, {
        id: current.normalization.id, revision: current.normalization.revision + 1, mode: 'simple',
        scope: current.normalization.scope, qc: current.normalization.qc,
        reference: { kind: 'd4_measured', projectIds: projects.map(p => p.id), roiNames: [] },
      });
      current.normalization = created.profiles.find(item => item.projectId === current.id).normalization;
      await ProjectStorage.saveProjectIfUnchanged(current, current.updatedAt);
      return current.normalization;
    });
    await h.page.evaluate(() => { window.__releaseSimpleStateAcknowledgement(); });
    await waitSaved(h.page, 1);
    const after = await snapshot(h.page);
    assert.deepEqual(after.bits, before.bits);
    assert.deepEqual(after.projects['simple-master-b'].normalization, newerProfile);
    assert.equal(after.projects['simple-master-b'].normalization.revision, 2);
    assert.equal(after.remote['simple-master-b'].state.normalization.revision, 1);
    const status = await h.page.locator('#normalization-status').innerText();
    assert.doesNotMatch(status, /クラウド同期 2\/2 件/);
    assert.match(status, /更新|変更|再読み込み|未完了/);
    assert.equal(after.calls.filter(call => call.kind === 'patch' && call.id === 'simple-master-b').length, 1,
      'a newer local profile is never automatically forced over the published revision');
    assert.deepEqual(dialogs, []); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
