/*
 * otsu.js — 大津の二値化 (背景除去)
 *
 * Share_Test の実装 (viewer/index.html: computeOtsuThreshold 3271-3324,
 * buildOtsuRecordFromTic 3586-3634) の移植。
 *
 * 各ピクセルの総信号量 (TIC = そのデータセットの全分子レイヤの和) を log10(x+1) した
 * 分布に大津の二値化を適用し、閾値未満のスポットを背景として全イオン像から一括で除く。
 * 生データは一切変更しない。
 */
(function (global) {
  'use strict';

  const OTSU_NBINS = 256;

  /**
   * 大津の二値化。data は log10(TIC+1) 済みを想定。
   * [min,max] を nBins 等幅ビンに分割し、クラス間分散 P1*P2*(mu1-mu2)^2 を最大化する
   * bin 中心を閾値として返す。ユニーク値が 1 つ以下なら中央値にフォールバック。
   */
  function computeOtsuThreshold(data, nBins) {
    nBins = nBins || OTSU_NBINS;
    let mn = Infinity, mx = -Infinity, finite = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (Number.isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; finite++; }
    }
    if (finite === 0) return { threshold: 0, degenerate: true };
    if (!(mx > mn)) {
      const arr = [];
      for (let i = 0; i < data.length; i++) if (Number.isFinite(data[i])) arr.push(data[i]);
      arr.sort((a, b) => a - b);
      const med = arr.length ? arr[Math.floor(arr.length / 2)] : mn;
      return { threshold: med, degenerate: true };
    }
    const width = (mx - mn) / nBins;
    const counts = new Float64Array(nBins);
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (!Number.isFinite(v)) continue;
      let b = Math.floor((v - mn) / width);
      if (b < 0) b = 0; else if (b >= nBins) b = nBins - 1;
      counts[b]++;
    }
    const total = finite;
    const centers = new Float64Array(nBins);
    let mu = 0;
    for (let b = 0; b < nBins; b++) { centers[b] = mn + (b + 0.5) * width; mu += centers[b] * (counts[b] / total); }
    let P1 = 0, cumCB = 0, bestVar = -Infinity, bestThr = centers[0];
    for (let b = 0; b < nBins; b++) {
      const p = counts[b] / total;
      P1 += p; cumCB += centers[b] * p;
      const P2 = 1 - P1;
      if (P1 <= 0 || P2 <= 0) continue;
      const mu1 = cumCB / P1;
      const mu2 = (mu - cumCB) / P2;
      const vb = P1 * P2 * (mu1 - mu2) * (mu1 - mu2);
      if (vb > bestVar) { bestVar = vb; bestThr = centers[b]; }
    }
    return { threshold: bestThr, degenerate: false };
  }

  /**
   * TIC ラスタから背景除去レコードを作る。
   * @param tic Float32Array(W*H) — 全分子レイヤの和。データ無しは NaN
   * @param opts { strength, manualThreshold }
   *   strength: 自動 Otsu からの log10 単位のオフセット (正 = 強く除去)
   *   manualThreshold: 生単位の手動閾値 (指定時は strength を無視)
   */
  function buildOtsuRecord(tic, W, H, opts) {
    opts = opts || {};
    const N = tic.length;
    const logTic = new Float64Array(N);
    let lmn = Infinity, lmx = -Infinity;
    for (let i = 0; i < N; i++) {
      const t = Number.isFinite(tic[i]) && tic[i] > 0 ? tic[i] : (Number.isFinite(tic[i]) ? 0 : NaN);
      const lv = Number.isFinite(t) ? Math.log10(t + 1) : NaN;
      logTic[i] = lv;
      if (Number.isFinite(lv)) { if (lv < lmn) lmn = lv; if (lv > lmx) lmx = lv; }
    }
    const autoThresholdLog = computeOtsuThreshold(logTic, OTSU_NBINS).threshold;

    // ヒストグラム (UI 表示用)
    const HB = OTSU_NBINS;
    let histMin = lmn, histMax = lmx;
    const histCounts = new Array(HB).fill(0);
    if (histMax > histMin) {
      const w = (histMax - histMin) / HB;
      for (let i = 0; i < N; i++) {
        if (!Number.isFinite(logTic[i])) continue;
        let b = Math.floor((logTic[i] - histMin) / w);
        if (b < 0) b = 0; else if (b >= HB) b = HB - 1;
        histCounts[b]++;
      }
    } else {
      histMin = lmn - 0.5; histMax = lmn + 0.5;
      histCounts[Math.floor(HB / 2)] = N;
    }

    // 有効閾値 = 手動指定 or 自動 Otsu + 強度オフセット
    const strength = Number(opts.strength) || 0;
    let effLog, thresholdOriginal, isManual = false;
    if (opts.manualThreshold != null && Number.isFinite(Number(opts.manualThreshold))) {
      isManual = true;
      thresholdOriginal = Number(opts.manualThreshold);
      effLog = Math.log10((thresholdOriginal > 0 ? thresholdOriginal : 0) + 1);
    } else {
      effLog = autoThresholdLog + strength;
      thresholdOriginal = Math.pow(10, effLog) - 1;
    }

    const keep = new Uint8Array(W * H);
    let nKept = 0, nValid = 0;
    for (let i = 0; i < N; i++) {
      if (!Number.isFinite(logTic[i])) continue;
      nValid++;
      if (logTic[i] > effLog) { keep[i] = 1; nKept++; }
    }

    return {
      W: W, H: H, keep: keep,
      thresholdOriginal: thresholdOriginal,
      autoThresholdLog: autoThresholdLog,
      effLog: effLog,
      strength: strength,
      manual: isManual,
      histCounts: histCounts, histMin: histMin, histMax: histMax,
      nOriginal: nValid, nKept: nKept, nRemoved: nValid - nKept,
    };
  }

  /** 複数の分子ラスタから TIC (画素ごとの総和) を作る */
  function buildTic(rasters) {
    if (!rasters || !rasters.length) return null;
    const n = rasters[0].values.length;
    const tic = new Float32Array(n);
    tic.fill(NaN);
    for (const r of rasters) {
      if (!r || !r.values || r.values.length !== n) continue;
      for (let i = 0; i < n; i++) {
        const v = r.values[i];
        if (!Number.isFinite(v)) continue;
        tic[i] = Number.isFinite(tic[i]) ? tic[i] + v : v;
      }
    }
    return tic;
  }

  global.Otsu = {
    NBINS: OTSU_NBINS,
    computeOtsuThreshold: computeOtsuThreshold,
    buildOtsuRecord: buildOtsuRecord,
    buildTic: buildTic,
  };
})(window);
