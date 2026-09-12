/*
 * normalization.js — immutable, display-independent MSI calculations.
 *
 * Public API (window.Normalization):
 *   suggestMapping(molecules) -> {ht,d4,da,ne}: unique keys or null.
 *   loadRasters(project,{storage}) -> Promise<{key:{W,H,values}}>.
 *   fingerprint(project,rasters) -> stable Float32 content/grid/key digest.
 *   createProfiles([{project,rasters,mapping}], config) -> {profiles,preview}.
 *     profiles = [{projectId,normalization}]; no project/raw mutation.
 *   evaluate(project,rasters) -> {profile,status,reasonCodes,channels,section,fingerprint}.
 *     channel = {role,method,unit,values:Float64Array|null,status,reasonCodes,pixelReasons}.
 *     values contains derived values only; D4/other raw channels return null.
 *   quantifyRoi(project,rasters,evaluation,Uint8Array mask) -> per-molecule rows.
 *     raw/normalized = {mean,sd,n}; empty means/sds are null, not zero.
 *     absolute = {value,unit,status,reasonCodes,response,responseAggregation}.
 *   invalidate(project,detail) marks an existing profile stale; does not remove raw data.
 *
 * Profile schema v1: id/revision/batchId/prepId/quality, mapping, qc, reference,
 * calibration, rawFingerprint/referenceGeometryFingerprint/calculationFingerprint,
 * section:{Ds,Dref,k,nGeometry,nMeasured,nValid,coverage,status,reasonCodes},
 * commonRanges:{ht:{min,max},da:{min,max},ne:{min,max}}, otsuSourceRoles/Keys.
 * Missing Otsu roles produce null keys, never a silently reduced source set.
 *
 * Finite Float32 values are hashed by their IEEE bits (all nonfinite missing
 * values canonicalized, matching the raw CSV/XLSX blank-cell convention).
 * Project/blob IDs, display settings, Otsu, registration display transforms and
 * unrelated ROI geometry do not participate. Reference ROI geometry does.
 * All arithmetic reads raw arrays, writes NEW arrays and never uses Otsu.
 * Coverage = analytical valid / measured eligible, with geometric n separate.
 * Section measured support is the union of all raw channels inside the fixed
 * reference region; whole_tissue means measured footprint, NOT inferred tissue.
 * Saturation unknown is explicitly provisional, never QC passed.
 */
