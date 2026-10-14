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
    return { width: doc.clientWidth, scroll: doc.scrollWidth, elements: [...document.querySelectorAll('#analysis-panel, #analysis-body, #analysis-charts, .analysis-minibar, .analysis-molecule:not([hidden]), .analysis-plot')]
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

test('many sections wrap on one molecule with a shared axis, no horizontal scroll and usable narrow-screen errors', { timeout: 120000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await seedAnalysisStack(h); await page.goto(h.baseURL + '/stack3d/index.html'); await readyAnalysisStack(page);
    await page.locator('[data-analysis-mode="by-section"]').click(); await settled(page, 'by-section', 69);
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 761, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); await paint(page);
      const plots = await page.locator('.analysis-molecule:visible canvas').evaluateAll(nodes => nodes.map(node => ({
        domain: node.dataset.axisDomain, keys: JSON.parse(node.dataset.groupKeys),
        width: node.getBoundingClientRect().width, available: node.parentElement.clientWidth, height: node.getBoundingClientRect().height
      })));
      assert.ok(plots.length > 1); assert.equal(new Set(plots.map(p => p.domain)).size, 1);
      assert.equal(new Set(plots.flatMap(p => p.keys)).size, 69);
      for (const plot of plots) { assert.ok(Math.abs(plot.width - plot.available) <= 1); assert.ok(plot.height >= 280); }
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
