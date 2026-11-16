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
  function pointInPolygon(x, y, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi) inside = !inside;
    }
    return inside;
  }
  function buildRois(project, bounds, measured) {
    const { width, height, matrix } = bounds, rois = [];
    const transform = ([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
    for (const [id, records] of Object.entries(project.roi?.roi_items || {})) {
      if (!Array.isArray(records)) throw failure('INVALID_ROI', '保存済みROIの構造が不正です。個別ページで確認してください。', project.id);
      const nativePolygons = records.map(record => record?.poly_msi);
      if (nativePolygons.some(poly => !Array.isArray(poly) || poly.length < 3 || poly.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(finite)))) {
        throw failure('INVALID_ROI', '保存済みROIの輪郭に不正な座標があります。個別ページで確認してください。', project.id);
      }
      if (!nativePolygons.length) continue;
      const mask = new Uint8Array(width * height);
      for (const polygon of nativePolygons) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of polygon) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
        for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(height - 1, Math.ceil(maxY)); y++) {
          for (let x = Math.max(0, Math.floor(minX)); x <= Math.min(width - 1, Math.ceil(maxX)); x++) if (pointInPolygon(x, y, polygon)) mask[y * width + x] = 1;
        }
      }
      let measuredCount = 0, areaPixels = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) { areaPixels++; if (measured[i]) measuredCount++; }
      const savedColor = project.roi.palette?.[id];
      const color = Array.isArray(savedColor) && savedColor.length >= 3 && savedColor.slice(0, 3).every(finite)
        ? savedColor.slice(0, 3).map(value => Math.round(Math.min(255, Math.max(0, value)))) : [180, 180, 180];
      rois.push({ id, name: String(project.roi.roi_names?.[id] || id), color,
        nativePolygons: nativePolygons.map(poly => poly.map(point => [...point])), polygons: nativePolygons.map(poly => poly.map(transform)),
        measuredCount, areaPixels, polygonCount: nativePolygons.length, originalVisible: project.roi.roi_show_flags?.[id] !== false });
    }
    return rois;
  }
  async function load(projectId) {
    const pair = global.MsiStPairs?.pairs.find(item => item.projectId === projectId);
    if (!pair) throw failure('UNREGISTERED_PAIR', 'この切片のMSI–ST対応は未登録です。');
    const storage = global.ProjectStorage;
    if (!storage?.getProject || !storage?.getValueRaster) throw failure('STORAGE_UNAVAILABLE', 'MSIの保存領域を利用できません。個別ページから開き直してください。', projectId);
    const project = await storage.getProject(projectId);
    if (!project) throw failure('PROJECT_NOT_LOADED', 'このブラウザには切片のMSIデータがまだありません。個別ページで切片を開き、読み込み後に比較画面を再読み込みしてください。', projectId);
    if (project.id !== projectId || global.MsiStPairs.getPairForProject(project)?.projectId !== pair.projectId) {
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
    if (!rasters.some(Boolean)) throw failure('NO_MSI_DATA', '比較に使用する5-HT・DA・NE・D4-5-HTの生信号が登録されていません。', projectId);
    const x = [], y = [], measured = new Uint8Array(count), values = Object.fromEntries(MOLECULES.map(molecule => [molecule.id, []]));
    for (let i = 0; i < count; i++) {
      if (!rasters.some(raster => raster && Number.isFinite(raster[i]))) continue;
      measured[i] = 1; x.push(i % bounds.width); y.push(Math.floor(i / bounds.width));
      for (let j = 0; j < MOLECULES.length; j++) values[MOLECULES[j].id].push(rasters[j] && Number.isFinite(rasters[j][i]) ? rasters[j][i] : null);
    }
    const loadedAt = new Date().toISOString(), projectUrl = viewerUrl(projectId);
    const source = { unit: 'a.u.', valueMode: 'raw', projectUrl, projectId, loadedAt, updatedAt: project.updatedAt || null,
      coordinateConvention: 'Zero-based native MSI pixels. Apply matrix to pixel centers [x+0.5,y+0.5]. ROI vertices use the same native pixel coordinate system.',
      note: 'Saved browser data only. No normalization, clipping, interpolation, thresholding, cloud sync, or writes. All-four-channel NaN pixels are omitted; individual NaN or absent-channel values remain null; zeros remain zero.' };
    const section = { ...bounds, x, y, values, ranges: Object.fromEntries(MOLECULES.map(molecule => [molecule.id, numericRange(values[molecule.id])])), measuredCount: x.length, source };
    const roiSection = { ...bounds, measuredCount: x.length, rois: buildRois(project, bounds, measured), source: { ...source,
      statistic: 'Measured pixel count is the union of finite raw values across the four displayed molecule channels inside the saved ROI; overlapping polygons count once.' } };
    return { project, loadedAt, msiValues: { version: 1, molecules: MOLECULES, sections: { [pair.section]: section } },
      roiData: { version: 1, sections: { [pair.section]: roiSection } } };
  }
  global.MsiStProject = Object.freeze({ load });
})(window);
