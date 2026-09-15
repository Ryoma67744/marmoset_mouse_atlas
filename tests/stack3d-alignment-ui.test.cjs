'use strict';
// Synthetic fixtures only. Browser execution belongs to the existing GitHub CI harness.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

const IDS = ['alignment-before', 'alignment-central', 'alignment-after'];
const REGION_NAMES = ['Region A', 'Region B', 'Region C', 'Region D'];
const ORIGINAL = { offsetXUm: 300, offsetYUm: 500, rotationDeg: 5 };

async function seed(h) {
  for (const id of IDS) await seedViewerProject(h.page, h.baseURL, { id });
  await h.page.evaluate(async ({ ids, names }) => {
    await ProjectStorage.putFolder({ id: 'alignment-folder', name: 'Alignment synthetic fixture', parentId: null });
    for (let i = 0; i < ids.length; i++) {
      const p = await ProjectStorage.getProject(ids[i]);
      p.displayName = 'Cor_5_' + (i + 1); p.folderId = 'alignment-folder';
      p.grid = { W: 8, H: 8, umPerPxX: 100, umPerPxY: 150 };
      p.rotation = { all: 180, msi: 0, he: 0 };
      p.stack3d = { schemaVersion: 1, offsetXUm: i === 1 ? 300 : 0, offsetYUm: i === 1 ? 500 : 0, rotationDeg: i === 1 ? 5 : 0 };
      p.valueDisplay = { mode: 'raw', scale: 'common' };
      p.roi = { roi_items: {}, roi_names: {}, palette: {}, roi_show_flags: {} };
      for (const [j, [x, y]] of [[1, 1], [5, 1], [2, 5], [5, 5]].entries()) {
        const key = 'roi-' + j;
        p.roi.roi_names[key] = names[j]; p.roi.roi_show_flags[key] = true;
        p.roi.palette[key] = [80 + j * 40, 200, 255 - j * 40];
        p.roi.roi_items[key] = [{ poly_msi: [[x - .5, y - .5], [x + .5, y - .5], [x + .5, y + .5], [x - .5, y + .5]] }];
      }
      const rasters = {};
      for (const molecule of p.molecules) {
        const values = Float32Array.from({ length: 64 }, (_, k) => molecule.key === 'MSI_D4-5-HT' ? 2 : 1 + k % 13);
        molecule.blobId = await ProjectStorage.putValueRaster(values);
        molecule.stats = MSIRaster.deriveBakeStats(values);
        rasters[molecule.key] = { W: 8, H: 8, values };
      }
      const created = Normalization.createProfiles([{ project: p, rasters, mapping: Normalization.suggestMapping(p.molecules) }], {
        id: 'alignment-profile-' + i, revision: 1, batchId: 'synthetic-batch', prepId: 'synthetic-prep', quality: 'provisional',
        coordinateMatchConfirmed: true, comparabilityConfirmed: true,
        qc: { minD4: 0, saturationD4: 1000, minCoverage: .8 },
        reference: { kind: 'whole_tissue', projectIds: [p.id], roiNames: [] }, calibration: null, otsuSourceRoles: ['ht', 'da'],
      });
      p.normalization = created.profiles[0].normalization;
      await ProjectStorage.putProject(p);
    }
    sessionStorage.setItem('marmoset:currentFolder', 'alignment-folder');
    for (const key of ['atlas-stack3d-selection', 'atlas-stack3d-view-v1', 'atlas-stack3d-layout-v1']) sessionStorage.removeItem(key);
  }, { ids: IDS, names: REGION_NAMES });
  await h.context.route(h.baseURL + '/lib/cloud-config.js', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};',
  }));
}

async function ready(page) {
  await page.waitForFunction(() => window.__stack3dReady && window.Atlas3D?.sections.length === 3 &&
    Atlas3D.renderer?.getStats().sectionCount === 3 && Atlas3D.renderer.getStats().renderCount > 0);
  assert.equal(await page.locator('#render-error').isVisible(), false);
}

async function open(h, id = IDS[1]) {
  await h.page.goto(h.baseURL + '/stack3d/index.html?project=' + id); await ready(h.page);
  await h.page.locator('#placement-details').evaluate(e => { e.open = true; });
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
  return page.evaluate(() => Atlas3D.sections.map(s => ({ id: s.id, offsetXUm: s.offsetXUm, offsetYUm: s.offsetYUm, rotationDeg: s.rotationDeg })));
}

