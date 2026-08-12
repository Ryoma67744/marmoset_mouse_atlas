/*
 * msi.js — MSI 生値ラスタのユーティリティ
 *
 * 従来この viewer は取り込み時に 8bit の PNG に量子化してしまっており、
 * そこから先は 0-255 の輝度しか見えなかった。生単位の強度ウィンドウ・大津法・
 * 定量的な ROI 統計はいずれも元の float が要るので、PNG と並行して
 * Float32Array の生値ラスタを保持する。
 *
 * ベイク時の百分位は Share_Test に合わせる:
 *   MSI_ROBUST_PERCENTILE          = 0.995  外れ値クリップ (PNG ベイク上限)
 *   MSI_DEFAULT_DISPLAY_PERCENTILE = 0.99   既定の表示上限
 */
(function (global) {
  'use strict';

  const MSI_ROBUST_PERCENTILE = 0.995;
  const MSI_DEFAULT_DISPLAY_PERCENTILE = 0.99;

  /** [{x,y,v}] → 生値ラスタ。既存の xlsx / txt 取り込み経路から使う。 */
  function rasterFromRows(rows) {
    const xs = [...new Set(rows.map(r => r.x))].sort((a, b) => a - b);
    const ys = [...new Set(rows.map(r => r.y))].sort((a, b) => a - b);
    const W = xs.length, H = ys.length;
    const xIndex = new Map(xs.map((v, i) => [v, i]));
    const yIndex = new Map(ys.map((v, i) => [v, i]));
    const values = new Float32Array(W * H);
    const cnt = new Uint16Array(W * H);
    values.fill(NaN);
    for (const r of rows) {
      const ci = xIndex.get(r.x), ri = yIndex.get(r.y);
      if (ci == null || ri == null) continue;
      const i = ri * W + ci;
      values[i] = cnt[i] ? values[i] + r.v : r.v;
      cnt[i]++;
    }
    for (let i = 0; i < values.length; i++) if (cnt[i] > 1) values[i] /= cnt[i];
    return { values: values, W: W, H: H, xs: xs, ys: ys };
  }

  /**
   * 生値ラスタから表示に必要な統計を 1 回のソートで出す。
   * @param bakeMode 'clip' (既定, p99.5 でクリップ) | 'full' (クリップしない)
   */
  function deriveBakeStats(values, bakeMode) {
    const finite = [];
    for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) finite.push(values[i]);
    if (!finite.length) {
      return { bakeLo: 0, bakeHi: 1, rawMin: 0, rawTrueMax: 1, rawDispMax: 1, mean: 0, n: 0 };
    }
    finite.sort((a, b) => a - b);
    const n = finite.length;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += finite[i];
    const at = (p) => finite[Math.min(n - 1, Math.max(0, Math.floor(n * p)))];
    const rawMin = finite[0];
    const rawTrueMax = finite[n - 1];
    const full = bakeMode === 'full';
    const bakeHi = full ? rawTrueMax : at(MSI_ROBUST_PERCENTILE);
    const rawDispMax = full ? rawTrueMax : at(MSI_DEFAULT_DISPLAY_PERCENTILE);
    return {
      bakeLo: rawMin,
      bakeHi: bakeHi > rawMin ? bakeHi : rawMin + 1e-9,
      rawMin: rawMin,
      rawTrueMax: rawTrueMax,
      rawDispMax: rawDispMax > rawMin ? rawDispMax : rawTrueMax,
      mean: sum / n,
      n: n,
    };
  }

  /** 生値を表示ウィンドウ [win.min, win.max] に写して 0..1 を返す */
  function msiValueEval(v, win) {
    if (!Number.isFinite(v)) return NaN;
    const lo = Number.isFinite(win && win.min) ? win.min : 0;
    let hi = Number.isFinite(win && win.max) ? win.max : lo + 1;
    if (!(hi > lo)) hi = lo + 1e-9;
    return Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  }

  /**
   * 生値ラスタを着色して canvas に描く。
   * @param opts {color:[r,g,b]|null, win:{min,max}, gamma, keep:Uint8Array|null}
   *   color が null ならグレースケール。
   *   keep は大津法の残すマスク (0 の画素は透明にして下の HE を見せる)。
   *   データの無い画素 (NaN) も透明。
   */
  function paintRasterToCanvas(values, W, H, opts) {
    opts = opts || {};
    const color = opts.color || null;
    const win = opts.win || { min: 0, max: 1 };
    const gamma = Number.isFinite(opts.gamma) ? opts.gamma : 0.5;
    const keep = opts.keep || null;
    const canvas = opts.canvas || document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.createImageData(W, H);
    const d = img.data;
    for (let i = 0, p = 0; i < values.length; i++, p += 4) {
      const v = values[i];
      if (!Number.isFinite(v) || (keep && !keep[i])) {
        d[p] = 0; d[p + 1] = 0; d[p + 2] = 0; d[p + 3] = 0;
        continue;
      }
      const n = msiValueEval(v, win);
      const bright = Math.pow(n, gamma);
      if (color) {
        d[p] = Math.min(255, Math.round(color[0] * bright));
        d[p + 1] = Math.min(255, Math.round(color[1] * bright));
        d[p + 2] = Math.min(255, Math.round(color[2] * bright));
      } else {
        const g = Math.min(255, Math.round(255 * bright));
        d[p] = g; d[p + 1] = g; d[p + 2] = g;
      }
      d[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /**
   * 生値ラスタを 8bit グレースケール PNG に焼く。
   * サムネイル用と、既存コードが期待する imageSources[key] の <img> 用。
   */
  function bakeToPngDataUrl(values, W, H, lo, hi) {
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.createImageData(W, H);
    const d = img.data;
    const range = (hi - lo) || 1e-9;
    for (let i = 0, p = 0; i < values.length; i++, p += 4) {
      const v = values[i];
      if (!Number.isFinite(v)) { d[p] = 0; d[p + 1] = 0; d[p + 2] = 0; d[p + 3] = 0; continue; }
      const g = Math.round(Math.max(0, Math.min(1, (v - lo) / range)) * 255);
      d[p] = g; d[p + 1] = g; d[p + 2] = g; d[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL('image/png');
  }

  /** ROI ポリゴン内の生値を取り出す (poly は MSI ピクセル座標) */
  function extractRoiValues(values, W, H, poly) {
    const out = [];
    if (!poly || poly.length < 3) return out;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of poly) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    const x0 = Math.max(0, Math.floor(minX)), x1 = Math.min(W - 1, Math.ceil(maxX));
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(H - 1, Math.ceil(maxY));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const v = values[y * W + x];
        if (!Number.isFinite(v)) continue;
        if (pointInPolygon(x, y, poly)) out.push(v);
      }
    }
    return out;
  }

  function pointInPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function stats(vals) {
    const n = vals.length;
    if (!n) return { n: 0, mean: 0, sd: 0, min: 0, max: 0 };
    let sum = 0, min = Infinity, max = -Infinity;
    for (const v of vals) { sum += v; if (v < min) min = v; if (v > max) max = v; }
    const mean = sum / n;
    let s2 = 0;
    for (const v of vals) s2 += (v - mean) * (v - mean);
    return { n: n, mean: mean, sd: Math.sqrt(s2 / n), min: min, max: max };
  }

  global.MSIRaster = {
    MSI_ROBUST_PERCENTILE, MSI_DEFAULT_DISPLAY_PERCENTILE,
    rasterFromRows, deriveBakeStats, msiValueEval,
    paintRasterToCanvas, bakeToPngDataUrl,
    extractRoiValues, pointInPolygon, stats,
  };
})(window);
