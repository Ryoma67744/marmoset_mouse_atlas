'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');

const VIEWER_ROTATIONS = [
  { all: 0, msi: 0, he: 0 },
  { all: 90, msi: 0, he: -90 },
  { all: -90, msi: 0, he: 180 },
  { all: 180, msi: 0, he: -90 },
  { all: 0, msi: 90, he: 180 },
  { all: 0, msi: -90, he: -90 },
  { all: 0, msi: 180, he: 90 },
  { all: 23, msi: 17, he: -41 },
];
const REGISTERED_ANGLE = -91.393457;

async function load(h) {
  await h.page.goto(h.baseURL + '/__test_seed');
  for (const file of ['lib/ingest.js', 'lib/section-display.js', 'lib/stack3d.js',
    'stack3d/vendor/three-orbit.min.js', 'stack3d/roi.js', 'lib/section-outline.js',
    'stack3d/section-outline.js', 'stack3d/renderer.js']) {
    await h.page.addScriptTag({ url: h.baseURL + '/' + file });
  }
}

async function inspect(h, { move = false, physical = false } = {}) {
  return h.page.evaluate(async ({ move, physical }) => {
    const projects = (await ProjectStorage.listProjects()).sort((a, b) => a.id.localeCompare(b.id));
    const snapshot = async () => ({
      projects: await ProjectStorage.listProjects(),
      bytes: Array.from(new Uint8Array((await ProjectStorage.getValueRaster(projects[0].molecules[0].blobId)).buffer)),
      heBytes: Array.from(new Uint8Array(await (await ProjectStorage.getBlob(projects[0].images.HE_Stain.blobId)).blob.arrayBuffer())),
    });
    const before = await snapshot();
    const sections = await Stack3D.loadSections(projects, { folders: [] });
    if (physical) {
      // Exercise the existing physical-coordinate convention independently.
      const p = { ...projects[0], atlas: undefined, displayName: 'Cor_1_1',
        grid: { W: 6, H: 4, umPerPxX: 200, umPerPxY: 350 },
        molecules: projects[0].molecules.map(molecule => ({ ...molecule, name: 'DA', analyteId: 'DA' })),
        rotation: { all: 90, msi: -20, he: 25 },
        stack3d: { offsetXUm: 500, offsetYUm: -750, rotationDeg: 15 } };
      sections.splice(0, sections.length, Stack3D.createSection(p, sections[0].rasters, { folders: [] }));
    }
    const pixels = canvas => ({ width: canvas.width, height: canvas.height,
      data: Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data) });
    const canvases = [], rendered = [], previews = [];
    for (const section of sections) {
      const msi = Stack3D.renderSection(section, { channels: [physical ? 'DA' : 'Dopamine-DPP'], mode: 'raw' });
      const he = await Stack3D.renderHePlane(section);
      const hePreview = await Stack3D.renderHePreview(section);
      rendered.push({ msi: pixels(msi.canvas), he: pixels(he) });
      previews.push({ msi: pixels(msi.previewCanvas), he: pixels(hePreview) });
      canvases.push(msi.canvas, msi.previewCanvas, he, hePreview);
      section.textureCanvas = msi.canvas;
      section.testHe = he;
    }
    const host = document.createElement('div'); host.style.cssText = 'width:800px;height:500px';
    document.body.append(host);
    const rois = new Map(), outlines = new Map(), errors = [];
    const originalRoi = Stack3DRoi.create, originalOutline = Stack3DSectionOutline.create;
    Stack3DRoi.create = (...args) => {
      const result = originalRoi(...args); rois.set(args[2].id, result.group); return result;
    };
    Stack3DSectionOutline.create = (...args) => {
      const result = originalOutline(...args); outlines.set(args[1].id, result.group); return result;
    };
    let renderedScene = null;
    const pose = object => ({ position: object.position.toArray(),
      angle: object.rotation.z * 180 / Math.PI, matrix: object.matrixWorld.toArray() });
    const originalAdd = AtlasThree.Scene.prototype.add;
    AtlasThree.Scene.prototype.add = function (...objects) {
      renderedScene = this;
      return originalAdd.apply(this, objects);
    };
    const renderer = Stack3DRenderer.createRenderer(host, { onError: error => errors.push(error.message) });
    const capture = () => {
      renderer.capturePNG();
      const meshState = [];
      renderedScene.traverse(object => {
        if (object.userData.layer === 'msi' || object.userData.layer === 'he') {
          meshState.push({ id: object.userData.sectionId, layer: object.userData.layer, ...pose(object) });
        }
      });
      return { meshes: meshState,
        rois: sections.map(section => ({ id: section.id, ...pose(rois.get(section.id)) })),
        outlines: sections.map(section => ({ id: section.id, ...pose(outlines.get(section.id)) })),
        stats: renderer.getStats() };
    };
    try {
      renderer.setSections(sections);
      renderer.updateHeTextures(Object.fromEntries(sections.map(section => [section.id, section.testHe])));
      renderer.setHeOverlay({ visible: true, opacity: 0.5 });
      renderer.setSpacing(2);
      const initial = capture();
      // Rebuilding the descriptors occurs when saved projects are refreshed.
      renderer.setSections(sections);
      const rebuilt = capture();
      let moved = null;
      if (move) {
        renderer.setPlacement(sections[0].id, { offsetXPx: -5, offsetYPx: 7, rotationDeg: 27 });
        moved = capture();
      }
      return { before, after: await snapshot(), rendered, previews, initial, rebuilt, moved, errors };
    } finally {
      renderer.dispose(); host.remove();
      Stack3DRoi.create = originalRoi; Stack3DSectionOutline.create = originalOutline;
      AtlasThree.Scene.prototype.add = originalAdd;
      sections.forEach(Stack3D.releaseSection);
      canvases.forEach(canvas => { canvas.width = 0; canvas.height = 0; });
    }
  }, { move, physical });
}

