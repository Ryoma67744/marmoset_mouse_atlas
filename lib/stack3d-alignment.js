/* Read-only, ordinal-neighbor ROI alignment candidates. No MSI values are used. */
(function (global) {
  'use strict';
  const RAD = Math.PI / 180;
  const validPoint = point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite);
  const nameOf = name => String(name == null ? '' : name).normalize('NFC').trim();
  function geometry(section) {
    if (!section || !section.project || !Number.isSafeInteger(section.W) || !Number.isSafeInteger(section.H) ||
        section.W < 1 || section.H < 1 || section.W * section.H > 16777216 ||
        !Number.isFinite(section.umPerPxX) || section.umPerPxX <= 0 ||
        !Number.isFinite(section.umPerPxY) || section.umPerPxY <= 0 ||
        !['angleDeg', 'rotationDeg', 'offsetXUm', 'offsetYUm'].every(key => Number.isFinite(section[key]))) {
      throw new Error('切片の寸法・画素サイズ・配置が不正です。');
    }
    return section;
  }
  function centroids(section) {
    const d = geometry(section), groups = new Map(), result = new Map();
    // Union every visible ring with exactly the same saved name, including
    // names shared by multiple ROI keys. Overlapping pixels count only once.
    for (const polygon of global.Stack3D.roiPolygons(d)) {
      const name = nameOf(polygon.name);
      if (!polygon.visible || !name) continue;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(polygon.vertices);
    }
    const angle = -(d.angleDeg + d.rotationDeg) * RAD, c = Math.cos(angle), s = Math.sin(angle);
    for (const [name, rings] of groups) {
      const mask = new Uint8Array(d.W * d.H);
      for (const ring of rings) global.MSIRaster.markRoiMask(mask, d.W, d.H, ring);
      let count = 0, sx = 0, sy = 0, edge = false;
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const x = i % d.W, y = Math.floor(i / d.W);
        // Membership follows the existing integer-coordinate ROI mask. The
        // displayed raster sample itself occupies a pixel with center +0.5.
        count++; sx += x + 0.5; sy += y + 0.5;
        if (x === 0 || y === 0 || x === d.W - 1 || y === d.H - 1) edge = true;
      }
      if (!count) continue;
      const x = (sx / count - d.W / 2) * d.umPerPxX / 1000;
      const y = -(sy / count - d.H / 2) * d.umPerPxY / 1000;
      const point = [c * x - s * y + d.offsetXUm / 1000, s * x + c * y - d.offsetYUm / 1000];
      const area = count * (d.umPerPxX / 1000) * (d.umPerPxY / 1000);
      if (!validPoint(point) || !Number.isFinite(area) || area <= 0) throw new Error('ROIの実寸座標を計算できません。');
      result.set(name, { point, area, edge });
    }
    return result;
  }
  function describe(previous, current, next) {
    const rows = [], warnings = [];
    if (!previous || !current || !next) return { available: false, reason: '前後両方の切片が必要です。端の切片は計算しません。', rows, warnings };
    try {
      const before = centroids(previous), center = centroids(current), after = centroids(next);
      for (const [name, q] of center) {
        const p = before.get(name), r = after.get(name);
        if (!p || !r) continue;
        const areaRatio = Math.max(p.area, q.area, r.area) / Math.min(p.area, q.area, r.area);
        if (!Number.isFinite(areaRatio)) throw new Error('ROI面積の比を有限な値として計算できません。');
        const edge = p.edge || q.edge || r.edge;
        rows.push({ name, previous: p.point, current: q.point, next: r.point,
          target: [p.point[0] / 2 + r.point[0] / 2, p.point[1] / 2 + r.point[1] / 2],
          areaRatio, edge, defaultSelected: areaRatio <= 2 && !edge });
      }
      rows.sort((a, b) => a.name.localeCompare(b.name));
      if (rows.some(row => row.areaRatio > 2)) warnings.push('面積比が2倍を超えるROIは、初期選択から除外しています。');
      if (rows.some(row => row.edge)) warnings.push('画像端に接するROIは、初期選択から除外しています。');
      if (rows.length < 3) return { available: false, reason: '前後と共通する有効なROIが3領域未満です。', rows, warnings };
      return { available: true, rows, warnings };
    } catch (error) {
      return { available: false, reason: error.message, rows: [], warnings };
    }
  }
  function fit(current, rows, includedNames) {
    const d = geometry(current), included = new Set(Array.from(includedNames || [], nameOf)), used = [], seen = new Set();
    for (const row of rows || []) {
      const name = nameOf(row.name);
      if (!included.has(name)) continue;
      if (!name || seen.has(name)) throw new Error('ROI名が重複しています。領域ごとに1点で計算してください。');
      if (!validPoint(row.current) || !validPoint(row.target)) throw new Error('ROI重心の座標が不正です。');
      seen.add(name); used.push(row);
    }
    if (used.length < 3) throw new Error('計算には異なるROIを3領域以上選択してください。');
    const source = [0, 0], target = [0, 0], n = used.length;
    for (const row of used) for (let axis = 0; axis < 2; axis++) {
      source[axis] += row.current[axis] / n; target[axis] += row.target[axis] / n;
    }
    let dot = 0, cross = 0, sourceSpread = 0, targetSpread = 0;
    for (const row of used) {
      const x = row.current[0] - source[0], y = row.current[1] - source[1];
      const u = row.target[0] - target[0], v = row.target[1] - target[1];
      dot += x * u + y * v; cross += x * v - y * u;
      sourceSpread += x * x + y * y; targetSpread += u * u + v * v;
    }
    // Proper 2D rigid least squares: equal weight per ROI, no scaling or
    // reflection. A collapsed distribution or vanishing rotational covariance
    // cannot determine a stable rotation and must not produce a candidate.
    const leverage = Math.hypot(dot, cross), spreadProduct = Math.sqrt(sourceSpread) * Math.sqrt(targetSpread);
    if (![sourceSpread, targetSpread, leverage, spreadProduct].every(Number.isFinite) ||
        sourceSpread <= 1e-12 || targetSpread <= 1e-12 || leverage <= Math.max(1e-12, spreadProduct * 1e-10)) {
      throw new Error('ROI重心の広がりや対応が不足しているため、回転を安定して計算できません。');
    }
    const theta = Math.atan2(cross, dot), c = Math.cos(theta), s = Math.sin(theta);
    const tx = target[0] - c * source[0] + s * source[1], ty = target[1] - s * source[0] - c * source[1];
    const oldX = d.offsetXUm / 1000, oldY = -d.offsetYUm / 1000;
    const newX = c * oldX - s * oldY + tx, newY = s * oldX + c * oldY + ty;
    const angleDeltaDeg = -theta / RAD;
    const placement = { offsetXUm: newX * 1000, offsetYUm: -newY * 1000, rotationDeg: d.rotationDeg + angleDeltaDeg };
    let beforeSquared = 0, afterSquared = 0;
    const fittedRows = used.map(row => {
      const fitted = [c * row.current[0] - s * row.current[1] + tx, s * row.current[0] + c * row.current[1] + ty];
      const errorBeforeMm = Math.hypot(row.current[0] - row.target[0], row.current[1] - row.target[1]);
      const errorAfterMm = Math.hypot(fitted[0] - row.target[0], fitted[1] - row.target[1]);
      beforeSquared += errorBeforeMm * errorBeforeMm; afterSquared += errorAfterMm * errorAfterMm;
      return { ...row, previous: row.previous && row.previous.slice(), current: row.current.slice(), next: row.next && row.next.slice(),
        target: row.target.slice(), fitted, errorBeforeMm, errorAfterMm };
    });
    const result = { placement, rmsBeforeMm: Math.sqrt(beforeSquared / n), rmsAfterMm: Math.sqrt(afterSquared / n),
      angleDeltaDeg, translationMm: [newX - oldX, newY - oldY], roiCount: n, rows: fittedRows };
    if (![...Object.values(placement), result.rmsBeforeMm, result.rmsAfterMm, angleDeltaDeg, ...result.translationMm].every(Number.isFinite)) {
      throw new Error('有限な位置合わせ候補を計算できません。');
    }
    return result;
  }
  global.Stack3DAlignment = Object.freeze({ describe, fit, centroids });
})(window);
