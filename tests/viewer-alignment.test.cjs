'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

const T = [[0.41, 0.075, 4.123456789012345], [-0.035, 0.36, 5.234567890123456], [0, 0, 1]];

const S = [[0.45, 0, 8], [0, 0.45, 5], [0, 0, 1]];
const fixturePoints = [[8, 10], [90, 10], [14, 65], [88, 67], [42, 21], [55, 53]];

async function openFixture(h, id, { matrix = T, points = fixturePoints } = {}) {
  await seedViewerProject(h.page, h.baseURL, { id });
  await h.page.evaluate(async ({ id, matrix, points }) => {
    const p = await ProjectStorage.getProject(id);
    delete p.normalization;
    p.valueDisplay = { mode: 'raw', scale: 'individual' };
    p.grid = { W: 64, H: 48, umPerPxX: 20, umPerPxY: 30 };
    p.world_coords = { T_he_to_msi: matrix, msi_um_per_px: { x: 20, y: 30 } };
    p.molecules = [];
    for (const [key, name, scale] of [
      ['MSI_GABA-DPP', 'GABA-DPP', 1000], ['MSI_Histamine-DPP', 'Histamine-DPP', 2],
      ['MSI_Dopamine-DPP', 'Dopamine-DPP', 8], ['MSI_Norepinephrine-DPP', 'Norepinephrine-DPP', 5],
      ['MSI_Serotonin-DPP', 'Serotonin-DPP', 10], ['MSI_Serotonin-d4-DPP', 'Serotonin-d4-DPP', 20],
    ]) {
      const values = Float32Array.from({ length: 64 * 48 }, (_, i) => {
        const x = i % 64, y = Math.floor(i / 64);
        if (((x - 29) / 25) ** 2 + ((y - 24) / 20) ** 2 > 1) return NaN;
        return scale * (1 + x / 64 + y / 48);
      });
      p.molecules.push({ key, name, blobId: await ProjectStorage.putValueRaster(values), stats: MSIRaster.deriveBakeStats(values) });
    }
    p.visibleLayers = ['MSI_Serotonin-DPP', 'HE_Stain'];
    const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 80;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 100, 80);
    ctx.fillStyle = '#d65498'; ctx.beginPath(); ctx.ellipse(50, 40, 45, 32, 0.12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#792e7a'; ctx.fillRect(45, 12, 5, 48);
    ctx.fillStyle = '#00c8ff'; ctx.fillRect(6, 4, 7, 9);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    p.images = { HE_Stain: { blobId: await ProjectStorage.putBlob({ blob }), filename: 'synthetic-HE.png' } };
    const he = points;
    const msi = he.map(([x, y]) => [matrix[0][0] * x + matrix[0][1] * y + matrix[0][2], matrix[1][0] * x + matrix[1][1] * y + matrix[1][2]]);
    // Intentionally stale legacy scalars: the canonical full matrix must win.
    p.alignment = { HE_Stain: { flip_lr: true, scale_pct: 1, rotate_deg: 90, offx: 0, offy: 0, landmarks: { he, msi } } };
    await ProjectStorage.putProject(p);
  }, { id, matrix, points });
  await h.page.goto(h.baseURL + '/viewer/index.html?project=' + id);
  await h.page.waitForFunction(id => typeof currentProject !== 'undefined' && currentProject?.id === id && viewerReady, id);
  await h.page.locator('#align-btn').click();
  await h.page.waitForFunction(() => document.querySelector('[data-img="preview"]')?.naturalWidth > 0);
}

async function sourceSnapshot(page) {
  const snapshot = await page.evaluate(() => ({
    roi: JSON.stringify(atlasData.roi),
    raw: Object.fromEntries(Object.entries(valueRasters).map(([k, r]) => [k, Array.from(new Uint32Array(r.values.buffer))])),
    T: structuredClone(atlasData.world_coords.T_he_to_msi),
  }));
  // Preserve bitwise comparisons without dumping tens of thousands of values
  // when a completely unrelated transform assertion fails.
  snapshot.raw = Object.fromEntries(Object.entries(snapshot.raw).map(([key, values]) =>
    [key, createHash('sha256').update(Buffer.from(new Uint32Array(values).buffer)).digest('hex')]));
  return snapshot;
}

