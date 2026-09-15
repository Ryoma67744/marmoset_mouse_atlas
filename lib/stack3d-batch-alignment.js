/* Simultaneous, regularized rigid XY placement proposals from ordinal ROI triples.
 * No measured values, pixel pitch, section order, or stored projects are changed.
 * The objective is an equal-weight mean over ROIs within each accepted triple,
 * plus a fixed lambda=1 prior toward every section's original placement.
 * This reduces short-range placement jitter; it does not establish anatomical truth.
 */
(function (global) {
  'use strict';
  const RAD = Math.PI / 180, LAMBDA = 1, MAX_ITERATIONS = 60;
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  const placementOf = d => ({ offsetXUm: d.offsetXUm, offsetYUm: d.offsetYUm, rotationDeg: d.rotationDeg });
  function cancelled(options) {
    if (!options.isCancelled || !options.isCancelled()) return;
    const error = new Error('一括配置候補の計算を取り消しました。'); error.name = 'AbortError'; throw error;
  }
  async function progress(options, phase, completed, total, iteration) {
    cancelled(options);
    if (options.onProgress) options.onProgress({ phase, completed, total, iteration });
    await pause(); cancelled(options);
  }
  function spread(points) {
    const a = [0, 0];
    for (const point of points) { a[0] += point[0] / points.length; a[1] += point[1] / points.length; }
    let squared = 0;
    for (const p of points) squared += (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
    return { anchor: a, squared: squared / points.length };
  }
  function stableSpread(points) {
    return points.length >= 3 && Number.isFinite(spread(points).squared) && spread(points).squared > 1e-12;
  }
  // SPD solve for a regularized normal equation; never silently use a singular fit.
  function choleskySolve(matrix, rhs) {
    const n = rhs.length, lower = new Float64Array(n * n), y = new Float64Array(n), x = new Float64Array(n);
    for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
      let value = matrix[i * n + j];
      for (let k = 0; k < j; k++) value -= lower[i * n + k] * lower[j * n + k];
      if (i === j) {
        if (!Number.isFinite(value) || value <= 0) throw new Error('位置合わせの連立方程式を安定して解けません。');
        lower[i * n + j] = Math.sqrt(value);
      } else lower[i * n + j] = value / lower[j * n + j];
    }
    for (let i = 0; i < n; i++) {
      let value = rhs[i]; for (let k = 0; k < i; k++) value -= lower[i * n + k] * y[k];
      y[i] = value / lower[i * n + i];
    }
    for (let i = n - 1; i >= 0; i--) {
      let value = y[i]; for (let k = i + 1; k < n; k++) value -= lower[k * n + i] * x[k];
      x[i] = value / lower[i * n + i];
      if (!Number.isFinite(x[i])) throw new Error('有限な位置合わせ候補を計算できません。');
    }
    return x;
  }
  async function solve(input, options = {}) {
    const sections = Array.from(input || []), ids = new Set(), warnings = [], rows = sections.map((d, index) => {
      if (!d || !d.id || ids.has(d.id) || !Object.values(placementOf(d)).every(Number.isFinite)) {
        throw new Error('切片IDまたは保存配置が不正・重複しています。');
      }
      ids.add(d.id);
      return { id: d.id, name: d.name || d.project && d.project.name || d.id, index, status: 'unsupported',
        reason: '前後の連続した3切片に共通する有効なROIが不足しています。', placement: placementOf(d), roiCount: 0,
        rmsBeforeMm: null, rmsAfterMm: null };
    });
    const unavailable = reason => ({ available: false, reason, rows, rmsBeforeMm: null, rmsAfterMm: null,
      tripletCount: 0, roiCount: 0, iterations: 0, converged: false, lambda: LAMBDA, warnings });
    cancelled(options);
    if (sections.length < 3) return unavailable('一括計算には連続する切片が3枚以上必要です。');
    const maps = [], triples = [], accepted = sections.map(() => new Map());
    for (let i = 0; i < sections.length; i++) {
      try { maps.push(global.Stack3DAlignment.centroids(sections[i])); }
      catch (error) { maps.push(null); rows[i].reason = error.message; }
      await progress(options, 'centroids', i + 1, sections.length, 0);
    }
    let rejectedArea = 0, rejectedEdge = 0, rejectedSpread = 0;
    for (let i = 1; i < sections.length - 1; i++) {
      const indices = [i - 1, i, i + 1];
      if (indices.some(index => !maps[index])) continue;
      const matches = [];
      for (const [name, center] of maps[i]) {
        const previous = maps[i - 1].get(name), next = maps[i + 1].get(name);
        if (!previous || !next) continue;
        const values = [previous, center, next], ratio = Math.max(...values.map(v => v.area)) / Math.min(...values.map(v => v.area));
        if (values.some(v => v.edge)) { rejectedEdge++; continue; }
        if (!Number.isFinite(ratio) || ratio > 2) { rejectedArea++; continue; }
        matches.push({ name, points: values.map(v => v.point.slice()) });
      }
      if (matches.length < 3) continue;
      if ([0, 1, 2].some(k => !stableSpread(matches.map(match => match.points[k])))) { rejectedSpread++; continue; }
      triples.push({ indices, matches });
      for (const match of matches) indices.forEach((index, k) => accepted[index].set(match.name, match.points[k]));
    }
    if (rejectedArea) warnings.push(`面積比が2倍を超えるROI対応 ${rejectedArea} 件を除外しました。`);
    if (rejectedEdge) warnings.push(`画像端に接するROI対応 ${rejectedEdge} 件を除外しました。`);
    if (rejectedSpread) warnings.push(`ROI重心の広がりが不足する3切片組 ${rejectedSpread} 組を除外しました。`);
    if (!triples.length) return unavailable('3領域以上の有効な同名ROIを持つ連続3切片組がありません。');
    const poses = [], poseIndex = new Map();
    accepted.forEach((points, sectionIndex) => {
      if (!points.size) return;
      const s = spread(Array.from(points.values())), d = sections[sectionIndex];
      // Radius and centroid refer to accepted ROI locations, not the raster center.
      poseIndex.set(sectionIndex, poses.length);
      poses.push({ sectionIndex, anchor: s.anchor, radiusSquared: s.squared });
      rows[sectionIndex].roiCount = points.size;
      rows[sectionIndex].reason = undefined;
    });
    const size = poses.length * 3, parameters = new Float64Array(size);
    function evaluate(values, normal) {
      const gradient = normal ? new Float64Array(size) : null, hessian = normal ? new Float64Array(size * size) : null;
      let objective = 0, dataSquared = 0;
      const tripleSquared = [];
      for (const triple of triples) {
        let squared = 0;
        for (const match of triple.matches) {
          const error = [0, 0], derivatives = [];
          for (let k = 0; k < 3; k++) {
            const pi = poseIndex.get(triple.indices[k]), base = pi * 3, pose = poses[pi], point = match.points[k];
            const theta = values[base + 2], c = Math.cos(theta), s = Math.sin(theta), coefficient = k === 1 ? 1 : -0.5;
            const x = point[0] - pose.anchor[0], y = point[1] - pose.anchor[1], rx = c * x - s * y, ry = s * x + c * y;
            error[0] += coefficient * (pose.anchor[0] + values[base] + rx);
            error[1] += coefficient * (pose.anchor[1] + values[base + 1] + ry);
            if (normal) derivatives.push([base, coefficient, 0], [base + 1, 0, coefficient], [base + 2, -coefficient * ry, coefficient * rx]);
          }
          squared += error[0] ** 2 + error[1] ** 2;
          if (normal) {
            const weight = 1 / triple.matches.length;
            for (const [a, ax, ay] of derivatives) {
              gradient[a] += weight * (ax * error[0] + ay * error[1]);
              for (const [b, bx, by] of derivatives) hessian[a * size + b] += weight * (ax * bx + ay * by);
            }
          }
        }
        squared /= triple.matches.length; tripleSquared.push(squared); dataSquared += squared;
      }
      objective = dataSquared;
      for (let i = 0; i < size; i++) {
        const weight = LAMBDA * (i % 3 === 2 ? poses[Math.floor(i / 3)].radiusSquared : 1);
        objective += weight * values[i] * values[i];
        if (normal) { gradient[i] += weight * values[i]; hessian[i * size + i] += weight; }
      }
      if (!Number.isFinite(objective)) throw new Error('有限な位置合わせ候補を計算できません。');
      return { objective, dataSquared, tripleSquared, gradient, hessian };
    }
    const baseline = evaluate(parameters, false);
    let current = baseline, iterations = 0, converged = false;
    try {
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        await progress(options, 'fit', iteration, MAX_ITERATIONS, iteration);
        const normal = evaluate(parameters, true), step = choleskySolve(normal.hessian, Float64Array.from(normal.gradient, v => -v));
        let largest = 0;
        for (let i = 0; i < size; i++) largest = Math.max(largest, Math.abs(step[i]) * (i % 3 === 2 ? Math.sqrt(poses[Math.floor(i / 3)].radiusSquared) : 1));
        if (largest < 1e-7) { converged = true; current = normal; break; }
        let alpha = 1, next = null, trial = null;
        for (let line = 0; line < 20; line++, alpha *= 0.5) {
          trial = Float64Array.from(parameters, (v, i) => v + alpha * step[i]); next = evaluate(trial, false);
          if (next.objective < normal.objective) break;
          next = null;
        }
        if (!next) {
          // A small predicted step at machine precision is stationary, but a
          // genuinely failed line search must not become an adoptable result.
          if (largest < 1e-5) { converged = true; current = normal; }
          break;
        }
        parameters.set(trial); current = next; iterations = iteration + 1;
        if (largest * alpha < 1e-7) { converged = true; break; }
      }
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      return { ...unavailable(error.message), tripletCount: triples.length, iterations };
    }
    cancelled(options);
    if (!converged || current.objective > baseline.objective + 1e-10 || current.dataSquared > baseline.dataSquared + 1e-10) {
      return { ...unavailable('一括配置候補が安定して収束しませんでした。元の配置を保持します。'), tripletCount: triples.length, iterations };
    }
    for (let pi = 0; pi < poses.length; pi++) {
      const pose = poses[pi], d = sections[pose.sectionIndex], row = rows[pose.sectionIndex], base = pi * 3;
      const theta = parameters[base + 2], c = Math.cos(theta), s = Math.sin(theta);
      const x = d.offsetXUm / 1000 - pose.anchor[0], y = -d.offsetYUm / 1000 - pose.anchor[1];
      const placement = { offsetXUm: (pose.anchor[0] + parameters[base] + c * x - s * y) * 1000,
        offsetYUm: -(pose.anchor[1] + parameters[base + 1] + s * x + c * y) * 1000,
        rotationDeg: d.rotationDeg - theta / RAD };
      if (!Object.values(placement).every(Number.isFinite)) return unavailable('有限な保存配置を計算できません。');
      const changed = Math.hypot(placement.offsetXUm - d.offsetXUm, placement.offsetYUm - d.offsetYUm) > 1e-6 ||
        Math.abs(placement.rotationDeg - d.rotationDeg) > 1e-8;
      row.status = changed ? 'adjusted' : 'unchanged'; row.placement = changed ? placement : placementOf(d);
      const incident = triples.map((triple, i) => triple.indices.includes(pose.sectionIndex) ? i : -1).filter(i => i >= 0);
      row.rmsBeforeMm = Math.sqrt(incident.reduce((sum, i) => sum + baseline.tripleSquared[i], 0) / incident.length);
      row.rmsAfterMm = Math.sqrt(incident.reduce((sum, i) => sum + current.tripleSquared[i], 0) / incident.length);
    }
    await progress(options, 'complete', sections.length, sections.length, iterations);
    return { available: true, rows, rmsBeforeMm: Math.sqrt(baseline.dataSquared / triples.length),
      rmsAfterMm: Math.sqrt(current.dataSquared / triples.length), tripletCount: triples.length,
      roiCount: triples.reduce((sum, triple) => sum + triple.matches.length, 0), iterations, converged, lambda: LAMBDA, warnings };
  }
  global.Stack3DBatchAlignment = Object.freeze({ solve });
})(window);
