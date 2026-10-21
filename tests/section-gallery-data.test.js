'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const clone = value => JSON.parse(JSON.stringify(value));
function canvas(W = 1, H = 1) {
  const result = { width: W, height: H, pixels: new Uint8ClampedArray(W * H * 4) };
  result.getContext = () => ({ getImageData: () => ({ data: result.pixels.slice() }),
    putImageData: image => { result.pixels = image.data.slice(); }, drawImage: () => {}, translate() {}, rotate() {} });
  return result;
}
function fixture() {
  const c = { console, Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Uint8ClampedArray, ArrayBuffer, DataView, setTimeout,
    document: { createElement: tag => { assert.equal(tag, 'canvas'); return canvas(); } } };
  c.window = c; vm.createContext(c);
  for (const file of ['section-navigation.js', 'normalization-scope.js', 'normalization.js', 'display-range.js',
    'section-display.js', 'section-edge-mask.js', 'stack3d.js', 'section-gallery-data.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), c, { filename: file });
  }
  const nativeOrient = c.Stack3D.orientCanvas;
  const projects = new Map(), arrays = new Map(), paintCalls = [], poses = [];
  const storage = { listProjects: async () => [...projects.values()].map(clone), getProject: async id => clone(projects.get(id) || null),
    listFolders: async () => [], getValueRaster: async id => arrays.get(id) || null,
    putProject() { throw new Error('Gallery must not save projects'); }, getBlob: async () => null };
  c.SectionDisplay.paintChannel = (values, raw, W, H, options) => {
    const result = canvas(W, H); for (let i = 0; i < W * H; i++) result.pixels.set([128, 0, 0, Number.isFinite(values[i]) ? 255 : 0], i * 4);
    paintCalls.push({ values: Array.from(values), raw: Array.from(raw), options: clone(options), result }); return result;
  };
  c.Stack3D.orientCanvas = (shape, source, options) => {
    poses.push({ ...shape, options }); const result = canvas(shape.W, shape.H); result.pixels = source.pixels.slice(); return result;
  };
  function mouse(n, id = 'm' + n) {
    const p = { id, displayName: 'Mouse_' + n, plane: 'coronal', images: {},
      atlas: { species: 'mouse', seriesId: 'mouse_tissue_1set', coordinateMode: 'pixel', sectionNumber: n },
      grid: { W: 9, H: 9 }, valueDisplay: { mode: 'raw' }, rotation: { all: 90, msi: 90 }, stack3d: { rotationDeg: -91 },
      molecules: [{ key: 'da', name: 'Dopamine-DPP', analyteId: 'Dopamine-DPP', blobId: id + '-da' },
        { key: 'd4', name: 'Serotonin-d4-DPP', analyteId: 'Serotonin-d4-DPP', blobId: id + '-d4' }] };
    const a = new Float32Array(81).fill(4), b = new Float32Array(81).fill(2); a[0] = 2000;
    arrays.set(id + '-da', a); arrays.set(id + '-d4', b);
    p.normalization = c.Normalization.createPixelRatioProfile(p, { da: { W: 9, H: 9, values: a }, d4: { W: 9, H: 9, values: b } },
      { id: 'test-ratio', revision: 1, standardKey: 'd4', targetKeys: ['da'], standardApplication: { method: 'uniform_spray', confirmed: true } });
    projects.set(id, p); return p;
  }
  const remote = p => ({ id: p.id, display_name: p.displayName, meta: { atlas: p.atlas, plane: p.plane,
    molecules: p.molecules.map(m => m.name) }, state: {} });
  const create = options => c.SectionGalleryData.create({ storage, cloud: { configured: () => false }, ...options });
  return { c, nativeOrient, projects, arrays, storage, paintCalls, poses, mouse, remote, create };
}

test('catalog lists same-series confirmed order, metadata sources and legacy series without fetching bundles', async () => {
  const f = fixture(), p12 = f.mouse(12), p11 = f.mouse(11); f.projects.set('cor', { id: 'cor', displayName: 'Cor_2_1', molecules: [{ key: 'x', name: 'DA' }] });
  const p13 = f.mouse(13); f.projects.delete(p13.id); let reads = 0;
  f.c.ProjectSync = { ensureLocal: () => { reads++; throw new Error('eager bundle'); } };
  const adapter = f.create({ cloud: { configured: () => true, signedIn: () => true, listProjects: async () => [p13, p11, p12].map(f.remote) } });
  const catalog = await adapter.loadCatalog({ seriesId: 'mouse_tissue_1set' });
  assert.deepEqual(clone(catalog.items.map(i => i.sectionNumber)), [11, 12, 13]);
  assert.equal(catalog.complete, true); assert.equal(reads, 0); assert.equal(catalog.series.length, 2);
  assert.ok(catalog.sources.some(s => s.key === 'msi:Dopamine-DPP'));
  assert.ok(catalog.sources.some(s => s.key === 'he')); assert.ok(catalog.sources.some(s => s.key === 'if:IF_Stain'));
});

test('mouse thumbnails use validated pixel ratios, P99 before mask, saved pose and do not change arrays/settings', async () => {
  const f = fixture(), p = f.mouse(1), before = clone(p), bits = Buffer.from(f.arrays.get('m1-da').buffer).toString('hex');
  const a = f.create(), catalog = await a.loadCatalog({ currentProject: p }), thumbnails = [];
  const result = await a.renderThumbnails(catalog, 'msi:Dopamine-DPP', { onThumbnail: value => thumbnails.push(value) });
  assert.match(result.notice, /画素d4補正・外側2画素/); assert.equal(result.loaded, 1); assert.equal(result.range.max, 1000); assert.equal(f.paintCalls[0].values[0], 1000);
  assert.equal(f.paintCalls[0].values[40], 2); assert.equal(thumbnails[0].edgeHiddenPixels, 56);
  assert.equal(thumbnails[0].canvas.pixels[3], 0); assert.equal(thumbnails[0].canvas.pixels[40 * 4 + 3], 255);
  assert.equal(f.poses[0].angleDeg, 91, 'scene pose, not Viewer rotation');
  assert.deepEqual(clone(p), before); assert.equal(Buffer.from(f.arrays.get('m1-da').buffer).toString('hex'), bits);
});

test('d4 remains raw QC with complete acquired footprint', async () => {
  const f = fixture(); f.mouse(1); const a = f.create(), catalog = await a.loadCatalog(), output = [];
  await a.renderThumbnails(catalog, 'msi:Serotonin-d4-DPP', { onThumbnail: item => output.push(item) });
  assert.equal(f.paintCalls[0].values[0], 2); assert.equal(output[0].canvas.pixels[3], 255);
  assert.equal(output[0].edgeHiddenPixels, 0); assert.match(output[0].mode, /原値QC/);
});

test('stale normalization cannot fall back to raw and missing contributors cannot create a partial footprint', async () => {
  const f = fixture(); const p1 = f.mouse(1), p2 = f.mouse(2); p1.normalization.invalidated = { code: 'NORMALIZATION_PROFILE_STALE' };
  p2.molecules.push({ key: 'missing', name: 'Missing', blobId: 'absent' });
  p2.normalization = f.c.Normalization.createPixelRatioProfile(p2, { da: { W: 9, H: 9, values: f.arrays.get('m2-da') }, d4: { W: 9, H: 9, values: f.arrays.get('m2-d4') } },
    { id: 'test-ratio', revision: 1, standardKey: 'd4', targetKeys: ['da'], standardApplication: { method: 'uniform_spray', confirmed: true } });
  const a = f.create(), catalog = await a.loadCatalog(), output = [];
  await a.renderThumbnails(catalog, 'msi:Dopamine-DPP', { onThumbnail: item => output.push(item) });
  assert.equal(f.paintCalls.length, 0); assert.equal(output.length, 2);
  assert.ok(output.every(item => item.status === 'error'));
  assert.match(output[0].notice, /NORMALIZATION_PROFILE_STALE/); assert.match(output[1].notice, /外側2画素の判定に必要な原値データが不足/);
});

test('current unsaved project is preferred without sync or persistent changes', async () => {
  const f = fixture(), p = f.mouse(1), draft = clone(p); draft.stack3d.rotationDeg = 23; draft.notes = { general: 'unsaved' };
  let syncCalls = 0; f.c.ProjectSync = { ensureLocal: async () => { syncCalls++; throw new Error('should not refresh local'); } };
  const a = f.create({ getCurrentProject: () => draft }), catalog = await a.loadCatalog();
  await a.renderThumbnails(catalog, 'msi:Dopamine-DPP');
  assert.equal(f.poses[0].angleDeg, -23); assert.equal(syncCalls, 0); assert.equal(f.projects.get('m1').stack3d.rotationDeg, -91);
  assert.deepEqual(draft.notes, { general: 'unsaved' });
});

test('arbitrary legacy molecules render raw; remote display names can resolve unique registered analyte IDs', async () => {
  const f = fixture(), p = { id: 'cor', displayName: 'Cor_1_1', grid: { W: 2, H: 2, umPerPxX: 100, umPerPxY: 100 },
    molecules: [{ key: 'x', name: 'Novel molecule', analyteId: 'unique:compound', blobId: 'x' }] };
  f.projects.set(p.id, p); f.arrays.set('x', new Float32Array([1, 2, 3, 4]));
  const a = f.create(), catalog = await a.loadCatalog();
  await a.renderThumbnails(catalog, 'msi:Novel molecule');
  assert.deepEqual(f.paintCalls[0].values, [1, 2, 3, 4]); assert.equal(f.paintCalls[0].options.derived, false);
});

test('remote-only series loads at most two bundles concurrently and imports only requested series', async () => {
  const f = fixture(), remote = [f.mouse(1), f.mouse(2), f.mouse(3)]; f.projects.clear();
  let active = 0, maximum = 0; const fetched = [];
  f.c.ProjectSync = { ensureLocal: async (id, options) => {
    fetched.push(id); active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 5));
    assert.equal(await options.canApplyRemote(), true); const p = remote.find(p => p.id === id); f.projects.set(id, p); active--; return p;
  } };
  const a = f.create({ cloud: { configured: () => true, signedIn: () => true, listProjects: async () => [...remote.map(f.remote), { id: 'other', display_name: 'Cor_1_1', meta: { molecules: ['DA'] } }] } });
  const catalog = await a.loadCatalog({ seriesId: 'mouse_tissue_1set' }); await a.renderThumbnails(catalog, 'msi:Dopamine-DPP');
  assert.deepEqual(fetched.sort(), ['m1', 'm2', 'm3']); assert.equal(maximum, 2);
});

