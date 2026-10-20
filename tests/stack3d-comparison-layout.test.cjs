'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');
const { seedAnalysisStack, readyAnalysisStack, scientificSnapshot } = require('./stack3d-analysis-fixture.cjs');

async function paint(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function orientation(page, expected) {
  await page.waitForFunction(expected => Atlas3D.analysis.getState().layout.orientation === expected, expected);
  await paint(page);
}
async function geometry(page) {
  return page.evaluate(() => {
    const bounds = selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
    };
    return { host: bounds('.scene-panel'), scene: bounds('.scene-viewport'), panel: bounds('#analysis-panel'),
      handle: bounds('#analysis-resizer'), scrubber: bounds('.slice-scrubber') };
  });
}
async function presentationIndependentState(page) {
  return page.evaluate(() => ({
    result: JSON.stringify(Atlas3D.analysis.getState().result),
    generation: Atlas3D.analysis.getState().generation,
    selected: Atlas3D.selected,
    camera: Atlas3D.renderer.getView(),
    channels: [...document.querySelectorAll('input[name=channel]')].map(input => [input.value, input.checked]),
    domain: document.querySelector('.analysis-molecule:not([hidden]) canvas')?.dataset.axisDomain,
    keys: document.querySelector('.analysis-molecule:not([hidden]) canvas')?.dataset.groupKeys
  }));
}
function sameScientificAndCameraState(after, before) {
  for (const field of ['position', 'target', 'up']) {
    before.camera[field].forEach((value, index) => {
      assert.ok(Math.abs(after.camera[field][index] - value) < 1e-8, 'layout must preserve camera ' + field);
    });
  }
  assert.equal(after.camera.zoom, before.camera.zoom);
  assert.deepEqual({ ...after, camera: null }, { ...before, camera: null },
    'layout must preserve statistical results, their generation, section selection, channels, axis and ranking');
}
async function noPageOverflow(page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return { width: root.clientWidth, scroll: root.scrollWidth,
      panels: [...document.querySelectorAll('#analysis-panel, #analysis-body, #analysis-charts, .analysis-minibar')]
        .filter(node => node.getBoundingClientRect().width > 0 && node.scrollWidth > node.clientWidth + 1)
        .map(node => node.id || node.className) };
  });
  assert.equal(overflow.scroll, overflow.width, 'only the plot may scroll horizontally');
  assert.deepEqual(overflow.panels, []);
}
async function openSmallStack(h) {
  await h.page.setViewportSize({ width: 1920, height: 1080 });
  await seedAnalysisStack(h, { count: 5, missingCorrection: false });
  await h.page.goto(h.baseURL + '/stack3d/index.html');
  await readyAnalysisStack(h.page, 5);
  await orientation(h.page, 'side');
}

