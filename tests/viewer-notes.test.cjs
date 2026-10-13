'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

const emptyNotes = () => ({ version: 1, atlasUrl: '', geneAtlasUrl: '', others: [] });
async function openViewer(h, id = 'viewer-notes', { seed = true } = {}) {
  if (seed) await seedViewerProject(h.page, h.baseURL, { id });
  await h.page.goto(h.baseURL + '/viewer/index.html?project=' + encodeURIComponent(id));
  await h.page.waitForFunction(id => typeof currentProject !== 'undefined' && currentProject?.id === id && viewerReady, id);
  await h.page.locator('#notes-panel').waitFor({ state: 'visible' });
  return id;
}
async function saveNow(page) {
  await page.evaluate(async () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    await saveViewerProject();
  });
}
async function waitForNotes(page, expected) {
  await page.waitForFunction(() => !saveTimer && !viewerSaving && !notesWorkPending());
  assert.deepEqual(await page.evaluate(async () => (await ProjectStorage.getProject(currentProject.id)).notes), expected);
}
async function holdDebounce(page) {
  await page.evaluate(() => {
    window.__notesOriginalTimeout = window.setTimeout;
    window.setTimeout = (fn, delay, ...args) => __notesOriginalTimeout(fn, delay === 400 ? 30000 : delay, ...args);
  });
}
async function numericalSnapshot(page) {
  return page.evaluate(() => ({
    roi: structuredClone(atlasData.roi),
    raw: Object.fromEntries(Object.entries(valueRasters).map(([key, raster]) => [key, Array.from(new Uint32Array(raster.values.buffer))])),
    stats: calcStats(extractRoiPixels('MSI_5-HT', 'all')),
    rotation: structuredClone(rotationState), alignment: structuredClone(atlasData.alignment),
  }));
}
async function delayedJsonCloud(page) {
  await page.evaluate(async () => {
    Cloud.configured = () => true; Cloud.signedIn = () => true;
    const json = value => JSON.parse(JSON.stringify(value));
    window.__notesRemote = { id: currentProject.id, updated_at: 'remote-initial',
      display_name: currentProject.displayName, bundle_path: 'synthetic/bundle.zip', bundle_rev: 1,
      state: json(Cloud.stateOf(currentProject)), meta: json(Cloud.metaOf(currentProject)) };
    viewerSaving++;
    try {
      const saved = await ProjectStorage.patchProjectFields(currentProject.id, { cloudUpdatedAt: __notesRemote.updated_at,
        cloudRev: 1, cloudBundlePath: __notesRemote.bundle_path,
        cloudStateHash: (Cloud.hashSyncState || Cloud.hashState)(__notesRemote.state), cloudDisplayName: currentProject.displayName },
        { expectedUpdatedAt: currentProject.updatedAt });
      currentProject = saved; viewerStoredProject = structuredClone(saved); viewerStoredUpdatedAt = saved.updatedAt;
    } finally { viewerSaving--; }
    window.__notesCloudWrites = 0;
    const gate = new Promise(resolve => { window.__finishNotesCloud = resolve; });
    Cloud.getProject = async () => json(__notesRemote);
    Cloud.patchRowIfUnchanged = async (id, patch, expected) => {
      if (id !== __notesRemote.id || expected !== __notesRemote.updated_at) return null;
      const sent = json(patch); window.__notesCloudWrites++; await gate;
      window.__notesRemote = { ...__notesRemote, ...sent, updated_at: 'remote-saved-' + __notesCloudWrites };
      return json(__notesRemote);
    };
    refreshCloudSaveState();
  });
}
function notesTest(name, body) {
  test(name, { timeout: 90000 }, async () => {
    const h = await startBrowserHarness(); h.page.on('dialog', dialog => dialog.accept());
    try { await body(h); assert.deepEqual(h.errors, []); } finally { await h.close(); }
  });
}

