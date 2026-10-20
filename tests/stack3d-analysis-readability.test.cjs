'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');
const { seedAnalysisStack, readyAnalysisStack } = require('./stack3d-analysis-fixture.cjs');

// Hash every stored raster byte in the browser. Sending millions of individual
// byte values through Playwright makes the large, realistic fixture time out.
async function scientificDigest(page) {
  return page.evaluate(async () => {
    const projects = (await ProjectStorage.listProjects()).sort((a, b) => a.id.localeCompare(b.id));
    const rasters = {};
    for (const project of projects) for (const molecule of project.molecules) {
      const values = await ProjectStorage.getValueRaster(molecule.blobId);
      const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      rasters[project.id + ':' + molecule.key] = { byteLength: bytes.byteLength,
        sha256: Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('') };
    }
    return { projects, rasters };
  });
}

async function paint(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function settled(page, mode, count) {
  await paint(page);
  await page.waitForFunction(({ mode, count }) => {
    const s = Atlas3D.analysis.getState();
    return s.result?.mode === mode && s.result.selection.count === count && document.querySelector('#analysis-panel').getAttribute('aria-busy') === 'false';
  }, { mode, count });
}
async function pooledSubset(page) {
  await page.locator('[data-analysis-mode="pooled"]').click();
  await page.locator('#analysis-conditions-summary').click();
  await page.locator('#analysis-range').fill('5-20');
  await page.locator('#analysis-apply-range').click();
  await settled(page, 'pooled', 16);
}
async function visibleMolecule(page) {
  return page.locator('.analysis-molecule:visible').evaluateAll(cards => cards.map(card => card.dataset.channel));
}
async function assertNoOverflow(page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return { width: doc.clientWidth, scroll: doc.scrollWidth, elements: [...document.querySelectorAll('#analysis-panel, #analysis-body, #analysis-charts, .analysis-minibar, .analysis-molecule:not([hidden])')]
      .filter(node => node.getBoundingClientRect().width > 0 && node.scrollWidth > node.clientWidth + 1).map(node => node.id || node.className) };
  });
  assert.equal(overflow.width, overflow.scroll); assert.deepEqual(overflow.elements, []);
}