async function setPlacement(page, placement) {
  for (const [id, key] of [['offset-x', 'offsetXUm'], ['offset-y', 'offsetYUm'], ['rotation', 'rotationDeg']]) {
    await page.locator('#' + id).fill(String(placement[key]));
  }
  await page.locator('#rotation').dispatchEvent('change');
  // Commit the native focused-input change before installing spies or clicking
  // Calculate; otherwise that click's blur would look like a calculation write.
  await page.locator('#rotation').evaluate(element => element.blur());
}

async function calculate(page) {
  await page.locator('#alignment-calculate').click();
  await page.waitForFunction(() => !document.getElementById('alignment-result').hidden &&
    document.querySelectorAll('#alignment-rois input.alignment-roi-input').length >= 3 &&
    !document.getElementById('alignment-calculate').disabled);
}

async function togglePreview(page) {
  const expected = (await page.locator('#alignment-preview').getAttribute('aria-pressed')) !== 'true';
  await page.locator('#alignment-preview').click();
  await page.waitForFunction(expected => document.getElementById('alignment-preview').getAttribute('aria-pressed') === String(expected) &&
    !document.getElementById('alignment-preview').disabled, expected);
}

async function adopt(page) {
  await page.locator('#alignment-adopt').click();
  await page.waitForFunction(() => document.getElementById('alignment-result').hidden && !document.getElementById('save-placement').disabled);
}

function nearPlacement(actual, expected, description) {
  for (const key of ['offsetXUm', 'offsetYUm', 'rotationDeg']) {
    assert.ok(Math.abs(actual[key] - expected[key]) < (key === 'rotationDeg' ? .01 : 1), description + ': ' + key);
  }
}

function scientificFields(project) {
  const { stack3d, updatedAt, ...rest } = project; return rest;
}