notesTest('Dataset notes persist with stable row ids, remain independent and preserve explicit clearing', async h => {
  await seedViewerProject(h.page, h.baseURL, { id: 'notes-other-project' });
  const id = await openViewer(h);
  assert.equal(await h.page.evaluate(() => Object.hasOwn(currentProject, 'notes')), false, 'legacy project must not create notes on open');
  assert.equal(await h.page.evaluate(async () => Object.hasOwn(await ProjectStorage.getProject(currentProject.id), 'notes')), false);
  assert.deepEqual(await h.page.evaluate(() => Object.keys(viewerChanges())), [], 'opening alone is not an edit');
  const before = await numericalSnapshot(h.page);
  await h.page.locator('#notes-atlas-url').fill('https://example.org/atlas?section=1');
  await h.page.locator('#notes-gene-atlas-url').fill('https://example.org/gene/TPH2');
  await h.page.locator('#notes-add').click();
  const first = h.page.locator('#notes-others [data-note-id]').first();
  await first.locator('[data-note-field="label"]').fill('参考文献');
  await first.locator('[data-note-field="url"]').fill('https://example.org/paper');
  await first.locator('[data-note-field="text"]').fill('切片についてのメモ\n二行目');
  await h.page.locator('#notes-add').click();
  const second = h.page.locator('#notes-others [data-note-id]').nth(1);
  await second.locator('[data-note-field="label"]').fill('URLなしのメモ');
  await second.locator('[data-note-field="text"]').fill('位置を次回確認する');
  const notes = await h.page.evaluate(() => structuredClone(currentProject.notes));
  assert.equal(notes.others.length, 2);
  assert.ok(notes.others[0].id && notes.others[1].id);
  assert.notEqual(notes.others[0].id, notes.others[1].id);
  await waitForNotes(h.page, notes);
  assert.match(await h.page.locator('#notes-status').textContent(), /この\s*PC\s*に保存済み/);
  assert.deepEqual(await numericalSnapshot(h.page), before, 'notes must not alter image data or analysis');
  assert.equal(await h.page.evaluate(async () => Object.hasOwn(await ProjectStorage.getProject('notes-other-project'), 'notes')), false);
  await h.page.reload();
  await h.page.waitForFunction(() => typeof currentProject !== 'undefined' && viewerReady);
  assert.equal(await h.page.locator('#notes-atlas-url').inputValue(), notes.atlasUrl);
  assert.equal(await h.page.locator('#notes-gene-atlas-url').inputValue(), notes.geneAtlasUrl);
  assert.deepEqual(await h.page.locator('#notes-others [data-note-id]').evaluateAll(rows => rows.map(row => ({ id: row.dataset.noteId,
    label: row.querySelector('[data-note-field="label"]').value, url: row.querySelector('[data-note-field="url"]').value,
    text: row.querySelector('[data-note-field="text"]').value }))), notes.others);
  await h.page.locator('#notes-others [data-note-id]').first().locator('[data-note-action="delete"]').click();
  await waitForNotes(h.page, { ...notes, others: [notes.others[1]] });
  await h.page.locator('#notes-atlas-url').fill('');
  await h.page.locator('#notes-gene-atlas-url').fill('');
  await h.page.locator('#notes-others [data-note-action="delete"]').click();
  await waitForNotes(h.page, emptyNotes());
  await openViewer(h, 'notes-other-project', { seed: false });
  assert.equal(await h.page.locator('#notes-atlas-url').inputValue(), '');
  assert.equal(await h.page.locator('#notes-others [data-note-id]').count(), 0);
  await openViewer(h, id, { seed: false });
  assert.deepEqual(await h.page.evaluate(() => currentProject.notes), emptyNotes(), 'explicit clear survives navigation/reload');
});

notesTest('Notes keep unsafe URLs inert and render imported markup as editable literal text', async h => {
  const id = await seedViewerProject(h.page, h.baseURL, { id: 'notes-unsafe' });
  const hostile = '<img src=x onerror="window.__notesInjected=true">';
  await h.page.evaluate(async ({ id, hostile }) => {
    const p = await ProjectStorage.getProject(id);
    p.notes = { version: 1, atlasUrl: 'javascript:window.__notesInjected=true', geneAtlasUrl: 'data:text/html,<script>alert(1)</script>',
      others: [{ id: 'stable-row', label: hostile, url: 'file:///private', text: hostile + '\n日本語' }] };
    await ProjectStorage.putProject(p);
  }, { id, hostile });
  await openViewer(h, id, { seed: false });
  for (const selector of ['#notes-atlas-open', '#notes-gene-atlas-open', '#notes-others [data-note-action="open"]']) {
    assert.equal(await h.page.locator(selector).getAttribute('href'), null, selector + ' must not navigate');
    assert.equal(await h.page.locator(selector).getAttribute('aria-disabled'), 'true');
  }
  assert.equal(await h.page.locator('#notes-panel img').count(), 0);
  assert.equal(await h.page.locator('[data-note-field="label"]').inputValue(), hostile);
  assert.equal(await h.page.locator('[data-note-field="text"]').inputValue(), hostile + '\n日本語');
  assert.equal(await h.page.evaluate(() => window.__notesInjected), undefined);
  await h.page.locator('#notes-atlas-url').fill('https://example.org/atlas');
  assert.equal(await h.page.locator('#notes-atlas-open').getAttribute('href'), 'https://example.org/atlas');
  assert.equal(await h.page.locator('#notes-atlas-open').getAttribute('target'), '_blank');
  assert.match(await h.page.locator('#notes-atlas-open').getAttribute('rel'), /noopener/);
  await h.page.locator('[data-note-field="url"]').fill('http://example.org/notes');
  assert.equal(await h.page.locator('[data-note-action="open"]').getAttribute('href'), 'http://example.org/notes');
  await saveNow(h.page);
  assert.equal(await h.page.evaluate(async () => (await ProjectStorage.getProject(currentProject.id)).notes.others[0].label), hostile);
});

