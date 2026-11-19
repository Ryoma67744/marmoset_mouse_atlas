/* Read saved MSI and ROI from this browser. Never sync, normalize, or write data. */
(function (global) {
  'use strict';
  const MOLECULES = Object.freeze([
    Object.freeze({ id: '5-HT', label: '5-HT', color: '#00ff66' }),
    Object.freeze({ id: 'DA', label: 'DA', color: '#ff5555' }),
    Object.freeze({ id: 'NE', label: 'NE', color: '#ffe14a' }),
    Object.freeze({ id: 'D4-5-HT', label: 'D4-5-HT', color: '#d7dce2', role: 'internal_standard' }),
  ]);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const REGIONS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'V1', 'V2'];
  function layerSources(st) {
    const pair = global.MsiStPairs.getPairForSt(st);
    if (!pair) return [];
    const result = [{ projectId: pair.projectId, section: pair.section, st: pair.st, mode: 'registered' }];
    const reference = global.MsiStPairs.getReferenceForSt(st);
    if (reference) result.push(reference);
    return result;
  }
  function comparisonRegion(definition) {
    // Input layer-named polygons are boundaries. Only the resolved difference represents a layer.
    if (definition.kind === 'cortical-layer') return 'L' + definition.layer;
    const name = definition.name.normalize('NFKC').trim();
    const area = /^(?:V([12])|Occipital\s+lobe\s*\(\s*V([12])\s*\))$/i.exec(name);
    return area ? 'V' + (area[1] || area[2]) : null;
  }
  function rawRoiStatistics(mask, rasters) {
    const result = {};
    for (const [j, molecule] of MOLECULES.entries()) {
      const raster = rasters[j];
      if (!raster) continue;
      const values = [];
      for (let i = 0; i < mask.length; i++) {
        if (mask[i] && Number.isFinite(raster[i])) values.push(raster[i]);
      }
      values.sort((a, b) => a - b);
      const count = values.length, mid = Math.floor(count / 2);
      const median = count ? (values[Math.floor((count - 1) / 2)] + values[mid]) / 2 : null;
      result[molecule.id] = { measuredPixels: count, median };
    }
    return result;
  }
  function layerRows(section, moleculeId) {
    return REGIONS.map(region => {
      const matches = (section?.rois || []).filter(roi => roi.region === region);
      const row = { region, available: false, status: 'missing_roi', reason: '対応する登録ROIがありません。',
        roiId: null, sourceKeys: [], ruleVersion: null, geometryPixels: null, measuredPixels: null, missingPixels: null, median: null };
      if (!section) return { ...row, status: 'not_loaded', reason: 'MSIの保存データが未読込です。' };
      if (!matches.length) return row;
      if (matches.length > 1) return { ...row, status: 'ambiguous_roi', reason: '同じ領域に対応するROIが複数あります。' };
      const roi = matches[0];
      Object.assign(row, { roiId: roi.id, sourceKeys: roi.sourceKeys, ruleVersion: roi.ruleVersion || null, geometryPixels: roi.areaPixels });
      if (!roi.available) {
        let status = 'invalid_roi';
        if (roi.reasonCodes.every(code => code === 'ROI_BOUNDARY_MISSING')) status = 'missing_roi';
        else if (roi.reasonCodes.includes('ROI_BOUNDARY_AMBIGUOUS')) status = 'ambiguous_roi';
        return { ...row, status, reason: roi.reason, reasonCodes: roi.reasonCodes };
      }
      const stats = roi.moleculeStats?.[moleculeId];
      if (!stats) return { ...row, status: 'channel_unavailable', reason: 'この分子の生信号が登録されていません。' };
      return { ...row, ...stats, available: stats.measuredPixels > 0, missingPixels: roi.areaPixels - stats.measuredPixels,
        status: stats.measuredPixels ? 'ok' : 'no_finite_pixels', reason: stats.measuredPixels ? '' : 'ROI内にこの分子の有限な測定画素がありません。' };
    });
  }
  function viewerUrl(projectId) {
    if (!projectId || !global.location?.href) return null;
    const url = new URL('../viewer/index.html', global.location.href);
    url.searchParams.set('project', projectId); url.searchParams.set('from', 'comparison'); url.searchParams.set('newtab', '1');
    return url.href;
  }
  function failure(code, message, projectId) {
    const error = new Error(message); error.code = code;
    if (projectId) error.viewerUrl = viewerUrl(projectId);
    return error;
  }
  function geometry(project) {
    const width = project.grid?.W, height = project.grid?.H;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 16000000) {
      throw failure('INVALID_GRID', 'MSIの画素寸法を確認できません。個別ページで切片を確認してください。', project.id);
    }
    const all = project.rotation?.all ?? 0, msi = project.rotation?.msi ?? 0;
    if (!finite(all) || !finite(msi)) throw failure('INVALID_ROTATION', 'MSIの保存済み回転角が不正です。', project.id);
    const angle = all + msi - 180 + (project.atlas?.coordinateMode === 'pixel' ? 180 : 0);
    if (!finite(angle)) throw failure('INVALID_ROTATION', 'MSIの保存済み回転角が不正です。', project.id);
    const radians = angle * Math.PI / 180;
    const c = Math.round(Math.cos(radians) * 1e12) / 1e12, s = Math.round(Math.sin(radians) * 1e12) / 1e12;
    const displayWidth = Math.max(1, Math.ceil(width * Math.abs(c) + height * Math.abs(s) - 1e-9));
    const displayHeight = Math.max(1, Math.ceil(width * Math.abs(s) + height * Math.abs(c) - 1e-9));
    return { width, height, displayWidth, displayHeight, angle,
      matrix: [c, s, -s, c, displayWidth / 2 - c * width / 2 + s * height / 2, displayHeight / 2 - s * width / 2 - c * height / 2],
      umPerPxX: finite(project.grid.umPerPxX) ? project.grid.umPerPxX : null,
      umPerPxY: finite(project.grid.umPerPxY) ? project.grid.umPerPxY : null };
  }
  function numericRange(values) {
    const sorted = values.filter(finite).sort((a, b) => a - b), valid = sorted.length;
    if (!valid) return { min: null, max: null, p99: null, valid: 0, missing: values.length, zero: 0, negative: 0 };
    const position = (valid - 1) * .99, lower = Math.floor(position), fraction = position - lower;
    return { min: sorted[0], max: sorted[valid - 1], p99: sorted[lower] * (1 - fraction) + sorted[Math.min(lower + 1, valid - 1)] * fraction,
      valid, missing: values.length - valid, zero: sorted.filter(value => value === 0).length, negative: sorted.filter(value => value < 0).length };
  }
  function buildRois(project, bounds, measured, rasters) {
    const { width, height, matrix } = bounds, rois = [];
    const transform = ([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
    const definitions = global.MSIRaster.roiDefinitions(project.roi);
    const boundaryKeys = new Set((definitions.find(definition => definition.kind === 'cortical-layer')?.boundaryChain || [])
      .flatMap(boundary => boundary.keys));
    for (const [key, records] of Object.entries(project.roi?.roi_items || {})) {
      // Layer geometry has per-ROI unavailable reasons in the common resolver.
      // Keep the existing strict validation for unrelated saved annotations.
      if (boundaryKeys.has(key)) continue;
      if (!Array.isArray(records)) throw failure('INVALID_ROI', '保存済みROIの構造が不正です。個別ページで確認してください。', project.id);
      const nativePolygons = records.map(record => record?.poly_msi);
      if (nativePolygons.some(poly => !Array.isArray(poly) || poly.length < 3 || poly.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(finite)))) {
        throw failure('INVALID_ROI', '保存済みROIの輪郭に不正な座標があります。個別ページで確認してください。', project.id);
      }
    }
    for (const definition of definitions) {
      const id = definition.key, contours = global.MSIRaster.roiContours(definition);
      const nativePolygons = contours.map(contour => contour.vertices);
      if (!nativePolygons.length && definition.kind !== 'cortical-layer') continue;
      const resolved = global.MSIRaster.roiMask(definition, width, height), mask = resolved.mask;
      let measuredCount = 0, areaPixels = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) { areaPixels++; if (measured[i]) measuredCount++; }
      // Run rectangles preserve exact union-minus-union membership even when a
      // boundary has overlapping polygons. An even-odd contour fill would XOR them.
      const paths = [];
      if (definition.kind === 'cortical-layer' && resolved.available) {
        for (let y = 0; y < height; y++) {
          let x = 0;
          while (x < width) {
            if (!mask[y * width + x]) { x++; continue; }
            const start = x;
            while (x < width && mask[y * width + x]) x++;
            const corners = [[start, y], [x, y], [x, y + 1], [start, y + 1]].map(transform);
            paths.push('M' + corners.map(point => point.join(',')).join('L') + 'Z');
          }
        }
      }
      const region = comparisonRegion(definition);
      rois.push({ id, name: definition.name, color: definition.color, region,
        moleculeStats: region && resolved.available ? rawRoiStatistics(mask, rasters) : null,
        nativePolygons: nativePolygons.map(poly => poly.map(point => [...point])), polygons: nativePolygons.map(poly => poly.map(transform)),
        measuredCount: resolved.available ? measuredCount : null, areaPixels: resolved.available ? areaPixels : null,
        polygonCount: nativePolygons.length, originalVisible: definition.visible,
        kind: definition.kind, definition: definition.definition, ruleVersion: definition.ruleVersion,
        sourceKeys: definition.sourceKeys, available: resolved.available, reasonCodes: resolved.reasonCodes,
        reason: global.MSIRaster.roiReasonText(resolved.reasonCodes), areaPath: paths.join('') });
    }
    return rois;
  }
  async function load(projectId, { referenceFor } = {}) {
    const pair = referenceFor === undefined ? global.MsiStPairs?.pairs.find(item => item.projectId === projectId) :
      layerSources(referenceFor).find(item => item.mode === 'reference' && item.projectId === projectId);
    if (!pair) throw failure('UNREGISTERED_PAIR', 'この切片のMSI–ST対応は未登録です。');
    const storage = global.ProjectStorage;
    if (!storage?.getProject || !storage?.getValueRaster) throw failure('STORAGE_UNAVAILABLE', 'MSIの保存領域を利用できません。個別ページから開き直してください。', projectId);
    const project = await storage.getProject(projectId);
    if (!project) throw failure('PROJECT_NOT_LOADED', 'このブラウザには切片のMSIデータがまだありません。個別ページで切片を開き、読み込み後に「MSI・ROIを再読込」を押してください。', projectId);
    if (project.id !== projectId || !global.MsiStPairs.isMarmosetCoronalProject(project)) {
      throw failure('PROJECT_MISMATCH', '保存済み切片とMSI–ST対応情報が一致しません。個別ページで確認してください。', projectId);
    }
    const bounds = geometry(project), count = bounds.width * bounds.height;
    const rasters = await Promise.all(MOLECULES.map(async molecule => {
      const candidates = (project.molecules || []).filter(item => item.key === 'MSI_' + molecule.id || item.name === molecule.id);
      if (candidates.length > 1) throw failure('AMBIGUOUS_MOLECULE', molecule.id + 'の登録が重複しています。個別ページで確認してください。', projectId);
      if (!candidates.length) return null;
      const values = await storage.getValueRaster(candidates[0].blobId);
      if (!(values instanceof Float32Array) || values.length !== count) throw failure('INVALID_RASTER', molecule.id + 'の生信号を読み込めません。個別ページでデータを読み込み直してください。', projectId);
      if (values.some(value => !Number.isFinite(value) && !Number.isNaN(value))) throw failure('INVALID_RASTER', molecule.id + 'の生信号に無限値が含まれています。', projectId);
      return values;
    }));
    if (!rasters.some(Boolean)) throw failure('NO_MSI_DATA', '5-HT・DA・NE・D4-5-HTの生信号が登録されていません。', projectId);
    const x = [], y = [], measured = new Uint8Array(count), values = Object.fromEntries(MOLECULES.map(molecule => [molecule.id, []]));
    for (let i = 0; i < count; i++) {
      if (!rasters.some(raster => raster && Number.isFinite(raster[i]))) continue;
      measured[i] = 1; x.push(i % bounds.width); y.push(Math.floor(i / bounds.width));
      for (let j = 0; j < MOLECULES.length; j++) values[MOLECULES[j].id].push(rasters[j] && Number.isFinite(rasters[j][i]) ? rasters[j][i] : null);
    }
    const loadedAt = new Date().toISOString(), projectUrl = viewerUrl(projectId);
    const source = { unit: 'a.u.', valueMode: 'raw', projectUrl, projectId, pairingMode: pair.mode || 'registered', st: pair.st,
      loadedAt, updatedAt: project.updatedAt || null,
      coordinateConvention: 'Zero-based native MSI pixels. Apply matrix to pixel centers [x+0.5,y+0.5]. ROI vertices use the same native pixel coordinate system.',
      note: 'Saved browser data only. No normalization, clipping, interpolation, thresholding, cloud sync, or writes. All-four-channel NaN pixels are omitted; individual NaN or absent-channel values remain null; zeros remain zero.' };
    const section = { ...bounds, x, y, values, ranges: Object.fromEntries(MOLECULES.map(molecule => [molecule.id, numericRange(values[molecule.id])])), measuredCount: x.length, source };
    const roiSection = { ...bounds, measuredCount: x.length, rois: buildRois(project, bounds, measured, rasters), source: { ...source,
      statistic: 'Measured pixel count is the union of finite raw values across the four displayed molecule channels inside the effective ROI. Cortical layers use outer boundary minus inner boundary; overlapping polygons count once.',
      roiRuleVersion: global.MSIRaster.ROI_LAYER_RULE_VERSION } };
    return { project, loadedAt, msiValues: { version: 1, molecules: MOLECULES, sections: { [pair.section]: section } },
      roiData: { version: 1, sections: { [pair.section]: roiSection } } };
  }
  global.MsiStProject = Object.freeze({ load, layerSources, layerRows });
})(window);
