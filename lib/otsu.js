/* Fixed-recipe, display-only Otsu masking. Registered-channel sum is NOT a
 * full-spectrum TIC or anatomical tissue mask. Raw arrays, analytical ROIs,
 * project settings and confirmation state are never modified here. */
(function (global) {
  'use strict';
  const OTSU_NBINS = 256;
  const REASONS = Object.freeze({
    OTSU_SOURCE_RECIPE_MISSING: 'Otsuに用いる固定の生値分子セットが未設定です。Masterで対象分子を確認してください。',
    OTSU_SOURCE_RECIPE_INVALID: 'Otsuの分子セットに空欄・重複・不正な指定があります。',
    OTSU_SOURCE_MISSING: '固定セットに必要な分子の生値ラスタがありません。別の分子セットへ自動変更はしません。',
    OTSU_SOURCE_UNKNOWN: '指定分子が登録情報に見つからず、内因性分子か確認できません。',
    OTSU_INTERNAL_STANDARD_SOURCE: '同位体標識分子・内部標準はOtsuの入力に使用できません。',
    OTSU_COORDINATE_MISMATCH: 'Otsu入力の幅・高さ・配列長が元のMSIグリッドと一致しません。',
    OTSU_NO_VALID_PIXELS: '必要な全分子の有限かつ非負の生値がそろう画素がありません。',
    OTSU_UNIFORM_SIGNAL: '有効信号が一定で、Otsuによる二群の閾値を決定できません。',
    OTSU_THRESHOLD_INVALID: '閾値が負・非有限、または強度設定が不正なため適用できません。',
    OTSU_PARTIAL_SOURCE_PIXELS: '一部の画素で必要分子の生値が不足・不正です。その画素のOtsu表示判定は算出不可です。',
    OTSU_SOURCE_PIXEL_NONFINITE: '必要分子の生値に欠損または非有限値があります。',
    OTSU_SOURCE_PIXEL_NEGATIVE: '必要分子の生値に負の値があります。',
    OTSU_SOURCE_SUM_NONFINITE: '登録分子の信号和が非有限になりました。',
    OTSU_SNAPSHOT_STALE: '保存したOtsu設定の生値または補正プロファイルが現在のデータと一致しません。Viewerで設定を確認して再適用してください。',
    OTSU_SNAPSHOT_UNVERIFIED: '保存したOtsu設定と現在の生値の一致を検証できません。表示判定は算出不可です。'
  });
  function reasonText(code) { return REASONS[code] || String(code || ''); }
  function dimensions(W, H, length) {
    return Number.isSafeInteger(W) && W > 0 && Number.isSafeInteger(H) && H > 0 &&
      Number.isSafeInteger(W * H) && W * H <= 0xffffffff &&
      (length === undefined || length === W * H);
  }
  // Unusable records have empty masks. Callers MUST check usable.
  function unavailable(W, H, reason, extra) {
    return Object.assign({
      W: Number.isSafeInteger(W) && W > 0 ? W : 0,
      H: Number.isSafeInteger(H) && H > 0 ? H : 0,
      usable: false, status: 'NOT_APPLIED', reasonCodes: [reason], reasonText: reasonText(reason),
      keep: new Uint8Array(0), evaluable: new Uint8Array(0),
      histCounts: new Array(OTSU_NBINS).fill(0), histMin: 0, histMax: 1,
      effLog: null, autoThresholdLog: null, thresholdOriginal: null, strength: 0, manual: false,
      nOriginal: 0, nKept: 0, nRemoved: 0, nUnevaluable: dimensions(W, H) ? W * H : 0,
      sourceLabel: 'registered-channel-sum', sourceKeys: []
    }, extra || {});
  }
  /** Otsu threshold for finite log-transformed values; never mutates data. */
  function computeOtsuThreshold(data, nBins) {
    nBins = Number.isInteger(nBins) && nBins >= 2 && nBins <= 65536 ? nBins : OTSU_NBINS;
    let mn = Infinity, mx = -Infinity, finite = 0;
    for (let i = 0; data && i < data.length; i++) {
      const v = data[i];
      if (Number.isFinite(v)) { mn = Math.min(mn, v); mx = Math.max(mx, v); finite++; }
    }
    if (!finite) return { threshold: 0, degenerate: true };
    if (!(mx > mn)) return { threshold: mn, degenerate: true };
    const width = (mx - mn) / nBins;
    if (!(width > 0) || !Number.isFinite(width)) return { threshold: mn, degenerate: true };
    const counts = new Float64Array(nBins);
    for (let i = 0; i < data.length; i++) {
      if (!Number.isFinite(data[i])) continue;
      const b = Math.max(0, Math.min(nBins - 1, Math.floor((data[i] - mn) / width)));
      counts[b]++;
    }
    let sum = 0;
    for (let b = 0; b < nBins; b++) sum += (mn + (b + 0.5) * width) * counts[b];
    let n1 = 0, sum1 = 0, bestVar = -Infinity, bestThr = mn;
    for (let b = 0; b < nBins; b++) {
      n1 += counts[b]; sum1 += (mn + (b + 0.5) * width) * counts[b];
      const n2 = finite - n1;
      // Integer counts avoid a phantom second class from floating-point P2.
      if (!n1 || !n2) continue;
      const delta = sum1 / n1 - (sum - sum1) / n2;
      const variance = (n1 / finite) * (n2 / finite) * delta * delta;
      if (variance > bestVar) { bestVar = variance; bestThr = mn + (b + 0.5) * width; }
    }
    return { threshold: bestThr, degenerate: bestVar === -Infinity };
  }
  /** Display record from a registered-channel sum (legacy function name).
   * Missing/negative signals are not zero-filled. Uniform and missing inputs
   * are unusable even when a manual threshold is supplied. */
  function buildOtsuRecord(tic, W, H, opts) {
    opts = opts || {};
    if (!tic || !dimensions(W, H, tic.length)) return unavailable(W, H, 'OTSU_COORDINATE_MISMATCH');
    const strength = opts.strength == null ? 0 : Number(opts.strength);
    const manual = opts.manualThreshold != null;
    const threshold = manual ? Number(opts.manualThreshold) : null;
    if (!Number.isFinite(strength) || (typeof opts.strength === 'string' && !opts.strength.trim()) ||
      (manual && (!Number.isFinite(threshold) || threshold < 0 ||
        (typeof opts.manualThreshold === 'string' && !opts.manualThreshold.trim())))) {
      return unavailable(W, H, 'OTSU_THRESHOLD_INVALID');
    }
    const N = W * H, logTic = new Float64Array(N), evaluable = new Uint8Array(N);
    let lmn = Infinity, lmx = -Infinity, nOriginal = 0;
    for (let i = 0; i < N; i++) {
      const v = tic[i];
      const lv = Number.isFinite(v) && v >= 0 ? Math.log1p(v) / Math.LN10 : NaN;
      logTic[i] = lv;
      if (Number.isFinite(lv)) { evaluable[i] = 1; nOriginal++; lmn = Math.min(lmn, lv); lmx = Math.max(lmx, lv); }
    }
    if (!nOriginal) return unavailable(W, H, 'OTSU_NO_VALID_PIXELS');
    const auto = computeOtsuThreshold(logTic, OTSU_NBINS);
    if (auto.degenerate) return unavailable(W, H, 'OTSU_UNIFORM_SIGNAL', { nOriginal, nUnevaluable: N - nOriginal });
    const effLog = manual ? Math.log1p(threshold) / Math.LN10 : auto.threshold + strength;
    const thresholdOriginal = manual ? threshold : Math.expm1(effLog * Math.LN10);
    if (!Number.isFinite(effLog) || effLog < 0 || !Number.isFinite(thresholdOriginal) || thresholdOriginal < 0) {
      return unavailable(W, H, 'OTSU_THRESHOLD_INVALID', { nOriginal, nUnevaluable: N - nOriginal });
    }
    const histCounts = new Array(OTSU_NBINS).fill(0), binWidth = (lmx - lmn) / OTSU_NBINS;
    const keep = new Uint8Array(N);
    let nKept = 0;
    for (let i = 0; i < N; i++) {
      if (!evaluable[i]) continue;
      const b = Math.max(0, Math.min(OTSU_NBINS - 1, Math.floor((logTic[i] - lmn) / binWidth)));
      histCounts[b]++;
      if (logTic[i] > effLog) { keep[i] = 1; nKept++; }
    }
    const reasonCodes = nOriginal < N ? ['OTSU_PARTIAL_SOURCE_PIXELS'] : [];
    return {
      W, H, usable: true, status: 'AVAILABLE', reasonCodes,
      reasonText: reasonCodes.map(reasonText).join(' '), keep, evaluable,
      thresholdOriginal, autoThresholdLog: auto.threshold, effLog, strength, manual,
      histCounts, histMin: lmn, histMax: lmx,
      nOriginal, nKept, nRemoved: nOriginal - nKept, nUnevaluable: N - nOriginal,
      sourceLabel: 'registered-channel-sum', sourceKeys: []
    };
  }
  function normalizedName(value) {
    return String(value == null ? '' : value).normalize('NFKC').toLowerCase()
      .replace(/[‐‑‒–—−ー]/g, '-').trim();
  }
  function isInternalStandard(molecule, key, profile) {
    const mapping = profile && profile.mapping || {};
    const roleTable = profile && profile.otsuSourceRoles || {};
    const role = normalizedName(roleTable[key] || molecule.analyticalRole || molecule.role || '');
    if (molecule.isInternalStandard === true || molecule.internalStandard === true ||
      /internal.?standard|isotope|labelled|labeled|標準|同位体/.test(role) || /^(is|d4|d3)$/.test(role)) return true;
    if ([mapping.d4, mapping.D4, profile && profile.internalStandardKey].includes(key)) return true;
    const name = normalizedName((molecule.name || '') + ' ' + key);
    // Include both name and key so a display-name edit cannot admit a known IS.
    return /(^|[^a-z0-9])d\d+(?=$|[^a-z0-9]|5ht|5-ht|da|ne|serotonin)/.test(name) ||
      /(^|[^a-z0-9])(13c\d*|15n\d*|18o\d*|c13|n15|o18)(?=$|[^a-z0-9])/.test(name) ||
      /(^|[^a-z0-9])(is|istd)(?=$|[^a-z0-9])|internal.?standard|標準|同位体/.test(name) ||
      /(?:5-?ht|serotonin|dopamine|noradrenaline|norepinephrine|da|ne)[-_\s]?d\d+(?=$|[^a-z0-9])/.test(name);
  }
  function sumRequiredRasters(rasters, W, H, ArrayType) {
    if (!rasters.length || !dimensions(W, H) || rasters.some(r => !r || !r.values ||
      r.W !== W || r.H !== H || !dimensions(r.W, r.H, r.values.length))) return null;
    const sum = new ArrayType(W * H);
    const reasonCounts = { OTSU_SOURCE_PIXEL_NONFINITE: 0, OTSU_SOURCE_PIXEL_NEGATIVE: 0, OTSU_SOURCE_SUM_NONFINITE: 0 };
    for (let i = 0; i < sum.length; i++) {
      let value = 0, nonfinite = false, negative = false;
      for (const r of rasters) {
        const v = r.values[i];
        if (!Number.isFinite(v)) nonfinite = true;
        else if (v < 0) negative = true;
        else value += v;
      }
      if (nonfinite) reasonCounts.OTSU_SOURCE_PIXEL_NONFINITE++;
      if (negative) reasonCounts.OTSU_SOURCE_PIXEL_NEGATIVE++;
      if (nonfinite || negative) sum[i] = NaN;
      else {
        sum[i] = value;
        if (!Number.isFinite(sum[i])) { sum[i] = NaN; reasonCounts.OTSU_SOURCE_SUM_NONFINITE++; }
      }
    }
    return { sum, reasonCounts };
  }
  function snapshotFailure(project, rasters, settings) {
    const profile = project.normalization || {};
    if ((settings.profileId != null && settings.profileId !== profile.id) ||
      (settings.profileRevision != null && settings.profileRevision !== profile.revision)) return 'OTSU_SNAPSHOT_STALE';
    if (settings.dataFingerprint != null) {
      if (typeof settings.dataFingerprint !== 'string' || !settings.dataFingerprint ||
        !global.Normalization || typeof global.Normalization.fingerprint !== 'function') return 'OTSU_SNAPSHOT_UNVERIFIED';
      try {
        if (settings.dataFingerprint !== global.Normalization.fingerprint(project, rasters)) return 'OTSU_SNAPSHOT_STALE';
      } catch (error) { return 'OTSU_SNAPSHOT_UNVERIFIED'; }
    }
    return null;
  }
  /** Safe Viewer/Excel API. Uses settings.sourceKeys if supplied, otherwise
   * project.normalization.otsuSourceKeys. Never substitutes available channels.
   * Mask arrays have W*H elements ONLY when usable === true. */
  function buildProjectRecord(project, rasters, settings) {
    project = project || {}; rasters = rasters || {}; settings = settings || {};
    const profile = project.normalization || {}, grid = project.grid || {}, W = grid.W, H = grid.H;
    if (!dimensions(W, H)) return unavailable(W, H, 'OTSU_COORDINATE_MISMATCH');
    const recipe = Object.prototype.hasOwnProperty.call(settings, 'sourceKeys') ? settings.sourceKeys : profile.otsuSourceKeys;
    if (!Array.isArray(recipe) || !recipe.length) return unavailable(W, H, 'OTSU_SOURCE_RECIPE_MISSING');
    if (recipe.some(key => typeof key !== 'string' || !key.trim()) || new Set(recipe).size !== recipe.length) {
      return unavailable(W, H, 'OTSU_SOURCE_RECIPE_INVALID');
    }
    const sourceKeys = recipe.slice(), definitions = Array.isArray(project.molecules) ? project.molecules : [], selected = [];
    for (const key of sourceKeys) {
      const matches = definitions.filter(m => m && m.key === key);
      if (matches.length !== 1) return unavailable(W, H, 'OTSU_SOURCE_UNKNOWN', { sourceKeys, failedSourceKey: key });
      if (isInternalStandard(matches[0], key, profile)) {
        return unavailable(W, H, 'OTSU_INTERNAL_STANDARD_SOURCE', { sourceKeys, failedSourceKey: key });
      }
      const raster = rasters[key];
      if (!raster || !raster.values) return unavailable(W, H, 'OTSU_SOURCE_MISSING', { sourceKeys, failedSourceKey: key });
      if (raster.W !== W || raster.H !== H || !dimensions(raster.W, raster.H, raster.values.length)) {
        return unavailable(W, H, 'OTSU_COORDINATE_MISMATCH', { sourceKeys, failedSourceKey: key });
      }
      selected.push(raster);
    }
    const snapshotReason = snapshotFailure(project, rasters, settings);
    if (snapshotReason) return unavailable(W, H, snapshotReason, { sourceKeys });
    const sums = sumRequiredRasters(selected, W, H, Float64Array);
    if (!sums) return unavailable(W, H, 'OTSU_COORDINATE_MISMATCH', { sourceKeys });
    return Object.assign(buildOtsuRecord(sums.sum, W, H, settings), {
      sourceKeys, sourceLabel: 'registered-channel-sum',
      sourceNames: sourceKeys.map(key => { const m = definitions.find(m => m.key === key); return m.name || m.key; }),
      pixelReasonCounts: sums.reasonCounts
    });
  }
  /** Legacy name retained; strict matching dimensions and all selected channels
   * per pixel are now required. New callers must use the fixed-recipe API. */
  function buildTic(rasters) {
    if (!Array.isArray(rasters) || !rasters.length || !rasters[0]) return null;
    const result = sumRequiredRasters(rasters, rasters[0].W, rasters[0].H, Float32Array);
    return result ? result.sum : null;
  }
  global.Otsu = { NBINS: OTSU_NBINS, computeOtsuThreshold, buildOtsuRecord, buildTic, buildProjectRecord, reasonText, REASONS };
})(window);
