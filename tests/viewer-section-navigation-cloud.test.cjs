'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

// Real controller and IndexedDB; synthetic cloud services and blocked external HTTP.
function cloudNavigationTest(name, run) {
  test(name, { timeout: 90000 }, async () => {
    const h = await startBrowserHarness();
    try { await run(h); assert.deepEqual(h.errors, []); } finally { await h.close(); }
  });
}
async function prepare(h, mode = 'success') {
  await seedViewerProject(h.page, h.baseURL, { id: 'nav-source' });
  await h.page.addScriptTag({ url: h.baseURL + '/lib/section-navigation.js' });
  await h.page.addScriptTag({ url: h.baseURL + '/viewer/section-navigation.js' });
  return h.page.evaluate(async mode => {
    const source = await ProjectStorage.getProject('nav-source');
    source.displayName = 'Mouse_01'; source.plane = 'coronal';
    source.atlas = { seriesId: 'synthetic-navigation-cloud', species: 'mouse', coordinateMode: 'pixel', sectionNumber: 1 };
    await ProjectStorage.putProject(source);
    const original = await ProjectStorage.getProject(source.id);
    const makeTarget = number => {
      const p = structuredClone(original);
      p.id = 'nav-target-' + number; p.displayName = 'Mouse_0' + number;
      p.atlas.sectionNumber = number; delete p.updatedAt;
      return p;
    };
    const targets = [makeTarget(2), makeTarget(3)];
    const row = p => ({ id: p.id, display_name: p.displayName,
      meta: { atlas: structuredClone(p.atlas), plane: p.plane }, state: {}, bundle_path: 'synthetic/' + p.id + '.zip' });
    window.__navState = { current: structuredClone(original), rows: [row(original), ...targets.map(row)],
      targets, calls: [], messages: [], pendingChanges: [], dirty: false, revision: 0, flushes: 0, mode, gated: false };
    const state = window.__navState;
    document.body.innerHTML = '<h1 id="atlas-title">Mouse_01</h1>' +
      '<nav id="section-navigation"><button id="section-previous">Previous</button>' +
      '<span id="section-position"></span><button id="section-next">Next</button></nav>' +
      '<textarea id="source-note" aria-label="Source note"></textarea>' +
      '<button id="synthetic-cloud">Cloud</button><button id="synthetic-export">Export</button>';
    history.replaceState(null, '', '/__test_seed?project=nav-source&from=stack3d&newtab=1');
    const cloud = { configured: () => true, signedIn: () => true,
      listProjects: async () => structuredClone(state.rows) };
    window.ProjectSync = {
      statusOf: () => ({ status: 'updated', reason: '' }),
      ensureLocal: async (id, options) => {
        state.calls.push(id);
        sessionStorage.setItem('synthetic-navigation-calls', JSON.stringify(state.calls));
        if (state.mode === 'failure') throw new Error('Synthetic target download failure');
        if (state.mode !== 'success') {
          state.gated = true;
          await new Promise(resolve => { window.__releasePreflight = resolve; });
        }
        if (!await options.canApplyRemote()) throw new Error('Synthetic guard rejected a changed source');
        const target = state.targets.find(p => p.id === id);
        if (!target) throw new Error('Synthetic target no longer exists');
        await options.storage.putProject(structuredClone(target));
        const saved = await options.storage.getProject(id);
        if (state.mode === 'delete-after-download') {
          state.rows = state.rows.filter(r => r.id !== id);
          await options.storage.deleteProjectRecord(id);
        }
        return saved;
      }
    };
    window.__navController = ViewerSectionNavigation.create({
      getProject: () => state.current, getReady: () => true, getBlockingReason: () => '',
      getRevision: () => state.revision, hasUnsavedChanges: () => state.dirty,
      flush: async () => {
        state.flushes++;
        if (state.dirty) { await ProjectStorage.putProject(structuredClone(state.current)); state.dirty = false; }
      },
      getViewState: () => ({ mode: 'normalized', layers: [{ key: 'MSI_5-HT' }] }),
      storage: ProjectStorage, cloud, zip: {},
      onMessage: message => state.messages.push(message), onCommit: value => { state.committed = value; },
      onPendingChange: value => {
        state.pendingChanges.push(value);
        document.getElementById('synthetic-cloud').disabled = value;
        document.getElementById('synthetic-export').disabled = value;
      }
    });
    document.getElementById('source-note').addEventListener('input', event => {
      state.current.notes = { text: event.target.value }; state.dirty = true; state.revision++;
    });
    await window.__navController.refresh();
    return original;
  }, mode);
}
async function waitStopped(page) {
  await page.waitForFunction(() => window.__navState.calls.length && !window.__navController.pending && window.__navState.messages.length);
}
async function assertSourceRetained(h, original) {
  assert.equal(new URL(h.page.url()).searchParams.get('project'), 'nav-source');
  assert.equal(await h.page.evaluate(() => window.__navState.current.id), 'nav-source');
  assert.deepEqual(await h.page.evaluate(() => ProjectStorage.getProject('nav-source')), original);
  assert.equal(await h.page.evaluate(() => !!window.__navState.committed), false);
}

