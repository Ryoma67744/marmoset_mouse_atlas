'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');
const { sectionId, seedAnalysisStack, readyAnalysisStack, setInputValue, scientificSnapshot } = require('./stack3d-analysis-fixture.cjs');

async function settle(page, expected = {}) {
  // A control schedules calculation on the next animation frame. Do not accept
  // the previous result in the brief interval before that frame starts.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(expected => {
    const state = window.Atlas3D?.analysis?.getState();
    return state && !state.loading && state.result &&
      (!expected.mode || state.result.mode === expected.mode) &&
      (!expected.valueMode || state.result.valueMode === expected.valueMode) &&
      (expected.count === undefined || state.result.selection.count === expected.count);
  }, expected);
}
async function result(page) { return page.evaluate(() => Atlas3D.analysis.getState().result); }
function group(result, channel, roi) { return result.channels.find(item => item.key === channel).groups.find(item => item.roiName === roi); }
async function openConditions(page) {
  if (!await page.locator('.analysis-controls').evaluate(node => node.open)) await page.locator('#analysis-conditions-summary').click();
}
async function applyRange(page, text, count) {
  await openConditions(page);
  await page.locator('#analysis-range').fill(text); await page.locator('#analysis-apply-range').click();
  await settle(page, { count });
}
async function mode(page, name, count) {
  await page.locator('[data-analysis-mode="' + name + '"]').click(); await settle(page, { mode: name, count });
  await openConditions(page);
}
async function useRois(page, names) {
  const inputs = page.locator('#analysis-roi-checks input[data-roi-name]');
  for (let i = 0; i < await inputs.count(); i++) {
    const input = inputs.nth(i), name = await input.getAttribute('data-roi-name');
    await input.setChecked(names.includes(name));
  }
  await settle(page);
}
function expectedCaudate(numbers, scale = 1) {
  // Independent rectangular-fixture oracle: 3 columns on multiples of 3,
  // otherwise 4 columns, at all 8 rows. No polygon/analysis production helper.
  const values = [];
  for (const number of numbers) for (let y = 0; y < 8; y++) for (let x = 0; x < (number % 3 ? 4 : 3); x++) {
    let value = scale * (number * 10 + x + y * 3);
    if (x === 0 && y === 0) value = 0;
    if (x === 1 && y === 1) value *= 8;
    values.push(value);
  }
  values.sort((a, b) => a - b);
  const quantile = p => { const at = (values.length - 1) * p, low = Math.floor(at); return values[low] + (values[Math.ceil(at)] - values[low]) * (at - low); };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { n: values.length, mean, sd: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length),
    q1: quantile(.25), median: quantile(.5), q3: quantile(.75), whiskerLow: values[0], whiskerHigh: quantile(.99), max: values.at(-1) };
}