function assertPose(capture, index, angle, xy) {
  const id = 'pose-' + index;
  const meshes = capture.meshes.filter(mesh => mesh.id === id);
  assert.equal(meshes.length, 2, 'both scientific image planes are rendered');
  const msi = meshes.find(mesh => mesh.layer === 'msi');
  const objects = [...meshes, capture.rois.find(roi => roi.id === id), capture.outlines.find(outline => outline.id === id)];
  for (const object of objects) {
    assert.ok(Math.abs(object.angle - angle) < 1e-10, `${id} stays at its registered angle`);
    assert.deepEqual(object.position.slice(0, 2), xy);
    assert.deepEqual(object.matrix, msi.matrix, 'MSI, aligned HE, ROI and outer edge share the same world frame');
  }
}

function quarterTurn(image, degrees) {
  let current = image;
  for (let turn = 0; turn < ((degrees / 90) % 4 + 4) % 4; turn++) {
    const { width, height, data } = current, rotated = Array(data.length).fill(0);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4, to = (x * height + height - 1 - y) * 4;
      for (let channel = 0; channel < 4; channel++) rotated[to + channel] = data[from + channel];
    }
    current = { width: height, height: width, data: rotated };
  }
  return current;
}

test('saved 2D rotations never disturb a registered mouse slice, including after reload and placement changes', async () => {
  const h = await startBrowserHarness();
  try {
    await load(h);
    await h.page.evaluate(async ({ rotations, registeredAngle }) => {
      // Asymmetric tissue with measured zero and unmeasured border pixels.
      const values = new Float32Array([
        NaN, NaN, NaN, NaN, NaN, NaN,
        NaN, 0, 2, 6, 20, NaN,
        NaN, 1, 4, 12, NaN, NaN,
        NaN, NaN, NaN, NaN, NaN, NaN,
      ]);
      const blobId = await ProjectStorage.putValueRaster(values);
      const image = document.createElement('canvas'); image.width = 6; image.height = 4;
      const ctx = image.getContext('2d');
      ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = '#00ff00'; ctx.fillRect(2, 1, 1, 1);
      const blob = await new Promise(resolve => image.toBlob(resolve, 'image/png'));
      const imageId = await ProjectStorage.putBlob({ blob, filename: 'landmarks.png', mime: 'image/png' });
      for (let index = 0; index < rotations.length; index++) {
        await ProjectStorage.putProject({
          id: 'pose-' + index, displayName: 'Registered mouse ' + index, plane: 'coronal',
          atlas: { species: 'mouse', seriesId: 'pose-regression', sectionNumber: index + 1, coordinateMode: 'pixel', displaySpacing: 2 },
          grid: { W: 6, H: 4, umPerPxX: null, umPerPxY: null },
          molecules: [{ key: 'MSI_DA', name: 'Dopamine-DPP', analyteId: 'Dopamine-DPP', blobId, stats: MSIRaster.deriveBakeStats(values) }],
          images: { HE_Stain: { blobId: imageId, filename: 'landmarks.png', mime: 'image/png' } },
          world_coords: { T_he_to_msi: [[1, 0, 1], [0, 1, 1], [0, 0, 1]] },
          rotation: rotations[index],
          stack3d: { coordinateMode: 'pixel', offsetXPx: 2, offsetYPx: -3, rotationDeg: registeredAngle },
          roi: { roi_items: { tissue: [{ poly_msi: [[1, 1], [5, 1], [4, 3], [1, 3]] }] },
            roi_names: { tissue: 'Tissue landmark' }, palette: { tissue: [255, 0, 0, 255] } },
        });
      }
    }, { rotations: VIEWER_ROTATIONS, registeredAngle: REGISTERED_ANGLE });
    const result = await inspect(h, { move: true });
    assert.deepEqual(result.after, result.before, '3D and preview rendering do not rewrite metadata, measurements or HE');
    for (let i = 0; i < VIEWER_ROTATIONS.length; i++) {
      assertPose(result.initial, i, REGISTERED_ANGLE, [2, -3]);
      assertPose(result.rebuilt, i, REGISTERED_ANGLE, [2, -3]);
      assert.deepEqual(result.rendered[i], result.rendered[0], '3D texture pixels retain the raw MSI frame regardless of saved display angles');
      const rotation = VIEWER_ROTATIONS[i];
      if (i < VIEWER_ROTATIONS.length - 1) {
        assert.deepEqual(result.previews[i].msi, quarterTurn(result.previews[0].msi, rotation.all + rotation.msi),
          'MSI 2D preview still honors saved display rotation');
        assert.deepEqual(result.previews[i].he, quarterTurn(result.previews[0].he, rotation.all + rotation.he),
          'HE 2D preview still honors its independent saved display rotation');
      }
    }
    assert.deepEqual([result.previews.at(-1).msi.width, result.previews.at(-1).msi.height], [8, 7], 'arbitrary 40° MSI preview retains its expanded bounds');
    assert.notDeepEqual(result.previews.at(-1).msi, result.previews[0].msi);
    const he = result.rendered[0].he;
    assert.deepEqual(he.data.slice((1 * he.width + 1) * 4, (1 * he.width + 1) * 4 + 4), [255, 0, 0, 255],
      'HE landmark is warped into the raw MSI frame before 3D placement');
    assertPose(result.moved, 0, 27, [-5, 7]);
    assertPose(result.moved, 1, REGISTERED_ANGLE, [2, -3]);
    assert.equal(result.initial.stats.sectionOutlines.availableCount, VIEWER_ROTATIONS.length);
    assert.equal(result.initial.stats.heVisibleCount, VIEWER_ROTATIONS.length);
    assert.deepEqual(result.errors, []);

    await load(h); // New document, same isolated IndexedDB.
    const reloaded = await inspect(h);
    assert.deepEqual(reloaded.before, result.before);
    assert.deepEqual(reloaded.after, result.before);
    for (let i = 0; i < VIEWER_ROTATIONS.length; i++) assertPose(reloaded.initial, i, REGISTERED_ANGLE, [2, -3]);
    assert.deepEqual(reloaded.rendered, result.rendered);
    assert.deepEqual(reloaded.previews, result.previews);
    assert.deepEqual(reloaded.errors, []);

    const physical = await inspect(h, { physical: true });
    const physicalMeshes = physical.initial.meshes;
    assert.ok(Math.abs(physicalMeshes.find(mesh => mesh.layer === 'msi').angle - 95) < 1e-10,
      'legacy physical MSI rotation remains unchanged');
    assert.ok(Math.abs(physicalMeshes.find(mesh => mesh.layer === 'he').angle - 50) < 1e-10,
      'legacy physical HE rotation remains independent');
    assert.deepEqual(physicalMeshes[0].position.slice(0, 2), [0.5, 0.75]);
    assert.deepEqual(physical.after, physical.before);
    assert.deepEqual(physical.errors, []);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
