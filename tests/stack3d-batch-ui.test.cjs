'use strict';
// Only synthetic projects are seeded; browser execution belongs to GitHub CI.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

const IDS = Array.from({ length: 7 }, (_, i) => 'batch-alignment-' + i);
const REGION_NAMES = ['Region A', 'Region B', 'Region C', 'Region D'];

async function seed(h, { unsupported = false } = {}) {
  for (const id of IDS) await seedViewerProject(h.page, h.baseURL, { id });
  await h.page.evaluate(async ({ ids, names, unsupported }) => {
    await ProjectStorage.putFolder({ id: 'batch-alignment-folder', name: 'Batch alignment synthetic fixture', parentId: null });
    for (let i = 0; i < ids.length; i++) {
      const p = await ProjectStorage.getProject(ids[i]);
      p.displayName = 'Cor_6_' + (i + 1); p.folderId = 'batch-alignment-folder';
      p.grid = { W: 8, H: 8, umPerPxX: 100, umPerPxY: 150 };
      p.rotation = { all: 180, msi: 0, he: 0 };
      p.stack3d = { schemaVersion: 1, offsetXUm: 0, offsetYUm: [0, 500, -400, 450, 0, 900, 700][i],
        rotationDeg: [0, 5, -4, 3, 0, 2, -1][i] };
      p.valueDisplay = { mode: 'raw', scale: 'common' };
      p.roi = { roi_items: {}, roi_names: {}, palette: {}, roi_show_flags: {} };
      if (!unsupported && i < 5) {
        for (const [j, [x, y]] of [[1, 1], [5, 1], [2, 5], [5, 5]].entries()) {
          const key = 'roi-' + j;
          p.roi.roi_names[key] = names[j]; p.roi.roi_show_flags[key] = true;
          p.roi.palette[key] = [80 + j * 40, 200, 255 - j * 40];
          p.roi.roi_items[key] = [{ poly_msi: [[x - .5, y - .5], [x + .5, y - .5], [x + .5, y + .5], [x - .5, y + .5]] }];
        }
      }
      const rasters = {};
      for (const molecule of p.molecules) {
        const values = Float32Array.from({ length: 64 }, (_, k) => molecule.key === 'MSI_D4-5-HT' ? 2 : 1 + k % 13);
        molecule.blobId = await ProjectStorage.putValueRaster(values);
        molecule.stats = MSIRaster.deriveBakeStats(values);
        rasters[molecule.key] = { W: 8, H: 8, values };
      }
      const created = Normalization.createProfiles([{ project: p, rasters, mapping: Normalization.suggestMapping(p.molecules) }], {
        id: 'batch-alignment-profile-' + i, revision: 1, batchId: 'synthetic-batch', prepId: 'synthetic-prep', quality: 'provisional',
        coordinateMatchConfirmed: true, comparabilityConfirmed: true,
        qc: { minD4: 0, saturationD4: 1000, minCoverage: .8 },
        reference: { kind: 'whole_tissue', projectIds: [p.id], roiNames: [] }, calibration: null, otsuSourceRoles: ['ht', 'da'],
      });
      p.normalization = created.profiles[0].normalization;
      await ProjectStorage.putProject(p);
    }
    sessionStorage.setItem('marmoset:currentFolder', 'batch-alignment-folder');
    for (const key of ['atlas-stack3d-selection', 'atlas-stack3d-view-v1', 'atlas-stack3d-layout-v1']) sessionStorage.removeItem(key);
  }, { ids: IDS, names: REGION_NAMES, unsupported });
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};',
  }));
}

async function ready(page) {
  await page.waitForFunction(() => window.__stack3dReady && window.Atlas3D?.sections.length === 7 &&
    Atlas3D.renderer?.getStats().sectionCount === 7 && Atlas3D.renderer.getStats().renderCount > 0);
  assert.equal(await page.locator('#render-error').isVisible(), false);
}

async function open(h) {
  await h.page.goto(h.baseURL + '/stack3d/index.html?project=' + IDS[2]); await ready(h.page);
  await h.page.locator('#placement-details').evaluate(e => { e.open = true; });
  await h.page.locator('#batch-alignment-details').evaluate(e => { e.open = true; });
}

