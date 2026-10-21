'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('Atlas layers share uniform slider spacing without changing XY, textures, camera, or visibility', async () => {
  const h = await startBrowserHarness();
  try {
    await h.page.goto(h.baseURL + '/__test_seed');
    for (const file of ['lib/section-display.js', 'lib/stack3d.js', 'lib/stack3d-standard-atlas.js',
      'stack3d/vendor/three-orbit.min.js', 'stack3d/roi.js', 'lib/section-outline.js', 'stack3d/section-outline.js', 'stack3d/brain-context.js', 'stack3d/renderer.js']) {
      await h.page.addScriptTag({ url: h.baseURL + '/' + file });
    }
    const result = await h.page.evaluate(() => {
      const sections = [0, 1].map(i => {
        const id = 'atlas-test-' + i, name = i ? 'Cor_2_3' : 'Cor_1_2';
        const project = { id, displayName: name, grid: { W: 6, H: 4, umPerPxX: 100, umPerPxY: 100 },
          images: {}, molecules: [{ key: 'MSI_DA', name: 'DA' }], rotation: { all: 90, he: 35, msi: -12 },
          world_coords: { T_he_to_msi: [[0.25, 0, 0], [0, 0.25, 0], [0, 0, 1]] },
          stack3d: { offsetXUm: i * 250, offsetYUm: -50, rotationDeg: 8 },
          roi: { roi_items: { a: [{ poly_msi: [[1, 1], [5, 1], [5, 3], [1, 3]] }] }, roi_names: { a: 'ROI' } } };
        const raw = Float32Array.from({ length: 24 }, (_, k) => k % 6 >= 1 && k % 6 <= 4 && k >= 6 && k < 18 ? k : NaN);
        const canvas = document.createElement('canvas'); canvas.width = 6; canvas.height = 4;
        canvas.getContext('2d').fillStyle = '#00ffff'; canvas.getContext('2d').fillRect(0, 0, 6, 4);
        return { id, name, project, zIndex: i, ...Stack3D.geometry(project), textureCanvas: canvas,
          rasters: { MSI_DA: { W: 6, H: 4, values: raw } }, channels: { DA: { key: 'MSI_DA', raw } } };
      });
      const dataset = { schemaVersion: 1, id: 'marmoset-bma2023-v1', sections: sections.map((section, i) => {
        const t = (i ? -12 : 17) * Math.PI / 180;
        return { name: section.name, projectId: section.id, atlasSlice: i ? 165 : 46,
          source: { grid: section.project.grid, rotation: section.project.rotation, T_he_to_msi: section.project.world_coords.T_he_to_msi },
          rawMSIToAtlas: [[2 * Math.cos(t), -2 * Math.sin(t), 235 + i], [2 * Math.sin(t), 2 * Math.cos(t), 301], [0, 0, 1]] };
      }) };
      const originalProjects = JSON.stringify(sections.map(s => s.project));
      const rawBytes = sections.map(s => Array.from(new Uint8Array(s.channels.DA.raw.buffer)));
      const groups = new Map(), outerGroups = new Map();
      const oldRoi = Stack3DRoi.create, oldOuter = Stack3DSectionOutline.create, oldAdd = AtlasThree.Scene.prototype.add;
      const oldFillText = CanvasRenderingContext2D.prototype.fillText;
      let captureLabels = [];
      CanvasRenderingContext2D.prototype.fillText = function (label, ...args) {
        captureLabels.push(String(label)); return oldFillText.call(this, label, ...args);
      };
      let scene;
      Stack3DRoi.create = (...args) => { const overlay = oldRoi(...args); groups.set(args[2].id, overlay.group); return overlay; };
      Stack3DSectionOutline.create = (...args) => { const overlay = oldOuter(...args); outerGroups.set(args[1].id, overlay.group); return overlay; };
      AtlasThree.Scene.prototype.add = function (...objects) { scene = this; return oldAdd.apply(this, objects); };
      const host = document.createElement('div'); host.style.cssText = 'width:800px;height:500px'; document.body.append(host);
      const errors = [], renderer = Stack3DRenderer.createRenderer(host, { onError: e => errors.push(e.message) });
      const pose = mesh => ({ position: mesh.position.toArray(), angle: mesh.rotation.z * 180 / Math.PI, uuid: mesh.uuid });
      const capture = () => {
        captureLabels = []; renderer.capturePNG(); const planes = [];
        scene.traverse(object => {
          if (object.userData.layer) planes.push({ id: object.userData.sectionId, layer: object.userData.layer,
            ...pose(object), texture: object.material.map?.uuid, geometry: object.geometry.uuid });
        });
        return { stats: renderer.getStats(), view: renderer.getView(), planes, captureLabels: [...captureLabels],
          rois: sections.filter(s => groups.has(s.id)).map(s => ({ id: s.id, ...pose(groups.get(s.id)) })),
          outlines: sections.filter(s => outerGroups.has(s.id)).map(s => ({ id: s.id, ...pose(outerGroups.get(s.id)) })) };
      };
      try {
        renderer.setSections(sections);
        renderer.updateHeTextures(Object.fromEntries(sections.map(s => [s.id, s.textureCanvas])));
        renderer.setHeOverlay({ visible: true, opacity: 0.4 }); renderer.setSpacing(0.8);
        renderer.setHiddenSections([sections[0].id]); renderer.select(1); renderer.setRange(0, 1);
        renderer.setView({ position: [0, 0, 30], target: [0, 0, 0], up: [0, 1, 0], zoom: 1.3 });
        const before = capture(), prepared = Stack3DStandardAtlas.prepare(sections, dataset);
        Stack3DStandardAtlas.apply(sections, prepared, 'atlas'); renderer.refreshPlacements();
        const atlas = capture();
        renderer.setBrainContext({ visible: true }); const combinedBadge = capture(); renderer.setBrainContext({ visible: false });
        renderer.setSpacing(2.25); const spacingChanged = capture();
        let partialError = '';
        try { renderer.refreshPlacements([sections[0], { ...sections[1], standardAtlasPose: undefined }]); } catch (e) { partialError = e.message; }
        const afterRejected = capture();
        Stack3DStandardAtlas.apply(sections, prepared, 'legacy'); renderer.refreshPlacements(sections); const restored = capture();
        Stack3DStandardAtlas.apply(sections, prepared, 'atlas'); renderer.setSections([sections[1]]); const subset = capture();
        return { before, atlas, combinedBadge, spacingChanged, restored, subset, afterRejected, partialError, errors,
          originalProjects, finalProjects: JSON.stringify(sections.map(s => s.project)), rawBytes,
          finalBytes: sections.map(s => Array.from(new Uint8Array(s.channels.DA.raw.buffer))) };
      } finally {
        renderer.dispose(); host.remove(); Stack3DRoi.create = oldRoi; Stack3DSectionOutline.create = oldOuter;
        AtlasThree.Scene.prototype.add = oldAdd; CanvasRenderingContext2D.prototype.fillText = oldFillText;
      }
    });
    assert.equal(result.atlas.stats.placementMode, 'atlas');
    assert.deepEqual(result.atlas.captureLabels, ['BMA2023 ESTIMATED PLACEMENT / RIGHT HEMISPHERE', 'UNIFORM DISPLAY SPACING / NOT MEASURED']);
    assert.deepEqual(result.combinedBadge.captureLabels, ['BMA2023 ESTIMATED PLACEMENT / RIGHT HEMISPHERE', 'UNIFORM DISPLAY SPACING / NOT MEASURED', 'SCHEMATIC / NOT REGISTERED']);
    assert.deepEqual(result.before.captureLabels, []); assert.deepEqual(result.restored.captureLabels, []);
    assert.deepEqual(result.atlas.view, result.before.view);
    assert.deepEqual(result.atlas.stats.hiddenSectionIds, result.before.stats.hiddenSectionIds);
    assert.deepEqual(result.atlas.stats.range, result.before.stats.range);
    assert.equal(result.atlas.stats.selectedIndex, result.before.stats.selectedIndex);
    assert.equal(result.atlas.stats.textureCount, 2); assert.equal(result.atlas.stats.heTextureCount, 2);
    for (const [state, spacing] of [[result.atlas, 0.8], [result.spacingChanged, 2.25]]) {
      assert.deepEqual(state.view, result.before.view);
      assert.deepEqual(state.stats.hiddenSectionIds, result.before.stats.hiddenSectionIds);
      assert.deepEqual(state.stats.range, result.before.stats.range);
      for (const [i, section] of state.stats.placements.entries()) {
        near(section.position[2], (i - 0.5) * spacing);
        near(section.rotationDeg, [-17, 12][i]);
        const planes = state.planes.filter(p => p.id === section.id);
        assert.equal(planes.length, 2);
        for (const object of [...planes, ...state.rois.filter(o => o.id === section.id), ...state.outlines.filter(o => o.id === section.id)]) {
          object.position.forEach((v, j) => near(v, section.position[j])); near(object.angle, section.rotationDeg);
        }
        near(section.position[0], result.atlas.stats.placements[i].position[0]);
        near(section.position[1], result.atlas.stats.placements[i].position[1]);
      }
    }
    assert.notDeepEqual(result.spacingChanged.stats.placements, result.atlas.stats.placements, 'Atlas depth responds to display spacing');
    assert.match(result.partialError, /同時/);
    assert.deepEqual(result.afterRejected.stats.placements, result.spacingChanged.stats.placements, 'failed mixed switch is atomic');
    for (const plane of result.before.planes) {
      const atlas = result.atlas.planes.find(p => p.id === plane.id && p.layer === plane.layer);
      assert.equal(atlas.uuid, plane.uuid); assert.equal(atlas.texture, plane.texture); assert.equal(atlas.geometry, plane.geometry);
    }
    result.before.rois.forEach((roi, i) => assert.equal(result.atlas.rois[i].uuid, roi.uuid));
    result.before.outlines.forEach((outline, i) => assert.equal(result.atlas.outlines[i].uuid, outline.uuid));
    assert.equal(result.restored.stats.placementMode, 'legacy');
    result.restored.stats.placements.forEach((pose, i) => {
      near(pose.position[0], result.before.stats.placements[i].position[0]); near(pose.position[1], result.before.stats.placements[i].position[1]);
      near(pose.rotationDeg, result.before.stats.placements[i].rotationDeg); near(pose.position[2], (i - 0.5) * 2.25);
    });
    assert.deepEqual(result.subset.stats.placements[0], result.spacingChanged.stats.placements[1], 'omitted slices do not recenter Atlas depth');
    assert.equal(result.finalProjects, result.originalProjects); assert.deepEqual(result.finalBytes, result.rawBytes);
    assert.deepEqual(result.errors, []); assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