test('wide screens place the unchanged 3D and ranked analysis beside each other; both layout controls work', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await openSmallStack(h);
    const source = await scientificSnapshot(page), before = await presentationIndependentState(page);
    let boxes = await geometry(page);
    assert.ok(boxes.host.width >= 1000);
    assert.ok(Math.abs(boxes.panel.width / boxes.host.width - .6) < .02, 'analysis starts at 60 percent');
    assert.ok(boxes.panel.x >= boxes.scene.right - 1, 'chart is to the right of 3D');
    assert.ok(Math.abs(boxes.panel.y - boxes.scene.y) <= 1, 'panels share their upper edge');
    assert.ok(boxes.scene.height > 700, '3D uses the available vertical space');
    assert.ok(boxes.scrubber.right <= boxes.panel.x + 1, 'section navigation stays below 3D');
    assert.equal(await page.locator('#analysis-resizer').getAttribute('aria-orientation'), 'vertical');
    assert.ok(boxes.handle.height > boxes.handle.width);

    await page.locator('#analysis-layout-toggle').click(); await orientation(page, 'stacked');
    boxes = await geometry(page);
    assert.ok(boxes.panel.y >= boxes.scene.bottom, 'stacked chart is below 3D');
    assert.ok(Math.abs(boxes.panel.width - boxes.host.width) <= 1);
    assert.equal(await page.locator('#analysis-resizer').getAttribute('aria-orientation'), 'horizontal');
    await page.locator('#analysis-toolbar-toggle').click(); await paint(page);
    assert.equal(await page.locator('#analysis-mini-layout-toggle').isVisible(), true);
    await page.locator('#analysis-mini-layout-toggle').click(); await orientation(page, 'side');
    await page.locator('#analysis-toolbar-expand').click(); await paint(page);
    assert.equal(await page.locator('#analysis-layout-toggle').isVisible(), true);
    await noPageOverflow(page);
    sameScientificAndCameraState(await presentationIndependentState(page), before);
    assert.deepEqual(await scientificSnapshot(page), source);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('vertical resizing supports pointer, keyboard, bounds and reset, and restores its ratio after reload and focus', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await openSmallStack(h);
    const before = await presentationIndependentState(page);
    const handle = page.locator('#analysis-resizer');
    let boxes = await geometry(page), originalWidth = boxes.panel.width;
    await handle.focus(); await page.keyboard.press('ArrowLeft'); await paint(page);
    assert.ok((await geometry(page)).panel.width > originalWidth + 5, 'Left increases the right-hand panel');
    await page.keyboard.press('ArrowRight'); await paint(page);
    assert.ok(Math.abs((await geometry(page)).panel.width - originalWidth) <= 1);
    await page.keyboard.press('Home'); await paint(page);
    let now = Number(await handle.getAttribute('aria-valuenow'));
    assert.ok(Math.abs(now - Number(await handle.getAttribute('aria-valuemin'))) <= 1);
    await page.keyboard.press('End'); await paint(page);
    now = Number(await handle.getAttribute('aria-valuenow'));
    assert.ok(Math.abs(now - Number(await handle.getAttribute('aria-valuemax'))) <= 1);
    await handle.dblclick(); await paint(page);
    assert.ok(Math.abs((await geometry(page)).panel.width - originalWidth) <= 1, 'double-click restores 40/60');

    boxes = await geometry(page);
    const x = boxes.handle.x + boxes.handle.width / 2, y = boxes.handle.y + boxes.handle.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 60, y, { steps: 6 }); await page.mouse.up();
    await paint(page);
    const changedWidth = (await geometry(page)).panel.width;
    assert.ok(changedWidth > originalWidth + 40, 'dragging the divider left enlarges the chart');
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('resizing-analysis-panel')), false);
    const ratio = await page.evaluate(() => Atlas3D.analysis.getState().layout.ratio);
    await page.locator('#analysis-collapse').click(); await paint(page);
    assert.equal(await page.locator('.analysis-body').isVisible(), false);
    assert.equal(await handle.isVisible(), false);
    await page.locator('#analysis-collapse').click(); await orientation(page, 'side');
    assert.ok(Math.abs((await geometry(page)).panel.width - changedWidth) <= 1, 'collapse preserves the chosen ratio');

    await page.locator('#analysis-expand').click(); await paint(page);
    assert.ok((await geometry(page)).panel.width >= changedWidth);
    await page.locator('#analysis-expand').click(); await paint(page);
    assert.ok(Math.abs((await geometry(page)).panel.width - changedWidth) <= 1, 'width expansion can be undone');
    await page.locator('#analysis-toolbar-toggle').click(); await page.locator('#analysis-mini-focus').click(); await paint(page);
    assert.equal(await page.locator('#scene').isVisible(), false);
    assert.ok((await geometry(page)).panel.width > 1800);
    assert.equal(await page.locator('#analysis-mini-layout-toggle').isVisible(), false);
    await page.keyboard.press('Escape'); await orientation(page, 'side');
    assert.equal(await page.locator('#scene').isVisible(), true);
    assert.equal(await page.locator('#analysis-mini-focus').evaluate(node => document.activeElement === node), true);
    assert.ok(Math.abs((await geometry(page)).panel.width - changedWidth) <= 1);
    sameScientificAndCameraState(await presentationIndependentState(page), before);

    await page.reload(); await readyAnalysisStack(page, 5); await orientation(page, 'side');
    assert.equal(await page.evaluate(() => Atlas3D.analysis.getState().layout.ratio), ratio);
    assert.ok(Math.abs((await geometry(page)).panel.width - changedWidth) <= 1);
    await page.locator('#analysis-mini-layout-toggle').click(); await orientation(page, 'stacked');
    await page.reload(); await readyAnalysisStack(page, 5); await orientation(page, 'stacked');
    assert.equal(await page.evaluate(() => Atlas3D.analysis.getState().layout.layout), 'stacked',
      'an explicit stacked preference survives a reload on a wide screen');
    await noPageOverflow(page);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('automatic fallback follows usable panel width without overwriting the side preference or overflowing on mobile', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await openSmallStack(h);
    const before = await presentationIndependentState(page);
    await page.setViewportSize({ width: 1366, height: 900 }); await orientation(page, 'stacked');
    assert.ok((await geometry(page)).host.width < 1000);
    assert.equal(await page.evaluate(() => Atlas3D.analysis.getState().layout.layout), 'side');
    await page.locator('#controls-toggle').click(); await orientation(page, 'side');
    assert.ok((await geometry(page)).host.width >= 1000,
      'sidebar collapse can enable comparison without a viewport resize');
    await page.locator('#controls-toggle').click(); await orientation(page, 'stacked');
    await page.setViewportSize({ width: 1920, height: 1080 }); await orientation(page, 'side');
    await page.locator('#analysis-toolbar-toggle').click(); await paint(page);
    for (const viewport of [{ width: 761, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport); await orientation(page, 'stacked');
      await noPageOverflow(page);
      assert.equal(await page.evaluate(() => Atlas3D.analysis.getState().layout.layout), 'side');
      if (viewport.width === 390) {
        assert.equal(await page.locator('#analysis-resizer').isVisible(), false);
        assert.equal(await page.locator('#analysis-mini-focus').isVisible(), false);
      }
      const toolbar = await page.locator('.analysis-minibar').evaluate(bar => {
        const outer = bar.getBoundingClientRect();
        return [...bar.querySelectorAll('button,select')].filter(node => node.getBoundingClientRect().width > 0)
          .map(node => {
            const inner = node.getBoundingClientRect();
            return { id: node.id, inside: inner.left >= outer.left - 1 && inner.right <= outer.right + 1 };
          });
      });
      assert.ok(toolbar.every(control => control.inside), JSON.stringify(toolbar));
    }
    await page.setViewportSize({ width: 1920, height: 1080 }); await orientation(page, 'side');
    sameScientificAndCameraState(await presentationIndependentState(page), before);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('long ranked section plots keep all groups in one row with plot-only scrolling in comparison mode', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness(), page = h.page;
  try {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await seedAnalysisStack(h, { count: 48, missingCorrection: false });
    await page.goto(h.baseURL + '/stack3d/index.html'); await readyAnalysisStack(page, 48); await orientation(page, 'side');
    await page.locator('[data-analysis-mode="by-section"]').click();
    await page.waitForFunction(() => Atlas3D.analysis.getState().result?.mode === 'by-section' &&
      Atlas3D.analysis.getState().result.selection.count === 48 && !Atlas3D.analysis.getState().loading);
    await paint(page);
    const result = await page.evaluate(() => JSON.stringify(Atlas3D.analysis.getState().result));
    const plot = page.locator('.analysis-molecule:visible .analysis-plot');
    const ranked = await plot.evaluate(node => {
      const canvas = node.querySelector('canvas'), keys = JSON.parse(canvas.dataset.groupKeys);
      const groups = Atlas3D.analysis.getState().result.channels.find(channel =>
        channel.key === node.closest('.analysis-molecule').dataset.channel).groups;
      return { count: node.querySelectorAll('canvas').length, keys, medians: keys.map(key => groups.find(group => group.key === key).distribution.median),
        width: node.clientWidth, content: node.scrollWidth };
    });
    assert.equal(ranked.count, 1); assert.equal(ranked.keys.length, 48); assert.equal(new Set(ranked.keys).size, 48);
    assert.ok(ranked.content > ranked.width);
    assert.ok(ranked.medians.every((median, index) => !index || ranked.medians[index - 1] >= median));
    await plot.scrollIntoViewIfNeeded();
    const click = await plot.evaluate(node => {
      node.scrollLeft = node.scrollWidth;
      const canvas = node.querySelector('canvas'), box = canvas.getBoundingClientRect(), keys = JSON.parse(canvas.dataset.groupKeys);
      const channel = node.closest('.analysis-molecule').dataset.channel;
      const group = Atlas3D.analysis.getState().result.channels.find(item => item.key === channel).groups.find(item => item.key === keys.at(-1));
      return { x: box.left + 84 + (box.width - 104) * (keys.length - .5) / keys.length,
        y: box.top + 100, sectionId: group.sectionId, scroll: node.scrollLeft };
    });
    await page.mouse.click(click.x, click.y);
    await page.waitForFunction(id => Atlas3D.sections[Atlas3D.selected].id === id, click.sectionId);
    await paint(page);
    assert.equal(await plot.evaluate(node => node.scrollLeft), click.scroll);
    assert.equal(await page.evaluate(() => JSON.stringify(Atlas3D.analysis.getState().result)), result);
    await noPageOverflow(page);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
