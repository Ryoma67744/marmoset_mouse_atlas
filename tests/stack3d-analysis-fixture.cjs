'use strict';
// Small, entirely synthetic scientific data shared by 3D analysis browser tests
// and visual QA. No production or user data is embedded in this fixture.
const { seedViewerProject } = require('./browser-harness.cjs');
const sectionId = number => 'analysis-section-' + String(number).padStart(2, '0');

async function seedAnalysisStack(harness, options = {}) {
  const count = options.count || 69;
  const width = options.width || 12, height = options.height || 8;
  const ids = Array.from({ length: count }, (_, index) => sectionId(index + 1));
  await seedViewerProject(harness.page, harness.baseURL, { id: ids[0] });
  await harness.page.evaluate(async ({ ids, width, height, missingCorrection, scopeVariant }) => {
    await ProjectStorage.putFolder({ id: 'analysis-species', name: 'Synthetic analysis', parentId: null });
    await ProjectStorage.putFolder({ id: 'analysis-coronal', name: 'Coronal', parentId: 'analysis-species', normalizationGroupId: 'analysis-group' });
    const entries = [];
    const polygon = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
    for (let index = 0; index < ids.length; index++) {
      const number = index + 1;
      const project = {
        id: ids[index], displayName: 'Cor_1_' + number, folderId: 'analysis-coronal',
        grid: { W: width, H: height, umPerPxX: 130, umPerPxY: 130 }, images: {}, molecules: [],
        visibleLayers: ['MSI_DA', 'MSI_NE', 'MSI_5-HT'], valueDisplay: { mode: 'raw' },
        rotation: { all: 0, msi: 0, he: 0 },
        roi: { roi_names: { caudate: 'Caudate', putamen: 'Putamen', thalamus: 'Thalamus' },
          roi_items: {
            caudate: [{ poly_msi: polygon(-.5, -.5, width * (.25 + (number % 3) * .05) - .5, height - .5) }],
            putamen: [{ poly_msi: polygon(width * .4 - .5, -.5, width * .7 - .5, height - .5) }],
            thalamus: [{ poly_msi: polygon(width * .75 - .5, -.5, width - .5, height - .5) }]
          }, palette: { caudate: [255, 125, 125], putamen: [125, 255, 125], thalamus: [125, 125, 255] },
          roi_show_flags: { caudate: true, putamen: true, thalamus: true } },
        otsu: { applied: false, sourceKeys: ['MSI_DA', 'MSI_NE', 'MSI_5-HT'] },
        normalizationBinding: { groupId: 'analysis-group', memberId: ids[index], folderPath: ['Synthetic analysis', 'Coronal'] }
      };
      if (number % 7 === 0) {
        delete project.roi.roi_names.thalamus; delete project.roi.roi_items.thalamus;
        delete project.roi.palette.thalamus; delete project.roi.roi_show_flags.thalamus;
      }
      const definitions = [['MSI_DA', 'DA', 1], ['MSI_NE', 'NE', 2], ['MSI_5-HT', '5-HT', 3], ['MSI_D4-5-HT', 'D4-5-HT', 0]];
      const rasters = {};
      for (const [key, name, scale] of definitions) {
        if (name === 'D4-5-HT' && number === missingCorrection) continue;
        const values = new Float32Array(width * height);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const at = y * width + x;
          values[at] = scale ? scale * (number * 10 + x + y * 3) : 10 + number;
          // Preserve measured zeroes; a finite high tail keeps whisker tests honest.
          if (scale && x === 0 && y === 0) values[at] = 0;
          if (scale && x === 1 && y === 1) values[at] *= 8;
          if (scale && x === width - 1 && y === height - 1) values[at] = NaN;
        }
        const blobId = await ProjectStorage.putValueRaster(values);
        project.molecules.push({ key, name, blobId, stats: MSIRaster.deriveBakeStats(values) });
        rasters[key] = { W: width, H: height, values };
      }
      entries.push({ project, rasters });
    }
    const result = Normalization.createSimpleProfiles(entries, { id: 'analysis-profile', revision: 1,
      scope: { type: 'folder-depth', depth: 2, includeDescendants: true, groupId: 'analysis-group',
        folderPath: ['Synthetic analysis', 'Coronal'], memberIds: ids } });
    if (!result.canSave) throw new Error('The synthetic analysis normalization profile must be valid');
    for (let index = 0; index < entries.length; index++) {
      entries[index].project.normalization = result.profiles[index].normalization;
      await ProjectStorage.putProject(entries[index].project);
    }
    if (scopeVariant) {
      const project = entries[ids.length - 2].project;
      project.normalization.scope.groupId = 'analysis-other-group';
      project.normalizationBinding.groupId = 'analysis-other-group';
      await ProjectStorage.putProject(project);
    }
    sessionStorage.setItem('marmoset:currentFolder', 'analysis-coronal');
    for (const key of ['atlas-stack3d-selection', 'atlas-stack3d-view-v1', 'atlas-stack3d-layout-v1',
      'atlas-stack3d-analysis-v1', 'atlas-stack3d-analysis-layout-v1']) sessionStorage.removeItem(key);
  }, { ids, width, height, missingCorrection: options.missingCorrection === false ? -1 : options.missingCorrection || count, scopeVariant: !!options.scopeVariant });
  await harness.context.route(harness.baseURL + '/lib/cloud-config.js', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.CLOUD_CONFIG = {};'
  }));
  return ids;
}

async function readyAnalysisStack(page, count = 69) {
  await page.waitForFunction(count => window.__stack3dReady && window.Atlas3D?.sections.length === count &&
    Atlas3D.renderer?.getStats().renderCount > 0, count);
  await page.waitForFunction(() => window.Atlas3D?.analysis?.getState && !Atlas3D.analysis.getState().loading && Atlas3D.analysis.getState().result);
}

async function setInputValue(page, selector, value) {
  await page.locator(selector).evaluate((input, value) => {
    input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function scientificSnapshot(page) {
  return page.evaluate(async () => {
    const projects = (await ProjectStorage.listProjects()).sort((a, b) => a.id.localeCompare(b.id));
    const result = { projects, rasters: {} };
    for (const project of projects) for (const molecule of project.molecules) {
      const values = await ProjectStorage.getValueRaster(molecule.blobId);
      result.rasters[project.id + ':' + molecule.key] = Array.from(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
    }
    return result;
  });
}

module.exports = { sectionId, seedAnalysisStack, readyAnalysisStack, setInputValue, scientificSnapshot };