async function nextStage(page) {
  await page.locator('[data-act="orient-next"]').click();
  await page.waitForFunction(() => document.querySelector('.alignment-modal')?.dataset.stage === '2');
}

async function frames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function clickImagePoint(page, which, point, dimensions) {
  const image = page.locator(`[data-img="${which}"]`);
  await image.evaluate(el => el.decode());
  await frames(page);
  await image.scrollIntoViewIfNeeded();
  const box = await image.boundingBox();
  assert.ok(box?.width && box?.height, `The ${which} image has a clickable area`);
  await page.evaluate(which => {
    document.addEventListener('click', event => {
      const rect = document.querySelector(`[data-img="${which}"]`).getBoundingClientRect();
      window.__alignmentTestClick = [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height];
    }, { once: true, capture: true });
  }, which);
  await image.click({ position: { x: box.width * point[0] / dimensions[0], y: box.height * point[1] / dimensions[1] } });
  const actual = await page.evaluate(() => window.__alignmentTestClick);
  await frames(page);
  return actual.map((fraction, axis) => fraction * dimensions[axis]);
}

async function pair(page, he, msi, heDimensions = [100, 80]) {
  const clickedHe = await clickImagePoint(page, 'he', he, heDimensions);
  const clickedMsi = await clickImagePoint(page, 'msi', msi, [64, 48]);
  return { he: clickedHe, msi: clickedMsi };
}

async function saveDraft(page) {
  await page.locator('[data-act="apply"]').click();
  await page.waitForFunction(() => !document.querySelector('.alignment-modal'));
  return page.evaluate(async () => {
    const p = await ProjectStorage.getProject(currentProject.id);
    return { T: p.world_coords.T_he_to_msi, a: p.alignment.HE_Stain, cloud: JSON.parse(JSON.stringify(Cloud.stateOf(p))) };
  });
}

async function openDetails(page, selector) {
  await page.locator(selector).evaluate(el => {
    for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.tagName === 'DETAILS') ancestor.open = true;
    }
  });
}

function assertMatrix(actual, expected, epsilon = 1e-8) {
  actual.forEach((row, i) => row.forEach((value, j) => {
    assert.ok(Math.abs(value - expected[i][j]) <= epsilon, `matrix[${i}][${j}]: ${value} != ${expected[i][j]}`);
  }));
}