(function (global) {
  'use strict';
  const SCHEMA_VERSION = 1;
  const METHOD_VERSION = '1.0.0';
  const ROLES = ['ht', 'd4', 'da', 'ne'];
  const REASONS = {
    NORMALIZATION_PROFILE_MISSING: '補正設定がありません。Masterでバッチ・参照領域・QC条件を設定してください。',
    NO_NORMALIZATION_TARGETS: '補正対象の5-HT・DA・NEが指定されていません。D4は生値QCとして表示し、その他の分子には補正を適用しません。',
    NORMALIZATION_PROFILE_STALE: '生値・座標・参照ROIまたは補正条件が変更されています。Masterで設定を再計算してください。',
    NORMALIZATION_PROVISIONAL: '測定間の共通変動としての妥当性が未検証のため、暫定的な正規化です。',
    WHOLE_TISSUE_PROVISIONAL: '全実測範囲を参照とした暫定補正です。組織構成の差や散布量の差は測定感度差と区別できません。',
    D4_MISSING: 'D4-5-HTが登録・指定されていません。対応する内部標準を指定してください。',
    D4_AMBIGUOUS: 'D4-5-HTの候補が複数あります。使用する分子を明示的に指定してください。',
    MAPPING_INVALID: '分子対応が不正または重複しています。分子ごとの役割を再確認してください。',
    COORDINATE_MISMATCH: '分子の幅・高さ・配列長または保存された座標軸が一致しません。同じMSI座標のデータが必要です。',
    COORDINATE_MATCH_UNCONFIRMED: '同一切片・測定座標への対応が未確認です。元座標の確認後にMasterで設定してください。',
    MEASUREMENT_COMPARABILITY_UNCONFIRMED: '内部標準の散布量・測定条件・前処理の比較可能性が未確認です。',
    VALIDATION_EVIDENCE_MISSING: '検証済み正規化として扱うための検証記録がありません。',
    RAW_MISSING: '対象分子の生値ラスタがありません。生値データを取得してください。',
    RAW_NOT_MEASURED: 'この座標に対象分子の有効な実測値がありません。',
    D4_NOT_MEASURED: 'この座標にD4-5-HTの有効な実測値がありません。',
    D4_LOW_SIGNAL: 'D4-5-HTが0以下または設定した最低信号以下のため、除算できません。',
    D4_SATURATION: 'D4-5-HTが設定した飽和閾値以上です。',
    D4_SATURATION_UNKNOWN: 'D4-5-HTの飽和情報が未設定です。飽和していないことは確認できていません。',
    QC_THRESHOLDS_MISSING: 'D4最低信号・最低有効率のQC条件が不正または未設定です。',
    REFERENCE_MISSING: '固定参照集合に利用可能なD4代表値がありません。参照試料・領域・QCを確認してください。',
    REFERENCE_PARTIAL: '指定した固定参照集合の一部が利用できません。集合を黙って縮小せず、再確認が必要です。',
    REFERENCE_ROI_MISSING: '指定した参照ROIがありません。同じ参照領域を設定してください。',
    ROI_EMPTY_GEOMETRY: 'ROI内に幾何学的な画素がありません。ROI位置・形状を確認してください。',
    NO_MEASURED_PIXELS: 'ROI内に対象分子の実測画素がありません。',
    INSUFFICIENT_VALID_COVERAGE: '解析可能な画素の割合が設定した最低有効率を下回ります。D4信号・欠測・ROIを確認してください。',
    CALIBRATION_MISSING: '検量線が未登録のため、5-HT/D4比は表示できますが絶対定量値は算出できません。',
    CALIBRATION_INVALID: '検証済みの線形検量線、係数、単位、範囲、集約方法または出典が不足しています。',
    CALIBRATION_CONDITION_MISMATCH: '検量線と試料の前処理・測定バッチ条件が一致しません。',
    CALIBRATION_RESPONSE_OUT_OF_RANGE: 'ROIの応答値が検証済み検量範囲外です。外挿は行いません。',
    BELOW_LLOQ: '定量値がLLOQ未満です。0または確定濃度としては報告しません。',
    ABOVE_ULOQ: '定量値がULOQを超えています。外挿は行いません。',
    ABSOLUTE_NOT_APPLICABLE: 'この分子には絶対定量を適用していません。',
    NOT_APPLIED: 'この分子には補正・正規化を適用していません。',
    RAW_QC: 'D4-5-HTは内部標準の生値QCとして表示します。',
    OTSU_SOURCE_MISSING: '固定したOtsu入力分子の一部がありません。入力集合を再設定してください。',
    NUMERIC_OVERFLOW: '計算結果が有限値ではありません。入力値・係数を確認してください。'
  };

  function reasonText(code) { return REASONS[code] || String(code || ''); }
  function unique(items) { return Array.from(new Set(items.filter(Boolean))); }
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
    if (Array.isArray(value) || ArrayBuffer.isView(value)) return '[' + Array.from(value, stableStringify).join(',') + ']';
    return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  function hasher() {
    let a = 2166136261, b = 2246822519;
    function byte(n) { a = Math.imul(a ^ n, 16777619); b = Math.imul(b ^ n, 3266489917); }
    return {
      string(s) { s = String(s); for (let i = 0; i < s.length; i++) { byte(s.charCodeAt(i) & 255); byte(s.charCodeAt(i) >>> 8); } byte(255); },
      word(n) { byte(n & 255); byte((n >>> 8) & 255); byte((n >>> 16) & 255); byte(n >>> 24); },
      finish() { return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0'); }
    };
  }
  function digest(value) { const h = hasher(); h.string(stableStringify(value)); return h.finish(); }
  function alias(name) {
    return String(name || '').normalize('NFKC').toLowerCase().trim().replace(/\s*\(\d+\)\s*$/, '').replace(/[\s_\-‐‑‒–—―ー]/g, '');
  }
  function candidates(molecules, role) {
    const accepted = {
      ht: ['5ht', 'serotonin', '5hydroxytryptamine'],
      d4: ['d45ht', '5htd4', 'serotonind4', 'd4serotonin'],
      da: ['da', 'dopamine'], ne: ['ne', 'norepinephrine', 'noradrenaline']
    };
    return (molecules || []).filter(m => accepted[role].includes(alias(m.name)));
  }
  function suggestMapping(molecules) {
    const mapping = {};
    ROLES.forEach(role => { const found = candidates(molecules, role); mapping[role] = found.length === 1 ? found[0].key : null; });
    return mapping;
  }
  function gridShape(project) { return { W: Number(project.grid && project.grid.W), H: Number(project.grid && project.grid.H) }; }
  async function loadRasters(project, deps) {
    const storage = (deps && deps.storage) || global.ProjectStorage;
    const grid = gridShape(project), result = {};
    for (const m of project.molecules || []) {
      const values = m.blobId ? await storage.getValueRaster(m.blobId) : null;
      if (values) result[m.key] = Object.assign({}, coordinates(m.grid), {
        W: m.grid && m.grid.W != null ? Number(m.grid.W) : grid.W,
        H: m.grid && m.grid.H != null ? Number(m.grid.H) : grid.H, values: values });
    }
    return result;
  }
  function rasterOf(rasters, key, project) {
    const r = key && rasters && rasters[key];
    if (!r) return null;
    return r.values && !ArrayBuffer.isView(r) ? r : Object.assign(gridShape(project), { values: r });
  }
  function coordinates(r) {
    const out = {};
    ['xs', 'ys', 'xCoordinates', 'yCoordinates', 'coordinateFingerprint'].forEach(k => { if (r && r[k] != null) out[k] = r[k]; });
    return out;
  }
  function shapeValid(project, r) {
    const grid = gridShape(project);
    return !!r && Number.isInteger(grid.W) && grid.W > 0 && Number.isInteger(grid.H) && grid.H > 0 &&
      Number.isSafeInteger(grid.W * grid.H) && r.W === grid.W && r.H === grid.H && r.values && r.values.length === grid.W * grid.H;
  }
  function coordinatesMatch(a, b) {
    for (const key of ['xs', 'ys', 'xCoordinates', 'yCoordinates', 'coordinateFingerprint']) {
      if (a && b && a[key] != null && b[key] != null && stableStringify(a[key]) !== stableStringify(b[key])) return false;
    }
    return true;
  }
  function moleculeCoordinatesValid(project, key, raster) {
    if (!shapeValid(project, raster)) return false;
    const definition = (project.molecules || []).find(m => m.key === key) || {}, grid = definition.grid || {};
    if (grid.W != null && Number(grid.W) !== raster.W || grid.H != null && Number(grid.H) !== raster.H) return false;
    return coordinatesMatch(grid, raster) && coordinatesMatch(project.grid, raster) && coordinatesMatch(grid, project.grid);
  }
  function effectiveCoordinates(project, key, raster) {
    const definition = (project.molecules || []).find(m => m.key === key) || {};
    return Object.assign({}, coordinates(definition.grid), coordinates(raster));
  }
  function fingerprint(project, rasters) {
    const h = hasher(), grid = project.grid || {};
    h.string(stableStringify({ W: grid.W, H: grid.H, umPerPxX: grid.umPerPxX == null ? null : grid.umPerPxX,
      umPerPxY: grid.umPerPxY == null ? null : grid.umPerPxY, coordinates: coordinates(grid) }));
    const bits = new DataView(new ArrayBuffer(4));
    for (const m of (project.molecules || []).slice().sort((a, b) => String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0)) {
      h.string(m.key);
      const r = rasterOf(rasters, m.key, project);
      if (!r) { h.string('missing'); continue; }
      h.string(stableStringify({ W: r.W, H: r.H, coordinates: coordinates(r), molecularGrid: m.grid || null }));
      h.word(r.values.length);
      for (let i = 0; i < r.values.length; i++) {
        const value = r.values[i];
        if (!Number.isFinite(value)) h.word(0x7fc00000);
        else { bits.setFloat32(0, value, true); h.word(bits.getUint32(0, true)); }
      }
    }
    return 'f32-v1:' + h.finish();
  }
  function validPolygon(poly) { return Array.isArray(poly) && poly.length >= 3 && poly.every(p => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])); }
  function referencePolygons(project, reference) {
    // Whole measured footprint has no anatomical ROI dependency. A name left
    // in an old form must neither change its mask nor invalidate the profile.
    if (reference.kind === 'whole_tissue') return [];
    const names = reference.roiNames || [], roi = project.roi || {}, items = roi.roi_items || {}, labels = roi.roi_names || {};
    const byName = [];
    names.forEach(name => {
      const polygons = [];
      Object.keys(items).forEach(key => {
        if (String(labels[key] || key).normalize('NFC').trim() !== String(name).normalize('NFC').trim()) return;
        (Array.isArray(items[key]) ? items[key] : []).forEach(rec => { if (rec && validPolygon(rec.poly_msi)) polygons.push(rec.poly_msi); });
      });
      byName.push({ name: name, polygons: polygons });
    });
    return byName;
  }
  function geometryFingerprint(project, reference) {
    return digest({ kind: reference.kind, regions: referencePolygons(project, reference) });
  }
  function measuredUnion(project, rasters) {
    const grid = gridShape(project), mask = new Uint8Array(Number.isSafeInteger(grid.W * grid.H) && grid.W * grid.H > 0 ? grid.W * grid.H : 0);
    for (const m of project.molecules || []) {
      const r = rasterOf(rasters, m.key, project);
      if (!shapeValid(project, r)) continue;
      for (let i = 0; i < mask.length; i++) if (Number.isFinite(r.values[i])) mask[i] = 1;
    }
    return mask;
  }
  function pointInside(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if (((a[1] > y) !== (b[1] > y)) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  function markPolygon(mask, W, H, poly) {
    if (global.MSIRaster && global.MSIRaster.markRoiMask) return global.MSIRaster.markRoiMask(mask, W, H, poly);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (pointInside(x, y, poly)) mask[y * W + x] = 1;
    return mask;
  }
  function referenceMask(project, rasters, reference) {
    const grid = gridShape(project), measured = measuredUnion(project, rasters);
    if (reference.kind === 'whole_tissue') return { mask: measured, measured: measured, reasonCodes: [] };
    if (reference.kind !== 'roi' && !(reference.roiNames || []).length) return { mask: measured, measured: measured, reasonCodes: [] };
    const groups = referencePolygons(project, reference), mask = new Uint8Array(measured.length);
    const reasons = !groups.length || groups.some(g => !g.polygons.length) ? ['REFERENCE_ROI_MISSING'] : [];
    groups.forEach(g => g.polygons.forEach(poly => markPolygon(mask, grid.W, grid.H, poly)));
    return { mask: mask, measured: measured, reasonCodes: reasons };
  }
  function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : sorted[mid - 1] / 2 + sorted[mid] / 2;
  }
  function qcValid(qc) {
    return qc && Number.isFinite(qc.minD4) && qc.minD4 >= 0 && Number.isFinite(qc.minCoverage) && qc.minCoverage > 0 && qc.minCoverage <= 1 &&
      (qc.saturationD4 == null || Number.isFinite(qc.saturationD4) && qc.saturationD4 > qc.minD4);
  }
  function d4Reason(value, qc) {
    if (!Number.isFinite(value)) return 'D4_NOT_MEASURED';
    if (!(value > 0) || !(value > qc.minD4)) return 'D4_LOW_SIGNAL';
    if (qc.saturationD4 != null && value >= qc.saturationD4) return 'D4_SATURATION';
    return null;
  }
  function mappingReasons(project, mapping) {
    const keys = ROLES.map(r => mapping[r]).filter(Boolean), reasons = [];
    if (new Set(keys).size !== keys.length || keys.some(k => !(project.molecules || []).some(m => m.key === k))) reasons.push('MAPPING_INVALID');
    return reasons;
  }
  function missingD4Reason(project) { return candidates(project.molecules, 'd4').length > 1 ? 'D4_AMBIGUOUS' : 'D4_MISSING'; }
  function sectionStats(project, rasters, mapping, config) {
    const area = referenceMask(project, rasters, config.reference), d4 = rasterOf(rasters, mapping.d4, project);
    const reasons = area.reasonCodes.concat(mappingReasons(project, mapping));
    if (!d4) reasons.push(missingD4Reason(project));
    else if (!moleculeCoordinatesValid(project, mapping.d4, d4)) reasons.push('COORDINATE_MISMATCH');
    if (!qcValid(config.qc)) reasons.push('QC_THRESHOLDS_MISSING');
    const values = [], counts = {}, result = { Ds: null, Dref: null, k: null, nGeometry: 0, nMeasured: 0, nValid: 0, coverage: null, reasonCounts: counts };
    for (let i = 0; i < area.mask.length; i++) {
      if (!area.mask[i]) continue;
      result.nGeometry++;
      if (!area.measured[i]) continue;
      result.nMeasured++;
      if (d4 && shapeValid(project, d4) && qcValid(config.qc)) {
        const reason = d4Reason(d4.values[i], config.qc);
        if (reason) counts[reason] = (counts[reason] || 0) + 1;
        else values.push(d4.values[i]);
      }
    }
    result.nValid = values.length;
    result.coverage = result.nMeasured ? values.length / result.nMeasured : null;
    if (!result.nGeometry) reasons.push('ROI_EMPTY_GEOMETRY');
    else if (!result.nMeasured) reasons.push('NO_MEASURED_PIXELS');
    if (result.nMeasured && (!values.length || result.coverage < config.qc.minCoverage)) reasons.push('INSUFFICIENT_VALID_COVERAGE');
    if (!reasons.length) result.Ds = median(values);
    result.reasonCodes = unique(reasons.concat(Object.keys(counts)));
    result.status = result.Ds == null ? 'UNAVAILABLE' : 'VALID';
    return result;
  }
  function calculationFingerprint(profile) {
    return digest({ schemaVersion: profile.schemaVersion, methodVersion: profile.methodVersion, id: profile.id, revision: profile.revision,
      batchId: profile.batchId, prepId: profile.prepId, quality: profile.quality, mapping: profile.mapping, qc: profile.qc,
      coordinateMatchConfirmed: profile.coordinateMatchConfirmed, comparabilityConfirmed: profile.comparabilityConfirmed,
      validationEvidence: profile.validationEvidence,
      reference: profile.reference, calibration: profile.calibration, section: profile.section,
      rawFingerprint: profile.rawFingerprint, referenceGeometryFingerprint: profile.referenceGeometryFingerprint,
      commonRanges: profile.commonRanges, otsuSourceRoles: profile.otsuSourceRoles, otsuSourceKeys: profile.otsuSourceKeys });
  }
  function createProfiles(entries, config) {
    if (!Array.isArray(entries) || !entries.length) throw new Error('対象プロジェクトがありません。');
    config = clone(config || {});
    if (!config.id || !Number.isInteger(config.revision) || config.revision < 1 || !String(config.batchId || '').trim() || !String(config.prepId || '').trim()) throw new Error('プロファイルID・版・測定バッチ・前処理IDが必要です。');
    if (config.coordinateMatchConfirmed !== true) throw new Error(reasonText('COORDINATE_MATCH_UNCONFIRMED'));
    if (config.comparabilityConfirmed !== true) throw new Error(reasonText('MEASUREMENT_COMPARABILITY_UNCONFIRMED'));
    if (config.quality === 'validated' && !String(config.validationEvidence || '').trim()) throw new Error(reasonText('VALIDATION_EVIDENCE_MISSING'));
    if (!qcValid(config.qc)) throw new Error(reasonText('QC_THRESHOLDS_MISSING'));
    config.qc.saturationD4 = config.qc.saturationD4 == null ? null : config.qc.saturationD4;
    if (!config.reference || !['qc', 'roi', 'whole_tissue'].includes(config.reference.kind)) throw new Error('固定参照領域の種類が必要です。');
    if (config.reference.kind === 'whole_tissue') config.reference.roiNames = [];
    if (!Array.isArray(config.reference.projectIds) || !config.reference.projectIds.length) throw new Error(reasonText('REFERENCE_MISSING'));
    if (new Set(entries.map(e => e.project.id)).size !== entries.length) throw new Error('同一プロジェクトが重複しています。');
    const referenceIds = unique(config.reference.projectIds), known = new Set(entries.map(e => e.project.id));
    if (referenceIds.some(id => !known.has(id))) throw new Error('固定参照プロジェクトは今回の計算対象に含めてください。');
    const calculated = entries.map(entry => {
      const mapping = Object.assign({ ht: null, d4: null, da: null, ne: null }, entry.mapping || suggestMapping(entry.project.molecules));
      if (mappingReasons(entry.project, mapping).length || new Set((entry.project.molecules || []).map(m => m.key)).size !== (entry.project.molecules || []).length) throw new Error(reasonText('MAPPING_INVALID'));
      return { entry: entry, mapping: mapping, rawFingerprint: fingerprint(entry.project, entry.rasters),
        geometryFingerprint: geometryFingerprint(entry.project, config.reference),
        section: sectionStats(entry.project, entry.rasters, mapping, config) };
    });
    const refs = calculated.filter(c => referenceIds.includes(c.entry.project.id));
    const allReferencesValid = refs.length === referenceIds.length && refs.every(c => Number.isFinite(c.section.Ds) && c.section.Ds > 0);
    const Dref = allReferencesValid ? median(refs.map(c => c.section.Ds)) : null;
    const referenceSnapshot = Object.assign({}, config.reference, { projectIds: referenceIds,
      entries: refs.map(c => ({ projectId: c.entry.project.id, name: c.entry.project.displayName || c.entry.project.name || '', Ds: c.section.Ds,
        rawFingerprint: c.rawFingerprint, geometryFingerprint: c.geometryFingerprint, status: c.section.status, reasonCodes: c.section.reasonCodes })) });
    const profiles = calculated.map(c => {
      const section = clone(c.section), reasons = section.reasonCodes.slice();
      section.Dref = Dref;
      if (Dref == null) reasons.push(refs.some(r => r.section.Ds != null) ? 'REFERENCE_PARTIAL' : 'REFERENCE_MISSING');
      if (section.Ds != null && Dref != null) section.k = Dref / section.Ds;
      if (section.k != null && (!Number.isFinite(section.k) || section.k <= 0)) { section.k = null; reasons.push('NUMERIC_OVERFLOW'); }
      const quality = config.quality === 'validated' && config.reference.kind !== 'whole_tissue' && config.qc.saturationD4 != null ? 'validated' : 'provisional';
      if (quality !== 'validated') reasons.push('NORMALIZATION_PROVISIONAL');
      if (config.reference.kind === 'whole_tissue') reasons.push('WHOLE_TISSUE_PROVISIONAL');
      if (config.qc.saturationD4 == null) reasons.push('D4_SATURATION_UNKNOWN');
      section.reasonCodes = unique(reasons);
      section.status = section.k == null ? 'UNAVAILABLE' : quality === 'validated' ? 'VALID' : 'PROVISIONAL';
      const sourceRoles = Array.isArray(config.otsuSourceRoles) ? config.otsuSourceRoles.slice() : [];
      const profile = { schemaVersion: SCHEMA_VERSION, methodVersion: METHOD_VERSION, id: String(config.id), revision: config.revision,
        batchId: String(config.batchId), prepId: String(config.prepId), quality: quality, createdAt: new Date().toISOString(),
        coordinateMatchConfirmed: true, comparabilityConfirmed: true, validationEvidence: String(config.validationEvidence || '').trim(),
        mapping: clone(c.mapping), qc: clone(config.qc), reference: clone(referenceSnapshot), calibration: clone(config.calibration || null),
        rawFingerprint: c.rawFingerprint, referenceGeometryFingerprint: c.geometryFingerprint, section: section,
        commonRanges: {}, otsuSourceRoles: sourceRoles, otsuSourceKeys: sourceRoles.map(role => ['ht', 'da', 'ne'].includes(role) ? c.mapping[role] || null : null) };
      profile.calculationFingerprint = calculationFingerprint(profile);
      return { projectId: c.entry.project.id, normalization: profile };
    });
    // Fixed full finite range: deterministic, no clipping and no dependence on
    // later Viewer selection, order, new projects or an export subset.
    const ranges = {};
    profiles.forEach((item, index) => {
      const evaluation = evaluate(Object.assign({}, entries[index].project, { normalization: item.normalization }), entries[index].rasters);
      Object.keys(evaluation.channels).forEach(key => {
        const channel = evaluation.channels[key];
        if (!channel.values) return;
        for (let i = 0; i < channel.values.length; i++) {
          const v = channel.values[i]; if (!Number.isFinite(v)) continue;
          if (!ranges[channel.role]) ranges[channel.role] = { min: v, max: v };
          else { ranges[channel.role].min = Math.min(ranges[channel.role].min, v); ranges[channel.role].max = Math.max(ranges[channel.role].max, v); }
        }
      });
    });
    profiles.forEach(item => {
      item.normalization.commonRanges = clone(ranges);
      item.normalization.calculationFingerprint = calculationFingerprint(item.normalization);
    });
    const preview = profiles.map((item, index) => Object.assign({ projectId: item.projectId, name: entries[index].project.displayName || entries[index].project.name || '',
      quality: item.normalization.quality, profileId: item.normalization.id, revision: item.normalization.revision }, clone(item.normalization.section)));
    return { profiles: profiles, preview: preview };
  }
  function evaluate(project, rasters) {
    project = project || {}; rasters = rasters || {};
    const profile = project.normalization || null, currentFingerprint = fingerprint(project, rasters), reasons = [];
    const mapping = profile && profile.mapping || suggestMapping(project.molecules);
    if (!profile) reasons.push('NORMALIZATION_PROFILE_MISSING');
    else {
      if (profile.invalidated || profile.schemaVersion !== SCHEMA_VERSION || profile.methodVersion !== METHOD_VERSION ||
          profile.rawFingerprint !== currentFingerprint || !profile.reference ||
          profile.referenceGeometryFingerprint !== geometryFingerprint(project, profile.reference) ||
          profile.calculationFingerprint !== calculationFingerprint(profile)) reasons.push('NORMALIZATION_PROFILE_STALE');
      if (!qcValid(profile.qc)) reasons.push('QC_THRESHOLDS_MISSING');
      if (profile.coordinateMatchConfirmed !== true) reasons.push('COORDINATE_MATCH_UNCONFIRMED');
      if (profile.comparabilityConfirmed !== true) reasons.push('MEASUREMENT_COMPARABILITY_UNCONFIRMED');
    }
    reasons.push.apply(reasons, mappingReasons(project, mapping));
    const d4 = rasterOf(rasters, mapping.d4, project), grid = gridShape(project), n = Number.isSafeInteger(grid.W * grid.H) && grid.W * grid.H > 0 ? grid.W * grid.H : 0;
    const channels = {};
    for (const m of project.molecules || []) {
      const role = ROLES.find(r => mapping[r] === m.key) || 'other', raw = rasterOf(rasters, m.key, project);
      const channel = { role: role, method: role === 'ht' ? 'pixel_ratio' : role === 'da' || role === 'ne' ? 'section_scale' : role === 'd4' ? 'raw_qc' : 'not_applied',
        unit: role === 'ht' ? '5-HT/D4-5-HT ratio' : role === 'da' || role === 'ne' ? 'normalized a.u.' : 'raw a.u.',
        values: null, status: 'UNAVAILABLE', reasonCodes: [], pixelReasons: [] };
      channels[m.key] = channel;
      if (role === 'd4' || role === 'other') {
        channel.status = role === 'd4' ? 'RAW_QC' : 'NOT_APPLIED'; channel.reasonCodes = [channel.status]; continue;
      }
      const failures = reasons.slice();
      if (!raw) failures.push('RAW_MISSING');
      else if (!moleculeCoordinatesValid(project, m.key, raw)) failures.push('COORDINATE_MISMATCH');
      if (!d4) failures.push(missingD4Reason(project));
      else if (!moleculeCoordinatesValid(project, mapping.d4, d4) || raw && !coordinatesMatch(
        effectiveCoordinates(project, m.key, raw), effectiveCoordinates(project, mapping.d4, d4))) failures.push('COORDINATE_MISMATCH');
      if (failures.length) { channel.reasonCodes = unique(failures); continue; }
      if (role !== 'ht' && !(profile.section && Number.isFinite(profile.section.k) && profile.section.k > 0)) {
        channel.reasonCodes = unique((profile.section && profile.section.reasonCodes || []).concat('REFERENCE_MISSING')); continue;
      }
      const values = new Float64Array(n); values.fill(NaN);
      const pixelReasons = new Array(n), counts = {}; let measured = 0, valid = 0;
      for (let i = 0; i < n; i++) {
        let reason = null;
        if (!Number.isFinite(raw.values[i])) reason = 'RAW_NOT_MEASURED';
        else {
          measured++;
          if (role === 'ht') reason = d4Reason(d4.values[i], profile.qc);
          if (!reason) {
            const value = role === 'ht' ? raw.values[i] / d4.values[i] : raw.values[i] * profile.section.k;
            if (Number.isFinite(value)) { values[i] = value; valid++; }
            else reason = 'NUMERIC_OVERFLOW';
          }
        }
        pixelReasons[i] = reason;
        if (reason) counts[reason] = (counts[reason] || 0) + 1;
      }
      channel.values = values; channel.pixelReasons = pixelReasons; channel.reasonCounts = counts;
      channel.nMeasured = measured; channel.nValid = valid; channel.coverage = measured ? valid / measured : null;
      channel.reasonCodes = unique(Object.keys(counts).filter(c => c !== 'RAW_NOT_MEASURED').concat(
        profile.quality !== 'validated' ? ['NORMALIZATION_PROVISIONAL'] : [], profile.qc.saturationD4 == null ? ['D4_SATURATION_UNKNOWN'] : []));
      if (!measured) channel.reasonCodes.push('NO_MEASURED_PIXELS');
      if (measured && (!valid || channel.coverage < profile.qc.minCoverage)) channel.reasonCodes.push('INSUFFICIENT_VALID_COVERAGE');
      channel.status = !valid ? 'UNAVAILABLE' : valid < measured ? 'PARTIAL' : profile.quality === 'validated' && profile.qc.saturationD4 != null ? 'VALID' : 'PROVISIONAL';
    }
    const applicable = Object.values(channels).filter(c => ['ht', 'da', 'ne'].includes(c.role));
    if (!applicable.length) reasons.push('NO_NORMALIZATION_TARGETS');
    const any = applicable.some(c => c.values && c.nValid > 0), all = applicable.length && applicable.every(c => c.status === 'VALID');
    const status = !any ? 'UNAVAILABLE' : all ? 'VALID' : applicable.some(c => ['PARTIAL', 'UNAVAILABLE'].includes(c.status)) ? 'PARTIAL' : 'PROVISIONAL';
    return { profile: profile, status: status, reasonCodes: unique(reasons.concat(...applicable.map(c => c.reasonCodes))), channels: channels,
      section: profile ? profile.section || null : null, fingerprint: currentFingerprint };
  }
  function statistics(values) {
    let n = 0, mean = 0, m2 = 0;
    for (const value of values) {
      if (!Number.isFinite(value)) continue;
      n++; const delta = value - mean; mean += delta / n; m2 += delta * (value - mean);
    }
    return { mean: n ? mean : null, sd: n ? Math.sqrt(Math.max(0, m2 / n)) : null, n: n };
  }
  function calibrationReasons(calibration, profile) {
    if (!calibration) return ['CALIBRATION_MISSING'];
    const c = calibration;
    if (c.model !== 'linear' || c.validated !== true || !c.id || !String(c.source || '').trim() || !String(c.unit || '').trim() ||
        !Number.isFinite(c.slope) || !(c.slope > 0) || !Number.isFinite(c.intercept) ||
        !Number.isFinite(c.lloq) || c.lloq < 0 || !Number.isFinite(c.uloq) || !(c.uloq > c.lloq) ||
        !Number.isFinite(c.responseMin) || !Number.isFinite(c.responseMax) || !(c.responseMax > c.responseMin) ||
        !['mean_pixel_ratio', 'ratio_of_sums'].includes(c.responseAggregation)) return ['CALIBRATION_INVALID'];
    if (!profile || c.prepId !== profile.prepId || c.batchId !== profile.batchId) return ['CALIBRATION_CONDITION_MISMATCH'];
    return [];
  }
  function quantifyRoi(project, rasters, evaluation, mask) {
    evaluation = evaluation || evaluate(project, rasters);
    const grid = gridShape(project), expected = grid.W * grid.H;
    const validMask = mask && mask.length === expected;
    const profile = evaluation.profile;
    return (project.molecules || []).map(m => {
      const channel = evaluation.channels[m.key], role = channel ? channel.role : 'other', rawRaster = rasterOf(rasters, m.key, project);
      const rawValues = [], normalizedValues = [], reasonCounts = {}; let nGeometry = 0, sumNumerator = 0, sumDenominator = 0;
      const reasons = [], d4 = profile && profile.mapping && rasterOf(rasters, profile.mapping.d4, project);
      if (!validMask) reasons.push('COORDINATE_MISMATCH');
      const goodRaw = shapeValid(project, rawRaster);
      if (!goodRaw) reasons.push(rawRaster ? 'COORDINATE_MISMATCH' : 'RAW_MISSING');
      if (validMask) for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        nGeometry++;
        if (goodRaw && Number.isFinite(rawRaster.values[i])) rawValues.push(rawRaster.values[i]);
        if (channel && channel.values && Number.isFinite(channel.values[i])) {
          normalizedValues.push(channel.values[i]);
          if (role === 'ht') { sumNumerator += rawRaster.values[i]; sumDenominator += d4.values[i]; }
        } else if (goodRaw && Number.isFinite(rawRaster.values[i]) && channel) {
          const codes = channel.pixelReasons[i] ? [channel.pixelReasons[i]] : channel.reasonCodes;
          unique(codes).forEach(code => { reasonCounts[code] = (reasonCounts[code] || 0) + 1; });
        }
      }
      if (validMask && !nGeometry) reasons.push('ROI_EMPTY_GEOMETRY');
      else if (nGeometry && !rawValues.length) reasons.push('NO_MEASURED_PIXELS');
      const raw = statistics(rawValues), normalized = statistics(normalizedValues);
      const nValid = ['d4', 'other'].includes(role) ? 0 : normalized.n;
      const coverage = raw.n ? nValid / raw.n : null;
      if (channel && ['ht', 'da', 'ne'].includes(role)) {
        if (!channel.values) reasons.push.apply(reasons, channel.reasonCodes);
        reasons.push.apply(reasons, Object.keys(reasonCounts));
        if (raw.n && (!nValid || profile && profile.qc && coverage < profile.qc.minCoverage)) {
          reasons.push('INSUFFICIENT_VALID_COVERAGE');
          normalized.mean = null; normalized.sd = null;
        }
      } else reasons.push(role === 'd4' ? 'RAW_QC' : 'NOT_APPLIED');
      const absolute = { value: null, unit: role === 'ht' && profile && profile.calibration ? profile.calibration.unit || null : null,
        status: 'UNAVAILABLE', reasonCodes: [], response: null, responseAggregation: null };
      if (role !== 'ht') { absolute.status = 'NOT_APPLICABLE'; absolute.reasonCodes = ['ABSOLUTE_NOT_APPLICABLE']; }
      else {
        absolute.reasonCodes = calibrationReasons(profile && profile.calibration, profile);
        if (profile && profile.calibration && (!profile.qc || profile.qc.saturationD4 == null)) absolute.reasonCodes.push('D4_SATURATION_UNKNOWN');
        const analyticalFailures = reasons.filter(c => !['NORMALIZATION_PROVISIONAL', 'D4_SATURATION_UNKNOWN', 'WHOLE_TISSUE_PROVISIONAL'].includes(c));
        if (normalized.mean == null || !nValid) absolute.reasonCodes = unique(absolute.reasonCodes.concat(analyticalFailures));
        if (!absolute.reasonCodes.length && normalized.mean != null && nValid) {
          const c = profile.calibration;
          absolute.responseAggregation = c.responseAggregation;
          absolute.response = c.responseAggregation === 'mean_pixel_ratio' ? normalized.mean : sumNumerator / sumDenominator;
          if (!Number.isFinite(absolute.response)) absolute.reasonCodes.push('NUMERIC_OVERFLOW');
          else if (absolute.response < c.responseMin || absolute.response > c.responseMax) absolute.reasonCodes.push('CALIBRATION_RESPONSE_OUT_OF_RANGE');
          else {
            const value = (absolute.response - c.intercept) / c.slope;
            if (!Number.isFinite(value)) absolute.reasonCodes.push('NUMERIC_OVERFLOW');
            else if (value < c.lloq) absolute.reasonCodes.push('BELOW_LLOQ');
            else if (value > c.uloq) absolute.reasonCodes.push('ABOVE_ULOQ');
            else { absolute.value = value; absolute.status = 'VALID'; }
          }
        }
      }
      const warnings = profile && profile.quality !== 'validated' && ['ht', 'da', 'ne'].includes(role) ? ['NORMALIZATION_PROVISIONAL'] : [];
      if (profile && (!profile.qc || profile.qc.saturationD4 == null) && ['ht', 'da', 'ne'].includes(role)) warnings.push('D4_SATURATION_UNKNOWN');
      const status = ['d4', 'other'].includes(role) ? role === 'd4' ? 'RAW_QC' : 'NOT_APPLIED' :
        normalized.mean == null ? 'UNAVAILABLE' : nValid < raw.n ? 'PARTIAL' : warnings.length ? 'PROVISIONAL' : 'VALID';
      return { key: m.key, name: m.name, role: role, method: channel ? channel.method : 'not_applied', unit: channel ? channel.unit : 'raw a.u.',
        raw: raw, normalized: normalized, absolute: absolute, nGeometry: nGeometry, nMeasured: raw.n, nValid: nValid,
        coverage: coverage, status: status, reasonCodes: unique(reasons.concat(warnings)), reasonCounts: reasonCounts };
    });
  }
  function invalidate(project, detail) {
    if (project && project.normalization) {
      project.normalization.invalidated = { code: 'NORMALIZATION_PROFILE_STALE', detail: String(detail || ''), at: new Date().toISOString() };
    }
    return project;
  }
  global.Normalization = { SCHEMA_VERSION: SCHEMA_VERSION, METHOD_VERSION: METHOD_VERSION, suggestMapping: suggestMapping,
    loadRasters: loadRasters, fingerprint: fingerprint, createProfiles: createProfiles, evaluate: evaluate,
    quantifyRoi: quantifyRoi, invalidate: invalidate, reasonText: reasonText, stableStringify: stableStringify,
    statistics: statistics, calibrationReasons: calibrationReasons, referenceGeometryFingerprint: geometryFingerprint };
})(window);