test('abort suppresses all callbacks and no stale generation is painted', async () => {
  const f = fixture(); f.mouse(1); const a = f.create(), catalog = await a.loadCatalog(), controller = new AbortController(); let calls = 0;
  f.storage.getValueRaster = async () => { controller.abort(); return new Float32Array(81).fill(1); };
  await assert.rejects(a.renderThumbnails(catalog, 'msi:Dopamine-DPP', { signal: controller.signal, onThumbnail: () => calls++ }), { name: 'AbortError' });
  assert.equal(calls, 0); assert.equal(f.paintCalls.length, 0);
});

test('HE and IF absence is explicit and IF never borrows HE alignment', async () => {
  const f = fixture(), p = f.mouse(1), a = f.create(); p.images.IF_Stain = { blobId: 'if' };
  p.world_coords = { T_he_to_msi: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
  let heCalls = 0; f.c.Stack3D.renderHePlane = async () => { heCalls++; throw new Error('must not warp IF'); };
  f.c.Stack3D.loadReferenceImage = async () => ({ width: 32, height: 16 });
  let catalog = await a.loadCatalog(), outputs = [];
  await a.renderThumbnails(catalog, 'he', { onThumbnail: item => outputs.push(item) });
  assert.equal(outputs[0].status, 'missing'); assert.match(outputs[0].notice, /未登録/);
  outputs = []; await a.renderThumbnails(catalog, 'if:IF_Stain', { onThumbnail: item => outputs.push(item) });
  assert.equal(outputs[0].status, 'ready'); assert.match(outputs[0].notice, /位置合わせは適用していません/); assert.equal(heCalls, 0);
});

test('duplicate confirmed section numbers are reported, not silently renumbered', async () => {
  const f = fixture(); f.mouse(1, 'a'); f.mouse(1, 'b'); const catalog = await f.create().loadCatalog();
  assert.equal(catalog.status, 'ambiguous'); assert.match(catalog.notice, /同じ切片番号/);
});


test('a registered molecule excluded from the fixed pixel-ratio profile is unavailable, never mislabeled raw', async () => {
  const f = fixture(), p = f.mouse(1);
  p.molecules.push({ key: 'other', name: 'Other-DPP', analyteId: 'Other-DPP', blobId: 'other' });
  f.arrays.set('other', new Float32Array(81).fill(12));
  p.normalization = f.c.Normalization.createPixelRatioProfile(p, {
    da: { W: 9, H: 9, values: f.arrays.get('m1-da') }, d4: { W: 9, H: 9, values: f.arrays.get('m1-d4') },
    other: { W: 9, H: 9, values: f.arrays.get('other') }
  }, { id: 'test-ratio', revision: 1, standardKey: 'd4', targetKeys: ['da'], standardApplication: { method: 'uniform_spray', confirmed: true } });
  const a = f.create(), catalog = await a.loadCatalog(), output = [];
  const result = await a.renderThumbnails(catalog, 'msi:Other-DPP', { onThumbnail: value => output.push(value) });
  assert.equal(output[0].status, 'error'); assert.match(output[0].notice, /NOT_APPLIED/);
  assert.equal(result.loaded, 0); assert.equal(f.paintCalls.length, 0);
});

test('registered HE retains thumbnail detail instead of shrinking back to the MSI native grid', async () => {
  const f = fixture(), p = f.mouse(1); p.stack3d.rotationDeg = 0;
  p.images.HE_Stain = { blobId: 'he' }; p.world_coords = { T_he_to_msi: [[0.01, 0, 0], [0, 0.01, 0], [0, 0, 1]] };
  f.c.Stack3D.loadReferenceImage = async () => ({ width: 900, height: 900 });
  f.c.Stack3D.renderHePlane = async () => canvas(480, 480);
  f.c.Stack3D.orientCanvas = f.nativeOrient;
  const a = f.create(), catalog = await a.loadCatalog(), output = [];
  await a.renderThumbnails(catalog, 'he', { onThumbnail: value => output.push(value) });
  assert.equal(output[0].status, 'ready'); assert.equal(output[0].canvas.width, 240); assert.equal(output[0].canvas.height, 240);
  assert.match(output[0].notice, /保存済みHE位置合わせ/);
});