test('legacy alignment no-op save preserves the exact canonical affine matrix and upgrades metadata without confirming orientation', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openFixture(h, 'alignment-matrix');
    const before = await sourceSnapshot(h.page);
    await h.page.locator('[data-act="apply"]').click();
    await h.page.waitForFunction(() => !document.querySelector('[data-act="apply"]'));
    const saved = await h.page.evaluate(async () => {
      const p = await ProjectStorage.getProject(currentProject.id);
      return { T: p.world_coords.T_he_to_msi, a: p.alignment.HE_Stain, cloud: JSON.parse(JSON.stringify(Cloud.stateOf(p))) };
    });
    assert.deepEqual(saved.T, T);
    assert.equal(saved.a.model, 'affine');
    assert.equal(saved.a.schemaVersion, 3);
    assert.equal(saved.a.orientation.confirmed, false);
    assert.deepEqual(saved.cloud.world_coords.T_he_to_msi, T);
    assert.deepEqual(await sourceSnapshot(h.page), before);
    await h.page.locator('#align-btn').click();
    await h.page.locator('[data-act="close"]').first().click();
    assert.deepEqual(await sourceSnapshot(h.page), before);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('numeric input updates preview without blur; blank or singular inputs keep the last preview and block saving', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openFixture(h, 'alignment-immediate');
    await nextStage(h.page);
    await openDetails(h.page, '[data-p="offx"]');
    const preview = h.page.locator('[data-img="preview"]');
    const before = await preview.getAttribute('src');
    await h.page.locator('[data-p="offx"]').fill('12');
    await h.page.waitForFunction(src => document.querySelector('[data-img="preview"]').src !== src, before);
    assert.equal(await h.page.locator('[data-p="offx"]').evaluate(el => document.activeElement === el), true);
    const valid = await preview.getAttribute('src');
    await h.page.locator('[data-p="offx"]').fill('');
    await h.page.waitForFunction(() => document.querySelector('[data-act="apply"]').disabled);
    assert.equal(await preview.getAttribute('src'), valid);
    await h.page.locator('[data-p="offx"]').fill('12');
    await h.page.waitForFunction(() => !document.querySelector('[data-act="apply"]').disabled);
    await h.page.locator('[data-p="scale_x_pct"]').fill('0');
    await h.page.waitForFunction(() => document.querySelector('[data-act="apply"]').disabled);
    assert.equal(await preview.getAttribute('src'), valid);
    await h.page.locator('[data-act="close"]').first().click();
    assert.deepEqual((await sourceSnapshot(h.page)).T, T);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('the oriented HE image and existing landmark dots rotate and reflect together while raw points stay unchanged', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openFixture(h, 'alignment-orientation');
    const before = await sourceSnapshot(h.page);
    const originalSource = await h.page.locator('[data-img="he"]').getAttribute('src');
    await h.page.locator('[data-act="orient-flip-lr"]').click();
    await frames(h.page);
    assert.notEqual(await h.page.locator('[data-img="he"]').getAttribute('src'), originalSource);
    await h.page.locator('[data-act="orient-right"]').click();
    await frames(h.page);
    const displayed = await h.page.evaluate(async () => {
      const image = document.querySelector('[data-img="he"]');
      await image.decode();
      const c = document.createElement('canvas'); c.width = image.naturalWidth; c.height = image.naturalHeight;
      c.getContext('2d').drawImage(image, 0, 0);
      const dot = document.querySelector('[data-pane="he"] [data-point="0"]');
      const imageBox = image.getBoundingClientRect(), paneBox = image.parentElement.getBoundingClientRect();
      const dotBox = dot.getBoundingClientRect();
      return { W: c.width, H: c.height, pixel: Array.from(c.getContext('2d').getImageData(71, 90, 1, 1).data),
        dot: [parseFloat(dot.style.left), parseFloat(dot.style.top)],
        paintedDot: [(dotBox.x + dotBox.width / 2 - imageBox.x) / imageBox.width * 100,
          (dotBox.y + dotBox.height / 2 - imageBox.y) / imageBox.height * 100],
        centerError: [imageBox.x + imageBox.width / 2 - paneBox.x - paneBox.width / 2,
          imageBox.y + imageBox.height / 2 - paneBox.y - paneBox.height / 2] };
    });
    assert.deepEqual([displayed.W, displayed.H], [80, 100]);
    assert.deepEqual(displayed.pixel, [0, 200, 255, 255]);
    assert.ok(Math.abs(displayed.dot[0] - 87.5) < 1e-6);
    assert.ok(Math.abs(displayed.dot[1] - 92) < 1e-6);
    assert.ok(Math.abs(displayed.paintedDot[0] - 87.5) < .02, 'The painted dot is not displaced by inherited CSS margins');
    assert.ok(Math.abs(displayed.paintedDot[1] - 92) < .02);
    assert.ok(displayed.centerError.every(value => Math.abs(value) < 1), 'HE stays centered in its displayed coordinate surface');
    assert.equal(await h.page.locator('[data-act="apply"]').isDisabled(), true);
    await h.page.locator('[data-act="close"]').first().click();
    assert.deepEqual(await sourceSnapshot(h.page), before);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('alternating HE/MSI pairs produce one automatic preview, preserve raw coordinates, and round-trip confirmed orientation', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openFixture(h, 'alignment-automatic-pairs', { matrix: S, points: [] });
    await nextStage(h.page);
    // An MSI click cannot silently start a pair.
    await clickImagePoint(h.page, 'msi', [30, 20], [64, 48]);
    assert.equal(await h.page.locator('[data-pane="msi"] [data-point]').count(), 0);
    const he = [[10, 10], [90, 10], [10, 70], [90, 70]], actualHe = [];
    for (const p of he.slice(0, 3)) actualHe.push((await pair(h.page, p, [0.45 * p[0] + 8, 0.45 * p[1] + 5])).he);
    await h.page.waitForFunction(() => !document.querySelector('[data-act="apply"]').disabled);
    const report = await h.page.locator('[data-el="report"]').textContent();
    const residual = /RMSE ([\d.]+) px/.exec(report);
    assert.ok(residual && Number(residual[1]) < .2, `Physical mouse clicks should align within a subpixel: ${report}`);
    assert.equal(await h.page.locator('[data-candidate-apply]').count(), 0);
    assert.equal(await h.page.locator('[data-img="preview"]').count(), 1);
    actualHe.push(await clickImagePoint(h.page, 'he', he[3], [100, 80]));
    assert.equal(await h.page.locator('[data-act="apply"]').isDisabled(), true, 'An incomplete pair cannot be saved');
    await clickImagePoint(h.page, 'msi', [48.5, 36.5], [64, 48]);
    const saved = await saveDraft(h.page);
    assertMatrix(saved.T, S, .1);
    assert.equal(saved.a.schemaVersion, 3);
    assert.equal(saved.a.orientation.confirmed, true);
    assert.equal(saved.a.fit.orientationRevision, saved.a.orientation.revision);
    saved.a.landmarks.he.forEach((p, i) => p.forEach((v, axis) => assert.ok(Math.abs(v - actualHe[i][axis]) < 1e-8)));
    await h.page.locator('#align-btn').click();
    await h.page.waitForFunction(() => document.querySelector('.alignment-modal'));
    const reopened = await saveDraft(h.page);
    assert.deepEqual(reopened.T, saved.T);
    assert.deepEqual(reopened.a.orientation, saved.a.orientation);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('a 180-degree landmark solution is rejected instead of overriding the confirmed orientation', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openFixture(h, 'alignment-reject-180', { matrix: S, points: [] });
    await nextStage(h.page);
    const before = await h.page.locator('[data-img="preview"]').getAttribute('src');
    for (const p of [[10, 10], [90, 10], [10, 70]]) {
      await pair(h.page, p, [53 - .45 * p[0], 41 - .45 * p[1]]);
    }
    assert.equal(await h.page.locator('[data-act="apply"]').isDisabled(), true);
    assert.equal(await h.page.locator('[data-img="preview"]').getAttribute('src'), before);
    assert.match(await h.page.locator('[data-el="solve-error"]').textContent(), /向き|角度|回転|15/);
    assert.equal(await h.page.locator('[data-candidate-apply]').count(), 0);
    await h.page.locator('[data-act="close"]').first().click();
    assert.deepEqual((await sourceSnapshot(h.page)).T, S);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('affine fitting rejects a reflected correspondence even when it would fit all four points exactly', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openFixture(h, 'alignment-reject-reflection', { matrix: S, points: [] });
    await nextStage(h.page);
    await openDetails(h.page, '[data-sel="model"]');
    await h.page.locator('[data-sel="model"]').selectOption('affine');
    for (const p of [[10, 10], [90, 10], [10, 70], [90, 70]]) {
      await pair(h.page, p, [53 - .45 * p[0], 5 + .45 * p[1]]);
    }
    assert.equal(await h.page.locator('[data-act="apply"]').isDisabled(), true);
    assert.match(await h.page.locator('[data-el="solve-error"]').textContent(), /向き|鏡映|反転/);
    await h.page.locator('[data-act="close"]').first().click();
    assert.deepEqual((await sourceSnapshot(h.page)).T, S);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('returning to orientation retains raw point pairs and prevents saving a fit from the previous orientation', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openFixture(h, 'alignment-stale-orientation', { matrix: S });
    await nextStage(h.page);
    await h.page.locator('[data-act="solve"]').click();
    await frames(h.page);
    assert.equal(await h.page.locator('[data-act="apply"]').isDisabled(), false);
    const originalDot = await h.page.locator('[data-pane="he"] [data-point="0"]').evaluate(el => [el.style.left, el.style.top]);
    await h.page.locator('[data-act="orient-back"]').click();
    await h.page.locator('[data-act="orient-right"]').click();
    await frames(h.page);
    assert.equal(await h.page.locator('[data-pane="he"] [data-point]').count(), fixturePoints.length);
    assert.equal(await h.page.locator('[data-pane="msi"] [data-point]').count(), fixturePoints.length);
    const rotatedDot = await h.page.locator('[data-pane="he"] [data-point="0"]').evaluate(el => [el.style.left, el.style.top]);
    assert.notDeepEqual(rotatedDot, originalDot);
    assert.equal(await h.page.locator('[data-act="apply"]').isDisabled(), true);
    await nextStage(h.page);
    assert.equal(await h.page.locator('[data-act="apply"]').isDisabled(), true);
    await h.page.locator('[data-act="solve"]').click();
    await frames(h.page);
    assert.equal(await h.page.locator('[data-act="apply"]').isDisabled(), true, 'The old point pairing requires a forbidden 90-degree correction');
    await h.page.locator('[data-act="close"]').first().click();
    const stored = await h.page.evaluate(async () => (await ProjectStorage.getProject(currentProject.id)).alignment.HE_Stain.landmarks);
    assert.deepEqual(stored.he, fixturePoints);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('oriented, zoomed and resized image clicks are saved in raw HE coordinates', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openFixture(h, 'alignment-zoom-coordinates', { matrix: S, points: [] });
    await h.page.locator('[data-act="orient-flip-lr"]').click();
    await h.page.locator('[data-act="orient-right"]').click();
    await nextStage(h.page);
    await h.page.locator('[data-act="zoom-in"][data-zoom-pane="he"]').click();
    await h.page.locator('[data-act="zoom-in"][data-zoom-pane="msi"]').click();
    await h.page.setViewportSize({ width: 1350, height: 940 });
    await frames(h.page);
    const raw = [[50, 40], [35, 25], [65, 25], [40, 55]], expectedRaw = [];
    for (const p of raw) {
      // Horizontal reflection, followed by a clockwise quarter turn.
      const displayPoint = [80 - p[1], 100 - p[0]];
      const clicked = await pair(h.page, displayPoint, [.45 * displayPoint[0] + 8, .45 * displayPoint[1] + 5], [80, 100]);
      expectedRaw.push([100 - clicked.he[1], 80 - clicked.he[0]]);
    }
    const saved = await saveDraft(h.page);
    saved.a.landmarks.he.forEach((p, i) => p.forEach((v, axis) => assert.ok(Math.abs(v - expectedRaw[i][axis]) < 1e-8, `raw coordinate ${i}/${axis}`)));
    assertMatrix(saved.T, [[0, -.45, 44], [-.45, 0, 50], [0, 0, 1]], .08);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('editing a pair replaces its two points and affine exclusion requires four complete pairs', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openFixture(h, 'alignment-edit-exclude', { matrix: S });
    await nextStage(h.page);
    await openDetails(h.page, '[data-edit-pair="0"]');
    await h.page.locator('[data-edit-pair="0"]').click();
    await h.page.locator('[data-pane="he"] [data-point="0"]').click();
    await frames(h.page);
    assert.match(await h.page.locator('[data-el="pick-guide"]').textContent(), /MSI/);
    await h.page.locator('[data-pane="msi"] [data-point="0"]').click();
    await frames(h.page);
    assert.equal(await h.page.locator('[data-act="edit-cancel"]').isVisible(), false);
    await h.page.locator('[data-edit-pair="0"]').click();
    const clicked = await pair(h.page, [20, 20], [17, 14]);
    assert.equal(await h.page.locator('[data-pane="he"] [data-point]').count(), 6);
    assert.equal(await h.page.locator('[data-pane="msi"] [data-point]').count(), 6);
    await openDetails(h.page, '[data-sel="model"]');
    await h.page.locator('[data-sel="model"]').selectOption('affine');
    for (const i of [0, 1, 2]) {
      await h.page.locator(`[data-exclude="${i}"]`).uncheck();
      await frames(h.page);
    }
    assert.equal(await h.page.locator('[data-act="apply"]').isDisabled(), true);
    assert.match(await h.page.locator('[data-el="status"]').textContent(), /4\s*組/);
    await h.page.locator('[data-exclude="0"]').check();
    await frames(h.page);
    const saved = await saveDraft(h.page);
    assert.equal(saved.a.landmarks.he.length, 6);
    assert.ok(Math.abs(saved.a.landmarks.he[0][0] - clicked.he[0]) < 1e-8);
    assert.ok(Math.abs(saved.a.landmarks.he[0][1] - clicked.he[1]) < 1e-8);
    assert.deepEqual(saved.a.landmarks.excluded, [1, 2]);
    assertMatrix(saved.T, S, .1);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('balanced reference excludes d4, preserves quantitative data, and clears stale automatic evaluation', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openFixture(h, 'alignment-reference');
    const before = await sourceSnapshot(h.page);
    await h.page.locator('[data-sel="reference"]').selectOption('balanced');
    assert.equal(await h.page.locator('[data-source-key]:checked').count(), 5);
    assert.equal(await h.page.locator('[data-source-key*="d4"]:checked').count(), 0);
    assert.deepEqual(await sourceSnapshot(h.page), before);
    await nextStage(h.page);
    const previewBeforeEvaluation = await h.page.locator('[data-img="preview"]').getAttribute('src');
    await h.page.locator('[data-act="auto"]').click();
    await h.page.waitForFunction(() => !document.querySelector('[data-act="auto"]').disabled);
    await frames(h.page);
    assert.match(await h.page.locator('[data-el="report"]').textContent(), /Dice/);
    assert.equal(await h.page.locator('[data-img="preview"]').getAttribute('src'), previewBeforeEvaluation, 'Silhouette evaluates but never overwrites a landmark registration');
    await h.page.locator('[data-sel="reference"]').selectOption('rawsum');
    await frames(h.page);
    assert.doesNotMatch(await h.page.locator('[data-el="report"]').textContent(), /Dice/);
    assert.deepEqual(await sourceSnapshot(h.page), before);
    await h.page.locator('[data-act="apply"]').click();
    await h.page.waitForFunction(() => !document.querySelector('[data-act="apply"]'));
    const stored = await h.page.evaluate(async () => (await ProjectStorage.getProject(currentProject.id)).alignment.HE_Stain);
    assert.equal(stored.reference.mode, 'rawsum');
    assert.equal(stored.reference.sourceKeys.length, 5);
    const after = await sourceSnapshot(h.page);
    assert.deepEqual(after.raw, before.raw);
    assert.equal(after.roi, before.roi);
    assertMatrix(after.T, before.T);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('failed alignment save leaves the draft open, restores project state, and permits retry', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  h.page.on('dialog', d => d.dismiss());
  try {
    await openFixture(h, 'alignment-save-failure');
    await nextStage(h.page);
    await openDetails(h.page, '[data-p="offx"]');
    const before = await sourceSnapshot(h.page);
    await h.page.evaluate(() => {
      window.__originalSave = saveViewerProject;
      saveViewerProject = async () => { throw new Error('Synthetic storage failure'); };
    });
    await h.page.locator('[data-p="offx"]').fill('9');
    await h.page.locator('[data-act="apply"]').click();
    await h.page.waitForFunction(() => document.querySelector('[data-act="apply"]') && !document.querySelector('[data-act="apply"]').disabled);
    assert.deepEqual(await sourceSnapshot(h.page), before);
    assert.equal(await h.page.locator('[data-p="offx"]').inputValue(), '9');
    await h.page.evaluate(() => { saveViewerProject = __originalSave; });
    await h.page.locator('[data-act="apply"]').click();
    await h.page.waitForFunction(() => !document.querySelector('[data-act="apply"]'));
    assert.equal((await sourceSnapshot(h.page)).T[0][2], 9);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('a missing saved reference is explicit and cannot be silently replaced on save', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openFixture(h, 'alignment-missing-reference');
    await h.page.locator('[data-act="close"]').first().click();
    await h.page.evaluate(() => {
      atlasData.alignment.HE_Stain.reference = { mode: 'single', sourceKeys: ['removed-source'] };
    });
    await h.page.locator('#align-btn').click();
    await h.page.waitForFunction(() => document.querySelector('[data-act="apply"]').disabled);
    assert.equal(await h.page.locator('[data-sel="msi"]').inputValue(), 'removed-source');
    assert.match(await h.page.locator('[data-el="reference-error"]').textContent(), /removed-source/);
    await h.page.locator('[data-sel="msi"]').selectOption('MSI_Serotonin-DPP');
    await h.page.waitForFunction(() => !document.querySelector('[data-act="apply"]').disabled);
    assert.deepEqual((await sourceSnapshot(h.page)).T, T);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('invalid canonical matrices are not replaced by stale legacy parameter fields', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openFixture(h, 'alignment-invalid-canonical');
    await h.page.locator('[data-act="close"]').first().click();
    const invalid = [[0, 0, 1], [0, 0, 2], [0, 0, 1]];
    await h.page.evaluate(matrix => { atlasData.world_coords.T_he_to_msi = matrix; }, invalid);
    const dialog = h.page.waitForEvent('dialog');
    const opening = h.page.locator('#align-btn').click();
    const alert = await dialog;
    assert.match(alert.message(), /変換行列.*無効|無効.*変換/);
    await alert.dismiss();
    await opening;
    assert.equal(await h.page.locator('.alignment-modal').count(), 0);
    assert.deepEqual((await sourceSnapshot(h.page)).T, invalid);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('a saved fit from an earlier orientation revision requires a new fit before saving', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openFixture(h, 'alignment-revision-mismatch', { matrix: S });
    await nextStage(h.page);
    const original = await saveDraft(h.page);
    await h.page.evaluate(() => { atlasData.alignment.HE_Stain.fit.orientationRevision = -1; });
    await h.page.locator('#align-btn').click();
    await frames(h.page);
    assert.equal(await h.page.locator('[data-act="apply"]').isDisabled(), true);
    assert.deepEqual((await sourceSnapshot(h.page)).T, original.T);
    await h.page.locator('[data-act="solve"]').click();
    await frames(h.page);
    const saved = await saveDraft(h.page);
    assert.equal(saved.a.fit.orientationRevision, saved.a.orientation.revision);
    assertMatrix(saved.T, S);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('changed HE source identity cannot silently reuse old landmark coordinates', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openFixture(h, 'alignment-source-identity', { matrix: S });
    await nextStage(h.page);
    const original = await saveDraft(h.page);
    await h.page.evaluate(() => { atlasData.alignment.HE_Stain.orientation.source.heFingerprint = 'different-image'; });
    await h.page.locator('#align-btn').click();
    await frames(h.page);
    assert.equal(await h.page.locator('[data-act="apply"]').isDisabled(), true);
    await nextStage(h.page);
    await h.page.locator('[data-act="solve"]').click();
    await frames(h.page);
    assert.equal(await h.page.locator('[data-act="apply"]').isDisabled(), true);
    assert.match(await h.page.locator('[data-el="status"]').textContent(), /画像|全消去/);
    assert.deepEqual((await sourceSnapshot(h.page)).T, original.T);
    await h.page.locator('[data-act="clear"]').click();
    for (const p of [[10, 10], [90, 10], [10, 70]]) await pair(h.page, p, [.45 * p[0] + 8, .45 * p[1] + 5]);
    const saved = await saveDraft(h.page);
    assert.equal(saved.a.landmarks.he.length, 3);
    assert.notEqual(saved.a.orientation.source.heFingerprint, 'different-image');
    assertMatrix(saved.T, S, .1);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('zero-point silhouette keeps the manually chosen reflection and survives reopen only for its saved reference recipe', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openFixture(h, 'alignment-auto-metadata', { matrix: S, points: [] });
    await h.page.locator('[data-sel="reference"]').selectOption('balanced');
    await h.page.locator('[data-act="orient-flip-lr"]').click();
    await nextStage(h.page);
    await h.page.locator('[data-act="auto"]').click();
    await h.page.waitForFunction(() => !document.querySelector('[data-act="auto"]').disabled);
    await frames(h.page);
    assert.match(await h.page.locator('[data-el="report"]').textContent(), /Dice/);
    await h.page.locator('[data-act="apply"]').click();
    await h.page.waitForFunction(() => !document.querySelector('[data-act="apply"]'));
    const aligned = await h.page.evaluate(() => structuredClone(currentProject.alignment.HE_Stain));
    const matrix = aligned.T_he_to_msi;
    assert.ok(matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0] < 0, 'The user-chosen reflection remains present');
    assert.ok(Math.abs(matrix[1][0]) < 1e-9 && Math.abs(matrix[0][1]) < 1e-9, 'Silhouette does not add a rotation');
    await h.page.locator('#align-btn').click();
    await h.page.waitForFunction(() => document.querySelector('[data-el="report"]').textContent.includes('Dice'));
    await h.page.locator('[data-act="apply"]').click();
    await h.page.waitForFunction(() => !document.querySelector('[data-act="apply"]'));
    assert.equal(await h.page.evaluate(() => !!currentProject.alignment.HE_Stain.autoAligned), true);
    await h.page.locator('#align-btn').click();
    await h.page.locator('[data-sel="reference"]').selectOption('rawsum');
    await h.page.waitForFunction(() => !document.querySelector('[data-el="report"]').textContent.includes('Dice'));
    await h.page.locator('[data-act="apply"]').click();
    await h.page.waitForFunction(() => !document.querySelector('[data-act="apply"]'));
    assert.equal(await h.page.evaluate(() => !!currentProject.alignment.HE_Stain.autoAligned), false);
    assert.equal(await h.page.evaluate(() => currentProject.alignment.HE_Stain.previousAutoAligned.stale), true);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('a queued preview cannot re-enable landmark edits while an alignment save is pending', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openFixture(h, 'alignment-pending-save');
    await nextStage(h.page);
    await openDetails(h.page, '[data-p="offx"]');
    await h.page.evaluate(() => {
      const original = saveViewerProject;
      const gate = new Promise(resolve => { window.__finishAlignmentSave = resolve; });
      saveViewerProject = async () => { await gate; return original(); };
      const field = document.querySelector('[data-p="offx"]');
      field.value = '9'; field.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-act="apply"]').click();
    });
    await h.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await h.page.locator('[data-exclude="0"]').isDisabled(), true);
    await h.page.evaluate(() => {
      const image = document.querySelector('[data-img="he"]'), r = image.getBoundingClientRect();
      image.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
      __finishAlignmentSave();
    });
    await h.page.waitForFunction(() => !document.querySelector('[data-act="apply"]'));
    assert.equal(await h.page.evaluate(() => currentProject.alignment.HE_Stain.landmarks.he.length), 6);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('large workspace comparison modes and same-grid molecule changes preserve the draft and scientific data', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await h.page.setViewportSize({width:1440,height:950});
    await openFixture(h,'alignment-workspace-preserve',{matrix:S});
    const before=await sourceSnapshot(h.page);
    await nextStage(h.page);
    const positions=await h.page.locator('[data-pane=he] [data-point]').evaluateAll(nodes=>nodes.map(n=>[n.style.left,n.style.top]));
    await h.page.locator('[data-sel=msi]').selectOption('MSI_Dopamine-DPP');
    await frames(h.page);
    assert.deepEqual(await h.page.locator('[data-pane=he] [data-point]').evaluateAll(nodes=>nodes.map(n=>[n.style.left,n.style.top])),positions);
    const size=await h.page.locator('.msi-align-viewport').evaluateAll(nodes=>nodes.map(n=>({w:n.clientWidth,h:n.clientHeight})));
    assert.ok(size.every(s=>s.w>550&&s.h>350),JSON.stringify(size));
    await h.page.locator('[data-view-mode=overlay]').click();
    await h.page.waitForFunction(()=>document.querySelector('.msi-align-composite > canvas').width>200);
    await h.page.locator('.msi-align-opacity input').fill('0.2');
    await frames(h.page);
    assert.deepEqual(await sourceSnapshot(h.page),before);
    await h.page.locator('[data-view-mode=final]').click();
    await frames(h.page);
    assert.deepEqual(await sourceSnapshot(h.page),before);
    await h.page.locator('[data-view-mode=split]').click();
    await h.page.locator('[data-act=close]').first().click();
    assert.deepEqual(await sourceSnapshot(h.page),before);assert.deepEqual(h.errors,[]);
  } finally {await h.close();}
});
