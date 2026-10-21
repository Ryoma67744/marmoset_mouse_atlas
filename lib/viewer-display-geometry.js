/* Display-only geometry. Saved HE -> MSI matrices and raw ROI coordinates never change. */
(function (global) {
  'use strict';
  const identity = () => [1, 0, 0, 1, 0, 0];
  const clean = n => Math.abs(n) < 1e-14 ? 0 : Math.abs(n - 1) < 1e-14 ? 1 : Math.abs(n + 1) < 1e-14 ? -1 : n;
  function multiply(a, b) {
    return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  }
  function point(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  function inverse(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    if (!Number.isFinite(det) || det === 0) throw new Error('表示座標を逆変換できません。');
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
      (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  }
  function rotation(degrees, cx, cy) {
    const a = degrees * Math.PI / 180, c = clean(Math.cos(a)), s = clean(Math.sin(a));
    return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
  }
  function size(value) { return value && Number.isFinite(value.w) && value.w > 0 && Number.isFinite(value.h) && value.h > 0; }
  function affine(T) {
    if (!Array.isArray(T) || T.length !== 3 || T.some(row => !Array.isArray(row) || row.length !== 3 || row.some(n => !Number.isFinite(n))) ||
        T[2][0] !== 0 || T[2][1] !== 0 || T[2][2] !== 1) throw new Error('保存された位置合わせ行列を表示できません。');
    return [T[0][0], T[1][0], T[0][1], T[1][1], T[0][2], T[1][2]];
  }
  function corners(m, w, h) { return [[0, 0], [w, 0], [w, h], [0, h]].map(p => point(m, ...p)); }
  function rotatedSize(w, h, degrees) {
    const a = degrees * Math.PI / 180, c = Math.abs(clean(Math.cos(a))), s = Math.abs(clean(Math.sin(a)));
    return { w: w * c + h * s, h: w * s + h * c };
  }
  function fit(w, h, degrees, availableWidth, availableHeight) {
    const bounds = rotatedSize(w, h, degrees);
    const scale = Math.min(availableWidth / bounds.w, availableHeight / bounds.h);
    return { width: w * scale, height: h * scale, scale, rotatedWidth: bounds.w * scale, rotatedHeight: bounds.h * scale };
  }
  function build(options) {
    const o = options || {}, layers = (o.layers || []).filter(layer => size(layer));
    const hasMsi = size(o.msiSize), ref = hasMsi ? o.msiSize : o.referenceSize;
    if (!size(ref)) throw new Error('表示する画像のサイズを取得できません。');
    const baseWidth = hasMsi ? ref.h : ref.w, baseHeight = hasMsi ? ref.w : ref.h;
    const cx = baseWidth / 2, cy = baseHeight / 2;
    // Keep the original, pre-expansion MSI frame and pivot. Deriving these from
    // the expanded canvas would silently change scale, placement and ROI picks.
    const B = hasMsi ? [0, -1, 1, 0, 0, ref.w] : identity();
    const rot = o.rotation || {}, rm = rotation(Number(rot.msi) || 0, cx, cy), rh = rotation(Number(rot.he) || 0, cx, cy);
    const baseMsiMatrix = multiply(rm, B), baseLayerMatrices = Object.create(null);
    const points = corners(baseMsiMatrix, ref.w, ref.h);
    let requestedScale = 1;
    for (const layer of layers) {
      let matrix;
      if (layer.kind === 'msi') matrix = baseMsiMatrix;
      else {
        if (layer.kind === 'he' && hasMsi && o.T) matrix = multiply(B, affine(o.T));
        else if (layer.h > layer.w) matrix = [0, -baseHeight / layer.w, baseWidth / layer.h, 0, 0, baseHeight];
        else matrix = [baseWidth / layer.w, 0, 0, baseHeight / layer.h, 0, 0];
        if (layer.kind === 'he') matrix = multiply(rh, matrix);
        if (hasMsi && layer.kind === 'he') requestedScale = Math.max(requestedScale, Math.min(8, Math.ceil(Math.max(layer.w / ref.w, layer.h / ref.h))));
      }
      baseLayerMatrices[layer.key] = matrix;
      points.push(...corners(matrix, layer.kind === 'msi' ? ref.w : layer.w, layer.kind === 'msi' ? ref.h : layer.h));
    }
    for (const p of o.roiPoints || []) if (Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every(Number.isFinite)) points.push(point(baseMsiMatrix, p[0], p[1]));
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    // Do not spread large ROI arrays into Math.min/max (argument count limit).
    const minX = xs.reduce((a, b) => Math.min(a, b), Infinity), maxX = xs.reduce((a, b) => Math.max(a, b), -Infinity);
    const minY = ys.reduce((a, b) => Math.min(a, b), Infinity), maxY = ys.reduce((a, b) => Math.max(a, b), -Infinity);
    const spanX = maxX - minX, spanY = maxY - minY;
    if (![minX, minY, spanX, spanY].every(Number.isFinite) || !(spanX > 0 && spanY > 0)) throw new Error('画像の表示範囲が不正です。');
    const maxEdge = o.maxEdge || 8192, maxPixels = o.maxPixels || 16777216;
    const renderScale = Math.min(requestedScale, (maxEdge - 1) / Math.max(spanX, spanY), Math.sqrt((maxPixels - maxEdge * 2) / (spanX * spanY)));
    if (!(renderScale > 0) || !Number.isFinite(renderScale)) throw new Error('画像の表示範囲が大きすぎます。');
    const D = [renderScale, 0, 0, renderScale, -minX * renderScale, -minY * renderScale];
    const layerMatrices = Object.create(null);
    for (const [key, matrix] of Object.entries(baseLayerMatrices)) layerMatrices[key] = multiply(D, matrix);
    return { width: Math.max(1, Math.ceil(spanX * renderScale - 1e-9)), height: Math.max(1, Math.ceil(spanY * renderScale - 1e-9)),
      renderScale, requestedScale, resolutionLimited: renderScale < requestedScale - 1e-9, bounds: { minX, minY, maxX, maxY },
      baseWidth, baseHeight, baseMsiMatrix, baseLayerMatrices, displayTransform: D,
      msiMatrix: multiply(D, baseMsiMatrix), layerMatrices, msiSize: { ...ref } };
  }
  global.ViewerDisplayGeometry = { build, multiply, inverse, point, rotation, corners, rotatedSize, fit };
})(typeof window !== 'undefined' ? window : globalThis);