async function snapshot(page) {
  return page.evaluate(async ids => {
    const projects = [], raw = {};
    for (const id of ids) {
      const p = await ProjectStorage.getProject(id); projects.push(p);
      for (const m of p.molecules) {
        const values = await ProjectStorage.getValueRaster(m.blobId);
        raw[id + ':' + m.key] = Array.from(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
      }
    }
    return { projects, raw };
  }, IDS);
}

async function placements(page) {
  return page.evaluate(() => Atlas3D.sections.map(s => ({ id: s.id, offsetXUm: s.offsetXUm, offsetYUm: s.offsetYUm,
    rotationDeg: s.rotationDeg, widthMm: s.widthMm, heightMm: s.heightMm, umPerPxX: s.umPerPxX, umPerPxY: s.umPerPxY })));
}

async function localResidual(page) {
  // Measure the visible placements independently of the solver's reported fit.
  return page.evaluate(() => {
    const maps = Atlas3D.sections.slice(0, 5).map(s => Stack3DAlignment.centroids(s));
    let squared = 0, count = 0;
    for (let i = 1; i < maps.length - 1; i++) {
      for (const [name, current] of maps[i]) {
        const previous = maps[i - 1].get(name), next = maps[i + 1].get(name);
        if (!previous || !next) continue;
        squared += (current.point[0] - (previous.point[0] + next.point[0]) / 2) ** 2 +
          (current.point[1] - (previous.point[1] + next.point[1]) / 2) ** 2;
        count++;
      }
    }
    return { rms: Math.sqrt(squared / count), count };
  });
}

async function setPlacement(page, placement) {
  for (const [id, key] of [['offset-x', 'offsetXUm'], ['offset-y', 'offsetYUm'], ['rotation', 'rotationDeg']]) {
    await page.locator('#' + id).fill(String(placement[key]));
  }
  await page.locator('#rotation').dispatchEvent('change');
  // Commit focused-input blur before observing the subsequent Calculate click.
  await page.locator('#rotation').evaluate(element => element.blur());
}

async function calculate(page) {
  await page.locator('#batch-calculate').click();
  await page.waitForFunction(() => !document.getElementById('batch-result').hidden &&
    document.querySelectorAll('#batch-rows .batch-section-select').length === 7 &&
    !document.getElementById('batch-preview').disabled);
}

async function togglePreview(page) {
  const expected = (await page.locator('#batch-preview').getAttribute('aria-pressed')) !== 'true';
  await page.locator('#batch-preview').click();
  await page.waitForFunction(expected => document.getElementById('batch-preview').getAttribute('aria-pressed') === String(expected) &&
    !document.getElementById('batch-preview').disabled, expected);
}

async function adopt(page) {
  await page.locator('#batch-adopt').click();
  await page.waitForFunction(() => !document.getElementById('batch-save').disabled);
}

async function save(page) {
  await page.locator('#batch-save').click();
  await page.waitForFunction(() => document.getElementById('batch-result').hidden);
}

async function configureCloudMock(page, { calls = [], failed = false } = {}) {
  await page.evaluate(({ calls, failed }) => {
    window.__batchCloudCalls = calls; window.__batchCloudFailed = failed;
    window.Cloud = { ...Cloud, configured: () => true, signedIn: () => true };
    window.ProjectSync = { ...ProjectSync, statusOf: () => ({ status: 'saved' }), async saveState(project) {
      window.__batchCloudCalls.push(project.id);
      if (project.id === 'batch-alignment-1' && !window.__batchCloudFailed) {
        window.__batchCloudFailed = true; throw new Error('Synthetic transient cloud failure');
      }
      return project;
    } };
    Atlas3D.selectSection(Atlas3D.selected);
  }, { calls, failed });
}

function scientificFields(project) {
  const { stack3d, updatedAt, ...rest } = project; return rest;
}

function changed(a, b) {
  return ['offsetXUm', 'offsetYUm', 'rotationDeg'].some(key => Math.abs(a[key] - b[key]) > 1e-5);
}

function assertSamePlacement(actual, expected) {
  for (const key of ['offsetXUm', 'offsetYUm', 'rotationDeg']) assert.ok(Math.abs(actual[key] - expected[key]) < 1e-6, key);
}

test('whole-stack calculation is read-only, previews several slices together, and cancels to an earlier individual draft', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); await open(h); const before = await snapshot(page);
    await setPlacement(page, { offsetXUm: 35, offsetYUm: -450, rotationDeg: -6 });
    const baseline = await placements(page), residualBefore = await localResidual(page);
    await page.evaluate(() => {
      window.__batchPlacementCalls = [];
      const original = Atlas3D.renderer.setPlacement;
      Atlas3D.renderer.setPlacement = function (id, values) {
        window.__batchPlacementCalls.push(id); return original.call(this, id, values);
      };
    });
    await calculate(page);
    assert.deepEqual(await placements(page), baseline);
    assert.deepEqual(await page.evaluate(() => window.__batchPlacementCalls), [], 'calculation alone must not move a section');
    assert.deepEqual(await snapshot(page), before, 'calculation does not persist any project');
    assert.equal(await page.locator('#batch-preview').getAttribute('aria-pressed'), 'false');
    for (const id of ['batch-adopt', 'batch-save', 'alignment-calculate', 'offset-x', 'offset-y', 'rotation', 'save-placement']) {
      assert.equal(await page.locator('#' + id).isDisabled(), true, id + ' must await the batch decision');
    }
    await togglePreview(page);
    const candidate = await placements(page), residualAfter = await localResidual(page);
    assert.ok(candidate.filter((p, i) => changed(p, baseline[i])).length > 1, 'the proposal must move several sections simultaneously');
    assert.ok(residualAfter.rms < residualBefore.rms, 'same-ROI local residual decreases across the stack');
    assert.equal(residualAfter.count, residualBefore.count);
    assert.deepEqual(candidate.slice(5), baseline.slice(5), 'unsupported sections retain their positions');
    for (let i = 0; i < candidate.length; i++) {
      for (const key of ['widthMm', 'heightMm', 'umPerPxX', 'umPerPxY']) assert.equal(candidate[i][key], baseline[i][key], key);
    }
    assert.equal(await page.locator('#batch-adopt').isDisabled(), false);
    assert.equal(await page.locator('#batch-save').isDisabled(), true);
    await page.locator('#batch-rows .batch-section-select[data-index="3"]').click();
    await page.waitForFunction(() => Atlas3D.sections[Atlas3D.selected]?.id === 'batch-alignment-3');
    assert.equal(await page.locator('#batch-preview').getAttribute('aria-pressed'), 'true', 'selecting a row keeps the whole-stack preview');
    assert.deepEqual(await placements(page), candidate);
    if (process.env.CI) {
      require('node:fs').mkdirSync('test-artifacts', { recursive: true });
      await page.locator('#batch-summary').scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'test-artifacts/stack3d-batch-preview.png' });
    }
    await togglePreview(page); assert.deepEqual(await placements(page), baseline);
    await togglePreview(page); assert.deepEqual(await placements(page), candidate);
    await page.locator('#batch-cancel').click();
    await page.waitForFunction(() => document.getElementById('batch-result').hidden);
    assert.deepEqual(await placements(page), baseline, 'cancel restores every pre-batch placement');
    await page.evaluate(() => Atlas3D.selectSection(2));
    assert.match(await page.locator('#placement-status').innerText(), /未保存/);
    assert.equal(await page.locator('#save-placement').isDisabled(), false);
    assert.deepEqual(await snapshot(page), before); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('adopt and atomic whole-stack save preserve raw rasters, correction metadata, physical scale, and unsupported projects', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); await open(h); const before = await snapshot(page);
    await calculate(page); await togglePreview(page); const candidate = await placements(page);
    await adopt(page);
    assert.deepEqual(await snapshot(page), before, 'adoption must still wait for explicit local save');
    assert.equal(await page.locator('#save-placement').isDisabled(), true, 'individual save cannot partially commit an adopted batch');
    await save(page); const after = await snapshot(page);
    assert.ok(after.projects.filter((p, i) => changed(p.stack3d, before.projects[i].stack3d)).length > 1);
    assert.deepEqual(after.raw, before.raw, 'all raw molecule rasters remain bitwise identical');
    for (let i = 0; i < after.projects.length; i++) {
      assert.deepEqual(scientificFields(after.projects[i]), scientificFields(before.projects[i]), 'scientific fields for ' + IDS[i]);
      assertSamePlacement(after.projects[i].stack3d, candidate[i]);
    }
    assert.deepEqual(after.projects.slice(5), before.projects.slice(5), 'unsupported projects are not rewritten, including their revisions');
    await page.reload(); await ready(page);
    const reloaded = await placements(page);
    for (let i = 0; i < reloaded.length; i++) assertSamePlacement(reloaded[i], candidate[i]);
    assert.deepEqual(await snapshot(page), after); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('an externally edited ROI invalidates the entire adopted batch without saving any candidate', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); await open(h);
    await calculate(page); await togglePreview(page); await adopt(page);
    const other = await h.context.newPage(); await other.goto(h.baseURL + '/__test_seed');
    await other.evaluate(async () => {
      const p = await ProjectStorage.getProject('batch-alignment-0');
      p.roi.roi_items['roi-0'][0].poly_msi[0][0] += .2;
      await ProjectStorage.saveProjectIfUnchanged(p, p.updatedAt);
    });
    await page.waitForFunction(() => Atlas3D.sourceChanged);
    const external = await snapshot(page);
    if (await page.locator('#batch-save').isVisible() && !(await page.locator('#batch-save').isDisabled())) {
      await page.locator('#batch-save').click();
      await page.waitForFunction(() => /更新|再計算|保存できません|変更/.test(document.getElementById('batch-message').textContent + document.getElementById('notice').textContent));
    }
    assert.deepEqual(await snapshot(page), external, 'the concurrent edit and all original placements are preserved');
    assert.ok(!(await page.locator('#batch-result').isVisible()) || await page.locator('#batch-save').isDisabled());
    await other.close(); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('a reference race after batch preflight rejects the atomic transaction and preserves every other project', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); await open(h); const before = await snapshot(page);
    await calculate(page); await togglePreview(page); await adopt(page);
    await page.evaluate(() => {
      const original = ProjectStorage.saveStack3DPlacements;
      window.__batchRace = null; window.__batchRaceOptions = null;
      ProjectStorage.saveStack3DPlacements = async function (values, options) {
        if (!window.__batchRace) {
          window.__batchRaceOptions = structuredClone(options);
          const p = await ProjectStorage.getProject('batch-alignment-0');
          p.roi.roi_names['roi-0'] = 'New concurrent region name';
          window.__batchRace = await ProjectStorage.saveProjectIfUnchanged(p, p.updatedAt);
        }
        return original.call(this, values, options);
      };
    });
    await page.locator('#batch-save').click();
    await page.waitForFunction(() => window.__batchRace &&
      /保存できません|更新または削除|再計算/.test(document.getElementById('batch-message').textContent + document.getElementById('notice').textContent));
    const after = await snapshot(page);
    const raced = await page.evaluate(() => ({ project: window.__batchRace, options: window.__batchRaceOptions }));
    const referenceIds = raced.options.expectedProjectRevisions.map(reference => reference.id);
    for (const id of IDS.slice(0, 5)) assert.ok(referenceIds.includes(id), 'atomic dependency revision for ' + id);
    assert.deepEqual(after.projects[0], raced.project, 'the newer ROI edit is retained');
    assert.deepEqual(after.projects.slice(1), before.projects.slice(1), 'no target is partially saved');
    assert.deepEqual(after.raw, before.raw); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('unsupported whole stacks report their limitation and cancellation cannot apply a late calculation result', { timeout: 180000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  page.on('dialog', dialog => dialog.accept());
  try {
    await seed(h, { unsupported: true }); await open(h); const unsupportedBefore = await snapshot(page);
    await page.locator('#batch-calculate').click();
    await page.waitForFunction(() => !document.getElementById('batch-calculate').disabled &&
      /ROI|領域|不足|ありません/.test(document.getElementById('batch-message').textContent + document.getElementById('batch-summary').textContent));
    assert.equal(await page.locator('#batch-preview').isDisabled(), true);
    assert.equal(await page.locator('#batch-adopt').isDisabled(), true);
    assert.deepEqual(await snapshot(page), unsupportedBefore);
    await seed(h); await open(h); const before = await snapshot(page), baseline = await placements(page);
    await page.evaluate(() => {
      const original = Stack3DBatchAlignment;
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      window.__batchReleaseSolve = release; window.__batchSolveStarted = false; window.__batchSolveFinished = false;
      window.Stack3DBatchAlignment = { ...original, async solve(...args) {
        window.__batchSolveStarted = true;
        await gate;
        try { return await original.solve(...args); }
        finally { window.__batchSolveFinished = true; }
      } };
    });
    await page.locator('#batch-calculate').click();
    await page.waitForFunction(() => window.__batchSolveStarted);
    await page.locator('#batch-cancel').click();
    await page.evaluate(() => window.__batchReleaseSolve());
    await page.waitForFunction(() => window.__batchSolveFinished && !document.getElementById('batch-calculate').disabled);
    assert.equal(await page.locator('#batch-result').isVisible(), false);
    assert.deepEqual(await placements(page), baseline, 'cancelled work cannot reapply a late result');
    assert.deepEqual(await snapshot(page), before); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('reload and detail navigation discard an unadopted whole-stack preview without persisting it', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); await open(h); const before = await snapshot(page), baseline = await placements(page);
    await calculate(page); await togglePreview(page);
    await page.locator('#reload').click(); await ready(page);
    await page.waitForFunction(() => Atlas3D.sections[2]?.offsetYUm === -400);
    assert.deepEqual(await placements(page), baseline);
    assert.equal(await page.locator('#batch-result').isVisible(), false);
    await calculate(page); await togglePreview(page);
    await page.locator('#open-section').click();
    await page.waitForURL('**/viewer/index.html?project=batch-alignment-2&from=stack3d');
    await open(h);
    assert.deepEqual(await placements(page), baseline);
    assert.deepEqual(await snapshot(page), before);
    assert.equal(await page.locator('#batch-result').isVisible(), false);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('optional cloud batch save keeps the completed local batch and retries only failed slices', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); await open(h);
    await configureCloudMock(page);
    const before = await snapshot(page);
    await calculate(page); await togglePreview(page); await adopt(page); await save(page);
    const local = await snapshot(page);
    const adjustedIds = local.projects.filter((p, i) => changed(p.stack3d, before.projects[i].stack3d)).map(p => p.id);
    assert.ok(adjustedIds.length > 1 && adjustedIds.includes('batch-alignment-1'));
    assert.equal(await page.locator('#batch-cloud').isVisible(), true);
    await page.locator('#batch-cloud').click();
    await page.waitForFunction(() => !document.getElementById('batch-cloud').disabled &&
      /未完了.*1.*再試行/.test(document.getElementById('batch-message').textContent));
    assert.deepEqual(await page.evaluate(() => window.__batchCloudCalls), adjustedIds);
    assert.deepEqual(await snapshot(page), local, 'a cloud failure must not roll back or rewrite the local placement batch');
    await page.reload(); await ready(page);
    await configureCloudMock(page, { calls: [...adjustedIds], failed: true });
    assert.equal(await page.locator('#batch-cloud').isVisible(), true, 'the failed-only retry remains available after reload');
    assert.match(await page.locator('#batch-cloud').innerText(), /1切片/);
    await page.locator('#batch-cloud').click();
    await page.waitForFunction(() => document.getElementById('batch-cloud').hidden &&
      /クラウド保存：1 \/ 1/.test(document.getElementById('batch-message').textContent));
    assert.deepEqual(await page.evaluate(() => window.__batchCloudCalls), [...adjustedIds, 'batch-alignment-1']);
    assert.deepEqual(await snapshot(page), local); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