test('ROI alignment calculates without writes, supports regional preview and cancels to the previous unsaved placement', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); await open(h);
    const before = await snapshot(page);
    const unsaved = { offsetXUm: 350, offsetYUm: 550, rotationDeg: 7 };
    await setPlacement(page, unsaved);
    const baseline = await placements(page);
    await page.evaluate(() => {
      window.__alignmentPlacementCalls = [];
      const original = Atlas3D.renderer.setPlacement;
      Atlas3D.renderer.setPlacement = function (id, values) {
        window.__alignmentPlacementCalls.push({ id, offsetXUm: values.offsetXUm, offsetYUm: values.offsetYUm, rotationDeg: values.rotationDeg });
        return original.call(this, id, values);
      };
    });
    await calculate(page);
    assert.deepEqual(await placements(page), baseline, 'calculating must not move any section');
    assert.deepEqual(await page.evaluate(() => window.__alignmentPlacementCalls), []);
    assert.deepEqual(await snapshot(page), before, 'calculating must not persist a proposal');
    assert.equal(await page.locator('#alignment-preview').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#alignment-adopt').isDisabled(), true);
    assert.equal(await page.locator('#save-placement').isDisabled(), true);
    assert.equal(await page.locator('#save-cloud').isDisabled(), true);
    assert.equal(await page.locator('#offset-x').isDisabled(), true);
    const checks = page.locator('#alignment-rois input.alignment-roi-input');
    assert.deepEqual(await checks.evaluateAll(es => es.filter(e => e.checked).map(e => e.value).sort()), REGION_NAMES);
    assert.match(await page.locator('#alignment-summary').innerText(), /4/);
    await checks.nth(3).uncheck();
    assert.equal(await page.locator('#alignment-preview').isDisabled(), false, 'three independent ROI centers permit rigid fitting');
    await checks.nth(2).uncheck();
    assert.equal(await page.locator('#alignment-preview').isDisabled(), true, 'two ROI centers are insufficient for this workflow');
    await checks.nth(2).check(); await checks.nth(3).check();
    await togglePreview(page);
    assert.equal(await page.locator('#alignment-preview').getAttribute('aria-pressed'), 'true');
    let current = await placements(page);
    nearPlacement(current[1], { offsetXUm: 0, offsetYUm: 0, rotationDeg: 0 }, 'known synthetic transform is removed');
    assert.deepEqual(current[0], baseline[0]); assert.deepEqual(current[2], baseline[2]);
    assert.ok((await page.evaluate(() => window.__alignmentPlacementCalls)).every(call => call.id === 'alignment-central'));
    assert.equal(await page.locator('#offset-x').isDisabled(), false);
    assert.equal(await page.locator('#alignment-adopt').isDisabled(), false);
    assert.equal(await page.locator('#save-placement').isDisabled(), true, 'preview must be explicitly adopted before saving');
    if (process.env.CI) {
      require('node:fs').mkdirSync('test-artifacts', { recursive: true });
      await page.locator('#alignment-summary').scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'test-artifacts/stack3d-alignment-preview.png' });
    }
    const tuned = { offsetXUm: 25, offsetYUm: -20, rotationDeg: 1 };
    await setPlacement(page, tuned);
    await togglePreview(page);
    nearPlacement((await placements(page))[1], unsaved, 'original comparison uses the pre-proposal unsaved state');
    await togglePreview(page);
    nearPlacement((await placements(page))[1], tuned, 'comparison preserves manual tuning');
    await page.locator('#alignment-cancel').click();
    assert.equal(await page.locator('#alignment-result').isVisible(), false);
    nearPlacement((await placements(page))[1], unsaved, 'cancel restores the previous unsaved placement');
    assert.match(await page.locator('#placement-status').innerText(), /未保存/);
    assert.equal(await page.locator('#save-placement').isDisabled(), false);
    assert.deepEqual(await snapshot(page), before); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('adopted ROI alignment saves only central stack3d placement and survives reload without changing scientific data', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); await open(h); const before = await snapshot(page);
    await calculate(page); await togglePreview(page);
    await adopt(page);
    assert.equal(await page.locator('#alignment-result').isVisible(), false);
    assert.equal(await page.locator('#save-placement').isDisabled(), false);
    assert.deepEqual(await snapshot(page), before, 'adoption does not itself persist');
    await page.locator('#save-placement').click();
    await page.waitForFunction(async () => Math.abs((await ProjectStorage.getProject('alignment-central')).stack3d.offsetYUm) < 1);
    const after = await snapshot(page);
    assert.deepEqual(after.raw, before.raw, 'all molecule rasters remain bitwise identical');
    assert.deepEqual(after.projects[0], before.projects[0]); assert.deepEqual(after.projects[2], before.projects[2]);
    assert.deepEqual(scientificFields(after.projects[1]), scientificFields(before.projects[1]), 'normalization, ROI, rotations and image registrations remain intact');
    nearPlacement(after.projects[1].stack3d, { offsetXUm: 0, offsetYUm: 0, rotationDeg: 0 }, 'saved central placement');
    await page.reload(); await ready(page);
    nearPlacement((await placements(page))[1], after.projects[1].stack3d, 'reloaded placement');
    assert.deepEqual(await snapshot(page), after); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('endpoint alignment cannot preview and unadopted candidates are discarded on section switch and reload', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  page.on('dialog', dialog => dialog.accept());
  try {
    await seed(h); await open(h, IDS[0]); const before = await snapshot(page);
    if (!(await page.locator('#alignment-calculate').isDisabled())) await page.locator('#alignment-calculate').click();
    assert.ok(await page.locator('#alignment-preview').isDisabled() || !(await page.locator('#alignment-result').isVisible()));
    assert.ok((await page.locator('#alignment-message').innerText()).trim().length > 0);
    await page.evaluate(() => Atlas3D.selectSection(1));
    await calculate(page); await togglePreview(page);
    await page.evaluate(() => Atlas3D.selectSection(2));
    nearPlacement((await placements(page))[1], ORIGINAL, 'section switch cancels unadopted preview');
    assert.equal(await page.locator('#alignment-result').isVisible(), false);
    await page.evaluate(() => Atlas3D.selectSection(1));
    await calculate(page); await togglePreview(page);
    await page.locator('#reload').click();
    await ready(page);
    await page.waitForFunction(() => Atlas3D.sections.find(s => s.id === 'alignment-central')?.offsetYUm === 500);
    assert.equal(await page.locator('#alignment-result').isVisible(), false);
    assert.deepEqual(await snapshot(page), before); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('changed central or neighboring ROI and placement invalidate adopted alignment before persistence', { timeout: 180000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  page.on('dialog', dialog => dialog.accept());
  try {
    for (const kind of ['central-roi', 'neighbor-roi', 'neighbor-placement']) {
      await seed(h); await open(h);
      await calculate(page); await togglePreview(page); await adopt(page);
      const other = await h.context.newPage(); await other.goto(h.baseURL + '/__test_seed');
      await other.evaluate(async kind => {
        const p = await ProjectStorage.getProject(kind === 'central-roi' ? 'alignment-central' : 'alignment-before');
        if (kind === 'neighbor-placement') p.stack3d.offsetYUm = 900;
        else p.roi.roi_items['roi-0'][0].poly_msi[0][0] += .2;
        await ProjectStorage.saveProjectIfUnchanged(p, p.updatedAt);
      }, kind);
      await page.waitForFunction(() => Atlas3D.sourceChanged);
      const external = await snapshot(page);
      if (!(await page.locator('#save-placement').isDisabled())) {
        await page.locator('#save-placement').click();
        await page.waitForFunction(() => /配置を保存できませんでした/.test(document.getElementById('notice').textContent));
      }
      assert.deepEqual(await snapshot(page), external, kind + ' must not be overwritten by a stale proposal');
      nearPlacement(external.projects[1].stack3d, ORIGINAL, kind + ': original saved central placement');
      await other.close();
    }
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('source-change notification cancels an unadopted ROI preview and prevents its application', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); await open(h); await calculate(page); await togglePreview(page);
    const other = await h.context.newPage(); await other.goto(h.baseURL + '/__test_seed');
    await other.evaluate(async () => {
      const p = await ProjectStorage.getProject('alignment-after');
      p.roi.roi_names['roi-1'] = 'Updated neighboring region';
      await ProjectStorage.saveProjectIfUnchanged(p, p.updatedAt);
    });
    await page.waitForFunction(() => Atlas3D.sourceChanged);
    const external = await snapshot(page);
    nearPlacement((await placements(page))[1], ORIGINAL, 'invalidated preview is rolled back');
    assert.ok(!(await page.locator('#alignment-result').isVisible()) || await page.locator('#alignment-adopt').isDisabled());
    assert.deepEqual(await snapshot(page), external); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('ROI alignment rejects a neighboring revision changed between preflight and the atomic placement write', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seed(h); await open(h); const before = await snapshot(page);
    await calculate(page); await togglePreview(page); await adopt(page);
    await page.evaluate(() => {
      const original = ProjectStorage.patchProjectFields;
      window.__alignmentRaceOptions = null; window.__alignmentRaceNeighbor = null;
      ProjectStorage.patchProjectFields = async function (id, fields, options) {
        if (id === 'alignment-central' && Object.hasOwn(fields, 'stack3d') && !window.__alignmentRaceNeighbor) {
          // This update occurs after the app's fresh-reference reads, while
          // saving is active, and immediately before the actual transaction.
          // Only an atomic dependency revision check can reject the old fit.
          window.__alignmentRaceOptions = structuredClone(options);
          const neighbor = await ProjectStorage.getProject('alignment-before');
          neighbor.roi.roi_items['roi-0'][0].poly_msi[0][0] += .2;
          window.__alignmentRaceNeighbor = await ProjectStorage.saveProjectIfUnchanged(neighbor, neighbor.updatedAt);
        }
        return original.call(this, id, fields, options);
      };
    });
    await page.locator('#save-placement').click();
    await page.waitForFunction(() => /配置を保存できませんでした/.test(document.getElementById('notice').textContent));
    const after = await snapshot(page);
    const raced = await page.evaluate(() => ({ neighbor: window.__alignmentRaceNeighbor, options: window.__alignmentRaceOptions }));
    assert.ok(raced.neighbor, 'the deterministic neighboring update must have happened');
    assert.deepEqual(raced.options.expectedProjectRevisions.map(reference => reference.id).sort(), [...IDS].sort(),
      'the write must check all three source project revisions');
    assert.deepEqual(after.projects[0], raced.neighbor, 'preserve the concurrent neighboring ROI edit');
    assert.deepEqual(after.projects[1], before.projects[1], 'reject rather than persisting the stale central candidate');
    assert.deepEqual(after.projects[2], before.projects[2]);
    assert.deepEqual(after.raw, before.raw); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
