'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness, seedViewerProject } = require('./browser-harness.cjs');

const T = [[0.41, 0.075, 4.123456789012345], [-0.035, 0.36, 5.234567890123456], [0, 0, 1]];

async function openFixture(h, id, { matrix = T } = {}) {
  await seedViewerProject(h.page, h.baseURL, { id });
  await h.page.evaluate(async ({ id, matrix }) => {
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
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    p.images = { HE_Stain: { blobId: await ProjectStorage.putBlob({ blob }), filename: 'synthetic-HE.png' } };
    const he = [[8, 10], [90, 10], [14, 65], [88, 67], [42, 21], [55, 53]];
    const msi = he.map(([x, y]) => [matrix[0][0] * x + matrix[0][1] * y + matrix[0][2], matrix[1][0] * x + matrix[1][1] * y + matrix[1][2]]);
    // Intentionally stale legacy scalars: the canonical full matrix must win.
    p.alignment = { HE_Stain: { flip_lr: true, scale_pct: 1, rotate_deg: 90, offx: 0, offy: 0, landmarks: { he, msi } } };
    await ProjectStorage.putProject(p);
  }, { id, matrix });
  await h.page.goto(h.baseURL + '/viewer/index.html?project=' + id);
  await h.page.waitForFunction(id => typeof currentProject !== 'undefined' && currentProject?.id === id && viewerReady, id);
  await h.page.locator('#align-btn').click();
  await h.page.waitForFunction(() => document.querySelector('[data-img="preview"]')?.naturalWidth > 0);
}

async function sourceSnapshot(page) {
  return page.evaluate(() => ({
    roi: JSON.stringify(atlasData.roi),
    raw: Object.fromEntries(Object.entries(valueRasters).map(([k, r]) => [k, Array.from(new Uint32Array(r.values.buffer))])),
    T: structuredClone(atlasData.world_coords.T_he_to_msi),
  }));
}

test('alignment opening and saving preserve an exact affine matrix over stale legacy scalars', { timeout: 90000 }, async () => {
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

test('landmark solve compares models, preserves current transform until adoption, and draws residual vectors', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openFixture(h, 'alignment-solve');
    await h.page.locator('[data-p="offx"]').fill('10');
    await h.page.locator('[data-sel="model"]').selectOption('affine');
    await h.page.locator('[data-act="solve"]').click();
    const candidates = h.page.locator('[data-el="candidates"]');
    await candidates.locator('[data-candidate-apply]').first().waitFor();
    assert.match(await candidates.textContent(), /アフィン/);
    assert.match(await candidates.textContent(), /相似/);
    assert.equal(await h.page.locator('[data-p="offx"]').inputValue(), '10');
    // The selected affine candidate is the one with effectively zero residual.
    await candidates.locator('.align-candidate').filter({ hasText: /アフィン/ }).locator('[data-candidate-apply]').click();
    assert.match(await h.page.locator('[data-el="report"]').textContent(), /0\.00\s*px/);
    assert.ok(await h.page.locator('[data-pane="preview"] svg line').count() >= 6);
    await h.page.locator('[data-act="apply"]').click();
    await h.page.waitForFunction(() => !document.querySelector('[data-act="apply"]'));
    const actual = (await sourceSnapshot(h.page)).T;
    actual.forEach((row, i) => row.forEach((v, j) => assert.ok(Math.abs(v - T[i][j]) < 1e-9)));
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
    await h.page.locator('[data-act="auto"]').click();
    await h.page.waitForFunction(() => !document.querySelector('[data-act="auto"]').disabled);
    assert.match(await h.page.locator('[data-el="candidates"]').textContent(), /Dice/);
    await h.page.locator('[data-sel="reference"]').selectOption('rawsum');
    assert.doesNotMatch(await h.page.locator('[data-el="candidates"]').textContent(), /Dice/);
    assert.deepEqual(await sourceSnapshot(h.page), before);
    await h.page.locator('[data-act="apply"]').click();
    await h.page.waitForFunction(() => !document.querySelector('[data-act="apply"]'));
    const stored = await h.page.evaluate(async () => (await ProjectStorage.getProject(currentProject.id)).alignment.HE_Stain);
    assert.equal(stored.reference.mode, 'rawsum');
    assert.equal(stored.reference.sourceKeys.length, 5);
    assert.deepEqual(await sourceSnapshot(h.page), before);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('failed alignment save leaves the draft open, restores project state, and permits retry', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  h.page.on('dialog', d => d.dismiss());
  try {
    await openFixture(h, 'alignment-save-failure');
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

test('automatic evaluation survives reopen only for its saved reference recipe', { timeout: 90000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openFixture(h, 'alignment-auto-metadata');
    await h.page.locator('[data-sel="reference"]').selectOption('balanced');
    await h.page.locator('[data-act="auto"]').click();
    await h.page.locator('[data-candidate-apply]').waitFor();
    await h.page.locator('[data-candidate-apply]').click();
    await h.page.locator('[data-act="apply"]').click();
    await h.page.waitForFunction(() => !document.querySelector('[data-act="apply"]'));
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
    await h.page.locator('[data-pick="he"]').click();
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
