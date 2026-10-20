'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');
const { seedAnalysisStack, scientificSnapshot, setInputValue } = require('./stack3d-analysis-fixture.cjs');

// Entirely synthetic: no study section names, values, project records or cloud data.
const SERIES = 'mouse_tissue_1set';
const ANALYTES = ['GABA-DPP', 'Histamine-DPP', 'Dopamine-DPP', 'Norepinephrine-DPP', 'Serotonin-DPP', 'Serotonin-d4-DPP'];
const STANDARD = ANALYTES[5];
const sectionId = number => 'synthetic-mouse-analysis-' + String(number).padStart(2, '0');
function sourceValues(number, channel) {
  if (channel === 5) {
    const values = Array(10).fill(1 + number % 4).concat([NaN, NaN]);
    if ([8, 33].includes(number)) values[1] = 0;
    if (number === 12) values[2] = NaN;
    if (number === 17) values[3] = -1;
    return Array.from(new Float32Array(values));
  }
  const base = (1 + Math.floor((number - 1) / 2)) * (channel + 1);
  const values = [0, base, base + 2, base * 8, base + 4, base + 8, base + 16, base + 32, base + 64, base + 128, NaN, NaN];
  if (channel === 1) values[8] = NaN; // This molecule's missing sample must not remove other molecules' data.
  return Array.from(new Float32Array(values));
}
function oracle(number, channel, mode) {
  const standard = sourceValues(number, 5);
  const values = sourceValues(number, channel).map((raw, index) => {
    if (!Number.isFinite(raw)) return NaN;
    if (mode === 'raw') return raw;
    return Number.isFinite(standard[index]) && standard[index] > 0 ? raw / standard[index] : NaN;
  }).filter(Number.isFinite).sort((a, b) => a - b);
  const quantile = p => {
    const at = (values.length - 1) * p, low = Math.floor(at), high = Math.ceil(at);
    return values[low] + (values[high] - values[low]) * (at - low);
  };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { n: values.length, mean, sd: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length),
    q1: quantile(.25), median: quantile(.5), q3: quantile(.75), whiskerLow: values[0], whiskerHigh: quantile(.99),
    min: values[0], max: values.at(-1) };
}
async function seedMouseAnalysis(h, { emptyChannelSection } = {}) {
  await seedAnalysisStack(h, { count: 3, missingCorrection: false });
  const rows = Array.from({ length: 48 }, (_, index) => ({
    number: index + 1, id: sectionId(index + 1), channels: ANALYTES.map((_, channel) => sourceValues(index + 1, channel))
  }));
  if (emptyChannelSection) rows[emptyChannelSection - 1].channels[1] = Array(12).fill(NaN);
  await h.page.evaluate(async ({ rows, analytes, series }) => {
    for (const row of rows) {
      const number = String(row.number).padStart(2, '0');
      const project = {
        id: row.id, displayName: 'Synthetic mouse section ' + number, plane: 'coronal',
        atlas: { species: 'mouse', seriesId: series, seriesName: 'Synthetic mouse',
          specimenId: 'synthetic-mouse', sectionNumber: row.number, sourceCandidateId: 'C' + String(row.number).padStart(3, '0'),
          coordinateMode: 'pixel', physicalSectionSpacing: null, displaySpacing: 2 },
        grid: { W: 4, H: 3, umPerPxX: null, umPerPxY: null }, images: {}, molecules: [],
        rotation: { all: 0, msi: 0, he: 0 }, valueDisplay: { mode: 'normalized', scale: 'common' },
        stack3d: { coordinateMode: 'pixel', offsetXPx: 0, offsetYPx: 0, rotationDeg: 0 },
        roi: { roi_items: {}, roi_names: {}, palette: {}, roi_show_flags: {} }
      };
      const rasters = {};
      for (let channel = 0; channel < analytes.length; channel++) {
        // Keys are deliberately local to the section; compatibility must use analyte identity.
        const key = 'synthetic-' + number + '-m' + channel, name = analytes[channel];
        const values = new Float32Array(row.channels[channel]);
        project.molecules.push({ key, name, analyteId: name,
          blobId: await ProjectStorage.putValueRaster(values), stats: MSIRaster.deriveBakeStats(values) });
        rasters[key] = { W: 4, H: 3, values };
      }
      project.visibleLayers = project.molecules.map(molecule => molecule.key);
      project.normalization = Normalization.createPixelRatioProfile(project, rasters, {
        id: 'synthetic-profile-' + number, revision: row.number,
        standardKey: project.molecules[5].key, targetKeys: project.molecules.slice(0, 5).map(molecule => molecule.key),
        standardApplication: { method: 'uniform_spray', confirmed: true, source: 'synthetic-test' }
      });
      await ProjectStorage.putProject(project);
    }
  }, { rows, analytes: ANALYTES, series: SERIES });
}
async function paint(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function ready(page, { series = SERIES, count = 48, mode, valueMode } = {}) {
  await paint(page);
  await page.waitForFunction(({ series, count, mode, valueMode }) => {
    const state = window.Atlas3D?.analysis?.getState();
    return window.__stack3dReady && Atlas3D.seriesId === series &&
      !document.querySelector('#series-select').disabled &&
      document.querySelector('#analysis-panel').getAttribute('aria-busy') === 'false' &&
      state?.result?.selection.count === count &&
      (!mode || state.result.mode === mode) && (!valueMode || state.result.valueMode === valueMode);
  }, { series, count, mode, valueMode });
  await paint(page);
}
async function switchMode(page, valueMode) {
  await page.locator('#value-mode').selectOption(valueMode); await ready(page, { valueMode });
}
async function currentResult(page) { return page.evaluate(() => Atlas3D.analysis.getState().result); }
async function installCanvasAudit(page) {
  await page.addInitScript(() => {
    const proto = CanvasRenderingContext2D.prototype, originalFill = proto.fillText, originalTransform = proto.setTransform;
    proto.setTransform = function (...args) { this.canvas.__labelCalls = []; return originalTransform.apply(this, args); };
    proto.fillText = function (text, x, y, ...args) {
      (this.canvas.__labelCalls ||= []).push({ text: String(text), x, y });
      return originalFill.call(this, text, x, y, ...args);
    };
  });
}
async function rankedPlot(page) {
  await paint(page);
  return page.locator('.analysis-molecule:visible').evaluate(card => {
    const canvas = card.querySelector('canvas');
    const groups = Atlas3D.analysis.getState().result.channels.find(channel => channel.key === card.dataset.channel).groups;
    const keys = JSON.parse(canvas.dataset.groupKeys), width = parseFloat(canvas.style.width), height = parseFloat(canvas.style.height);
    const slot = (width - 104) / keys.length;
    return { channel: card.dataset.channel, canvasCount: card.querySelectorAll('canvas').length, keys,
      tableKeys: [...card.querySelectorAll('tbody tr')].map(row => row.dataset.groupKey),
      labels: keys.map((key, index) => {
        const group = groups.find(group => group.key === key), x = 84 + slot * (index + .5);
        const atlas = Atlas3D.sections.find(section => section.id === group.sectionId).project.atlas;
        return { name: `${atlas.sectionNumber} · ${atlas.sourceCandidateId}`, median: group.distribution?.median, sectionId: group.sectionId,
          text: canvas.__labelCalls?.filter(call => Math.abs(call.x - x) < .1 && call.y > height - 90).map(call => call.text).join(' ') };
      }), plotWidth: canvas.parentElement.clientWidth, canvasWidth: width,
      documentWidth: document.documentElement.clientWidth, documentScroll: document.documentElement.scrollWidth };
  });
}

test('mouse whole-pixel charts use exact full distributions for all 48 sections and six raw / five corrected molecules', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), { page } = h;
  try {
    await seedMouseAnalysis(h); const original = await scientificSnapshot(page);
    await installCanvasAudit(page);
    await page.goto(h.baseURL + '/stack3d/index.html?series=' + SERIES); await ready(page);
    assert.equal(await page.locator('#analysis-panel').isVisible(), true);
    const initial = await page.evaluate(() => Atlas3D.analysis.getState());
    assert.equal(initial.mode, 'by-section'); assert.equal(initial.scope, 'all'); assert.equal(initial.sampleScope, 'all-measured');
    assert.match(await page.locator('#analysis-sample-scope').innerText(), /全測定画素/);
    assert.equal(await page.locator('#analysis-range').isVisible(), false);
    for (const valueMode of ['raw', 'normalized']) {
      await switchMode(page, valueMode);
      const result = await currentResult(page), expectedChannels = valueMode === 'raw' ? ANALYTES : ANALYTES.slice(0, 5);
      assert.deepEqual(result.channels.map(channel => channel.key), expectedChannels);
      assert.deepEqual(result.selection.sectionIds, Array.from({ length: 48 }, (_, index) => sectionId(index + 1)));
      for (const channel of result.channels) {
        const index = ANALYTES.indexOf(channel.key);
        assert.equal(channel.groups.length, 48); assert.notEqual(channel.status, 'BLOCKED');
        if (valueMode === 'normalized') assert.match(channel.unit, /ratio/);
        for (let number = 1; number <= 48; number++) {
          const group = channel.groups.find(group => group.sectionId === sectionId(number)), expected = oracle(number, index, valueMode);
          assert.ok(group?.distribution, channel.key + ' section ' + number);
          assert.equal(group.statistics.n, expected.n); assert.equal(group.distribution.n, expected.n);
          assert.equal(group.counts.nMeasured, sourceValues(number, index).filter(Number.isFinite).length);
          for (const key of ['mean', 'sd']) assert.ok(Math.abs(group.statistics[key] - expected[key]) < 1e-9, channel.key + ' ' + number + ' ' + key);
          for (const key of ['q1', 'median', 'q3', 'whiskerLow', 'whiskerHigh', 'min', 'max']) {
            assert.ok(Math.abs(group.distribution[key] - expected[key]) < 1e-9, channel.key + ' ' + number + ' ' + key);
          }
        }
        await page.locator('[data-analysis-molecule="' + channel.key + '"]').click();
        const plot = await rankedPlot(page);
        assert.equal(plot.canvasCount, 1); assert.equal(plot.keys.length, 48); assert.deepEqual(plot.keys, plot.tableKeys);
        assert.ok(plot.canvasWidth > plot.plotWidth); assert.equal(plot.documentWidth, plot.documentScroll);
        assert.ok(plot.labels.every((label, index) => !index || plot.labels[index - 1].median >= label.median));
        for (const label of plot.labels) {
          assert.equal(label.text.replace(/\s/g, ''), label.name.replace(/\s/g, ''));
          assert.doesNotMatch(label.text, /…|n\s*=/i);
        }
      }
    }
    assert.deepEqual(await scientificSnapshot(page), original, 'plots do not create ROIs or modify raw, profile, placement or saved data');
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('mouse graphs retain all 48 targets independently of 3D visibility and use stable section IDs after sorting', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), { page } = h;
  try {
    await seedMouseAnalysis(h); await installCanvasAudit(page);
    await page.goto(h.baseURL + '/stack3d/index.html?series=' + SERIES); await ready(page); await switchMode(page, 'raw');
    await page.locator('[data-analysis-molecule="Histamine-DPP"]').click(); await paint(page);
    const initial = await currentResult(page);
    for (const input of await page.locator('input[name="channel"]:enabled').all()) await input.uncheck();
    await setInputValue(page, '#threshold', .8); await setInputValue(page, '#opacity', .2);
    await setInputValue(page, '#section-slider', 9);
    await page.locator('input.section-visible[data-section-id="' + sectionId(3) + '"]').uncheck();
    await paint(page);
    assert.deepEqual(await currentResult(page), initial, '3D molecule choices, cutoffs and visibility do not alter statistical data');
    assert.equal(await page.locator('[data-analysis-molecule="Histamine-DPP"]').isEnabled(), true);
    const plot = page.locator('.analysis-molecule:visible .analysis-plot');
    await plot.scrollIntoViewIfNeeded();
    const click = await plot.evaluate(node => {
      node.scrollLeft = node.scrollWidth;
      const canvas = node.querySelector('canvas'), rect = canvas.getBoundingClientRect(), keys = JSON.parse(canvas.dataset.groupKeys);
      const result = Atlas3D.analysis.getState().result.channels.find(channel => channel.key === 'Histamine-DPP');
      const last = result.groups.find(group => group.key === keys.at(-1));
      return { x: rect.left + 84 + (rect.width - 104) * (keys.length - .5) / keys.length,
        y: rect.top + 100, id: last.sectionId, scrollLeft: node.scrollLeft };
    });
    await page.mouse.click(click.x, click.y);
    await page.waitForFunction(id => Atlas3D.sections[Atlas3D.selected].id === id, click.id); await paint(page);
    assert.deepEqual(await currentResult(page), initial, 'selecting a ranked box does not rescope or recompute the 48-section result');
    assert.equal(await plot.evaluate(node => node.scrollLeft), click.scrollLeft);
    assert.match(await page.locator('#analysis-sample-scope').innerText(), /48/);
    const table = page.locator('.analysis-molecule:visible .analysis-table-details');
    await table.locator('summary').click();
    await page.locator('.analysis-molecule:visible tr[data-section-id="' + sectionId(26) + '"] .analysis-section-link').click();
    await page.waitForFunction(id => Atlas3D.sections[Atlas3D.selected].id === id, sectionId(26));
    assert.equal((await currentResult(page)).selection.count, 48);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('mouse analysis restores series-specific display state and cancels obsolete mode/series results without changing marmoset ROI defaults', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), { page } = h;
  try {
    await seedMouseAnalysis(h);
    await page.goto(h.baseURL + '/stack3d/index.html?series=' + SERIES); await ready(page); await switchMode(page, 'raw');
    await page.locator('[data-analysis-molecule="' + STANDARD + '"]').click(); await paint(page);
    assert.equal(await page.locator('.analysis-molecule:visible').getAttribute('data-channel'), STANDARD);
    await switchMode(page, 'normalized');
    assert.equal(await page.locator('.analysis-molecule:visible').getAttribute('data-channel'), 'Serotonin-DPP');
    assert.match(await page.locator('#analysis-channel-note').innerText(), /原値|内部標準|QC/);
    assert.ok(!(await currentResult(page)).channels.some(channel => channel.key === STANDARD));
    await page.locator('[data-analysis-molecule="Norepinephrine-DPP"]').click();
    await page.locator('#analysis-axis-mode').selectOption('full');
    await page.locator('#analysis-toolbar-toggle').click();
    await page.locator('#series-select').selectOption('legacy_marmoset'); await ready(page, { series: 'legacy_marmoset', count: 1 });
    const legacy = await page.evaluate(() => Atlas3D.analysis.getState());
    assert.equal(legacy.mode, 'selected'); assert.equal(legacy.activeMolecule, 'DA'); assert.equal(legacy.sampleScope, 'roi');
    assert.equal(legacy.toolbarMinimized, false); assert.equal(legacy.axisMode, 'auto');
    await page.locator('[data-analysis-mode="pooled"]').click(); await ready(page, { series: 'legacy_marmoset', count: 3, mode: 'pooled' });
    await page.locator('[data-analysis-molecule="NE"]').click();
    await page.locator('#series-select').selectOption(SERIES); await ready(page);
    let mouse = await page.evaluate(() => Atlas3D.analysis.getState());
    assert.equal(mouse.activeMolecule, 'Norepinephrine-DPP'); assert.equal(mouse.axisMode, 'full'); assert.equal(mouse.toolbarMinimized, true);
    assert.equal(mouse.mode, 'by-section'); assert.equal(mouse.result.selection.count, 48);
    await page.reload(); await ready(page);
    mouse = await page.evaluate(() => Atlas3D.analysis.getState());
    assert.equal(mouse.activeMolecule, 'Norepinephrine-DPP'); assert.equal(mouse.axisMode, 'full'); assert.equal(mouse.toolbarMinimized, true);
    await page.evaluate(() => {
      const select = document.querySelector('#value-mode');
      for (const mode of ['raw', 'normalized', 'raw', 'normalized']) {
        select.value = mode; select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await ready(page, { valueMode: 'normalized' });
    assert.deepEqual((await currentResult(page)).channels.map(channel => channel.key), ANALYTES.slice(0, 5));
    // Begin a different mode and immediately switch species, before the queued computation can finish.
    await page.evaluate(() => {
      const values = document.querySelector('#value-mode'); values.value = 'raw';
      values.dispatchEvent(new Event('change', { bubbles: true }));
      const series = document.querySelector('#series-select'); series.value = 'legacy_marmoset';
      series.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await ready(page, { series: 'legacy_marmoset', count: 3, mode: 'pooled' });
    const finalLegacy = await page.evaluate(() => Atlas3D.analysis.getState());
    assert.equal(finalLegacy.activeMolecule, 'NE'); assert.equal(finalLegacy.sampleScope, 'roi');
    assert.deepEqual(finalLegacy.result.channels.map(channel => channel.key), ['DA', 'NE', '5-HT']);
    assert.ok(finalLegacy.result.selection.sectionIds.every(id => id.startsWith('analysis-section-')));
    // Switching from another series' normalized view must not prematurely
    // discard the mouse raw-QC selection while its saved raw mode is loading.
    await page.locator('#value-mode').selectOption('normalized');
    await ready(page, { series: 'legacy_marmoset', count: 3, mode: 'pooled', valueMode: 'normalized' });
    await page.locator('#series-select').selectOption(SERIES); await ready(page);
    await switchMode(page, 'raw');
    await page.locator('#analysis-molecule-select').selectOption(STANDARD); await paint(page);
    assert.equal(await page.locator('.analysis-molecule:visible').getAttribute('data-channel'), STANDARD);
    await page.locator('#series-select').selectOption('legacy_marmoset');
    await ready(page, { series: 'legacy_marmoset', count: 3, mode: 'pooled', valueMode: 'normalized' });
    await page.locator('#series-select').selectOption(SERIES); await ready(page, { valueMode: 'raw' });
    assert.equal(await page.locator('.analysis-molecule:visible').getAttribute('data-channel'), STANDARD);
    assert.equal((await page.evaluate(() => Atlas3D.analysis.getState())).activeMolecule, STANDARD);
    await page.reload(); await ready(page, { valueMode: 'raw' });
    assert.equal(await page.locator('.analysis-molecule:visible').getAttribute('data-channel'), STANDARD);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('mouse molecule with no measured values remains an unavailable last box and reports zero measured sections', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), { page } = h;
  try {
    await seedMouseAnalysis(h, { emptyChannelSection: 7 });
    await page.goto(h.baseURL + '/stack3d/index.html?series=' + SERIES); await ready(page); await switchMode(page, 'raw');
    await page.locator('[data-analysis-molecule="Histamine-DPP"]').click(); await paint(page);
    const result = await currentResult(page), channel = result.channels.find(channel => channel.key === 'Histamine-DPP');
    const missing = channel.groups.find(group => group.sectionId === sectionId(7));
    assert.equal(channel.groups.length, 48); assert.equal(missing.distribution, null);
    assert.equal(missing.counts.nMeasured, 0); assert.equal(missing.counts.includedSections, 0);
    assert.equal(missing.counts.nIncluded, 0); assert.equal(missing.counts.targetSections, 1);
    const lastKey = await page.locator('.analysis-molecule:visible canvas').evaluate(canvas => JSON.parse(canvas.dataset.groupKeys).at(-1));
    assert.equal(lastKey, missing.key, 'a missing measurement stays in the requested 48-section comparison');
    await page.locator('.analysis-molecule:visible .analysis-table-details > summary').click();
    const row = page.locator('.analysis-molecule:visible tr[data-section-id="' + sectionId(7) + '"]');
    assert.match(await row.locator('[data-stat="sections"]').innerText(), /^1\s*\/\s*0\s*\/\s*0$/);
    assert.match(await row.locator('[data-stat="median"]').innerText(), /算出不可/);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