test('molecule tabs, automatic axes and minimized toolbar change presentation only and restore applied conditions', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await seedAnalysisStack(h, { width: 125, height: 106 });
    const source = await scientificDigest(page);
    await page.goto(h.baseURL + '/stack3d/index.html'); await readyAnalysisStack(page);
    await pooledSubset(page);
    // Leave an unapplied edit: compact summary must describe the actual result.
    await page.locator('#analysis-range').fill('25-30');
    await page.locator('#analysis-conditions-summary').click();
    const before = await page.evaluate(() => ({ generation: Atlas3D.analysis.getState().generation,
      result: JSON.stringify(Atlas3D.analysis.getState().result), camera: Atlas3D.renderer.getView(),
      channels: [...document.querySelectorAll('input[name=channel]')].map(input => input.checked) }));
    assert.deepEqual(await visibleMolecule(page), ['DA']);
    const autoDomain = await page.locator('.analysis-molecule:visible canvas').getAttribute('data-axis-domain');
    await page.locator('#analysis-axis-mode').selectOption('full'); await paint(page);
    const fullDomain = JSON.parse(await page.locator('.analysis-molecule:visible canvas').getAttribute('data-axis-domain'));
    assert.ok(fullDomain[1] > JSON.parse(autoDomain)[1], 'full range reveals high tail');
    await page.locator('#analysis-axis-mode').selectOption('auto'); await paint(page);
    assert.equal(await page.locator('.analysis-molecule:visible canvas').getAttribute('data-axis-domain'), autoDomain);
    await page.locator('[data-analysis-molecule="NE"]').click(); await paint(page);
    assert.deepEqual(await visibleMolecule(page), ['NE']);
    const expandedHeight = (await page.locator('.analysis-molecule:visible canvas').boundingBox()).height;
    await page.locator('#analysis-toolbar-toggle').click(); await paint(page);
    assert.equal(await page.locator('.analysis-controls').isVisible(), false);
    assert.match(await page.locator('#analysis-mini-summary').innerText(), /5.?20/);
    assert.doesNotMatch(await page.locator('#analysis-mini-summary').innerText(), /25.?30/);
    const minimizedHeight = (await page.locator('.analysis-molecule:visible canvas').boundingBox()).height;
    assert.ok(minimizedHeight > expandedHeight, 'minimizing gives height to the chart');
    await page.locator('#analysis-molecule-select').selectOption('5-HT'); await paint(page);
    assert.deepEqual(await visibleMolecule(page), ['5-HT']);
    await page.locator('#analysis-mini-focus').click(); await paint(page);
    assert.equal(await page.locator('#scene').isVisible(), false);
    const wide = await page.locator('.analysis-molecule:visible canvas').boundingBox(); assert.ok(wide.width > 1800);
    await page.keyboard.press('Escape'); await paint(page);
    assert.equal(await page.locator('#scene').isVisible(), true);
    assert.equal(await page.evaluate(() => !!document.activeElement.getBoundingClientRect().width), true, 'focus returns to a visible control');
    await assertNoOverflow(page);
    const after = await page.evaluate(() => ({ generation: Atlas3D.analysis.getState().generation,
      result: JSON.stringify(Atlas3D.analysis.getState().result), camera: Atlas3D.renderer.getView(),
      channels: [...document.querySelectorAll('input[name=channel]')].map(input => input.checked) }));
    assert.deepEqual(after, before, 'display actions do not recompute or mutate scientific/3D state');
    await page.reload(); await readyAnalysisStack(page); await paint(page);
    assert.equal(await page.locator('#analysis-toolbar-expand').isVisible(), true);
    assert.deepEqual(await visibleMolecule(page), ['5-HT']);
    assert.match(await page.locator('#analysis-mini-summary').innerText(), /5.?20/);
    await page.evaluate(() => Atlas3D.analysis.markStale());
    assert.equal(await page.locator('#analysis-stale').isVisible(), true);
    await page.locator('#analysis-toolbar-expand').click();
    assert.equal(await page.locator('#analysis-toolbar-toggle').isVisible(), true);
    await page.locator('#analysis-collapse').click(); assert.equal(await page.locator('.analysis-body').isVisible(), false);
    await page.locator('#analysis-collapse').click(); assert.equal(await page.locator('.analysis-body').isVisible(), true);
    assert.deepEqual(await scientificDigest(page), source); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('69 sections remain in a ranked single row with plot-only scrolling and stable section selection', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seedAnalysisStack(h); await page.goto(h.baseURL + '/stack3d/index.html'); await readyAnalysisStack(page);
    await page.locator('[data-analysis-mode="by-section"]').click(); await settled(page, 'by-section', 69);
    const originalResult = await page.evaluate(() => JSON.stringify(Atlas3D.analysis.getState().result));
    const plot = page.locator('.analysis-molecule:visible .analysis-plot');
    await plot.scrollIntoViewIfNeeded();
    const click = await plot.evaluate(node => {
      node.scrollLeft = node.scrollWidth;
      const canvas = node.querySelector('canvas'), rect = canvas.getBoundingClientRect();
      const keys = JSON.parse(canvas.dataset.groupKeys), result = Atlas3D.analysis.getState().result.channels[0];
      const lastKey = keys.at(-1), lastGroup = result.groups.find(group => group.key === lastKey);
      return { x: rect.left + 84 + (rect.width - 104) * (keys.length - .5) / keys.length,
        y: rect.top + 100, sectionId: lastGroup.sectionId, scrollLeft: node.scrollLeft };
    });
    await page.mouse.click(click.x, click.y);
    await page.waitForFunction(id => Atlas3D.sections[Atlas3D.selected].id === id, click.sectionId);
    await paint(page);
    assert.ok(click.scrollLeft > 0);
    assert.equal(await plot.evaluate(node => node.scrollLeft), click.scrollLeft, 'selection does not jump back to the first group');
    assert.equal(await page.evaluate(() => JSON.stringify(Atlas3D.analysis.getState().result)), originalResult);
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 761, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); await paint(page);
      const plots = await page.locator('.analysis-molecule:visible canvas').evaluateAll(nodes => nodes.map(node => ({
        domain: node.dataset.axisDomain, keys: JSON.parse(node.dataset.groupKeys),
        width: node.getBoundingClientRect().width, available: node.parentElement.clientWidth, height: node.getBoundingClientRect().height
      })));
      assert.equal(plots.length, 1);
      assert.equal(new Set(plots.flatMap(p => p.keys)).size, 69);
      for (const plot of plots) { assert.ok(plot.width > plot.available); assert.ok(plot.height >= 280); }
      const ranking = await page.evaluate(() => {
        const card = document.querySelector('.analysis-molecule:not([hidden])');
        const keys = JSON.parse(card.querySelector('canvas').dataset.groupKeys);
        const groups = Atlas3D.analysis.getState().result.channels.find(channel => channel.key === card.dataset.channel).groups;
        return { medians: keys.map(key => groups.find(group => group.key === key).distribution.median),
          keys, tableKeys: [...card.querySelectorAll('tbody tr')].map(row => row.dataset.groupKey) };
      });
      assert.deepEqual(ranking.keys, ranking.tableKeys);
      assert.ok(ranking.medians.every((median, index) => !index || ranking.medians[index - 1] >= median));
      await assertNoOverflow(page);
      if (viewport.width === 761) {
        await page.locator('#analysis-toolbar-toggle').click(); await paint(page);
        await assertNoOverflow(page);
        const bounds = await page.locator('.analysis-minibar').evaluate(bar => {
          const outer = bar.getBoundingClientRect();
          return ['analysis-molecule-select', 'analysis-mini-focus', 'analysis-toolbar-expand'].map(id => {
            const child = document.getElementById(id).getBoundingClientRect();
            return { id, visible: child.width > 0 && child.height > 0,
              inside: child.left >= outer.left && child.right <= outer.right };
          });
        });
        assert.ok(bounds.every(control => control.visible && control.inside), JSON.stringify(bounds));
        await page.locator('#analysis-toolbar-expand').click(); await paint(page);
      }
    }
    await page.locator('#analysis-toolbar-toggle').click();
    assert.equal(await page.locator('#analysis-mini-focus').isVisible(), false, 'desktop-only action is absent on mobile');
    await page.locator('#analysis-molecule-select').selectOption('NE'); await paint(page);
    assert.deepEqual(await visibleMolecule(page), ['NE']); await assertNoOverflow(page);
    await page.evaluate(() => Atlas3D.analysis.beginLoad());
    assert.equal(await page.locator('#analysis-status').isVisible(), true);
    await page.evaluate(() => Atlas3D.analysis.loadFailed('Synthetic load failure'));
    assert.equal(await page.locator('#analysis-status').isVisible(), true);
    assert.match(await page.locator('#analysis-status').innerText(), /Synthetic load failure/);
    assert.equal(await page.locator('#analysis-charts canvas').count(), 0);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('17 complete ROI names render in one row without n labels; all modes and value modes rank without changing source data', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await page.setViewportSize({ width: 1366, height: 900 });
    await seedAnalysisStack(h, { count: 3, width: 34, height: 8, missingCorrection: false });
    const names = ['Blood vessel', 'Caudate', 'Cingulate', 'Geniculate nucleus', 'Habenula', 'Hippocampus',
      'Interpeduncular nucleus', 'Midbrain', 'Occipital lobe', 'Parietal lobe', 'Periaqueductal gray',
      'Pons', 'Red nucleus', 'Substantia nigra', 'Temporal lobe', 'Thalamus', 'White matter'];
    await page.evaluate(async names => {
      for (const project of await ProjectStorage.listProjects()) {
        const roi = { roi_names: {}, roi_items: {}, palette: {}, roi_show_flags: {} };
        names.forEach((name, index) => {
          const key = 'region-' + index, x = index * 2 - .5;
          roi.roi_names[key] = name; roi.roi_items[key] = [{ poly_msi: [[x, -.5], [x + 2, -.5], [x + 2, 7.5], [x, 7.5]] }];
          roi.palette[key] = [125, 255, 125]; roi.roi_show_flags[key] = true;
        });
        project.roi = roi; await ProjectStorage.putProject(project);
      }
    }, names);
    const source = await scientificDigest(page);
    await page.addInitScript(() => {
      const proto = CanvasRenderingContext2D.prototype, fillText = proto.fillText, setTransform = proto.setTransform;
      proto.setTransform = function (...args) { this.canvas.__labelCalls = []; return setTransform.apply(this, args); };
      proto.fillText = function (text, x, y, ...rest) {
        (this.canvas.__labelCalls ||= []).push({ text: String(text), x, y, width: this.measureText(text).width });
        return fillText.call(this, text, x, y, ...rest);
      };
    });
    await page.goto(h.baseURL + '/stack3d/index.html'); await readyAnalysisStack(page, 3); await paint(page);
    for (const mode of ['selected', 'pooled']) {
      await page.locator('button[data-analysis-mode="' + mode + '"]').click(); await settled(page, mode, mode === 'selected' ? 1 : 3);
      for (const valueMode of ['raw', 'normalized']) {
        await page.locator('#value-mode').selectOption(valueMode);
        await page.waitForFunction(value => Atlas3D.analysis.getState().result?.valueMode === value &&
          document.querySelector('#analysis-panel').getAttribute('aria-busy') === 'false', valueMode);
        for (const channel of ['DA', 'NE', '5-HT']) {
          await page.locator('[data-analysis-molecule="' + channel + '"]').click(); await paint(page);
          const state = await page.locator('.analysis-molecule:visible').evaluate(card => {
            const canvas = card.querySelector('canvas'), result = Atlas3D.analysis.getState().result;
            const groups = result.channels.find(item => item.key === card.dataset.channel).groups;
            const keys = JSON.parse(canvas.dataset.groupKeys), width = parseFloat(canvas.style.width), height = parseFloat(canvas.style.height);
            const slot = (width - 104) / keys.length;
            return { canvasCount: card.querySelectorAll('canvas').length, keys,
              sourceKeys: groups.map(group => group.key), tableKeys: [...card.querySelectorAll('tbody tr')].map(row => row.dataset.groupKey),
              labels: keys.map((key, index) => {
                const x = 84 + slot * (index + .5), group = groups.find(group => group.key === key);
                const calls = canvas.__labelCalls.filter(call => Math.abs(call.x - x) < .1 && call.y > height - 90);
                return { name: group.name, median: group.distribution.median, text: calls.map(call => call.text).join(' '),
                  fit: calls.every(call => call.width <= slot - 8 && call.y < height - 5) };
              }) };
          });
          assert.equal(state.canvasCount, 1); assert.equal(state.keys.length, 17);
          assert.deepEqual(state.keys, state.tableKeys);
          assert.ok(state.labels.every((label, index) => !index || state.labels[index - 1].median >= label.median));
          assert.notDeepEqual(state.keys, state.sourceKeys, 'presentation leaves the alphabetical scientific result in its original order');
          for (const label of state.labels) {
            assert.equal(label.text.replace(/\s/g, ''), label.name.replace(/\s/g, ''));
            assert.ok(label.fit); assert.doesNotMatch(label.text, /…|n = /);
          }
          await assertNoOverflow(page);
        }
      }
    }
    assert.deepEqual(await scientificDigest(page), source); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
