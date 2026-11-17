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
      // Missing signal still defines the axes, but is neither measured zero
      // nor an observation in a duplicate-coordinate average.
      if (!Number.isFinite(r.v)) continue;
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
   *   color は分子ごとの固定色。null ならグレースケール。
   *   keep は大津法の残すマスク (0 の画素は透明にして下の HE を見せる)。
   *   データの無い画素 (NaN) も透明。
   *
   * ★ gamma の既定は 1 (線形) = Share_Test と同じ。測定値に比例した明るさになる。
   */
  function paintRasterToCanvas(values, W, H, opts) {
    opts = opts || {};
    const color = opts.color || null;
    const win = opts.win || { min: 0, max: 1 };
    const gamma = Number.isFinite(opts.gamma) ? opts.gamma : 1;
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
      const bright = gamma === 1 ? n : Math.pow(n, gamma);
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

  /**
   * ROI ポリゴンの内側を mask (Uint8Array, 長さ W*H) に 1 で塗る。
   *
   * ★ 1 つの ROI が離れた複数の場所を持つとき、頂点配列を連結してはいけない。
   *   even-odd 判定でも描画でも、離れたリング同士に「繋ぎ線」が入ってしまう。
   *   ポリゴンごとにこれを呼んで同じ mask に重ねて塗る。こうすると
   *   重なった部分も 1 画素として 1 回だけ数えられる (連結だと二重に数える)。
   */
  function markRoiMask(mask, W, H, poly, ox, oy) {
    if (!mask || !poly || poly.length < 3) return mask;
    // mask は (ox, oy) を左上とする W×H の面。HE のような大きい画像では
    // 全面ぶんを確保すると数十 MB になるので、呼ぶ側が ROI の外接矩形だけを
    // 渡せるようにしてある (省略時は画像の左上から全面)。
    const offX = ox | 0, offY = oy | 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const pt of poly) {
      if (!pt) continue;
      if (pt[0] < minX) minX = pt[0];
      if (pt[0] > maxX) maxX = pt[0];
      if (pt[1] < minY) minY = pt[1];
      if (pt[1] > maxY) maxY = pt[1];
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return mask;
    const x0 = Math.max(offX, Math.floor(minX)), x1 = Math.min(offX + W - 1, Math.ceil(maxX));
    const y0 = Math.max(offY, Math.floor(minY)), y1 = Math.min(offY + H - 1, Math.ceil(maxY));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (pointInPolygon(x, y, poly)) mask[(y - offY) * W + (x - offX)] = 1;
      }
    }
    return mask;
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

  // Saved Layer 1..5 polygons are cumulative anatomical boundaries. Effective
  // cortical layers are virtual masks; neither these polygons nor raw signals
  // are rewritten. All consumers must use roiMask, never union both contours.
  const ROI_LAYER_RULE_VERSION = 'cortical-difference-v1';
  const roiLabel = value => String(value == null ? '' : value).normalize('NFC').trim();
  const distinct = values => Array.from(new Set(values));
  const roiMaskCache = new WeakMap();
  const ROI_REASONS = {
    ROI_BOUNDARY_MISSING: '層の計算に必要な境界ROIがありません。',
    ROI_BOUNDARY_AMBIGUOUS: '同じ境界に該当するROIが複数あります。',
    ROI_BOUNDARY_INVALID: '境界ROIの頂点が不正です。',
    ROI_BOUNDARY_EMPTY: '境界ROIにMSI座標の画素がありません。',
    ROI_LAYER_NOT_NESTED: '境界ROIの包含関係が逆転または交差しています。境界を確認してください。',
    ROI_LAYER_KEY_COLLISION: '層の仮想IDと保存済みROIのIDが重複しています。',
    ROI_LAYER_NAME_CONFLICT: '計算した層と保存済みROIの名前が重複しています。',
    ROI_GRID_INVALID: 'ROIの計算に必要なMSIグリッドが不正です。'
  };
  function roiReasonText(code) { return Array.isArray(code) ? distinct(code).map(roiReasonText).join(' ') : ROI_REASONS[code] || code; }
  function roiCanonicalName(name, definitions) {
    const normalized = roiLabel(name), match = normalized.normalize('NFKC').match(/^layer\s*([1-6])$/i);
    if (!match) return normalized;
    const canonical = 'Layer ' + match[1];
    return Array.isArray(definitions) && definitions.some(definition => definition.kind === 'cortical-layer' && definition.name === canonical)
      ? canonical : normalized;
  }
  function validRoiPolygon(poly) {
    return Array.isArray(poly) && poly.length >= 3 && poly.every(point => Array.isArray(point) && point.length >= 2 &&
      Number.isFinite(point[0]) && Number.isFinite(point[1]));
  }
  function boundaryIndex(name) {
    const normalized = roiLabel(name).normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
    if (normalized === 'whole' || normalized === 'occipital lobe whole') return 0;
    if (normalized === 'white matter' || normalized === 'white mater') return 6;
    const match = normalized.match(/^layer\s*([1-5])$/);
    return match ? Number(match[1]) : null;
  }
  function roiColor(roi, key) {
    const color = roi.palette && roi.palette[key];
    return Array.isArray(color) && color.length >= 3 && color.slice(0, 3).every(Number.isFinite)
      ? color.slice(0, 3).map(value => Math.round(Math.max(0, Math.min(255, value)))) : [160, 200, 255];
  }
  function roiDefinitions(roi, options) {
    roi = roi || {}; options = options || {};
    const items = roi.roi_items || {}, names = roi.roi_names || {}, flags = roi.roi_show_flags || {};
    const originals = Object.entries(items).map(([key, records]) => {
      const valid = Array.isArray(records) ? records.filter(record => record && validRoiPolygon(record.poly_msi)) : [];
      return { key, keys: [key], name: roiLabel(names[key] || key), kind: 'normal',
        polys: valid.map(record => record.poly_msi.map(point => point.slice(0, 2))),
        sourceKeys: [key], outerKeys: [], innerKeys: [], outerPolys: [], innerPolys: [],
        definition: '', ruleVersion: null, reasonCodes: [], visible: flags[key] !== false, color: roiColor(roi, key),
        invalidSource: !Array.isArray(records) || !records.length || valid.length !== records.length };
    });
    const hasLayers = originals.some(record => { const index = boundaryIndex(record.name); return index >= 1 && index <= 5; });
    let definitions = originals;
    if (hasLayers) {
      const expectedNames = ['Whole', 'Layer 1', 'Layer 2', 'Layer 3', 'Layer 4', 'Layer 5', 'White matter'];
      const chain = expectedNames.map((name, index) => {
        const matches = originals.filter(record => boundaryIndex(record.name) === index), reasons = [];
        if (!matches.length) reasons.push('ROI_BOUNDARY_MISSING');
        else if (matches.length !== 1) reasons.push('ROI_BOUNDARY_AMBIGUOUS');
        else if (matches[0].invalidSource) reasons.push('ROI_BOUNDARY_INVALID');
        return { index, name, keys: matches.map(record => record.key),
          polys: matches.length === 1 && !matches[0].invalidSource ? matches[0].polys : [], reasonCodes: reasons };
      });
      definitions = originals.filter(record => { const index = boundaryIndex(record.name); return !(index >= 1 && index <= 5); });
      for (let layer = 1; layer <= 6; layer++) {
        const outer = chain[layer - 1], inner = chain[layer], key = '__cortical_layer__' + layer;
        const sourceKeys = distinct([...outer.keys, ...inner.keys]), visibilitySource = layer < 6 ? inner : outer;
        const primary = originals.find(record => record.key === visibilitySource.keys[0]);
        const reasonCodes = distinct([...outer.reasonCodes, ...inner.reasonCodes]);
        if (Object.hasOwn(items, key)) {
          reasonCodes.push('ROI_LAYER_KEY_COLLISION');
          originals.filter(record => record.key === key).forEach(record => record.reasonCodes.push('ROI_LAYER_KEY_COLLISION'));
        }
        const nameConflicts = layer === 6 ? originals.filter(record => /^layer\s*6$/i.test(record.name.normalize('NFKC'))) : [];
        if (nameConflicts.length) {
          reasonCodes.push('ROI_LAYER_NAME_CONFLICT');
          nameConflicts.forEach(record => record.reasonCodes.push('ROI_LAYER_NAME_CONFLICT'));
        }
        definitions.push({ key, keys: [key], name: 'Layer ' + layer, kind: 'cortical-layer', layer,
          // polys intentionally stays empty: union-only legacy callers must not
          // silently count the two contours as a cumulative ROI.
          polys: [], outerPolys: outer.polys, innerPolys: inner.polys, outerKeys: outer.keys.slice(), innerKeys: inner.keys.slice(),
          sourceKeys, definition: outer.name + ' − ' + inner.name, ruleVersion: ROI_LAYER_RULE_VERSION,
          reasonCodes, visible: Object.hasOwn(flags, key) ? flags[key] !== false : primary ? primary.visible : true,
          color: Object.hasOwn(roi.palette || {}, key) ? roiColor(roi, key) : primary ? primary.color.slice() : [160, 200, 255],
          boundaryChain: chain });
      }
    }
    if (!options.groupByName) return definitions;
    const grouped = [], byName = new Map();
    for (const definition of definitions) {
      // Virtual layers are never merged with saved cumulative annotations.
      const groupKey = definition.kind + ':' + definition.name;
      if (!byName.has(groupKey)) { byName.set(groupKey, definition); grouped.push(definition); continue; }
      const group = byName.get(groupKey);
      group.keys.push(...definition.keys); group.sourceKeys.push(...definition.sourceKeys); group.polys.push(...definition.polys);
      group.visible = group.visible || definition.visible;
      group.invalidSource = group.invalidSource || definition.invalidSource;
    }
    return grouped;
  }
  function roiContours(definition) {
    if (!definition) return [];
    return definition.kind === 'cortical-layer'
      ? [...definition.outerPolys.map(vertices => ({ vertices, role: 'outer' })), ...definition.innerPolys.map(vertices => ({ vertices, role: 'inner' }))]
      : definition.polys.map(vertices => ({ vertices, role: 'normal' }));
  }
  function boundaryMasks(chain, W, H) {
    const cached = roiMaskCache.get(chain);
    if (cached && cached.W === W && cached.H === H) return cached;
    const masks = chain.map(boundary => {
      if (boundary.reasonCodes.length) return null;
      const mask = new Uint8Array(W * H);
      boundary.polys.forEach(poly => markRoiMask(mask, W, H, poly));
      return mask;
    });
    const counts = masks.map(mask => mask ? mask.reduce((sum, value) => sum + value, 0) : null);
    const checks = [];
    let previous = null;
    for (let inner = 0; inner < chain.length; inner++) {
      if (!masks[inner] || !counts[inner]) continue;
      if (previous !== null) {
        let outsidePixels = 0;
        for (let i = 0; i < masks[inner].length; i++) if (masks[inner][i] && !masks[previous][i]) outsidePixels++;
        checks.push({ outer: chain[previous].name, inner: chain[inner].name, outerKeys: chain[previous].keys,
          innerKeys: chain[inner].keys, outsidePixels });
      }
      previous = inner;
    }
    const result = { W, H, masks, counts, checks };
    roiMaskCache.set(chain, result); return result;
  }
  function roiMask(definition, W, H) {
    if (!Number.isSafeInteger(W) || !Number.isSafeInteger(H) || W < 1 || H < 1 || !Number.isSafeInteger(W * H) || W * H > 16777216) {
      return { mask: new Uint8Array(0), available: false, reasonCodes: ['ROI_GRID_INVALID'], nGeometry: null, geometryQc: null };
    }
    const mask = new Uint8Array(W * H), reasons = definition ? (definition.reasonCodes || []).slice() : ['ROI_BOUNDARY_MISSING'];
    let geometryQc = { outsidePixels: 0, containmentChecks: [] };
    if (definition && definition.kind === 'cortical-layer') {
      const boundaries = boundaryMasks(definition.boundaryChain, W, H), outerIndex = definition.layer - 1, innerIndex = definition.layer;
      const outer = boundaries.masks[outerIndex], inner = boundaries.masks[innerIndex];
      geometryQc = { outsidePixels: boundaries.checks.reduce((sum, item) => sum + item.outsidePixels, 0),
        containmentChecks: boundaries.checks, outerPixels: boundaries.counts[outerIndex], innerPixels: boundaries.counts[innerIndex] };
      if (geometryQc.outsidePixels) reasons.push('ROI_LAYER_NOT_NESTED');
      if (outer && !boundaries.counts[outerIndex] || inner && !boundaries.counts[innerIndex]) reasons.push('ROI_BOUNDARY_EMPTY');
      if (!reasons.length && outer && inner) for (let i = 0; i < mask.length; i++) mask[i] = outer[i] && !inner[i] ? 1 : 0;
    } else if (definition && !reasons.length) definition.polys.forEach(poly => markRoiMask(mask, W, H, poly));
    return { mask, available: !reasons.length, reasonCodes: distinct(reasons),
      nGeometry: reasons.length ? null : mask.reduce((sum, value) => sum + value, 0), geometryQc };
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
    extractRoiValues, markRoiMask, pointInPolygon, stats,
    ROI_LAYER_RULE_VERSION, roiDefinitions, roiMask, roiContours, roiReasonText, roiCanonicalName,
  };
})(window);