notesTest('Japanese composition, newlines, Escape and undo in notes never operate an active ROI polygon', async h => {
  await openViewer(h);
  await h.page.locator('#notes-add').click();
  await h.page.evaluate(() => { toggleDrawingMode(true); drawingVertices = [[0, 0], [2, 0], [2, 1]]; });
  const textarea = h.page.locator('[data-note-field="text"]');
  await textarea.focus();
  await textarea.dispatchEvent('compositionstart', { data: '' });
  await textarea.evaluate(el => { el.value = '日本語'; el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: '日本語' })); });
  await textarea.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await textarea.dispatchEvent('compositionend', { data: '日本語' });
  await textarea.dispatchEvent('input');
  await textarea.press('End');
  await textarea.press('Enter');
  await textarea.press('Escape');
  await textarea.dispatchEvent('keydown', { key: 'z', ctrlKey: true });
  assert.equal(await textarea.inputValue(), '日本語\n');
  assert.deepEqual(await h.page.evaluate(() => ({ drawing: drawingMode, vertices: drawingVertices, modal: !!document.querySelector('.modal-backdrop') })),
    { drawing: true, vertices: [[0, 0], [2, 0], [2, 1]], modal: false });
  await saveNow(h.page);
  assert.equal(await h.page.evaluate(async () => (await ProjectStorage.getProject(currentProject.id)).notes.others[0].text), '日本語\n');
  await h.page.evaluate(() => toggleDrawingMode(false));
});

notesTest('A local storage failure preserves the visible notes draft and never reports it as saved', async h => {
  await openViewer(h); await holdDebounce(h.page);
  await h.page.evaluate(() => { ProjectStorage.patchProjectFields = async () => { throw new Error('Synthetic storage quota failure'); }; });
  await h.page.locator('#notes-atlas-url').fill('https://example.org/unsaved-draft');
  await h.page.evaluate(async () => { clearTimeout(saveTimer); saveTimer = 0; await saveViewerProject().catch(() => {}); });
  assert.equal(await h.page.locator('#notes-atlas-url').inputValue(), 'https://example.org/unsaved-draft');
  assert.equal(await h.page.evaluate(() => currentProject.notes.atlasUrl), 'https://example.org/unsaved-draft');
  assert.equal(await h.page.evaluate(async () => Object.hasOwn(await ProjectStorage.getProject(currentProject.id), 'notes')), false);
  assert.match(await h.page.locator('#notes-status').textContent(), /保存できません|保存.*停止|保存.*失敗/);
  assert.equal(await h.page.evaluate(() => viewerSaveConflict), true);
});

