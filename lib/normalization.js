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
 *     rawStatus/rawReasonCodes describe raw measurements independently of correction.
 *     absolute = {value,unit,status,reasonCodes,response,responseAggregation}.
 *   invalidate(project,detail) marks an existing profile stale; does not remove raw data.
 *
 * Profile schema v1 (legacy), v2 (immutable folder-depth scope), or v3
 * (explicit pixel_ratio / section_scale targets with report-only default QC).
 * id/revision/batchId/prepId/quality, mapping, qc, reference,
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
  const SCHEMA_VERSION = 2;
  const LEGACY_SCHEMA_VERSION = 1;
  const METHOD_VERSION = '1.0.0';
  // Legacy constants and their serializers are deliberately frozen.
  const SIMPLE_SCHEMA_VERSION = 3;
  const SIMPLE_METHOD_VERSION = '2.0.0';
  const ROLES = ['ht', 'd4', 'da', 'ne'];
  const REASONS = {
    NORMALIZATION_PROFILE_MISSING: '補正設定がありません。Masterでバッチ・参照領域・QC条件を設定してください。',
    NO_NORMALIZATION_TARGETS: '補正対象の5-HT・DA・NEが指定されていません。D4は生値QCとして表示し、その他の分子には補正を適用しません。',
    NORMALIZATION_PROFILE_STALE: '生値・座標・参照ROIまたは補正条件が変更されています。Masterで設定を再計算してください。',
    NORMALIZATION_SCHEMA_UNSUPPORTED: '未対応の補正設定形式です。対応するアプリで設定を確認してください。',
    NORMALIZATION_SCOPE_INVALID: '補正グループの種類・階層・識別情報または対象集合が不正です。グループ全体で再設定してください。',
    GROUP_MEMBERSHIP_CHANGED: '補正時と現在のグループが異なります。保存済みの計算記録は保持していますが、現在のグループには未適用です。Masterで再設定してください。',
    NORMALIZATION_PROVISIONAL: '測定間の共通変動としての妥当性が未検証のため、暫定的な正規化です。',
    WHOLE_TISSUE_PROVISIONAL: '全実測範囲を参照とした暫定補正です。組織構成の差や散布量の差は測定感度差と区別できません。',
    D4_MISSING: 'D4-5-HTが登録・指定されていません。対応する内部標準を指定してください。',
    D4_AMBIGUOUS: 'D4-5-HTの候補が複数あります。使用する分子を明示的に指定してください。',
    HT_AMBIGUOUS: '5-HTの候補が複数あります。画素ごとの比に使う5-HTを指定してください。',
    SIMPLE_NO_TARGETS: '数値データを持つ補正対象分子がありません。対象分子を確認してください。',
    PARTIAL_VALID_PIXELS: '一部の有効な実測画素から算出しています。有効画素数と割合を確認してください。',
    INDIVIDUAL_RANGE: '分子名の対応が一意でないため、このデータの個別色レンジを使用します。',
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
    REFERENCE_INVALID: '固定参照データまたは参照ROIの指定形式が不正です。参照集合を確認してください。',
    REFERENCE_PARTIAL: '指定した固定参照集合の一部が利用できません。集合を黙って縮小せず、再確認が必要です。',
    REFERENCE_ROI_MISSING: '指定した参照ROIがありません。同じ参照領域を設定してください。',
    ROI_EMPTY_GEOMETRY: 'ROI内に幾何学的な画素がありません。ROI位置・形状を確認してください。',
    NO_MEASURED_PIXELS: 'ROI内に対象分子の実測画素がありません。',
    INSUFFICIENT_VALID_COVERAGE: '解析可能な画素の割合が設定した最低有効率を下回ります。D4信号・欠測・ROIを確認してください。',
    CALIBRATION_MISSING: '検量線が未登録のため、絶対定量値は算出できません。',
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
    const value = { schemaVersion: profile.schemaVersion, methodVersion: profile.methodVersion, id: profile.id, revision: profile.revision,
      batchId: profile.batchId, prepId: profile.prepId, quality: profile.quality, mapping: profile.mapping, qc: profile.qc,
      coordinateMatchConfirmed: profile.coordinateMatchConfirmed, comparabilityConfirmed: profile.comparabilityConfirmed,
      validationEvidence: profile.validationEvidence,
      reference: profile.reference, calibration: profile.calibration, section: profile.section,
      rawFingerprint: profile.rawFingerprint, referenceGeometryFingerprint: profile.referenceGeometryFingerprint,
      commonRanges: profile.commonRanges, otsuSourceRoles: profile.otsuSourceRoles, otsuSourceKeys: profile.otsuSourceKeys };
    // Do not add even a null field to schema v1: existing exported snapshots
    // must retain exactly the previous fingerprint and numerical validity.
    if (profile.schemaVersion === SCHEMA_VERSION) value.scope = profile.scope;
    return digest(value);
  }
  function portableMemberId(project) {
    return global.NormalizationScope ? global.NormalizationScope.memberId(project) :
      project && project.normalizationBinding && project.normalizationBinding.memberId || project && project.id;
  }
  function scopeValid(scope) {
    const text = value => typeof value === 'string' && value.trim().length > 0;
    return !!scope && typeof scope === 'object' && !Array.isArray(scope) && scope.type === 'folder-depth' && scope.depth === 2 &&
      scope.includeDescendants === true && text(scope.groupId) && Array.isArray(scope.folderPath) && scope.folderPath.length === 2 &&
      scope.folderPath.every(text) && Array.isArray(scope.memberIds) && scope.memberIds.length > 0 && scope.memberIds.every(text) &&
      new Set(scope.memberIds).size === scope.memberIds.length &&
      Object.keys(scope).every(key => ['type', 'depth', 'includeDescendants', 'groupId', 'folderPath', 'memberIds'].includes(key));
  }
  function referenceValid(reference) {
    const text = value => typeof value === 'string' && value.trim().length > 0;
    return !!reference && typeof reference === 'object' && !Array.isArray(reference) && ['qc', 'roi', 'whole_tissue'].includes(reference.kind) &&
      Array.isArray(reference.projectIds) && reference.projectIds.length > 0 && reference.projectIds.every(text) &&
      (reference.roiNames == null || Array.isArray(reference.roiNames) && reference.roiNames.every(text));
  }
  function createProfiles(entries, config) {
    if (!Array.isArray(entries) || !entries.length) throw new Error('対象プロジェクトがありません。');
    config = clone(config || {});
    const scoped = Object.prototype.hasOwnProperty.call(config, 'scope');
    if (scoped && !scopeValid(config.scope)) throw new Error(reasonText('NORMALIZATION_SCOPE_INVALID'));
    if (!config.id || !Number.isInteger(config.revision) || config.revision < 1 || !String(config.batchId || '').trim() || !String(config.prepId || '').trim()) throw new Error('プロファイルID・版・測定バッチ・前処理IDが必要です。');
    if (config.coordinateMatchConfirmed !== true) throw new Error(reasonText('COORDINATE_MATCH_UNCONFIRMED'));
    if (config.comparabilityConfirmed !== true) throw new Error(reasonText('MEASUREMENT_COMPARABILITY_UNCONFIRMED'));
    if (config.quality === 'validated' && !String(config.validationEvidence || '').trim()) throw new Error(reasonText('VALIDATION_EVIDENCE_MISSING'));
    if (!qcValid(config.qc)) throw new Error(reasonText('QC_THRESHOLDS_MISSING'));
    config.qc.saturationD4 = config.qc.saturationD4 == null ? null : config.qc.saturationD4;
    if (!config.reference || !['qc', 'roi', 'whole_tissue'].includes(config.reference.kind)) throw new Error('固定参照領域の種類が必要です。');
    if (config.reference.kind === 'whole_tissue') config.reference.roiNames = [];
    if (!Array.isArray(config.reference.projectIds) || !config.reference.projectIds.length) throw new Error(reasonText('REFERENCE_MISSING'));
    if (!referenceValid(config.reference) || scoped && new Set(config.reference.projectIds).size !== config.reference.projectIds.length) throw new Error(reasonText('REFERENCE_INVALID'));
    if (new Set(entries.map(e => e.project.id)).size !== entries.length) throw new Error('同一プロジェクトが重複しています。');
    if (scoped) {
      const ids = entries.map(e => portableMemberId(e.project));
      if (ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length ||
          ids.length !== config.scope.memberIds.length || ids.some(id => !config.scope.memberIds.includes(id))) {
        throw new Error(reasonText('NORMALIZATION_SCOPE_INVALID'));
      }
      config.scope.memberIds.sort();
    }
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
    const referenceSnapshot = Object.assign({}, config.reference, { projectIds: scoped ? refs.map(c => portableMemberId(c.entry.project)) : referenceIds,
      entries: refs.map(c => Object.assign({ projectId: scoped ? portableMemberId(c.entry.project) : c.entry.project.id, name: c.entry.project.displayName || c.entry.project.name || '', Ds: c.section.Ds,
        rawFingerprint: c.rawFingerprint, geometryFingerprint: c.geometryFingerprint, status: c.section.status, reasonCodes: c.section.reasonCodes },
        scoped ? { memberId: portableMemberId(c.entry.project) } : {})) });
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
      const profile = { schemaVersion: scoped ? SCHEMA_VERSION : LEGACY_SCHEMA_VERSION, methodVersion: METHOD_VERSION, id: String(config.id), revision: config.revision,
        batchId: String(config.batchId), prepId: String(config.prepId), quality: quality, createdAt: new Date().toISOString(),
        coordinateMatchConfirmed: true, comparabilityConfirmed: true, validationEvidence: String(config.validationEvidence || '').trim(),
        mapping: clone(c.mapping), qc: clone(config.qc), reference: clone(referenceSnapshot), calibration: clone(config.calibration || null),
        rawFingerprint: c.rawFingerprint, referenceGeometryFingerprint: c.geometryFingerprint, section: section,
        commonRanges: {}, otsuSourceRoles: sourceRoles, otsuSourceKeys: sourceRoles.map(role => ['ht', 'da', 'ne'].includes(role) ? c.mapping[role] || null : null) };
      if (scoped) profile.scope = clone(config.scope);
      profile.calculationFingerprint = calculationFingerprint(profile);
      return { projectId: c.entry.project.id, normalization: profile };
    });
    // Fixed full finite range: deterministic, no clipping and no dependence on
    // later Viewer selection, order, new projects or an export subset.
    const ranges = {};
    profiles.forEach((item, index) => {
      const prospective = Object.assign({}, entries[index].project, { normalization: item.normalization });
      if (scoped) prospective.normalizationBinding = { groupId: config.scope.groupId, folderPath: config.scope.folderPath.slice(), memberId: portableMemberId(entries[index].project) };
      const evaluation = evaluate(prospective, entries[index].rasters);
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
  // Schema 3 uses explicit per-channel methods. It never changes the legacy
  // role dispatch, reference masks or serialized calculation fingerprints.
  function isCorrectedChannel(channel) {
    return !!channel && channel.applicable !== false && ['pixel_ratio', 'section_scale'].includes(channel.method);
  }
  function rangeForChannel(profile, channel) {
    if (!profile || !channel || !isCorrectedChannel(channel)) return null;
    const key = profile.schemaVersion === SIMPLE_SCHEMA_VERSION ? channel.rangeKey || channel.analyteId : channel.role;
    const value = profile.commonRanges && profile.commonRanges[key];
    return value && Number.isFinite(value.min) && Number.isFinite(value.max) && value.max >= value.min ? value : null;
  }
  function isSupportedScopedProfile(profile) {
    return !!profile && [SCHEMA_VERSION, SIMPLE_SCHEMA_VERSION].includes(profile.schemaVersion) && scopeValid(profile.scope);
  }
  function isInternalStandard(molecule) {
    if (!molecule) return false;
    if (global.Otsu && typeof global.Otsu.isInternalStandard === 'function' && global.Otsu.isInternalStandard(molecule, molecule.key, null)) return true;
    if (molecule.isInternalStandard === true || molecule.internalStandard === true || molecule.isotopeStandard === true || molecule.isIsotope === true) return true;
    const role = String(molecule.analyticalRole || molecule.role || '').normalize('NFKC').toLowerCase();
    if (/internal.?standard|isotope|labelled|labeled|標準|同位体/.test(role) || /^(is|d4|d3)$/.test(role)) return true;
    const name = String((molecule.name || '') + ' ' + (molecule.key || '')).normalize('NFKC').trim().toLowerCase();
    if (candidates([molecule], 'd4').length) return true;
    return /internal[\s_-]*standard|標準|同位体/.test(name) || /(^|[^a-z0-9])(?:is|istd)(?=$|[^a-z0-9])/.test(name) ||
      /(?:5-?ht|serotonin|dopamine|noradrenaline|norepinephrine|da|ne)[-_\s]?d\d+(?=$|[^a-z0-9])/.test(name) ||
      /(^|[^a-z0-9])(?:d\d+|\d{1,2}[dD]|13c\d*|15n\d*|17o\d*|18o\d*|33s\d*|34s\d*|2h\d*)(?=$|[^a-z0-9])/.test(name) ||
      /(?:\[|\()(?:u[- ]?)?(?:13c|15n|17o|18o|33s|34s|2h|d\d+)/.test(name);
  }
  function numericMolecules(project, rasters) {
    return (project.molecules || []).filter(m => {
      const type = String(m.type || m.kind || '').toLowerCase();
      const name = alias(m.name);
      return !['image', 'he', 'if', 'atlas', 'fluorescence'].includes(type) &&
        !['he', 'hestain', 'atlas', 'if', 'fluorescence'].includes(name) && !!rasterOf(rasters, m.key, project);
    });
  }
  function suggestSimpleMapping(project, rasters) {
    const molecules = numericMolecules(project || {}, rasters || {});
    const d4 = candidates(molecules, 'd4').map(m => m.key), ht = candidates(molecules, 'ht').map(m => m.key);
    const issues = [];
    if (d4.length !== 1) issues.push(d4.length ? 'D4_AMBIGUOUS' : 'D4_MISSING');
    if (ht.length > 1) issues.push('HT_AMBIGUOUS');
    const standardKey = d4.length === 1 ? d4[0] : null;
    const targetKeys = molecules.filter(m => m.key !== standardKey && !isInternalStandard(m)).map(m => m.key);
    return { standardKey: standardKey, htKey: ht.length === 1 ? ht[0] : null, targetKeys: targetKeys,
      excludedKeys: (project.molecules || []).filter(m => !targetKeys.includes(m.key)).map(m => m.key),
      issues: issues, candidates: { d4: d4, ht: ht } };
  }
  function simpleReferenceValid(reference) {
    if (!reference) return false;
    return referenceValid(Object.assign({}, reference, { kind: reference.kind === 'd4_measured' ? 'qc' : reference.kind })) &&
      (reference.kind !== 'roi' || reference.roiNames && reference.roiNames.length > 0) &&
      new Set(reference.projectIds).size === reference.projectIds.length;
  }
  function simpleFingerprint(profile) {
    const value = {};
    ['schemaVersion', 'methodVersion', 'id', 'revision', 'mode', 'batchId', 'prepId', 'quality', 'mapping', 'qc',
      'coordinateMatchConfirmed', 'comparabilityConfirmed', 'validationEvidence', 'reference', 'calibration', 'section',
      'rawFingerprint', 'referenceGeometryFingerprint', 'commonRanges', 'otsuSourceRoles', 'otsuSourceKeys',
      'scope', 'targets', 'excludedKeys', 'configurationSource'].forEach(key => { value[key] = profile[key]; });
    return digest(value);
  }
  function simpleMapping(entry) {
    const project = entry.project, suggestion = suggestSimpleMapping(project, entry.rasters);
    const input = entry.simpleMapping || {}, own = key => Object.prototype.hasOwnProperty.call(input, key);
    const standardKey = own('standardKey') ? input.standardKey : suggestion.standardKey;
    const htKey = own('htKey') ? input.htKey : suggestion.htKey;
    if (!standardKey) throw new Error(reasonText(suggestion.candidates.d4.length > 1 ? 'D4_AMBIGUOUS' : 'D4_MISSING'));
    if (!own('htKey') && suggestion.candidates.ht.length > 1) throw new Error(reasonText('HT_AMBIGUOUS'));
    const targetKeys = own('targetKeys') ? input.targetKeys : suggestion.targetKeys;
    const numeric = numericMolecules(project, entry.rasters), numericKeys = numeric.map(m => m.key);
    if (!numericKeys.includes(standardKey) || !Array.isArray(targetKeys) || new Set(targetKeys).size !== targetKeys.length ||
        targetKeys.some(key => !numericKeys.includes(key) || key === standardKey || isInternalStandard(numeric.find(m => m.key === key))) ||
        htKey != null && (!targetKeys.includes(htKey) || htKey === standardKey)) throw new Error(reasonText('MAPPING_INVALID'));
    const mapping = { ht: htKey || null, d4: standardKey, da: null, ne: null };
    ['da', 'ne'].forEach(role => {
      const found = candidates(numeric.filter(m => targetKeys.includes(m.key) && m.key !== htKey), role);
      if (found.length === 1) mapping[role] = found[0].key;
    });
    return { mapping: mapping, targetKeys: targetKeys.slice(), excludedKeys: (project.molecules || []).filter(m => !targetKeys.includes(m.key)).map(m => m.key) };
  }
  function simpleSectionStats(project, rasters, mapping, config) {
    const d4 = rasterOf(rasters, mapping.d4, project);
    let area;
    if (config.reference.kind === 'd4_measured') {
      const n = gridShape(project).W * gridShape(project).H;
      const mask = new Uint8Array(Number.isSafeInteger(n) && n > 0 ? n : 0);
      if (shapeValid(project, d4)) for (let i = 0; i < mask.length; i++) if (Number.isFinite(d4.values[i])) mask[i] = 1;
      area = { mask: mask, measured: mask, reasonCodes: [] };
    } else area = referenceMask(project, rasters, config.reference);
    const reasons = area.reasonCodes.slice(), counts = {}, values = [];
    const result = { Ds: null, Dref: null, k: null, nGeometry: 0, nMeasured: 0, nValid: 0, coverage: null, reasonCounts: counts };
    if (!d4) reasons.push('D4_MISSING');
    else if (!moleculeCoordinatesValid(project, mapping.d4, d4)) reasons.push('COORDINATE_MISMATCH');
    if (!qcValid(config.qc)) reasons.push('QC_THRESHOLDS_MISSING');
    for (let i = 0; i < area.mask.length; i++) {
      if (!area.mask[i]) continue;
      result.nGeometry++;
      if (!area.measured[i]) continue;
      result.nMeasured++;
      if (shapeValid(project, d4) && qcValid(config.qc)) {
        const reason = d4Reason(d4.values[i], config.qc);
        if (reason) counts[reason] = (counts[reason] || 0) + 1;
        else values.push(d4.values[i]);
      }
    }
    result.nValid = values.length;
    result.coverage = result.nMeasured ? result.nValid / result.nMeasured : null;
    if (!result.nGeometry) reasons.push(config.reference.kind === 'd4_measured' ? 'NO_MEASURED_PIXELS' : 'ROI_EMPTY_GEOMETRY');
    else if (!result.nMeasured) reasons.push('NO_MEASURED_PIXELS');
    if (result.nMeasured && (!values.length || config.qc.enforceCoverage && result.coverage < config.qc.minCoverage)) reasons.push('INSUFFICIENT_VALID_COVERAGE');
    if (!reasons.length && values.length) result.Ds = median(values);
    result.reasonCodes = unique(reasons.concat(Object.keys(counts)));
    if (values.length && values.length < result.nMeasured) result.reasonCodes.push('PARTIAL_VALID_PIXELS');
    result.status = result.Ds == null ? 'UNAVAILABLE' : 'VALID';
    return result;
  }
  function simpleTargetsValid(profile, project) {
    const targets = profile.targets, mapping = profile.mapping || {}, keys = (project.molecules || []).map(m => m.key);
    if (!Array.isArray(targets) || new Set(targets.map(t => t && t.key)).size !== targets.length || !keys.includes(mapping.d4) || mappingReasons(project, mapping).length) return false;
    if (targets.some(t => !t || !keys.includes(t.key) || t.key === mapping.d4 ||
      !['pixel_ratio', 'section_scale'].includes(t.method) || (t.method === 'pixel_ratio') !== (t.key === mapping.ht) ||
      !['group', 'individual'].includes(t.rangeScope) || typeof t.analyteId !== 'string' || !t.analyteId)) return false;
    return mapping.ht == null || targets.some(t => t.key === mapping.ht && t.method === 'pixel_ratio');
  }
  function createSimpleProfiles(entries, config) {
    if (!Array.isArray(entries) || !entries.length || entries.some(e => !e || !e.project)) throw new Error('対象プロジェクトがありません。');
    // A registered numeric source that failed to load is a data error, not an
    // absent analyte. Never let automatic target discovery silently remove it.
    // Image-only definitions without a numeric blob remain intentionally outside
    // the eligible target set; a genuinely absent molecule has no definition.
    for (const entry of entries) {
      const missing = (entry.project.molecules || []).filter(m => m.blobId && !rasterOf(entry.rasters, m.key, entry.project));
      if (!missing.length) continue;
      const error = new Error((entry.project.displayName || entry.project.name || entry.project.id) + ': ' + reasonText('RAW_MISSING') +
        ' 対象: ' + missing.map(m => m.name || m.key).join(', '));
      error.code = 'RAW_MISSING'; error.projectId = entry.project.id; error.missingRawKeys = missing.map(m => m.key);
      throw error;
    }
    config = clone(config || {});
    if (!scopeValid(config.scope)) throw new Error(reasonText('NORMALIZATION_SCOPE_INVALID'));
    if (!config.id || !Number.isInteger(config.revision) || config.revision < 1) throw new Error('プロファイルID・版が必要です。');
    config.mode = config.mode || 'simple';
    if (!['simple', 'advanced'].includes(config.mode)) throw new Error('補正設定モードが不正です。');
    config.qc = Object.assign({ minD4: 0, saturationD4: null, minCoverage: 0.8, enforceCoverage: false }, config.qc || {});
    if (!qcValid(config.qc) || typeof config.qc.enforceCoverage !== 'boolean') throw new Error(reasonText('QC_THRESHOLDS_MISSING'));
    config.reference = config.reference || { kind: 'd4_measured', projectIds: entries.map(e => e.project.id), roiNames: [] };
    if (['d4_measured', 'whole_tissue'].includes(config.reference.kind)) config.reference.roiNames = [];
    if (!simpleReferenceValid(config.reference)) throw new Error(reasonText('REFERENCE_INVALID'));
    const localIds = entries.map(e => e.project.id), members = entries.map(e => portableMemberId(e.project));
    if (new Set(localIds).size !== entries.length || new Set(members).size !== entries.length ||
        members.length !== config.scope.memberIds.length || members.some(id => !config.scope.memberIds.includes(id))) throw new Error(reasonText('NORMALIZATION_SCOPE_INVALID'));
    const refIds = config.reference.projectIds;
    if (refIds.some(id => !localIds.includes(id)) || config.mode === 'simple' && (refIds.length !== localIds.length || localIds.some(id => !refIds.includes(id)))) throw new Error(reasonText('REFERENCE_INVALID'));
    config.scope.memberIds.sort();
    if (config.quality === 'validated' && (!String(config.validationEvidence || '').trim() || !String(config.batchId || '').trim() ||
        !String(config.prepId || '').trim() || config.comparabilityConfirmed !== true || config.coordinateMatchConfirmed !== true)) throw new Error(reasonText('VALIDATION_EVIDENCE_MISSING'));
    const calculated = entries.map(entry => {
      if (new Set((entry.project.molecules || []).map(m => m.key)).size !== (entry.project.molecules || []).length) throw new Error(reasonText('MAPPING_INVALID'));
      const resolved = simpleMapping(entry);
      return Object.assign({ entry: entry, rawFingerprint: fingerprint(entry.project, entry.rasters),
        geometryFingerprint: geometryFingerprint(entry.project, config.reference),
        section: simpleSectionStats(entry.project, entry.rasters, resolved.mapping, config) }, resolved);
    });
    const duplicateNames = new Set();
    calculated.forEach(c => {
      const seen = new Set();
      c.targetKeys.forEach(key => {
        const m = c.entry.project.molecules.find(m => m.key === key), name = String(m.name || '').normalize('NFC').trim();
        if (seen.has(name)) duplicateNames.add(name);
        seen.add(name);
      });
    });
    const refs = calculated.filter(c => refIds.includes(c.entry.project.id));
    const allReferencesValid = refs.every(c => Number.isFinite(c.section.Ds) && c.section.Ds > 0);
    const Dref = allReferencesValid ? median(refs.map(c => c.section.Ds)) : null;
    const reference = Object.assign({}, config.reference, { projectIds: refs.map(c => portableMemberId(c.entry.project)), entries: refs.map(c => ({
      projectId: portableMemberId(c.entry.project), memberId: portableMemberId(c.entry.project), name: c.entry.project.displayName || c.entry.project.name || '',
      Ds: c.section.Ds, rawFingerprint: c.rawFingerprint, geometryFingerprint: c.geometryFingerprint, status: c.section.status, reasonCodes: c.section.reasonCodes })) });
    const profiles = calculated.map(c => {
      const section = clone(c.section), reasons = section.reasonCodes.slice();
      section.Dref = Dref;
      if (Dref == null) reasons.push(refs.some(r => r.section.Ds != null) ? 'REFERENCE_PARTIAL' : 'REFERENCE_MISSING');
      if (section.Ds != null && Dref != null) section.k = Dref / section.Ds;
      if (section.k != null && (!Number.isFinite(section.k) || section.k <= 0)) { section.k = null; reasons.push('NUMERIC_OVERFLOW'); }
      const quality = config.quality === 'validated' && !['whole_tissue', 'd4_measured'].includes(config.reference.kind) && config.qc.saturationD4 != null ? 'validated' : 'provisional';
      if (quality !== 'validated') reasons.push('NORMALIZATION_PROVISIONAL');
      if (config.reference.kind === 'whole_tissue') reasons.push('WHOLE_TISSUE_PROVISIONAL');
      if (config.qc.saturationD4 == null) reasons.push('D4_SATURATION_UNKNOWN');
      section.reasonCodes = unique(reasons);
      section.status = section.k == null ? 'UNAVAILABLE' : quality === 'validated' ? 'VALID' : 'PROVISIONAL';
      const targets = c.targetKeys.map(key => {
        const m = c.entry.project.molecules.find(m => m.key === key), name = String(m.name || '').normalize('NFC').trim();
        const method = key === c.mapping.ht ? 'pixel_ratio' : 'section_scale';
        const rangeScope = !name || duplicateNames.has(name) || /^(?:unknown|unnamed|未同定|不明|分子|molecule|msi)(?:[\s_-]*\d+)?$/i.test(name) ? 'individual' : 'group';
        return { key: key, method: method, analyteName: name, rangeScope: rangeScope,
          analyteId: rangeScope === 'group' ? 'group:' + stableStringify([method, name]) : 'individual:' + stableStringify([portableMemberId(c.entry.project), key, method]) };
      });
      const sources = Array.isArray(config.otsuSourceKeys) ? config.otsuSourceKeys : config.otsuSourceKeys && config.otsuSourceKeys[c.entry.project.id] || [];
      const profile = { schemaVersion: SIMPLE_SCHEMA_VERSION, methodVersion: SIMPLE_METHOD_VERSION, mode: config.mode,
        id: String(config.id), revision: config.revision, createdAt: new Date().toISOString(), batchId: String(config.batchId || '').trim(), prepId: String(config.prepId || '').trim(),
        quality: quality, coordinateMatchConfirmed: config.coordinateMatchConfirmed === true, comparabilityConfirmed: config.comparabilityConfirmed === true,
        validationEvidence: String(config.validationEvidence || '').trim(), configurationSource: 'folder-isotope-relative',
        mapping: clone(c.mapping), targets: targets, excludedKeys: c.excludedKeys.slice(), qc: clone(config.qc), reference: clone(reference),
        scope: clone(config.scope), calibration: clone(config.calibration || null), rawFingerprint: c.rawFingerprint,
        referenceGeometryFingerprint: c.geometryFingerprint, section: section, commonRanges: {}, otsuSourceRoles: [],
        otsuSourceKeys: (Array.isArray(sources) ? sources : []).map(key => {
          const m = c.entry.project.molecules.find(m => m.key === key);
          return key && key !== c.mapping.d4 && m && !isInternalStandard(m) ? key : null;
        }) };
      profile.calculationFingerprint = simpleFingerprint(profile);
      return { projectId: c.entry.project.id, normalization: profile };
    });
    const evaluations = profiles.map((item, i) => evaluateSimple(Object.assign({}, entries[i].project, {
      normalization: item.normalization, normalizationBinding: { groupId: config.scope.groupId, memberId: members[i], folderPath: config.scope.folderPath.slice() }
    }), entries[i].rasters));
    const ranges = {};
    evaluations.forEach(evaluation => Object.values(evaluation.channels).forEach(channel => {
      if (!isCorrectedChannel(channel) || !channel.values) return;
      for (const value of channel.values) if (Number.isFinite(value)) {
        const range = ranges[channel.rangeKey];
        if (range) { range.min = Math.min(range.min, value); range.max = Math.max(range.max, value); }
        else ranges[channel.rangeKey] = { min: value, max: value };
      }
    }));
    profiles.forEach(item => { item.normalization.commonRanges = clone(ranges); item.normalization.calculationFingerprint = simpleFingerprint(item.normalization); });
    const preview = profiles.map((item, i) => {
      const evaluation = evaluations[i], correctedOutputs = entries[i].project.molecules.filter(m => isCorrectedChannel(evaluation.channels[m.key])).map(m => {
        const channel = evaluation.channels[m.key];
        return { key: m.key, name: m.name, method: channel.method, nMeasured: channel.nMeasured || 0, nValid: channel.nValid || 0,
          coverage: channel.coverage == null ? null : channel.coverage, status: channel.status, reasonCodes: channel.reasonCodes.slice() };
      });
      return Object.assign({ projectId: item.projectId, name: entries[i].project.displayName || entries[i].project.name || '', profileId: item.normalization.id,
        revision: item.normalization.revision, quality: item.normalization.quality, correctedOutputs: correctedOutputs,
        totalFiniteOutput: correctedOutputs.reduce((sum, output) => sum + output.nValid, 0) }, clone(item.normalization.section));
    });
    const saveReasons = [];
    if (preview.some(p => !(Number.isFinite(p.k) && p.k > 0))) saveReasons.push('REFERENCE_PARTIAL');
    if (!preview.some(p => p.totalFiniteOutput > 0)) saveReasons.push('SIMPLE_NO_TARGETS');
    if (evaluations.some(ev => Object.values(ev.channels).some(c => isCorrectedChannel(c) && c.reasonCodes.some(code => ['COORDINATE_MISMATCH', 'RAW_MISSING', 'MAPPING_INVALID'].includes(code))))) saveReasons.push('COORDINATE_MISMATCH');
    // Enabling absolute calibration is an explicit user choice: an incomplete
    // curve cannot be saved as if that requested operation had succeeded.
    // Preview still contains the usable relative values and exact failures.
    profiles.forEach(item => {
      const profile = item.normalization;
      if (!profile.calibration) return;
      saveReasons.push.apply(saveReasons, calibrationReasons(profile.calibration, profile));
      if (profile.qc.saturationD4 == null) saveReasons.push('D4_SATURATION_UNKNOWN');
    });
    return { profiles: profiles, preview: preview, canSave: !saveReasons.length, reasonCodes: unique(saveReasons) };
  }
  function evaluateSimple(project, rasters) {
    const profile = project.normalization, currentFingerprint = fingerprint(project, rasters), reasons = [];
    const mapping = profile.mapping || {}, referenceValidNow = simpleReferenceValid(profile.reference), validScope = scopeValid(profile.scope);
    if (!referenceValidNow) reasons.push('REFERENCE_INVALID');
    if (!validScope || !referenceValidNow || validScope && referenceValidNow && (
        profile.reference.projectIds.some(id => !profile.scope.memberIds.includes(id)) || !Array.isArray(profile.reference.entries) ||
        profile.reference.entries.length !== profile.reference.projectIds.length ||
        profile.reference.entries.some(e => !e || e.memberId !== e.projectId || !profile.reference.projectIds.includes(e.projectId)) ||
        new Set(profile.reference.entries.map(e => e && e.projectId)).size !== profile.reference.projectIds.length)) reasons.push('NORMALIZATION_SCOPE_INVALID');
    if (Object.prototype.hasOwnProperty.call(project, 'normalizationBinding')) {
      const binding = project.normalizationBinding;
      if (!binding || !validScope || binding.groupId !== profile.scope.groupId) reasons.push('GROUP_MEMBERSHIP_CHANGED');
      else if (typeof binding.memberId !== 'string' || !profile.scope.memberIds.includes(binding.memberId)) reasons.push('NORMALIZATION_SCOPE_INVALID');
    }
    if (profile.invalidated || profile.methodVersion !== SIMPLE_METHOD_VERSION || profile.rawFingerprint !== currentFingerprint ||
        !referenceValidNow || profile.referenceGeometryFingerprint !== geometryFingerprint(project, profile.reference) ||
        profile.calculationFingerprint !== simpleFingerprint(profile)) reasons.push('NORMALIZATION_PROFILE_STALE');
    if (!qcValid(profile.qc) || typeof profile.qc.enforceCoverage !== 'boolean') reasons.push('QC_THRESHOLDS_MISSING');
    if (!simpleTargetsValid(profile, project)) reasons.push('MAPPING_INVALID');
    const channels = {}, d4 = rasterOf(rasters, mapping.d4, project), grid = gridShape(project), n = Number.isSafeInteger(grid.W * grid.H) && grid.W * grid.H > 0 ? grid.W * grid.H : 0;
    for (const m of project.molecules || []) {
      const target = (Array.isArray(profile.targets) ? profile.targets : []).find(t => t && t.key === m.key);
      const role = m.key === mapping.d4 ? 'd4' : target ? ROLES.find(r => mapping[r] === m.key) || 'analyte' : 'other';
      const method = target ? target.method : role === 'd4' ? 'raw_qc' : 'not_applied';
      const channel = { role: role, method: method, applicable: !!target, unit: method === 'pixel_ratio' ? '5-HT/D4-5-HT ratio' : target ? 'normalized a.u.' : 'raw a.u.',
        values: null, status: 'UNAVAILABLE', reasonCodes: [], pixelReasons: [], nMeasured: 0, nValid: 0, coverage: null,
        rangeKey: target ? target.analyteId : null, analyteId: target ? target.analyteId : null, rangeScope: target ? target.rangeScope : null };
      channels[m.key] = channel;
      if (!target) { channel.status = role === 'd4' ? 'RAW_QC' : 'NOT_APPLIED'; channel.reasonCodes = [channel.status]; continue; }
      const failures = reasons.slice(), raw = rasterOf(rasters, m.key, project);
      if (!raw) failures.push('RAW_MISSING');
      else if (!moleculeCoordinatesValid(project, m.key, raw)) failures.push('COORDINATE_MISMATCH');
      if (!d4) failures.push('D4_MISSING');
      else if (!moleculeCoordinatesValid(project, mapping.d4, d4) || method === 'pixel_ratio' && raw &&
        !coordinatesMatch(effectiveCoordinates(project, m.key, raw), effectiveCoordinates(project, mapping.d4, d4))) failures.push('COORDINATE_MISMATCH');
      if (raw && shapeValid(project, raw)) for (const v of raw.values) if (Number.isFinite(v)) channel.nMeasured++;
      if (failures.length) { channel.reasonCodes = unique(failures); continue; }
      if (method === 'section_scale' && !(profile.section && Number.isFinite(profile.section.k) && profile.section.k > 0)) {
        channel.reasonCodes = unique((profile.section && profile.section.reasonCodes || []).concat('REFERENCE_MISSING')); continue;
      }
      const values = new Float64Array(n); values.fill(NaN);
      const pixelReasons = new Array(n), counts = {};
      for (let i = 0; i < n; i++) {
        let reason = !Number.isFinite(raw.values[i]) ? 'RAW_NOT_MEASURED' : method === 'pixel_ratio' ? d4Reason(d4.values[i], profile.qc) : null;
        if (!reason) {
          const value = method === 'pixel_ratio' ? raw.values[i] / d4.values[i] : raw.values[i] * profile.section.k;
          if (Number.isFinite(value)) { values[i] = value; channel.nValid++; } else reason = 'NUMERIC_OVERFLOW';
        }
        pixelReasons[i] = reason;
        if (reason) counts[reason] = (counts[reason] || 0) + 1;
      }
      channel.values = values; channel.pixelReasons = pixelReasons; channel.reasonCounts = counts;
      channel.coverage = channel.nMeasured ? channel.nValid / channel.nMeasured : null;
      channel.reasonCodes = unique(Object.keys(counts).filter(c => c !== 'RAW_NOT_MEASURED').concat(
        profile.quality !== 'validated' ? ['NORMALIZATION_PROVISIONAL'] : [], profile.qc.saturationD4 == null ? ['D4_SATURATION_UNKNOWN'] : [],
        channel.rangeScope === 'individual' ? ['INDIVIDUAL_RANGE'] : []));
      if (!channel.nMeasured) channel.reasonCodes.push('NO_MEASURED_PIXELS');
      if (channel.nMeasured && (!channel.nValid || profile.qc.enforceCoverage && channel.coverage < profile.qc.minCoverage)) channel.reasonCodes.push('INSUFFICIENT_VALID_COVERAGE');
      if (channel.nValid && channel.nValid < channel.nMeasured) channel.reasonCodes.push('PARTIAL_VALID_PIXELS');
      channel.status = !channel.nValid ? 'UNAVAILABLE' : channel.nValid < channel.nMeasured ? 'PARTIAL' : profile.quality === 'validated' ? 'VALID' : 'PROVISIONAL';
    }
    const applicable = Object.values(channels).filter(isCorrectedChannel), any = applicable.some(c => c.nValid > 0);
    if (!applicable.length) reasons.push('SIMPLE_NO_TARGETS');
    return { profile: profile, status: !any ? 'UNAVAILABLE' : applicable.every(c => c.status === 'VALID') ? 'VALID' : applicable.some(c => ['PARTIAL', 'UNAVAILABLE'].includes(c.status)) ? 'PARTIAL' : 'PROVISIONAL',
      reasonCodes: unique(reasons.concat(...applicable.map(c => c.reasonCodes))), channels: channels, section: profile.section || null, fingerprint: currentFingerprint };
  }
  function evaluate(project, rasters) {
    if (project && project.normalization && project.normalization.schemaVersion === SIMPLE_SCHEMA_VERSION) return evaluateSimple(project, rasters || {});
    project = project || {}; rasters = rasters || {};
    const profile = project.normalization || null, currentFingerprint = fingerprint(project, rasters), reasons = [];
    const mapping = profile && profile.mapping || suggestMapping(project.molecules);
    if (!profile) reasons.push('NORMALIZATION_PROFILE_MISSING');
    else {
      const supported = profile.schemaVersion === LEGACY_SCHEMA_VERSION || profile.schemaVersion === SCHEMA_VERSION;
      const validReference = referenceValid(profile.reference);
      if (!supported) reasons.push('NORMALIZATION_SCHEMA_UNSUPPORTED');
      if (!validReference) reasons.push('REFERENCE_INVALID');
      if (profile.schemaVersion === SCHEMA_VERSION) {
        const valid = scopeValid(profile.scope);
        if (!valid || !validReference || valid && validReference && (
          new Set(profile.reference.projectIds).size !== profile.reference.projectIds.length ||
          profile.reference.projectIds.some(id => !profile.scope.memberIds.includes(id)) ||
          !Array.isArray(profile.reference.entries) || profile.reference.entries.length !== profile.reference.projectIds.length ||
          profile.reference.entries.some(entry => !entry || entry.memberId !== entry.projectId || !profile.reference.projectIds.includes(entry.projectId)) ||
          new Set(profile.reference.entries.map(entry => entry && entry.projectId)).size !== profile.reference.projectIds.length
        )) reasons.push('NORMALIZATION_SCOPE_INVALID');
        if (Object.prototype.hasOwnProperty.call(project, 'normalizationBinding')) {
          const binding = project.normalizationBinding;
          if (!binding || !valid || binding.groupId !== profile.scope.groupId) reasons.push('GROUP_MEMBERSHIP_CHANGED');
          else if (typeof binding.memberId !== 'string' || !profile.scope.memberIds.includes(binding.memberId)) reasons.push('NORMALIZATION_SCOPE_INVALID');
        }
      } else if (profile.scope != null) reasons.push('NORMALIZATION_SCOPE_INVALID');
      if (profile.invalidated || !supported || profile.methodVersion !== METHOD_VERSION ||
          profile.rawFingerprint !== currentFingerprint || !validReference ||
          profile.referenceGeometryFingerprint !== geometryFingerprint(project, profile.reference) ||
          profile.calculationFingerprint !== calculationFingerprint(profile)) reasons.push('NORMALIZATION_PROFILE_STALE');
      if (!qcValid(profile.qc)) reasons.push('QC_THRESHOLDS_MISSING');
      if (profile.coordinateMatchConfirmed !== true) reasons.push('COORDINATE_MATCH_UNCONFIRMED');
      if (profile.comparabilityConfirmed !== true) reasons.push('MEASUREMENT_COMPARABILITY_UNCONFIRMED');
    }
    if (profile) reasons.push.apply(reasons, mappingReasons(project, mapping));
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
      // An absent setup is the cause, not an observed failure of D4 or QC.
      if (!profile) { channel.reasonCodes = ['NORMALIZATION_PROFILE_MISSING']; continue; }
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
    if (!profile || c.prepId !== profile.prepId || c.batchId !== profile.batchId || profile.schemaVersion === SIMPLE_SCHEMA_VERSION &&
        (!String(profile.prepId || '').trim() || !String(profile.batchId || '').trim() || profile.comparabilityConfirmed !== true || profile.coordinateMatchConfirmed !== true)) return ['CALIBRATION_CONDITION_MISMATCH'];
    return [];
  }
  function quantifyRoi(project, rasters, evaluation, mask) {
    evaluation = evaluation || evaluate(project, rasters);
    const grid = gridShape(project), expected = grid.W * grid.H;
    const validMask = mask && mask.length === expected;
    const profile = evaluation.profile;
    return (project.molecules || []).map(m => {
      const channel = evaluation.channels[m.key], role = channel ? channel.role : 'other', rawRaster = rasterOf(rasters, m.key, project);
      const applicable = isCorrectedChannel(channel), simple = profile && profile.schemaVersion === SIMPLE_SCHEMA_VERSION;
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
      const nValid = applicable ? normalized.n : 0;
      const coverage = raw.n ? nValid / raw.n : null;
      if (applicable) {
        if (!channel.values) reasons.push.apply(reasons, channel.reasonCodes);
        reasons.push.apply(reasons, Object.keys(reasonCounts));
        if (simple && nValid && nValid < raw.n) reasons.push('PARTIAL_VALID_PIXELS');
        if (channel.values && raw.n && (!nValid || profile && profile.qc && (!simple || profile.qc.enforceCoverage) && coverage < profile.qc.minCoverage)) {
          reasons.push('INSUFFICIENT_VALID_COVERAGE');
          normalized.mean = null; normalized.sd = null;
        }
      } else reasons.push(role === 'd4' ? 'RAW_QC' : 'NOT_APPLIED');
      const absolute = { value: null, unit: role === 'ht' && profile && profile.calibration ? profile.calibration.unit || null : null,
        status: 'UNAVAILABLE', reasonCodes: [], response: null, responseAggregation: null };
      if (role !== 'ht') { absolute.status = 'NOT_APPLICABLE'; absolute.reasonCodes = ['ABSOLUTE_NOT_APPLICABLE']; }
      else if (simple && !profile.calibration) { absolute.status = 'NOT_CONFIGURED'; }
      else {
        const analyticalFailures = reasons.filter(c => !['NORMALIZATION_PROVISIONAL', 'D4_SATURATION_UNKNOWN', 'WHOLE_TISSUE_PROVISIONAL'].includes(c));
        absolute.reasonCodes = normalized.mean == null || !nValid ? unique(analyticalFailures) : calibrationReasons(profile && profile.calibration, profile);
        if (normalized.mean != null && nValid && profile && profile.calibration && (!profile.qc || profile.qc.saturationD4 == null)) absolute.reasonCodes.push('D4_SATURATION_UNKNOWN');
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
      const warnings = profile && profile.quality !== 'validated' && applicable ? ['NORMALIZATION_PROVISIONAL'] : [];
      if (profile && (!profile.qc || profile.qc.saturationD4 == null) && applicable) warnings.push('D4_SATURATION_UNKNOWN');
      const status = !applicable ? role === 'd4' ? 'RAW_QC' : 'NOT_APPLIED' :
        normalized.mean == null ? 'UNAVAILABLE' : nValid < raw.n ? 'PARTIAL' : warnings.length ? 'PROVISIONAL' : 'VALID';
      const rawReasonCodes = [];
      if (!validMask || rawRaster && !goodRaw) rawReasonCodes.push('COORDINATE_MISMATCH');
      if (!rawRaster) rawReasonCodes.push('RAW_MISSING');
      if (validMask && !nGeometry) rawReasonCodes.push('ROI_EMPTY_GEOMETRY');
      else if (nGeometry && !raw.n) rawReasonCodes.push('NO_MEASURED_PIXELS');
      else if (raw.n < nGeometry) rawReasonCodes.push('RAW_NOT_MEASURED');
      return { key: m.key, name: m.name, role: role, method: channel ? channel.method : 'not_applied', unit: channel ? channel.unit : 'raw a.u.',
        ...(simple ? { applicable: applicable, rangeKey: channel && channel.rangeKey, analyteId: channel && channel.analyteId, rangeScope: channel && channel.rangeScope } : {}),
        raw: raw, normalized: normalized, absolute: absolute, nGeometry: nGeometry, nMeasured: raw.n, nValid: nValid,
        rawStatus: !raw.n ? 'UNAVAILABLE' : raw.n < nGeometry ? 'PARTIAL' : 'VALID', rawReasonCodes: rawReasonCodes,
        coverage: coverage, status: status, reasonCodes: unique(reasons.concat(warnings)), reasonCounts: reasonCounts };
    });
  }
  function invalidate(project, detail) {
    if (project && project.normalization) {
      project.normalization.invalidated = { code: 'NORMALIZATION_PROFILE_STALE', detail: String(detail || ''), at: new Date().toISOString() };
    }
    return project;
  }
  global.Normalization = { SCHEMA_VERSION: SCHEMA_VERSION, LEGACY_SCHEMA_VERSION: LEGACY_SCHEMA_VERSION, METHOD_VERSION: METHOD_VERSION, suggestMapping: suggestMapping,
    SIMPLE_SCHEMA_VERSION: SIMPLE_SCHEMA_VERSION, SIMPLE_METHOD_VERSION: SIMPLE_METHOD_VERSION,
    createSimpleProfiles: createSimpleProfiles, suggestSimpleMapping: suggestSimpleMapping, isInternalStandard: isInternalStandard,
    isCorrectedChannel: isCorrectedChannel, rangeForChannel: rangeForChannel, isSupportedScopedProfile: isSupportedScopedProfile,
    loadRasters: loadRasters, fingerprint: fingerprint, createProfiles: createProfiles, evaluate: evaluate,
    quantifyRoi: quantifyRoi, invalidate: invalidate, reasonText: reasonText, stableStringify: stableStringify,
    statistics: statistics, calibrationReasons: calibrationReasons, referenceGeometryFingerprint: geometryFingerprint };
})(window);
