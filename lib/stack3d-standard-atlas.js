/* Optional, source-bound BMA2023 placement. Project data are never modified. */
(function (global) {
  'use strict';
  const PRESET_ID = 'marmoset-bma2023-v1';
  const ATLAS_PITCH_MM = 0.05, ATLAS_CENTER = 360, ORIGIN_SLICE = 314;
  const preparedStates = new WeakMap();
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const close = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  function affine(value) {
    return Array.isArray(value) && value.length === 3 && value.every(row => Array.isArray(row) && row.length === 3 && row.every(finite)) &&
      close(value[2][0], 0) && close(value[2][1], 0) && close(value[2][2], 1) &&
      Math.abs(value[0][0] * value[1][1] - value[0][1] * value[1][0]) > 1e-12;
  }
  function validGrid(grid) {
    return grid && Number.isSafeInteger(grid.W) && grid.W > 0 && Number.isSafeInteger(grid.H) && grid.H > 0 &&
      finite(grid.umPerPxX) && grid.umPerPxX > 0 && finite(grid.umPerPxY) && grid.umPerPxY > 0;
  }
  function rotations(value) {
    return ['all', 'he', 'msi'].map(key => value?.[key] ?? 0);
  }
  function validReference(reference) {
    if (reference == null) return true;
    if (typeof reference !== 'object' || Array.isArray(reference)) return false;
    return (!Object.hasOwn(reference, 'nativeGrid') || (Array.isArray(reference.nativeGrid) && reference.nativeGrid.length === 2 && reference.nativeGrid.every(n => n === 720))) &&
      (!Object.hasOwn(reference, 'pixelSpacingMm') || close(reference.pixelSpacingMm, ATLAS_PITCH_MM)) &&
      (!Object.hasOwn(reference, 'sliceSpacingMm') || close(reference.sliceSpacingMm, ATLAS_PITCH_MM)) &&
      (!Object.hasOwn(reference, 'imageOriginPx') || (Array.isArray(reference.imageOriginPx) && reference.imageOriginPx.length === 2 && reference.imageOriginPx.every(n => n === ATLAS_CENTER))) &&
      (!Object.hasOwn(reference, 'relativeSliceOrigin') || close(reference.relativeSliceOrigin, ORIGIN_SLICE)) &&
      (!Object.hasOwn(reference, 'physicalScale') || close(reference.physicalScale, 1)) &&
      (!Object.hasOwn(reference, 'specimenHemisphere') || reference.specimenHemisphere === 'right') &&
      (!Object.hasOwn(reference, 'nativeImageSide') || reference.nativeImageSide === 'left');
  }
  function sourceMatches(section, row) {
    const project = section?.project, source = row.source;
    if (!project || section.id !== row.projectId || project.id !== row.projectId || section.name !== row.name ||
        String(project.displayName || project.name || '') !== row.name ||
        global.Stack3D.seriesOf(section).id !== 'legacy_marmoset' || section.coordinateMode === 'pixel') return false;
    const grid = project.grid;
    if (!validGrid(grid) || ['W', 'H', 'umPerPxX', 'umPerPxY'].some(key => !close(grid[key], source.grid[key]))) return false;
    if (!close(section.W, grid.W) || !close(section.H, grid.H) ||
        !close(section.sceneWidth, grid.W * grid.umPerPxX / 1000) || !close(section.sceneHeight, grid.H * grid.umPerPxY / 1000)) return false;
    if (Object.hasOwn(source, 'rawFingerprint') &&
        (typeof source.rawFingerprint !== 'string' || !source.rawFingerprint.startsWith('f32-v1:') || section.sourceFingerprint !== source.rawFingerprint)) return false;
    const currentRotation = rotations(project.rotation), sourceRotation = rotations(source.rotation);
    if (currentRotation.some((value, index) => !close(value, sourceRotation[index]))) return false;
    const T = project.world_coords?.T_he_to_msi;
    return affine(T) && T.every((line, y) => line.every((value, x) => close(value, source.T_he_to_msi[y][x])));
  }
  function poseFor(row, displayIndex, displayCount) {
    const grid = row.source?.grid, M = row.rawMSIToAtlas;
    if (!validGrid(grid) || !affine(row.source?.T_he_to_msi) || !rotations(row.source?.rotation).every(finite) || !affine(M) ||
        !finite(row.atlasSlice) || row.atlasSlice < 0 || row.atlasSlice > 719) throw new Error('Atlas配置の座標または参照断面が不正です。');
    const [a, b] = M[0], [c, d] = M[1], sx = grid.umPerPxX / 50, sy = grid.umPerPxY / 50;
    // Columns may have different pixel lengths, but must be an isometry in
    // measured physical coordinates: no extra scale, shear, or reflection.
    if (!(a * d - b * c > 0) || !close(Math.hypot(a, c), sx) || !close(Math.hypot(b, d), sy) ||
        Math.abs(a * b + c * d) > 1e-9 * Math.max(1, sx * sy)) throw new Error('Atlas配置が測定画素サイズを保持する剛体変換ではありません。');
    const u = a * grid.W / 2 + b * grid.H / 2 + M[0][2], v = c * grid.W / 2 + d * grid.H / 2 + M[1][2];
    const pose = { x: (u - ATLAS_CENTER) * ATLAS_PITCH_MM, y: (ATLAS_CENTER - v) * ATLAS_PITCH_MM,
      angleDeg: -Math.atan2(c, a) * 180 / Math.PI,
      displayIndex, displayCount, ordinalZ: displayIndex - (displayCount - 1) / 2,
      atlasZMm: (row.atlasSlice - ORIGIN_SLICE) * ATLAS_PITCH_MM,
      atlasSlice: row.atlasSlice, atlasSliceSource: clone(row.atlasSliceSource ?? null), presetId: PRESET_ID, method: clone(row.method ?? null), qc: clone(row.qc ?? null),
      source: 'standard-atlas-estimate' };
    if (![pose.x, pose.y, pose.angleDeg, pose.ordinalZ, pose.atlasZMm].every(finite)) throw new Error('Atlas配置の計算結果が不正です。');
    return freeze(pose);
  }
  function prepare(sections, dataset) {
    const result = { available: false, matched: 0, total: Array.isArray(sections) ? sections.length : 0,
      reason: '', byId: new Map(), id: PRESET_ID, reference: clone(dataset?.reference ?? null) };
    if (!Array.isArray(sections) || !sections.length) { result.reason = '表示する切片がありません。'; return result; }
    if (dataset?.schemaVersion !== 1 || dataset.id !== PRESET_ID || !Array.isArray(dataset.sections) || !dataset.sections.length) {
      result.reason = '対応する標準Atlas配置データがありません。'; return result;
    }
    if (!validReference(dataset.reference)) { result.reason = '標準Atlasの座標系・半球・画素サイズが対応していません。'; return result; }
    const rows = new Map(), names = new Set(), state = new Map();
    try {
      for (const input of dataset.sections) {
        if (typeof input?.projectId !== 'string' || !input.projectId || typeof input.name !== 'string' || !input.name ||
            rows.has(input.projectId) || names.has(input.name)) throw new Error('Atlas配置の切片IDまたは名前が重複・欠落しています。');
        const row = freeze(clone(input)), order = global.Stack3D.naturalCor(row.name);
        if (!order || !Number.isSafeInteger(order.group) || !Number.isSafeInteger(order.section)) throw new Error('Atlas配置の切片順を確認できません。');
        rows.set(row.projectId, { row, order }); names.add(row.name);
      }
      // Keep the complete preset's natural section order. Loading a subset,
      // hiding planes, or narrowing a range must not collapse the Z gaps.
      // Atlas slice numbers are provenance only: repeats/reversals do not
      // overlap or reverse scientific sample sections in this display mode.
      const ordered = [...rows.values()].sort((a, b) => a.order.group - b.order.group || a.order.section - b.order.section ||
        a.row.name.localeCompare(b.row.name) || a.row.projectId.localeCompare(b.row.projectId));
      ordered.forEach((entry, index) => { entry.pose = poseFor(entry.row, index, ordered.length); });
      const ids = new Set();
      for (const section of sections) {
        if (!section || ids.has(section.id)) throw new Error('表示する切片IDが重複・欠落しています。');
        ids.add(section.id);
        const entry = rows.get(section.id);
        if (entry && sourceMatches(section, entry.row)) {
          result.byId.set(section.id, entry.pose); state.set(section.id, entry); result.matched++;
        }
      }
      result.available = result.matched === result.total;
      if (!result.available) result.reason = `読込済み${result.total}切片のうち${result.matched}切片だけが配置の元データと一致します。従来配置で表示します。`;
      preparedStates.set(result, state);
    } catch (error) {
      result.available = false; result.matched = 0; result.byId.clear(); result.reason = error.message;
    }
    return result;
  }
  function apply(sections, prepared, mode) {
    if (!Array.isArray(sections) || !['atlas', 'legacy'].includes(mode)) throw new TypeError('配置モードが不正です。');
    if (mode === 'legacy') { sections.forEach(section => { delete section.standardAtlasPose; }); return sections; }
    const state = preparedStates.get(prepared);
    // Recheck before switching: a cloud refresh may replace the source after
    // preparation. Fail atomically, rather than mix two coordinate frames.
    if (!prepared?.available || !state || sections.length !== prepared.total || new Set(sections.map(section => section.id)).size !== sections.length ||
        sections.some(section => !state.has(section.id) || !sourceMatches(section, state.get(section.id).row))) {
      throw new Error('元データが配置候補と一致しません。標準Atlas配置を再確認してください。');
    }
    sections.forEach(section => { section.standardAtlasPose = state.get(section.id).pose; });
    return sections;
  }
  global.Stack3DStandardAtlas = { prepare, apply, PRESET_ID };
})(window);