notesTest('A competing notes edit stops stale writes while retaining both the saved peer version and the visible draft', async h => {
  const id = await openViewer(h); await holdDebounce(h.page);
  await h.page.locator('#notes-atlas-url').fill('https://example.org/my-draft');
  const peer = await h.context.newPage(); await peer.goto(h.baseURL + '/__test_seed');
  const peerNotes = { ...emptyNotes(), atlasUrl: 'https://example.org/peer-saved' };
  await peer.evaluate(async ({ id, notes }) => {
    const p = await ProjectStorage.getProject(id);
    await ProjectStorage.patchProjectFields(id, { notes }, { expectedUpdatedAt: p.updatedAt });
  }, { id, notes: peerNotes });
  await h.page.evaluate(async () => { clearTimeout(saveTimer); saveTimer = 0; await saveViewerProject().catch(() => {}); });
  assert.equal(await h.page.evaluate(() => viewerSaveConflict), true);
  assert.equal(await h.page.locator('#notes-atlas-url').inputValue(), 'https://example.org/my-draft');
  assert.equal(await h.page.evaluate(() => currentProject.notes.atlasUrl), 'https://example.org/my-draft');
  assert.deepEqual(await peer.evaluate(async id => (await ProjectStorage.getProject(id)).notes, id), peerNotes);
  assert.equal(await h.page.locator('#export-zip').isDisabled(), true);
  assert.match(await h.page.locator('#notes-status').textContent(), /保存できません|保存.*停止|保存.*失敗/);
});

notesTest('Notes refresh when idle but external changes do not replace a composing or pending local draft', async h => {
  const id = await openViewer(h);
  const peer = await h.context.newPage(); await peer.goto(h.baseURL + '/__test_seed');
  const peerWrite = notes => peer.evaluate(async ({ id, notes }) => {
    const p = await ProjectStorage.getProject(id);
    await ProjectStorage.patchProjectFields(id, { notes }, { expectedUpdatedAt: p.updatedAt });
  }, { id, notes });
  await peerWrite({ ...emptyNotes(), atlasUrl: 'https://example.org/new-shared-value' });
  await h.page.evaluate(() => refreshViewerProject());
  await h.page.waitForFunction(() => document.getElementById('notes-atlas-url').value === 'https://example.org/new-shared-value');
  await holdDebounce(h.page);
  await h.page.locator('#notes-atlas-url').focus();
  await h.page.locator('#notes-atlas-url').dispatchEvent('compositionstart', { data: '' });
  await h.page.locator('#notes-atlas-url').evaluate(el => { el.value = '日本語入力中'; el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: '日本語入力中' })); });
  await peerWrite({ ...emptyNotes(), atlasUrl: 'https://example.org/newer-shared-value' });
  await h.page.evaluate(() => refreshViewerProject());
  assert.equal(await h.page.locator('#notes-atlas-url').inputValue(), '日本語入力中');
  await h.page.locator('#notes-atlas-url').dispatchEvent('compositionend', { data: '日本語入力中' });
  await h.page.locator('#notes-atlas-url').dispatchEvent('input');
  await h.page.evaluate(() => refreshViewerProject());
  assert.equal(await h.page.locator('#notes-atlas-url').inputValue(), '日本語入力中');
  assert.equal(await h.page.evaluate(() => currentProject.notes.atlasUrl), '日本語入力中');
  assert.equal(await peer.evaluate(async id => (await ProjectStorage.getProject(id)).notes.atlasUrl, id), 'https://example.org/newer-shared-value');
});

notesTest('Cloud acknowledgement saves only sent notes and retains a newer persisted edit plus a pending draft', async h => {
  await openViewer(h);
  await h.page.locator('#notes-atlas-url').fill('https://example.org/sent-A');
  await saveNow(h.page);
  await delayedJsonCloud(h.page);
  await h.page.locator('#notes-gene-atlas-url').fill('https://example.org/gene');
  await saveNow(h.page);
  const sent = await h.page.evaluate(() => structuredClone(currentProject.notes));
  await h.page.locator('#cloud-save').click();
  await h.page.waitForFunction(() => __notesCloudWrites === 1);
  await h.page.locator('#notes-atlas-url').fill('https://example.org/persisted-B');
  await saveNow(h.page);
  await holdDebounce(h.page);
  await h.page.locator('#notes-atlas-url').fill('https://example.org/pending-C');
  await h.page.evaluate(() => __finishNotesCloud());
  await h.page.waitForFunction(() => !viewerActions.cloud);
  assert.equal(await h.page.evaluate(() => viewerSaveConflict), false);
  assert.equal(await h.page.locator('#notes-atlas-url').inputValue(), 'https://example.org/pending-C');
  assert.equal(await h.page.evaluate(() => currentProject.notes.atlasUrl), 'https://example.org/pending-C');
  assert.equal(await h.page.evaluate(() => viewerStoredProject.notes.atlasUrl), 'https://example.org/persisted-B');
  assert.equal(await h.page.evaluate(() => !!saveTimer), true);
  assert.deepEqual(await h.page.evaluate(() => __notesRemote.state.notes), sent);
  assert.equal(await h.page.evaluate(() => cloudDirty()), true);
  assert.match(await h.page.locator('#cloud-save-label').textContent(), /未保存/);
  assert.match(await h.page.locator('#viewer-action-status').textContent(), /メモ/);
  await saveNow(h.page);
  assert.equal(await h.page.evaluate(async () => (await ProjectStorage.getProject(currentProject.id)).notes.atlasUrl), 'https://example.org/pending-C');
});


