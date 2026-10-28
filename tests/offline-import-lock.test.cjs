'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');

async function master(h, { bootstrap = false } = {}) {
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({ contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};' }));
  if (bootstrap) await h.context.route(h.baseURL + '/lib/offline-config.js', route => route.fulfill({ contentType: 'application/javascript',
    body: 'window.ATLAS_OFFLINE_WORKSPACE_ID="drop-lock-test";window.ATLAS_OFFLINE={enabled:true,workspaceId:"drop-lock-test"};' }));
  await h.page.addInitScript(bootstrap => {
    const originalFetch = window.fetch;
    window.fetch = (resource, options) => {
      const url = new URL(typeof resource === 'string' ? resource : resource.url, location.href);
      if (url.pathname.endsWith(bootstrap ? '/data/workspace.zip' : '/offline/atlas-app.manifest.json')) {
        window.offlineReadWaiting = true;
        return new Promise((resolve, reject) => {
          window.releaseOfflineRead = () => resolve(new Response('Synthetic unavailable archive', { status: 503 }));
          if (options && options.signal) options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
        });
      }
      return originalFetch(resource, options);
    };
  }, bootstrap);
  await h.page.goto(h.baseURL + '/');
  await h.page.evaluate(() => {
    window.parsePairCalls = 0;
    ImzML.parsePair = async () => { parsePairCalls++; throw new Error('Import must stay locked'); };
    window.dropFiles = (zoneId, filenames) => {
      const transfer = new DataTransfer();
      for (const name of filenames) transfer.items.add(new File(['synthetic'], name));
      document.getElementById(zoneId).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    };
    window.changeFiles = (inputId, filenames) => {
      const transfer = new DataTransfer();
      for (const name of filenames) transfer.items.add(new File(['synthetic'], name));
      const input = document.getElementById(inputId); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    window.importState = () => ({ summaries: Object.fromEntries(['msi', 'he', 'atlas', 'immuno'].map(key => [key, document.getElementById(key + '-summary').textContent])),
      inputsDisabled: ['msi', 'he', 'atlas', 'immuno'].every(key => document.getElementById(key + '-input').disabled),
      registerDisabled: document.getElementById('register-btn').disabled, parsePairCalls, registerStatus: document.getElementById('register-status').textContent });
  });
}

async function exerciseLockedImports(page) {
  return page.evaluate(() => {
    const before = importState();
    dropFiles('msi-drop', ['DA_Cor_1_10.imzML', 'DA_Cor_1_10.ibd']);
    for (const key of ['he', 'atlas', 'immuno']) dropFiles(key + '-drop', ['dropped-' + key + '.png']);
    changeFiles('msi-input', ['NE_Cor_2_20.imzML', 'NE_Cor_2_20.ibd']);
    for (const key of ['he', 'atlas', 'immuno']) changeFiles(key + '-input', ['changed-' + key + '.png']);
    document.getElementById('register-btn').dispatchEvent(new Event('click'));
    return { before, after: importState() };
  });
}

for (const pending of [false, true]) test('Master offline export keeps dropped and selected files locked ' + (pending ? 'with an existing pending import' : 'with an empty MSI selection'), { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await master(h);
    await h.page.evaluate(pending => {
      dropFiles('he-drop', ['original-he.png']);
      if (pending) dropFiles('msi-drop', ['DA_Cor_5_50.imzML', 'DA_Cor_5_50.ibd']);
    }, pending);
    const initial = await h.page.evaluate(() => importState());
    assert.equal(initial.registerDisabled, !pending);
    assert.match(initial.summaries.he, /original-he.png/);
    await h.page.click('#offline-export');
    await h.page.waitForFunction(() => offlineReadWaiting);
    const result = await exerciseLockedImports(h.page);
    assert.equal(result.before.inputsDisabled && result.before.registerDisabled, true);
    assert.deepEqual(result.after, result.before, 'disabled file selection and synthetic drops must not alter pending imports or restart registration');
    if (pending) {
      const regrouped = await h.page.evaluate(() => {
        const radio = document.querySelector('input[name="grpmode"][value="single"]');
        radio.checked = true; radio.dispatchEvent(new Event('change'));
        document.getElementById('register-btn').dispatchEvent(new Event('click'));
        return importState();
      });
      assert.equal(regrouped.registerDisabled, true, 'regrouping cannot reenable registration while export is busy');
      assert.equal(regrouped.parsePairCalls, 0);
      await h.page.evaluate(() => {
        const radio = document.querySelector('input[name="grpmode"][value="auto"]');
        radio.checked = true; radio.dispatchEvent(new Event('change'));
      });
    }
    await h.page.click('#offline-cancel');
    await h.page.waitForFunction(() => document.getElementById('offline-status').textContent === '出力をキャンセルしました。');
    const after = await h.page.evaluate(async () => ({ ...importState(), projects: await ProjectStorage.listProjects() }));
    assert.equal(after.inputsDisabled, false); assert.equal(after.registerDisabled, !pending);
    assert.equal(after.parsePairCalls, 0); assert.deepEqual(after.projects, []);
    assert.deepEqual(after.summaries, initial.summaries);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Master bootstrap keeps synthetic drops and input changes locked while the original workspace is being fetched', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await master(h, { bootstrap: true });
    await h.page.waitForFunction(() => offlineReadWaiting);
    const result = await exerciseLockedImports(h.page);
    assert.equal(result.before.inputsDisabled && result.before.registerDisabled, true);
    assert.deepEqual(result.after, result.before);
    assert.deepEqual(result.after.summaries, { msi: '', he: '', atlas: '', immuno: '' });
    await h.page.evaluate(() => releaseOfflineRead());
    await h.page.waitForFunction(() => document.getElementById('offline-status').textContent.includes('同梱データを復元できませんでした'));
    const after = await h.page.evaluate(async () => ({ ...importState(), projects: await ProjectStorage.listProjects(), marker: await ProjectStorage.hasWorkspaceRestore() }));
    assert.equal(after.inputsDisabled && after.registerDisabled, true);
    assert.equal(after.parsePairCalls, 0); assert.deepEqual(after.projects, []); assert.equal(after.marker, false);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
