'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');
const empty = () => ({ version: 1, atlasUrl: '', geneAtlasUrl: '', others: [] });
const ids = ['notes-merge-target', 'notes-merge-source'];

async function fixture(h, notes) {
  for (const id of ids) await seedViewerProject(h.page, h.baseURL, { id });
  await h.page.evaluate(async ({ ids, notes }) => {
    for (let index = 0; index < ids.length; index++) {
      const project = await ProjectStorage.getProject(ids[index]);
      project.displayName = index ? 'Source section' : 'Target section';
      if (!index) project.molecules.push({ ...project.molecules[0], key: 'MSI_target_extra', name: 'Target extra' });
      if (notes[index] !== null) project.notes = notes[index];
      delete project.normalization;
      await ProjectStorage.putProject(project);
    }
  }, { ids, notes });
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({ contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};' }));
  await h.page.goto(h.baseURL + '/');
  await h.page.waitForFunction(() => document.querySelectorAll('#project-list input.sel').length === 2);
  await h.page.evaluate(() => {
    window.confirm = () => true; window.prompt = () => '';
    const commit = ProjectStorage.commitProjectMerge;
    ProjectStorage.commitProjectMerge = async (...args) => {
      try { const saved = await commit(...args); window.__notesMergeFinished = true; return saved; }
      catch (error) { window.__notesMergeError = error.code; throw error; }
    };
  });
}
async function clickMerge(h, conflict = false) {
  for (const checkbox of await h.page.locator('#project-list input.sel').all()) await checkbox.check();
  await h.page.locator('#bulk-merge').click();
  await h.page.waitForFunction(conflict => conflict ? !!window.__notesMergeError : !!window.__notesMergeFinished, conflict);
}
async function snapshot(page) {
  return page.evaluate(async ids => {
    const projects = await Promise.all(ids.map(id => ProjectStorage.getProject(id)));
    const bits = {};
    for (const project of projects.filter(Boolean)) for (const molecule of project.molecules) {
      const values = await ProjectStorage.getValueRaster(molecule.blobId);
      bits[molecule.blobId] = Array.from(new Uint32Array(values.buffer, values.byteOffset, values.length));
    }
    return { projects, bits };
  }, ids);
}
function mergeTest(name, body) {
  test(name, { timeout: 90000 }, async () => {
    const h = await startBrowserHarness();
    try { await body(h); assert.deepEqual(h.errors, []); } finally { await h.close(); }
  });
}

mergeTest('Master merge preserves conflicting reference URLs, source notes and unique row IDs before deleting sources', async h => {
  const target = { ...empty(), atlasUrl: 'https://example.org/target-atlas', geneAtlasUrl: 'https://example.org/target-gene',
    targetExtra: { keep: true }, others: [{ id: 'collision', label: 'Target memo', url: '', text: 'target text' }] };
  const source = { ...empty(), atlasUrl: 'https://example.org/source-atlas', geneAtlasUrl: 'https://example.org/source-gene', others: [
    { id: 'collision', label: '参考資料', url: 'https://example.org/paper', text: '日本語\n2行目', extra: { keep: ['source'] } },
    { id: 'source-unique', label: '', url: '', text: '文章だけ' },
  ] };
  await fixture(h, [target, source]);
  const before = await snapshot(h.page);
  await h.page.evaluate(() => {
    const commit = ProjectStorage.commitProjectMerge;
    ProjectStorage.commitProjectMerge = async (project, options) => {
      window.__beforeNotesCommit = await Promise.all(options.expectedRevisions.map(item => ProjectStorage.getProject(item.id)));
      return commit(project, options);
    };
  });
  await clickMerge(h);
  const after = await snapshot(h.page);
  assert.equal(after.projects[0].id, ids[0]);
  assert.equal(after.projects[1], undefined, 'successful merge removes the source only after its notes are retained');
  assert.deepEqual(await h.page.evaluate(() => __beforeNotesCommit), before.projects, 'source and target records remain unchanged until guarded commit');
  assert.deepEqual(after.bits, before.bits, 'all raw source rasters remain bitwise identical');
  const notes = after.projects[0].notes;
  assert.equal(notes.atlasUrl, target.atlasUrl);
  assert.equal(notes.geneAtlasUrl, target.geneAtlasUrl);
  assert.deepEqual(notes.targetExtra, target.targetExtra);
  assert.deepEqual(notes.others[0], target.others[0]);
  assert.deepEqual(notes.others.slice(1, 3).map(({ label, url, text }) => ({ label, url, text })), [
    { label: 'Source section / marmoset Atlas URL', url: source.atlasUrl, text: '' },
    { label: 'Source section / marmoset Gene Atlas URL', url: source.geneAtlasUrl, text: '' },
  ]);
  assert.notEqual(notes.others[3].id, 'collision');
  assert.equal(notes.others[4].id, 'source-unique', 'a noncolliding source row keeps its ID');
  assert.equal(notes.others[3].label, 'Source section / 参考資料');
  assert.equal(notes.others[4].label, 'Source section / メモ');
  assert.deepEqual(notes.others[3].extra, source.others[0].extra);
  assert.equal(notes.others[3].text, source.others[0].text);
  assert.equal(notes.others[3].url, source.others[0].url);
  assert.equal(notes.others[4].text, source.others[1].text);
  assert.equal(new Set(notes.others.map(row => row.id)).size, notes.others.length);
});

mergeTest('Master merge adopts source notes by value when target has none', async h => {
  const source = { ...empty(), atlasUrl: 'https://example.org/source-atlas', geneAtlasUrl: 'https://example.org/source-gene',
    extra: { preserved: true }, others: [{ id: 'stable-source', label: 'Memo', url: '', text: 'source text' }] };
  await fixture(h, [null, source]);
  const before = await snapshot(h.page);
  await clickMerge(h);
  const after = await snapshot(h.page);
  assert.deepEqual(after.projects[0].notes, source);
  assert.deepEqual(after.bits, before.bits);
});

mergeTest('Master merge leaves notes absent when both legacy inputs have no notes', async h => {
  await fixture(h, [null, null]);
  const before = await snapshot(h.page);
  await clickMerge(h);
  const after = await snapshot(h.page);
  assert.equal(Object.hasOwn(after.projects[0], 'notes'), false);
  assert.deepEqual(after.bits, before.bits);
});

mergeTest('Concurrent source notes edit rejects Master merge without deleting or overwriting either dataset', async h => {
  const target = { ...empty(), atlasUrl: 'https://example.org/target' };
  const source = { ...empty(), atlasUrl: 'https://example.org/source' };
  await fixture(h, [target, source]);
  const before = await snapshot(h.page);
  const newer = await h.page.evaluate(async ids => {
    const commit = ProjectStorage.commitProjectMerge;
    const newer = { ...(await ProjectStorage.getProject(ids[1])).notes, geneAtlasUrl: 'https://example.org/newer' };
    ProjectStorage.commitProjectMerge = async (project, options) => {
      await ProjectStorage.patchProjectFields(ids[1], { notes: newer });
      return commit(project, options);
    };
    return newer;
  }, ids);
  await clickMerge(h, true);
  const after = await snapshot(h.page);
  assert.equal(await h.page.evaluate(() => __notesMergeError), 'LOCAL_CONFLICT');
  assert.deepEqual(after.projects[0].notes, target);
  assert.deepEqual(after.projects[1].notes, newer);
  assert.deepEqual(after.projects[0].molecules, before.projects[0].molecules);
  assert.deepEqual(after.projects[1].molecules, before.projects[1].molecules);
  assert.deepEqual(after.bits, before.bits);
});

mergeTest('Master merge fills a blank target reference and avoids duplicating equal fixed URLs', async h => {
  const target = { ...empty(), geneAtlasUrl: 'https://example.org/shared-gene' };
  const source = { ...empty(), atlasUrl: 'https://example.org/source-atlas', geneAtlasUrl: target.geneAtlasUrl,
    others: [{ id: 'stable-source', label: 'Memo', url: '', text: 'source text' }] };
  await fixture(h, [target, source]);
  const before = await snapshot(h.page);
  await clickMerge(h);
  const after = await snapshot(h.page);
  assert.equal(after.projects[0].notes.atlasUrl, source.atlasUrl);
  assert.equal(after.projects[0].notes.geneAtlasUrl, source.geneAtlasUrl);
  assert.deepEqual(after.projects[0].notes.others, [{ ...source.others[0], label: 'Source section / Memo' }]);
  assert.deepEqual(after.bits, before.bits);
});