notesTest('Reverting notes to the cloud snapshot before acknowledgement still preserves the pending revert', async h => {
  await openViewer(h);
  await h.page.locator('#notes-atlas-url').fill('https://example.org/sent-S0');
  await saveNow(h.page);
  await delayedJsonCloud(h.page);
  await h.page.locator('#notes-gene-atlas-url').fill('https://example.org/gene');
  await saveNow(h.page);
  const sent = await h.page.evaluate(() => structuredClone(currentProject.notes));
  await h.page.locator('#cloud-save').click();
  await h.page.waitForFunction(() => __notesCloudWrites === 1);
  await h.page.locator('#notes-atlas-url').fill('https://example.org/persisted-S1');
  await saveNow(h.page);
  await holdDebounce(h.page);
  await h.page.evaluate(sent => {
    const input = document.getElementById('notes-atlas-url');
    input.value = sent.atlasUrl;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: sent.atlasUrl }));
    __finishNotesCloud();
  }, sent);
  await h.page.waitForFunction(() => !viewerActions.cloud);
  assert.equal(await h.page.evaluate(() => viewerSaveConflict), false);
  assert.equal(await h.page.locator('#notes-atlas-url').inputValue(), sent.atlasUrl);
  assert.deepEqual(await h.page.evaluate(() => currentProject.notes), sent, 'revert equal to the original sent snapshot is still a local change');
  assert.equal(await h.page.evaluate(() => viewerStoredProject.notes.atlasUrl), 'https://example.org/persisted-S1');
  assert.equal(await h.page.evaluate(() => !!saveTimer), true);
  await saveNow(h.page);
  assert.deepEqual(await h.page.evaluate(async () => (await ProjectStorage.getProject(currentProject.id)).notes), sent);
});


notesTest('An in-flight local save plus revert stays protected and Master navigation waits for the final value', async h => {
  const id = await openViewer(h);
  await h.page.locator('#notes-atlas-url').fill('https://example.org/local-S0');
  await saveNow(h.page);
  const initial = await h.page.evaluate(() => structuredClone(currentProject.notes));
  await holdDebounce(h.page);
  await h.page.evaluate(() => {
    const original = ProjectStorage.patchProjectFields;
    const gate = new Promise(resolve => { window.__finishNotesLocal = resolve; });
    ProjectStorage.patchProjectFields = async (...args) => {
      window.__notesLocalStarted = true;
      await gate;
      return original(...args);
    };
  });
  await h.page.locator('#notes-atlas-url').fill('https://example.org/local-S1');
  await h.page.evaluate(() => {
    clearTimeout(saveTimer); saveTimer = 0; window.__notesLocalSave = saveViewerProject();
  });
  await h.page.waitForFunction(() => window.__notesLocalStarted);
  await h.page.locator('#notes-atlas-url').fill(initial.atlasUrl);
  assert.equal(await h.page.evaluate(() => notesChanged()), false, 'revert currently matches the old baseline');
  assert.equal(await h.page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event); return event.defaultPrevented;
  }), true, 'in-flight writes must still protect a revert equal to the old baseline');
  assert.match(await h.page.locator('#notes-status').textContent(), /保存中|未保存/);
  await h.page.locator('#back-master').click({ noWaitAfter: true });
  assert.match(h.page.url(), /\/viewer\/index\.html/);
  assert.equal(await h.page.evaluate(() => notesNavigationPending), true);
  await h.page.evaluate(() => __finishNotesLocal());
  await h.page.waitForURL(h.baseURL + '/index.html');
  assert.deepEqual(await h.page.evaluate(async id => (await ProjectStorage.getProject(id)).notes, id), initial);
});


