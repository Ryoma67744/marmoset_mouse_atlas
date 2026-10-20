/* Display-only, raw-data references for HE/MSI alignment. Registered-channel
 * sums are not full-spectrum TICs. Source arrays and analytical data are never
 * modified; each build returns its own Float64 buffer. */
(function (global) {
  'use strict';
  const SCHEMA_VERSION = 1, QUANTILE = 0.99, QUANTILE_METHOD = 'linear-h-n-minus-1';
  const REASONS = Object.freeze({
    ALIGNMENT_REFERENCE_MODE_INVALID: '重ね合わせの参照画像の種類が不正です。',
    ALIGNMENT_REFERENCE_RECIPE_INVALID: '参照画像に使う分子を、重複のない固定セットで選択してください。',
    ALIGNMENT_REFERENCE_SOURCE_UNKNOWN: '選択した分子の登録情報を一意に確認できません。',
    ALIGNMENT_REFERENCE_SOURCE_MISSING: '選択した分子の生値がありません。分子を自動的に除外することはできません。',
    ALIGNMENT_REFERENCE_COORDINATE_MISMATCH: '選択した分子の画素グリッドまたは座標がMSIと一致しません。',
    ALIGNMENT_REFERENCE_INTERNAL_STANDARD: '合成画像には同位体標識分子・内部標準を使用できません。',
    ALIGNMENT_REFERENCE_ROLE_UNAVAILABLE: '内部標準の判定機能を読み込めないため、合成画像を作成できません。',
    ALIGNMENT_REFERENCE_NO_VALID_PIXELS: '選択した全分子の有限かつ非負の生値がそろう画素がありません。',
    ALIGNMENT_REFERENCE_SCALE_INVALID: 'P99が0または非有限の分子があるため、強度差補正合成を作成できません。',
    ALIGNMENT_REFERENCE_SUM_NONFINITE: '選択した分子の生値の合計が非有限になったため、合成画像を作成できません。'
  });
  function reasonText(code) { return REASONS[code] || String(code || ''); }
  function fail(code, sourceKey) {
    const error = new Error(reasonText(code) + (sourceKey ? ' [' + sourceKey + ']' : ''));
    error.code = code;
    if (sourceKey != null) error.sourceKey = sourceKey;
    throw error;
  }
  function dimensions(W, H, length) {
    return Number.isSafeInteger(W) && W > 0 && Number.isSafeInteger(H) && H > 0 &&
      Number.isSafeInteger(W * H) && W * H <= 0xffffffff && (length == null || length === W * H);
  }
  function stable(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value) || ArrayBuffer.isView(value)) return '[' + Array.from(value, stable).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  function coordinates(record) {
    const out = {};
    for (const key of ['xs', 'ys', 'xCoordinates', 'yCoordinates', 'coordinateFingerprint']) {
      if (record && record[key] != null) out[key] = record[key];
    }
    return out;
  }
  function coordinatesMatch(records) {
    for (const key of ['xs', 'ys', 'xCoordinates', 'yCoordinates', 'coordinateFingerprint']) {
      let expected;
      for (const record of records) {
        if (!record || record[key] == null) continue;
        const actual = stable(record[key]);
        if (expected !== undefined && actual !== expected) return false;
        expected = actual;
      }
    }
    return true;
  }
  function internalStandard(molecule, project) {
    if (!global.Otsu || typeof global.Otsu.isInternalStandard !== 'function') fail('ALIGNMENT_REFERENCE_ROLE_UNAVAILABLE');
    return global.Otsu.isInternalStandard(molecule, molecule.key, project.normalization || {});
  }
  /** A stable default recipe from registered endogenous channels. Raster
   * availability and Viewer visibility never silently narrow this recipe. */
  function sourceKeys(project) {
    project = project || {};
    return (Array.isArray(project.molecules) ? project.molecules : [])
      .filter(molecule => molecule && typeof molecule.key === 'string' && !internalStandard(molecule, project))
      .map(molecule => molecule.key);
  }
  function quantile(sorted, probability) {
    const h = (sorted.length - 1) * probability, lower = Math.floor(h), fraction = h - lower;
    return fraction ? sorted[lower] * (1 - fraction) + sorted[lower + 1] * fraction : sorted[lower];
  }
  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(key => deepFreeze(value[key]));
    return Object.freeze(value);
  }
  // Two independent 32-bit streams identify the exact selected Float64 content,
  // grid and coordinates for cache/provenance checks; this is not a security hash.
  function sourceFingerprint(project, selected) {
    let first = 2166136261, second = 3335557771;
    function byte(value) {
      first = Math.imul(first ^ value, 16777619) >>> 0;
      second = Math.imul(second ^ value, 2246822519) >>> 0;
    }
    function text(value) {
      const content = String(value);
      for (let i = 0; i < content.length; i++) { const c = content.charCodeAt(i); byte(c & 255); byte(c >>> 8); }
      byte(255); byte(0);
    }
    const grid = project.grid || {}, bits = new DataView(new ArrayBuffer(8));
    text(stable({ W: grid.W, H: grid.H, coordinates: coordinates(grid) }));
    for (const source of selected) {
      text(source.key);
      text(stable({ W: source.raster.W, H: source.raster.H,
        coordinates: coordinates(source.raster), molecularGrid: source.definition.grid || null }));
      for (let i = 0; i < source.raster.values.length; i++) {
        bits.setFloat64(0, source.raster.values[i], true);
        for (let j = 0; j < 8; j++) byte(bits.getUint8(j));
      }
    }
    return 'alignment-f64-v1:' + first.toString(16).padStart(8, '0') + second.toString(16).padStart(8, '0');
  }
  /** Build from raw values, never display-corrected values. `single` permits a
   * labelled standard for manual comparison; both composite modes exclude it.
   * Errors are explicit and carry `code` and, where applicable, `sourceKey`. */
  function build(project, valueRasters, options) {
    project = project || {}; valueRasters = valueRasters || {}; options = options || {};
    const mode = options.mode || 'single', grid = project.grid || {}, W = grid.W, H = grid.H;
    if (!['single', 'rawsum', 'balanced'].includes(mode)) fail('ALIGNMENT_REFERENCE_MODE_INVALID');
    if (!dimensions(W, H)) fail('ALIGNMENT_REFERENCE_COORDINATE_MISMATCH');
    const keys = Object.prototype.hasOwnProperty.call(options, 'sourceKeys') ? options.sourceKeys : sourceKeys(project);
    if (!Array.isArray(keys) || !keys.length || keys.some(key => typeof key !== 'string' || !key.trim()) ||
      new Set(keys).size !== keys.length || (mode === 'single' && keys.length !== 1)) fail('ALIGNMENT_REFERENCE_RECIPE_INVALID');
    const definitions = Array.isArray(project.molecules) ? project.molecules : [], selected = [];
    for (const key of keys) {
      const matches = definitions.filter(definition => definition && definition.key === key);
      if (matches.length !== 1) fail('ALIGNMENT_REFERENCE_SOURCE_UNKNOWN', key);
      const definition = matches[0], moleculeGrid = definition.grid || {}, raster = valueRasters[key];
      if (mode !== 'single' && internalStandard(definition, project)) fail('ALIGNMENT_REFERENCE_INTERNAL_STANDARD', key);
      if (!raster || !raster.values) fail('ALIGNMENT_REFERENCE_SOURCE_MISSING', key);
      if (raster.W !== W || raster.H !== H || !dimensions(W, H, raster.values.length) ||
        (moleculeGrid.W != null && Number(moleculeGrid.W) !== W) ||
        (moleculeGrid.H != null && Number(moleculeGrid.H) !== H) ||
        !coordinatesMatch([grid, moleculeGrid, raster])) fail('ALIGNMENT_REFERENCE_COORDINATE_MISMATCH', key);
      selected.push({ key, definition, raster });
    }
    // If coordinate metadata is present only on the individual channels, also
    // compare those channels to each other rather than only to the project grid.
    if (!coordinatesMatch(selected.flatMap(source => [source.raster, source.definition.grid]))) {
      fail('ALIGNMENT_REFERENCE_COORDINATE_MISMATCH');
    }
    const length = W * H, valid = new Uint8Array(length);
    let nValid = 0;
    for (let i = 0; i < length; i++) {
      if (selected.every(source => Number.isFinite(source.raster.values[i]) && source.raster.values[i] >= 0)) {
        valid[i] = 1; nValid++;
      }
    }
    if (!nValid) fail('ALIGNMENT_REFERENCE_NO_VALID_PIXELS');
    const scales = Object.create(null), sourceRanges = Object.create(null);
    for (const source of selected) {
      const sorted = new Float64Array(nValid);
      let offset = 0;
      for (let i = 0; i < length; i++) if (valid[i]) sorted[offset++] = source.raster.values[i];
      sorted.sort();
      sourceRanges[source.key] = { min: sorted[0], max: sorted[nValid - 1] };
      if (mode === 'balanced') {
        const scale = quantile(sorted, QUANTILE);
        if (!(scale > 0) || !Number.isFinite(scale)) fail('ALIGNMENT_REFERENCE_SCALE_INVALID', source.key);
        scales[source.key] = scale;
      }
    }
    const values = new Float64Array(length);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < length; i++) {
      if (!valid[i]) { values[i] = NaN; continue; }
      let sum = 0;
      for (const source of selected) {
        const intensity = source.raster.values[i];
        sum += mode === 'balanced' ? Math.min(intensity / scales[source.key], 1) : intensity;
      }
      if (!Number.isFinite(sum)) fail('ALIGNMENT_REFERENCE_SUM_NONFINITE');
      values[i] = sum; min = Math.min(min, sum); max = Math.max(max, sum);
    }
    const fingerprint = sourceFingerprint(project, selected), names = selected.map(source => source.definition.name || source.key);
    const metadata = deepFreeze({
      schemaVersion: SCHEMA_VERSION, mode, sourceKeys: keys.slice(), sourceNames: names.slice(),
      sourceFingerprint: fingerprint, W, H, nValid, nInvalid: length - nValid,
      sourceRanges, scales, quantile: mode === 'balanced' ? QUANTILE : null,
      quantileMethod: mode === 'balanced' ? QUANTILE_METHOD : null,
      recipe: mode === 'balanced' ? 'sum(min(raw/P99,1))' : mode === 'rawsum' ? 'sum(raw)' : 'raw',
      validPixelRule: 'all-selected-finite-and-nonnegative',
      sourceLabel: mode === 'balanced' ? 'intensity-balanced-registered-channel-sum' :
        mode === 'rawsum' ? 'registered-channel-sum' : 'single-raw-channel'
    });
    return { values, W, H, usable: true, sourceKeys: keys.slice(), sourceNames: names,
      range: { min, max }, nValid, nInvalid: length - nValid, sourceFingerprint: fingerprint, metadata };
  }
  global.AlignmentReference = Object.freeze({ SCHEMA_VERSION, QUANTILE, QUANTILE_METHOD, REASONS, reasonText, sourceKeys, build });
})(window);
