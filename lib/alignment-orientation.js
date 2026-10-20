/*
 * Orientation-first registration.
 * Coordinates are pixel edges: pixel (i,j) has centre (i+.5,j+.5).
 * C_he maps raw HE to the direction explicitly chosen by the user; C_msi
 * maps raw MSI to the same working units. Registration estimates only F:
 *     T_raw = inverse(C_msi) * F * C_he.
 * Neither a previous T nor a silhouette's principal axis defines direction.
 */
(function (global) {
  'use strict';
  const A = global.Align;
  if (!A) throw new Error('alignment-orientation.js requires Align');
  const identity = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const copy = value => JSON.parse(JSON.stringify(value));
  const determinant = T => T[0][0] * T[1][1] - T[0][1] * T[1][0];
  const apply = A.applyAffinePoint;
  const invert = A.invertAffine;
  const MAX_RESIDUAL_CONDITION = 100;

  function multiply(left, right) {
    return left.map(row => right[0].map((_, j) =>
      row.reduce((sum, v, k) => sum + v * right[k][j], 0)));
  }

  function pitch(value) {
    return value && Number.isFinite(value.x) && value.x > 0 &&
      Number.isFinite(value.y) && value.y > 0 ? { x: value.x, y: value.y } : null;
  }

  function dimension(value) {
    if (!Number.isInteger(value) || value <= 0) throw new Error('画像の幅と高さが不正です');
    return value;
  }

  function baseFrame(w, h, sourcePitch, physical, unitPitch) {
    const sx = physical ? sourcePitch.x / unitPitch : 1;
    const sy = physical ? sourcePitch.y / unitPitch : 1;
    const matrix = [[sx, 0, 0], [0, sy, 0], [0, 0, 1]];
    return { matrix, baseMatrix: copy(matrix), width: w * sx, height: h * sy,
      rawWidth: w, rawHeight: h, pitch: sourcePitch, physical, unitPitch };
  }

  function createFrame(options) {
    const o = options || {};
    const hp = pitch(o.hePitch), mp = pitch(o.msiPitch);
    const physical = !!(hp && mp);
    const unitPitch = physical ? mp.x : null;
    return {
      he: baseFrame(dimension(o.heWidth), dimension(o.heHeight), hp, physical, unitPitch),
      msi: baseFrame(dimension(o.msiWidth), dimension(o.msiHeight), mp, physical, unitPitch),
      physical, unitPitch,
    };
  }

  function corners(frame, matrix) {
    return [[0, 0], [frame.rawWidth, 0], [frame.rawWidth, frame.rawHeight], [0, frame.rawHeight]]
      .map(p => apply(matrix, p[0], p[1]));
  }

  function validateFrame(frame) {
    if (!frame || !A.validateAffine(frame.matrix) || !A.validateAffine(frame.baseMatrix) ||
        !Number.isInteger(frame.rawWidth) || frame.rawWidth <= 0 ||
        !Number.isInteger(frame.rawHeight) || frame.rawHeight <= 0 ||
        !Number.isFinite(frame.width) || frame.width <= 0 ||
        !Number.isFinite(frame.height) || frame.height <= 0) {
      throw new Error('向きの座標情報が不正です');
    }
    const base = frame.baseMatrix;
    if (!(base[0][0] > 0) || !(base[1][1] > 0) || base[0][1] !== 0 || base[1][0] !== 0 ||
        base[0][2] !== 0 || base[1][2] !== 0) throw new Error('基準画素サイズが不正です');
    if (frame.physical === true) {
      if (!pitch(frame.pitch) || !Number.isFinite(frame.unitPitch) || frame.unitPitch <= 0 ||
          base[0][0] !== frame.pitch.x / frame.unitPitch ||
          base[1][1] !== frame.pitch.y / frame.unitPitch) throw new Error('物理画素サイズと向きの座標単位が一致しません');
    } else if (frame.physical !== false || frame.unitPitch !== null ||
        base[0][0] !== 1 || base[1][1] !== 1) {
      throw new Error('未知の画素サイズから座標倍率を推測することはできません');
    }
    const O = multiply(frame.matrix, invert(base));
    const x = Math.hypot(O[0][0], O[1][0]), y = Math.hypot(O[0][1], O[1][1]);
    const dot = O[0][0] * O[0][1] + O[1][0] * O[1][1];
    if (Math.abs(x - 1) > 1e-8 || Math.abs(y - 1) > 1e-8 || Math.abs(dot) > 1e-8) {
      throw new Error('向きの情報に倍率または変形が混在しています');
    }
    const pts = corners(frame, frame.matrix), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const eps = 1e-8 * Math.max(1, frame.width, frame.height);
    if (Math.abs(Math.min(...xs)) > eps || Math.abs(Math.min(...ys)) > eps ||
        Math.abs(Math.max(...xs) - frame.width) > eps ||
        Math.abs(Math.max(...ys) - frame.height) > eps) {
      throw new Error('画像の向きと表示範囲が一致しません');
    }
    return frame;
  }

  function validatePair(options) {
    const he = validateFrame(options && options.he), msi = validateFrame(options && options.msi);
    if (he.physical !== msi.physical || he.unitPitch !== msi.unitPitch) {
      throw new Error('HE と MSI の座標単位が一致しません');
    }
    if (msi.matrix.some((row, i) => row.some((value, j) => value !== msi.baseMatrix[i][j]))) {
      throw new Error('MSI の基準方向は固定です。HE 側で向きを揃えてください');
    }
    return { he, msi };
  }

  function orient(frame, operation) {
    validateFrame(frame);
    const type = typeof operation === 'string' ? operation : operation && operation.type;
    let linear;
    if (type === 'mirror-x') linear = [[-1, 0, 0], [0, 1, 0], [0, 0, 1]];
    else if (type === 'mirror-y') linear = [[1, 0, 0], [0, -1, 0], [0, 0, 1]];
    else {
      const degrees = type === 'rotate-left' ? -90 : type === 'rotate-right' ? 90 :
        type === 'rotate' ? operation.degrees : NaN;
      if (!Number.isFinite(degrees)) throw new Error('向きの操作または回転角度が不正です');
      const radians = degrees * Math.PI / 180;
      // Exact quarter turns prevent a one-pixel bounding-box expansion.
      const clean = v => Math.abs(v) < 1e-14 ? 0 : Math.abs(v - 1) < 1e-14 ? 1 :
        Math.abs(v + 1) < 1e-14 ? -1 : v;
      const cos = clean(Math.cos(radians)), sin = clean(Math.sin(radians));
      linear = [[cos, -sin, 0], [sin, cos, 0], [0, 0, 1]];
    }
    const centre = [frame.width / 2, frame.height / 2];
    const mapped = apply(linear, centre[0], centre[1]);
    linear[0][2] = centre[0] - mapped[0]; linear[1][2] = centre[1] - mapped[1];
    const next = copy(frame), transformed = multiply(linear, frame.matrix);
    const pts = corners(frame, transformed), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    transformed[0][2] -= x0; transformed[1][2] -= y0;
    next.matrix = transformed;
    next.width = Math.max(...xs) - x0; next.height = Math.max(...ys) - y0;
    return validateFrame(next);
  }

  function fromRaw(frame, point) { return apply(frame.matrix, point[0], point[1]); }
  function toRaw(frame, point) { return apply(invert(frame.matrix), point[0], point[1]); }
  function toCanonical(F, options) {
    return multiply(multiply(invert(options.msi.matrix), F), options.he.matrix);
  }
  function toWorking(T, options) {
    return multiply(multiply(options.msi.matrix, T), invert(options.he.matrix));
  }

  function rotationLimit(options) {
    const value = options.maxRotationDeg == null ? 15 : options.maxRotationDeg;
    if (!Number.isFinite(value) || value < 0 || value > 15) {
      throw new Error('自動の角度補正は 0〜15°の範囲で指定してください');
    }
    return value;
  }

  // Rotation of the proper polar factor, not the first affine column (QR).
  function polarRotation(F) {
    return Math.atan2(F[1][0] - F[0][1], F[0][0] + F[1][1]) * 180 / Math.PI;
  }

  function conditionNumber(F) {
    const norm = Math.max(Math.abs(F[0][0]), Math.abs(F[0][1]), Math.abs(F[1][0]), Math.abs(F[1][1]));
    const a = F[0][0] / norm, b = F[0][1] / norm, c = F[1][0] / norm, d = F[1][1] / norm;
    const xx = a * a + c * c, yy = b * b + d * d, xy = a * b + c * d;
    // sigmaMin = |det| / sigmaMax avoids cancelling near-equal eigenvalues.
    const sigmaMaxSquared = (xx + yy + Math.hypot(xx - yy, 2 * xy)) / 2;
    return sigmaMaxSquared / Math.abs(a * d - b * c);
  }

  function check(T, options) {
    try {
      validatePair(options);
      if (!A.validateAffine(T)) throw new Error('有効な変換行列ではありません');
      const F = toWorking(T, options);
      if (!A.validateAffine(F)) throw new Error('向きを揃えた座標で変換行列が退化しています');
      if (!(determinant(F) > 0)) throw new Error('自動の反転は行いません。向きまたは対応点を確認してください');
      const condition = conditionNumber(F);
      if (!(condition <= MAX_RESIDUAL_CONDITION + 1e-8)) {
        return { valid: false, reason: '縦横の倍率差またはせん断が大きすぎます。向きと対応点を確認してください',
          F, rotationDeg: polarRotation(F), condition };
      }
      const rotationDeg = polarRotation(F), limit = rotationLimit(options);
      if (Math.abs(rotationDeg) > limit + 1e-7) {
        return { valid: false, reason: '角度補正が ' + limit +
          '°を超えます。第1段階の向きまたは対応点を確認してください', F, rotationDeg };
      }
      return { valid: true, reason: '', F, rotationDeg, condition };
    } catch (error) {
      return { valid: false, reason: error.message, F: null, rotationDeg: null };
    }
  }

  function pointSet(landmarks, minCount, options) {
    if (!landmarks || !Array.isArray(landmarks.he) || !Array.isArray(landmarks.msi) ||
        landmarks.he.length !== landmarks.msi.length) throw new Error('HE と MSI の対応点数を揃えてください');
    const excluded = landmarks.excluded || [];
    if (!Array.isArray(excluded) || excluded.some(i => !Number.isInteger(i) || i < 0 || i >= landmarks.he.length)) {
      throw new Error('除外する対応点の番号が不正です');
    }
    const use = new Set(excluded), indices = landmarks.he.map((_, i) => i).filter(i => !use.has(i));
    if (indices.length < minCount) throw new Error('使用する対応点が ' + minCount + ' 組以上必要です');
    for (const key of ['he', 'msi']) {
      if (landmarks[key].some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) {
        throw new Error('対応点に無効な座標があります');
      }
    }
    const transformed = {};
    for (const key of ['he', 'msi']) transformed[key] = indices.map(i => fromRaw(options[key], landmarks[key][i]));
    return transformed;
  }

  function solve(landmarks, options) {
    validatePair(options);
    const model = options.model || 'similarity';
    if (model !== 'similarity' && model !== 'affine') throw new Error('変換モデルが不正です');
    const working = pointSet(landmarks, model === 'affine' ? 4 : 3, options);
    // Also validates spread/duplicates for similarity. A negative unconstrained
    // determinant reveals a reflected point ordering; never fit it by shrinking.
    const affine = A.solveAffineFromLandmarks(working);
    if (!(determinant(affine.T) > 0)) {
      throw new Error('対応点の並びが反転しています。第1段階の向きまたは点の番号を確認してください');
    }
    let F = affine.T;
    if (model === 'similarity') {
      F = A.buildHeToMsiAffine(Object.assign({ model }, A.solveAlignFromLandmarks(working, false, false)));
    }
    const T = toCanonical(F, options), validation = check(T, options);
    if (!validation.valid) throw new Error(validation.reason);
    return { T, F, model, state: A.decomposeAffine(T), rotationDeg: validation.rotationDeg,
      n: working.he.length, residuals: A.computeLandmarkResiduals(landmarks, T, options.msi.pitch) };
  }

  function maskStatistics(mask, frame) {
    if (!mask || !Number.isInteger(mask.w) || !Number.isInteger(mask.h) || mask.w < 1 || mask.h < 1 ||
        !mask.mask || mask.mask.length !== mask.w * mask.h ||
        !Number.isFinite(mask.sx) || mask.sx <= 0 || !Number.isFinite(mask.sy) || mask.sy <= 0) {
      throw new Error('組織マスクの座標情報が不正です');
    }
    const epsilon = 1e-6 * Math.max(frame.rawWidth, frame.rawHeight);
    if (Math.abs(mask.w * mask.sx - frame.rawWidth) > epsilon ||
        Math.abs(mask.h * mask.sy - frame.rawHeight) > epsilon) {
      throw new Error('組織マスクと元画像の大きさが一致しません');
    }
    let count = 0, x = 0, y = 0;
    for (let j = 0; j < mask.h; j++) for (let i = 0; i < mask.w; i++) {
      if (!mask.mask[j * mask.w + i]) continue;
      count++; x += (i + 0.5) * mask.sx; y += (j + 0.5) * mask.sy;
    }
    if (count < 3 || count > mask.mask.length * 0.995) throw new Error('組織の輪郭を抽出できません');
    return { centre: fromRaw(frame, [x / count, y / count]),
      area: count * mask.sx * mask.sy * Math.abs(determinant(frame.matrix)) };
  }

  function silhouette(heMask, msiMask, options) {
    validatePair(options);
    const h = maskStatistics(heMask, options.he), m = maskStatistics(msiMask, options.msi);
    const limit = options.allowRotation === true ? rotationLimit(options) : 0;
    const requestedBudget = options.maxEvaluations == null ? 400 : options.maxEvaluations;
    if (!Number.isInteger(requestedBudget) || requestedBudget < 2 || requestedBudget > 2000) {
      throw new Error('輪郭評価の上限は 2〜2000 回の整数にしてください');
    }
    const scaleLocked = options.he.physical === true && options.msi.physical === true;
    const scale = scaleLocked ? 1 : Math.sqrt(m.area / h.area);
    let evals = 0;
    const evaluate = (angle, s, x, y) => {
      if (evals >= requestedBudget || !Number.isFinite(s) || !(s > 0) || Math.abs(angle) > limit + 1e-9) return null;
      const theta = angle * Math.PI / 180, cos = Math.cos(theta), sin = Math.sin(theta);
      const F = [[s * cos, -s * sin, x - s * (cos * h.centre[0] - sin * h.centre[1])],
        [s * sin, s * cos, y - s * (sin * h.centre[0] + cos * h.centre[1])], [0, 0, 1]];
      const T = toCanonical(F, options);
      evals++;
      return { angle, scale: s, x, y, F, T, dice: A.maskDiceUnderAffine(heMask, msiMask, T) };
    };
    let initialDice = null;
    // The existing result is a comparison only. It cannot rotate the search
    // origin, unlock its scale, or introduce a reflected initial candidate.
    if (options.initialT && A.validateAffine(options.initialT)) {
      initialDice = A.maskDiceUnderAffine(heMask, msiMask, options.initialT); evals++;
    }
    let best = evaluate(0, scale, m.centre[0], m.centre[1]);
    if (!best) throw new Error('輪郭の初期位置を計算できません');
    const initialCandidateDice = best.dice;
    // Bound every candidate around the user's frame, including repeated calls.
    for (const step of [[4, 0.04, 4], [1, 0.01, 1], [0.25, 0.0025, 0.25]]) {
      let changed = true;
      while (changed && evals < requestedBudget) {
        changed = false;
        for (let axis = 0; axis < 4 && evals < requestedBudget; axis++) {
          if ((axis === 0 && limit === 0) || (axis === 1 && scaleLocked)) continue;
          for (const sign of [1, -1]) {
            const candidate = evaluate(best.angle + (axis === 0 ? sign * step[0] : 0),
              best.scale * (axis === 1 ? 1 + sign * step[1] : 1),
              best.x + (axis === 2 ? sign * step[2] : 0), best.y + (axis === 3 ? sign * step[2] : 0));
            if (candidate && candidate.dice > best.dice + 1e-6) { best = candidate; changed = true; }
          }
        }
      }
    }
    return { T: best.T, F: best.F, state: A.decomposeAffine(best.T), dice: best.dice,
      initialDice, initialCandidateDice, improved: initialDice == null || best.dice > initialDice + 1e-6,
      rotationDeg: best.angle, evals, budgetExhausted: evals >= requestedBudget,
      scaleLocked, heArea: h.area, msiArea: m.area };
  }

  function serialize(frames) {
    validatePair(frames);
    return copy({ he: frames.he, msi: frames.msi, physical: !!frames.he.physical,
      unitPitch: frames.he.unitPitch });
  }

  function restore(saved, expected) {
    const frames = serialize(saved);
    if (expected) {
      validatePair(expected);
      for (const key of ['he', 'msi']) {
        for (const field of ['rawWidth', 'rawHeight', 'physical', 'unitPitch']) {
          if (frames[key][field] !== expected[key][field]) throw new Error('保存した向きと現在の画像情報が一致しません');
        }
        if (JSON.stringify(frames[key].baseMatrix) !== JSON.stringify(expected[key].baseMatrix) ||
            JSON.stringify(frames[key].pitch) !== JSON.stringify(expected[key].pitch)) {
          throw new Error('保存した向きと現在の画素サイズが一致しません');
        }
      }
    }
    return frames;
  }

  global.AlignmentOrientation = {
    createFrame, orient, solve, silhouette, check, serialize, restore,
    multiply, invert, apply, fromRaw, toRaw, toCanonical, toWorking, polarRotation, validateFrame,
    conditionNumber, MAX_RESIDUAL_CONDITION,
  };
})(window);