cloudNavigationTest('Remote-only catalogue loads only the adjacent target before a same-tab transition', async h => {
  const original = await prepare(h);
  assert.match(await h.page.locator('#section-position').textContent(), /1\s*\/\s*3/);
  assert.deepEqual(await h.page.evaluate(async () => (await ProjectStorage.listProjects()).map(p => p.id)), ['nav-source']);
  const pageCount = h.context.pages().length;
  await Promise.all([
    h.page.waitForURL(url => url.searchParams.get('project') === 'nav-target-2'),
    h.page.locator('#section-next').click(),
  ]);
  await h.page.waitForFunction(() => typeof ProjectStorage !== 'undefined');
  assert.deepEqual(await h.page.evaluate(() => JSON.parse(sessionStorage.getItem('synthetic-navigation-calls'))), ['nav-target-2']);
  const stored = await h.page.evaluate(async () => ({ source: await ProjectStorage.getProject('nav-source'),
    next: await ProjectStorage.getProject('nav-target-2'), distant: await ProjectStorage.getProject('nav-target-3') }));
  assert.deepEqual(stored.source, original); assert.equal(stored.next.id, 'nav-target-2'); assert.equal(!!stored.distant, false);
  assert.equal(new URL(h.page.url()).searchParams.get('from'), 'stack3d');
  assert.equal(new URL(h.page.url()).searchParams.get('newtab'), '1');
  assert.equal(h.context.pages().length, pageCount);
  const carry = await h.page.evaluate(() => JSON.parse(sessionStorage.getItem('atlas-viewer-navigation-view')));
  assert.equal(carry.targetId, 'nav-target-2'); assert.equal(carry.sourceSeries, 'synthetic-navigation-cloud');
});

cloudNavigationTest('A failed remote target download retains the source and makes no target cache', async h => {
  const original = await prepare(h, 'failure');
  await h.page.locator('#section-next').click(); await waitStopped(h.page);
  await assertSourceRetained(h, original);
  assert.deepEqual(await h.page.evaluate(() => window.__navState.calls), ['nav-target-2']);
  assert.equal(!!await h.page.evaluate(() => ProjectStorage.getProject('nav-target-2')), false);
  assert.match(await h.page.locator('#section-navigation-status').textContent(), /移動しませんでした.*Synthetic target download failure/);
  assert.equal(await h.page.locator('#section-next').isDisabled(), false);
  assert.deepEqual(await h.page.evaluate(() => window.__navState.pendingChanges), [true, false]);
  assert.equal(await h.page.locator('#synthetic-cloud').isDisabled(), false);
  assert.equal(await h.page.locator('#synthetic-export').isDisabled(), false);
});

cloudNavigationTest('Editing the source while remote preflight waits cancels navigation and preserves the draft', async h => {
  const original = await prepare(h, 'wait');
  await h.page.locator('#section-next').click(); await h.page.waitForFunction(() => window.__navState.gated);
  assert.equal(await h.page.locator('#synthetic-cloud').isDisabled(), true);
  assert.equal(await h.page.locator('#synthetic-export').isDisabled(), true);
  await h.page.locator('#source-note').fill('Draft started during target preparation');
  await h.page.evaluate(() => window.__releasePreflight()); await waitStopped(h.page);
  await assertSourceRetained(h, original);
  assert.equal(await h.page.locator('#source-note').inputValue(), 'Draft started during target preparation');
  assert.equal(await h.page.evaluate(() => window.__navState.dirty), true);
  assert.equal(!!await h.page.evaluate(() => ProjectStorage.getProject('nav-target-2')), false);
  assert.match(await h.page.locator('#section-navigation-status').textContent(), /移動しませんでした/);
});

cloudNavigationTest('Renumbering the target during remote preflight cancels the intended transition', async h => {
  const original = await prepare(h, 'wait');
  await h.page.locator('#section-next').click(); await h.page.waitForFunction(() => window.__navState.gated);
  await h.page.evaluate(() => {
    window.__navState.targets[0].atlas.sectionNumber = 4;
    window.__navState.rows.find(row => row.id === 'nav-target-2').meta.atlas.sectionNumber = 4;
    window.__releasePreflight();
  });
  await waitStopped(h.page); await assertSourceRetained(h, original);
  assert.match(await h.page.locator('#section-navigation-status').textContent(), /系列または番号が変わりました/);
  assert.deepEqual(await h.page.evaluate(() => window.__navState.calls), ['nav-target-2']);
});

cloudNavigationTest('A target removed after download is caught by catalogue revalidation before leaving', async h => {
  const original = await prepare(h, 'delete-after-download');
  await h.page.locator('#section-next').click(); await h.page.waitForFunction(() => window.__navState.gated);
  await h.page.evaluate(() => window.__releasePreflight());
  await waitStopped(h.page); await assertSourceRetained(h, original);
  assert.equal(!!await h.page.evaluate(() => ProjectStorage.getProject('nav-target-2')), false);
  assert.match(await h.page.locator('#section-navigation-status').textContent(), /一覧または順番が変わりました/);
  assert.match(await h.page.locator('#section-position').textContent(), /1\s*\/\s*2/);
  assert.deepEqual(await h.page.evaluate(() => window.__navState.calls), ['nav-target-2']);
});