test('3D analysis uses real ROI pixels for all three modes and arbitrary section subsets without editing scientific data', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seedAnalysisStack(h); const before = await scientificSnapshot(page);
    await page.goto(h.baseURL + '/stack3d/index.html?project=' + sectionId(46)); await readyAnalysisStack(page);
    let current = await result(page);
    assert.equal(current.mode, 'selected'); assert.deepEqual(current.selection.sectionIds, [sectionId(46)]);
    assert.equal(await page.locator('#analysis-charts .analysis-molecule').count(), 3);
    assert.equal(await page.locator('#analysis-charts .analysis-molecule:visible').count(), 1);
    assert.equal(await page.locator('#analysis-charts canvas').count(), 1);
    await mode(page, 'pooled'); await useRois(page, ['Caudate', 'Putamen', 'Thalamus']); await applyRange(page, '5-20', 16);
    current = await result(page); const expected = expectedCaudate(Array.from({ length: 16 }, (_, index) => index + 5));
    for (const channel of ['DA', 'NE', '5-HT']) {
      const g = group(current, channel, 'Caudate'), oracle = expectedCaudate(Array.from({ length: 16 }, (_, index) => index + 5), ['DA', 'NE', '5-HT'].indexOf(channel) + 1);
      assert.equal(g.counts.targetSections, 16); assert.equal(g.counts.includedSections, 16);
      assert.equal(g.statistics.n, oracle.n); assert.equal(g.distribution.n, oracle.n);
      assert.ok(Math.abs(g.statistics.mean - oracle.mean) < 1e-9); assert.ok(Math.abs(g.statistics.sd - oracle.sd) < 1e-9);
      for (const key of ['q1', 'median', 'q3', 'whiskerLow', 'whiskerHigh', 'max']) assert.ok(Math.abs(g.distribution[key] - oracle[key]) < 1e-9, channel + ' ' + key);
      assert.ok(g.distribution.upperTailCount > 0, 'P99 tail remains in data and is plotted separately');
    }
    const missing = group(current, 'DA', 'Thalamus');
    assert.equal(missing.counts.targetSections, 16); assert.equal(missing.counts.roiSections, 14); assert.equal(missing.counts.includedSections, 14);
    assert.deepEqual(missing.exclusions.map(item => item.sectionId).sort(), [sectionId(7), sectionId(14)].sort());
    const row = page.locator('.analysis-molecule[data-channel="DA"] .analysis-table tr[data-roi-name="Caudate"]');
    await page.locator('.analysis-molecule[data-channel="DA"] .analysis-table-details > summary').click();
    assert.match(await row.locator('[data-stat="count"]').innerText(), new RegExp(String(expected.n)));
    assert.ok((await row.locator('[data-stat="median"]').innerText()).length > 0);
    await applyRange(page, '5-20,24,30-35', 23);
    assert.deepEqual((await result(page)).selection.numbers, [...Array.from({ length: 16 }, (_, i) => i + 5), 24, 30, 31, 32, 33, 34, 35]);
    await applyRange(page, '5-20,20,5', 16);
    await mode(page, 'by-section', 16); await page.locator('#analysis-single-roi').selectOption('Thalamus'); await settle(page);
    await page.waitForFunction(() => Atlas3D.analysis.getState().result?.channels.every(channel => channel.groups.every(g => g.roiName === 'Thalamus')));
    current = await result(page); assert.equal(current.channels[0].groups.length, 16);
    const absent = current.channels[0].groups.find(item => item.sectionId === sectionId(7));
    assert.equal(absent.distribution, null); assert.equal(absent.counts.nIncluded, 0);
    const comparisonTable = page.locator('.analysis-molecule[data-channel="DA"] .analysis-table-details');
    if (!await comparisonTable.evaluate(node => node.open)) await comparisonTable.locator('summary').click();
    assert.match(await page.locator('.analysis-molecule[data-channel="DA"] tr[data-section-id="' + sectionId(7) + '"]').innerText(), /ROI|領域|欠損|なし|—/);
    await page.locator('.analysis-molecule[data-channel="DA"] tr[data-section-id="' + sectionId(8) + '"] .analysis-section-link').click();
    await page.waitForFunction(id => Atlas3D.sections[Atlas3D.selected].id === id, sectionId(8));
    assert.equal((await result(page)).selection.count, 16, 'selecting a comparison row preserves the analysis subset');
    assert.equal(await page.locator('.analysis-molecule[data-channel="DA"] tr[data-section-id="' + sectionId(8) + '"]').getAttribute('aria-selected'), 'true');
    await page.locator('#analysis-all-sections').click(); await settle(page, { count: 69 });
    await mode(page, 'selected', 1); assert.deepEqual((await result(page)).selection.sectionIds, [sectionId(8)]);
    assert.deepEqual(await scientificSnapshot(page), before, 'charts and scope controls are read-only'); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('analysis section IDs stay independent of the 3D cutoff and visibility, including snapshot import and reordered reload', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seedAnalysisStack(h); await page.goto(h.baseURL + '/stack3d/index.html?project=' + sectionId(46)); await readyAnalysisStack(page);
    await mode(page, 'pooled'); await applyRange(page, '5-20', 16);
    const pooled = group(await result(page), 'DA', 'Caudate').distribution;
    await setInputValue(page, '#section-slider', 9); await page.waitForFunction(() => Atlas3D.selected === 9);
    assert.equal((await result(page)).selection.count, 16); assert.deepEqual(group(await result(page), 'DA', 'Caudate').distribution, pooled);
    await page.locator('input.section-visible[data-section-id="' + sectionId(3) + '"]').uncheck();
    assert.equal((await result(page)).selection.count, 16);
    await page.locator('#analysis-use-display').click(); await settle(page, { count: 9 });
    const snapshot = (await result(page)).selection.sectionIds;
    assert.deepEqual(snapshot, [1, 2, 4, 5, 6, 7, 8, 9, 10].map(sectionId));
    await setInputValue(page, '#section-slider', 4); await page.locator('input.section-visible[data-section-id="' + sectionId(3) + '"]').check();
    await setInputValue(page, '#threshold', .8); await setInputValue(page, '#opacity', .25);
    assert.deepEqual((await result(page)).selection.sectionIds, snapshot, 'import is a snapshot rather than a live 3D display filter');
    await page.locator('#analysis-range').fill('5-75'); await page.locator('#analysis-apply-range').click();
    assert.equal(await page.locator('#analysis-range-error').isVisible(), true); assert.deepEqual((await result(page)).selection.sectionIds, snapshot);
    await page.reload(); await readyAnalysisStack(page); assert.deepEqual((await result(page)).selection.sectionIds, snapshot);
    // Renaming changes natural order. Restored targets must remain the same IDs,
    // rather than silently selecting the projects now at the old numeric indexes.
    const other = await h.context.newPage(); await other.goto(h.baseURL + '/__test_seed');
    await other.evaluate(async id => { const project = await ProjectStorage.getProject(id); project.displayName = 'Cor_99_1'; await ProjectStorage.putProject(project); }, sectionId(1));
    await page.waitForFunction(() => Atlas3D.sourceChanged); assert.equal(await page.locator('#analysis-stale').isVisible(), true);
    await page.locator('#reload').click(); await readyAnalysisStack(page);
    assert.deepEqual((await result(page)).selection.sectionIds.slice().sort(), snapshot.slice().sort());
    assert.equal((await result(page)).selection.numbers.includes(69), true, 'renamed first project now occupies the last index');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('corrected 3D analysis excludes missing corrections instead of presenting raw pixels as normalized', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seedAnalysisStack(h); const before = await scientificSnapshot(page);
    await page.goto(h.baseURL + '/stack3d/index.html?project=' + sectionId(69)); await readyAnalysisStack(page);
    await page.locator('#value-mode').selectOption('normalized'); await settle(page, { valueMode: 'normalized' });
    let current = await result(page);
    for (const channel of current.channels) for (const g of channel.groups) {
      assert.equal(g.distribution, null); assert.equal(g.counts.nIncluded, 0);
      assert.ok(g.exclusions.some(item => item.sectionId === sectionId(69)), 'missing correction is reported');
    }
    await mode(page, 'pooled'); await useRois(page, ['Caudate']); await applyRange(page, '68-69', 2);
    current = await result(page);
    for (const channel of current.channels) {
      const g = channel.groups[0]; assert.equal(g.counts.targetSections, 2); assert.equal(g.counts.roiSections, 2);
      assert.equal(g.counts.includedSections, 1); assert.ok(g.distribution); assert.ok(g.exclusions.some(item => item.sectionId === sectionId(69)));
    }
    const htNormalized = group(current, '5-HT', 'Caudate').statistics.mean;
    const expected68 = expectedCaudate([68], 3);
    assert.ok(Math.abs(htNormalized - expected68.mean / 78) < 1e-10, '5-HT is an actual pixel ratio, not display-color intensity');
    await page.locator('#value-mode').selectOption('raw'); await settle(page, { valueMode: 'raw' });
    current = await result(page); for (const channel of current.channels) assert.equal(channel.groups[0].counts.includedSections, 2);
    assert.deepEqual(await scientificSnapshot(page), before); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('stacked analysis dock sits below the slice scrubber, resizes and collapses without changing the camera, and clears failed loads', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seedAnalysisStack(h); await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(h.baseURL + '/stack3d/index.html?project=' + sectionId(46)); await readyAnalysisStack(page);
    await page.locator('#analysis-layout-toggle').click();
    const camera = await page.evaluate(() => Atlas3D.renderer.getView());
    const geometry = () => page.evaluate(() => {
      const rect = selector => { const { x, y, width, height, bottom } = document.querySelector(selector).getBoundingClientRect(); return { x, y, width, height, bottom }; };
      return { scene: rect('#scene'), scrubber: rect('.slice-scrubber'), analysis: rect('#analysis-panel'),
        body: rect('.analysis-body'), doc: [document.documentElement.clientWidth, document.documentElement.scrollWidth] };
    });
    let size = await geometry(); assert.ok(size.analysis.y >= size.scrubber.bottom - 1); assert.ok(size.scene.height >= 180); assert.equal(size.doc[0], size.doc[1]);
    const expandedSceneHeight = size.scene.height;
    await page.locator('#analysis-collapse').click(); assert.equal(await page.locator('.analysis-body').isVisible(), false);
    size = await geometry(); assert.ok(size.scene.height > expandedSceneHeight + 150);
    await page.locator('#analysis-collapse').click(); assert.equal(await page.locator('.analysis-body').isVisible(), true);
    const resizer = page.locator('#analysis-resizer'), handle = await resizer.boundingBox();
    const beforeHeight = (await page.locator('#analysis-panel').boundingBox()).height;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y - 90, { steps: 8 }); await page.mouse.up();
    const afterHeight = (await page.locator('#analysis-panel').boundingBox()).height; assert.ok(afterHeight > beforeHeight + 40);
    assert.deepEqual(await page.evaluate(() => Atlas3D.renderer.getView()), camera);
    await page.reload(); await readyAnalysisStack(page);
    assert.ok(Math.abs((await page.locator('#analysis-panel').boundingBox()).height - afterHeight) <= 2, 'dock height survives reload');
    await page.setViewportSize({ width: 1366, height: 768 }); await page.waitForTimeout(100);
    size = await geometry(); assert.ok(size.scene.height >= 179); assert.ok(size.analysis.y >= size.scrubber.bottom - 1); assert.equal(size.doc[0], size.doc[1]);
    await page.locator('#analysis-resizer').focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home');
    assert.ok((await geometry()).scene.height >= 179);
    await page.evaluate(() => Atlas3D.analysis.beginLoad());
    assert.equal(await page.locator('#analysis-charts canvas').count(), 0, 'a new load removes the previous numeric plot immediately');
    await page.evaluate(() => Atlas3D.analysis.loadFailed('Synthetic load failure'));
    assert.equal(await page.locator('#analysis-charts canvas').count(), 0); assert.match(await page.locator('#analysis-status').innerText(), /失敗|読み込|再読込|Synthetic/);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('large distribution worker matches exact statistics, preserves source buffers and recovers after cancellation', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await page.goto(h.baseURL + '/__test_seed');
    await page.addScriptTag({ url: h.baseURL + '/lib/roi-distribution.js' });
    await page.addScriptTag({ url: h.baseURL + '/stack3d/analysis-worker-client.js' });
    const actual = await page.evaluate(async () => {
      const values = Float64Array.from({ length: 100003 }, (_, index) => index % 101 === 0 ? 0 : (index * 17 % 13007) - 500);
      values[7] = NaN; values[8] = Infinity; values[9] = -Infinity; values[99999] = 999999;
      const bytes = new Uint8Array(values.buffer).slice();
      const expected = RoiDistribution.summarize(values, { maxPoints: 300 });
      const worker = Stack3DAnalysisWorker.create();
      try {
        const result = await worker.summarize(values, { maxPoints: 300 });
        const controller = new AbortController();
        const pending = worker.summarize(values, { signal: controller.signal, maxPoints: 300 }).then(() => 'resolved', error => error.name);
        controller.abort(); const cancelled = await pending;
        const recovered = await worker.summarize(values, { maxPoints: 300 });
        const tailExpected = RoiDistribution.summarize(values, { maxPoints: 300, includeUpperTailValues: true });
        const tailResult = await worker.summarize(values, { maxPoints: 300, includeUpperTailValues: true });
        const small = values.slice(0, 300);
        const smallExpected = RoiDistribution.summarize(small, { includeUpperTailValues: true });
        const smallResult = await worker.summarize(small, { includeUpperTailValues: true });
        const after = new Uint8Array(values.buffer);
        return { expected, result, recovered, cancelled, tailExpected, tailResult, smallExpected, smallResult, byteLength: values.byteLength,
          unchanged: after.length === bytes.length && after.every((value, index) => value === bytes[index]) };
      } finally { worker.dispose(); }
    });
    assert.deepEqual(actual.result, actual.expected); assert.deepEqual(actual.recovered, actual.expected);
    assert.deepEqual(actual.tailResult, actual.tailExpected); assert.deepEqual(actual.smallResult, actual.smallExpected);
    assert.ok(Object.values(actual.tailResult.upperTailValues).length > 0);
    assert.equal(actual.cancelled, 'AbortError'); assert.equal(actual.byteLength, 100003 * 8); assert.equal(actual.unchanged, true);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