notesTest('An autosaved focused note retains focus and DOM while external refresh waits for blur', async h => {
  const id = await openViewer(h);
  const input = h.page.locator('#notes-atlas-url');
  await input.fill('https://example.org/locally-saved');
  await saveNow(h.page);
  await input.focus();
  await input.evaluate(el => { window.__focusedNotesInput = el; });
  const peer = await h.context.newPage(); await peer.goto(h.baseURL + '/__test_seed');
  await peer.evaluate(async id => {
    const p = await ProjectStorage.getProject(id);
    await ProjectStorage.patchProjectFields(id, { notes: { ...p.notes, atlasUrl: 'https://example.org/peer-update' } }, { expectedUpdatedAt: p.updatedAt });
  }, id);
  await h.page.evaluate(() => refreshViewerProject());
  assert.equal(await input.inputValue(), 'https://example.org/locally-saved');
  assert.equal(await input.evaluate(el => el === window.__focusedNotesInput && document.activeElement === el), true);
  await input.evaluate(el => el.blur());
  await h.page.evaluate(() => refreshViewerProject());
  await h.page.waitForFunction(() => document.getElementById('notes-atlas-url').value === 'https://example.org/peer-update');
  assert.equal(await h.page.evaluate(() => notesWorkPending()), false);
});


notesTest('Immediate ZIP actions flush notes and an edit made while importing keeps the current screen', async h => {
  const id = await openViewer(h); await holdDebounce(h.page);
  await h.page.evaluate(() => {
    ZipIO.exportProject = async project => {
      window.__notesExport = structuredClone(project.notes);
      window.__notesExportStored = (await ProjectStorage.getProject(project.id)).notes;
      return new Blob(['synthetic ZIP']);
    };
    ZipIO.importZip = async () => {
      window.__notesImportStored = (await ProjectStorage.getProject(currentProject.id)).notes;
      await new Promise(resolve => { window.__finishNotesImport = resolve; });
      return { project: { id: 'synthetic-imported-project' }, warnings: [] };
    };
  });
  await h.page.locator('#notes-atlas-url').fill('https://example.org/export-now');
  await h.page.locator('#export-zip').click();
  await h.page.waitForFunction(() => !viewerActions.export && !!window.__notesExport);
  assert.equal(await h.page.evaluate(() => __notesExport.atlasUrl), 'https://example.org/export-now');
  assert.deepEqual(await h.page.evaluate(() => __notesExportStored), await h.page.evaluate(() => __notesExport));
  await h.page.locator('#notes-atlas-url').fill('https://example.org/before-import');
  await h.page.locator('#import-zip-input').setInputFiles({ name: 'synthetic.zip', mimeType: 'application/zip', buffer: Buffer.from('synthetic') });
  await h.page.waitForFunction(() => typeof window.__finishNotesImport === 'function');
  assert.equal(await h.page.evaluate(() => __notesImportStored.atlasUrl), 'https://example.org/before-import');
  await h.page.locator('#notes-atlas-url').fill('https://example.org/edited-during-import');
  await h.page.evaluate(() => __finishNotesImport());
  await h.page.waitForFunction(() => !viewerActions.import);
  assert.equal(await h.page.evaluate(() => currentProject.id), id);
  assert.equal(await h.page.locator('#notes-atlas-url').inputValue(), 'https://example.org/edited-during-import');
  assert.match(await h.page.locator('#viewer-action-status').textContent(), /メモ.*保持.*切り替えていません/);
  await saveNow(h.page);
  assert.equal(await h.page.evaluate(async () => (await ProjectStorage.getProject(currentProject.id)).notes.atlasUrl), 'https://example.org/edited-during-import');
});

notesTest('Returning to the 3D viewer flushes an immediate notes edit before navigation', async h => {
  const id = await seedViewerProject(h.page, h.baseURL, { id: 'notes-stack-return' });
  await h.page.goto(h.baseURL + '/viewer/index.html?project=' + id + '&from=stack3d');
  await h.page.waitForFunction(() => typeof currentProject !== 'undefined' && viewerReady);
  await h.page.route('**/stack3d/index.html?project=*', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><script src="/lib/storage.js"></script><p>3D return destination</p>',
  }));
  await holdDebounce(h.page);
  await h.page.locator('#notes-atlas-url').fill('https://example.org/return-to-3d');
  await h.page.locator('#back-stack3d').click();
  await h.page.waitForURL(h.baseURL + '/stack3d/index.html?project=' + id);
  assert.equal(await h.page.evaluate(async id => (await ProjectStorage.getProject(id)).notes.atlasUrl, id), 'https://example.org/return-to-3d');
});

