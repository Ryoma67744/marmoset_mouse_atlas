/*
 * align.js — HE ↔ MSI の位置合わせ (重ね合わせ) の数学
 *
 * Share_Test の viewer/index.html:1446-2176 の移植。純関数群 (heTissueMask だけは
 * 画素読み出しに canvas が要る) なので、そのまま単体でテストできる。
 *
 * ★ 座標系の約束: T_he_to_msi は「生 HE ピクセル → 生 MSI ラスタピクセル」の 3×3。
 *   表示上の回転 (viewer の -90°) は一切絡まない。
 * ★ マスクは { mask:Uint8Array(w*h, 0|1), w, h, sx, sy } で表す。
 *   sx/sy は「マスク 1 画素あたりの生ピクセル数」。
 */
(function (global) {
  'use strict';

  const HE_MASK_MAX_EDGE = 512;   // HE 組織マスクの作業解像度
  const HE_MASK_SAT_MIN = 0.10;   // H&E 組織はピンク/紫で彩度が高い…
  const HE_MASK_VAL_MAX = 0.995;  // …一方スライド背景はほぼ白
  const ALIGN_DICE_MAX_EDGE = 384; // Dice 評価時に MSI グリッドを間引く上限
  const ALIGN_ANISO_MIN = 0.03;   // これ以下のシルエットは回転情報を持たない

  // 実測に基づく誤差バジェット (Share_Test 1557-1567)
  const AUTO_ALIGN_SIGMA_PX = 0.9;        // スケールをシルエット面積から推定した場合
  const AUTO_ALIGN_SIGMA_LOCKED_PX = 0.7; // スケールを既知の µm/px 比に固定した場合

  // =====================================================================
  // アフィン変換
  // =====================================================================

  function applyAffinePoint(T, x, y) {
    return [T[0][0] * x + T[0][1] * y + T[0][2], T[1][0] * x + T[1][1] * y + T[1][2]];
  }

  /** A finite, invertible affine matrix in raw HE → raw MSI pixel coordinates. */
  function validateAffine(T) {
    if (!Array.isArray(T) || T.length !== 3 || T.some(row =>
      !Array.isArray(row) || row.length !== 3 || row.some(v => !Number.isFinite(v)))) return false;
    if (T[2][0] !== 0 || T[2][1] !== 0 || T[2][2] !== 1) return false;
    const a = T[0][0], b = T[0][1], c = T[1][0], d = T[1][1];
    const norm = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
    if (!(norm > 0)) return false;
    // Relative determinant also permits valid HE/MSI pixel scale ratios below 1e-6.
    return Math.abs((a / norm) * (d / norm) - (b / norm) * (c / norm)) > 1e-12;
  }

  function invertAffine(T) {
    if (!validateAffine(T)) return null;
    const a = T[0][0], b = T[0][1], tx = T[0][2];
    const c = T[1][0], d = T[1][1], ty = T[1][2];
    const det = a * d - b * c;
    if (!Number.isFinite(det) || det === 0) return null;
    const inv = 1 / det;
    return [
      [d * inv, -b * inv, (b * ty - d * tx) * inv],
      [-c * inv, a * inv, (c * tx - a * ty) * inv],
      [0, 0, 1],
    ];
  }

  /**
   * Compose only after an intentional parameter edit. The saved full matrix is
   * canonical and must not be decomposed/rebuilt merely to open or save a dialog.
   * Affine: T = Translate · Rotate · [[sx, shear*sy], [0, sy]].
   * Similarity keeps the legacy uniform scale and reflection parameters.
   */
  function buildHeToMsiAffine(st) {
    const affine = st.model === 'affine';
    const xPct = affine ? st.scale_x_pct : st.scale_pct;
    const yPct = affine ? st.scale_y_pct : st.scale_pct;
    const shear = affine ? st.shear : 0;
    if (![xPct, yPct, shear, st.rotate_deg, st.offx, st.offy].every(Number.isFinite) ||
      !(xPct > 0) || !(yPct > 0)) throw new Error('変換パラメータは有限の数値、スケールは 0 より大きい値にしてください');
    const sx = (st.flip_lr ? -1 : 1) * (xPct / 100);
    const sy = (st.flip_ud ? -1 : 1) * (yPct / 100);
    const th = st.rotate_deg * Math.PI / 180;
    const cos = Math.cos(th), sin = Math.sin(th);
    const T = [
      [cos * sx, (cos * shear - sin) * sy, st.offx],
      [sin * sx, (sin * shear + cos) * sy, st.offy],
      [0, 0, 1],
    ];
    if (!validateAffine(T)) throw new Error('変換行列が退化しています。スケールまたはせん断を確認してください');
    return T;
  }

  /** QR parameter decomposition, preserving nonuniform scale and shear. */
  function decomposeAffine(T) {
    if (!validateAffine(T)) throw new Error('有効なアフィン変換行列ではありません');
    const a = T[0][0], b = T[0][1], c = T[1][0], d = T[1][1];
    const det = a * d - b * c;
    const s = Math.hypot(a, c);
    const flip_lr = det < 0;
    const sx = (flip_lr ? -1 : 1) * s;
    const cos = a / sx, sin = c / sx;
    const sy = -sin * b + cos * d;
    const shear = (cos * b + sin * d) / sy;
    const similar = Math.abs(s - sy) <= 1e-10 * Math.max(s, sy) && Math.abs(shear) <= 1e-10;
    return {
      model: similar ? 'similarity' : 'affine',
      flip_lr: flip_lr, flip_ud: false,
      scale_pct: s * 100, scale_x_pct: s * 100, scale_y_pct: sy * 100,
      shear: shear, rotate_deg: Math.atan2(sin, cos) * 180 / Math.PI,
      offx: T[0][2], offy: T[1][2],
    };
  }

  function defaultAlignState() {
    return { flip_lr: false, flip_ud: false, scale_pct: 100, rotate_deg: 0, offx: 0, offy: 0 };
  }

  function excludedLandmarkIndices(landmarks) {
    const list = (landmarks && landmarks.excluded) || [];
    if (!Array.isArray(list) || list.some(i => !Number.isInteger(i) || i < 0 ||
      i >= Math.min(landmarks.he.length, landmarks.msi.length))) {
      throw new Error('除外する対応点の番号が不正です');
    }
    return new Set(list);
  }

  function validatePointSet(pts, label) {
    if (!Array.isArray(pts) || pts.some(p => !Array.isArray(p) || p.length !== 2 ||
      !p.every(Number.isFinite))) throw new Error(label + ' の対応点に無効な座標があります');
    for (let i = 0; i < pts.length; i++) for (let j = 0; j < i; j++) {
      if (pts[i][0] === pts[j][0] && pts[i][1] === pts[j][1]) {
        throw new Error(label + ' の対応点が重複しています');
      }
    }
  }

  function includedLandmarks(landmarks, minCount) {
    const he = (landmarks && landmarks.he) || [], msi = (landmarks && landmarks.msi) || [];
    if (!Array.isArray(he) || !Array.isArray(msi) || he.length !== msi.length) {
      throw new Error('HE と MSI の対応点数を揃えてください');
    }
    const excluded = excludedLandmarkIndices({ he, msi, excluded: landmarks && landmarks.excluded });
    const indices = he.map((_, i) => i).filter(i => !excluded.has(i));
    const source = indices.map(i => he[i]), target = indices.map(i => msi[i]);
    validatePointSet(source, 'HE'); validatePointSet(target, 'MSI');
    if (indices.length < minCount) throw new Error('使用する対応点が ' + minCount + ' 組以上必要です');
    return { he: source, msi: target, indices: indices };
  }

  function normalizedPoints(pts, requireNoncollinear) {
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p[0] / pts.length; cy += p[1] / pts.length; }
    let xx = 0, xy = 0, yy = 0;
    for (const p of pts) {
      const x = p[0] - cx, y = p[1] - cy;
      xx += x * x; xy += x * y; yy += y * y;
    }
    const scale = Math.sqrt((xx + yy) / pts.length);
    if (!Number.isFinite(scale) || !(scale > 0)) throw new Error('対応点の広がりが不足しています');
    if (requireNoncollinear) {
      const trace = xx + yy;
      // det / maxEigenvalue² avoids subtracting nearly equal eigenvalues.
      const maxEigen = (trace + Math.hypot(xx - yy, 2 * xy)) / 2;
      const ratio = (xx / maxEigen) * (yy / maxEigen) - (xy / maxEigen) ** 2;
      if (!(ratio > 1e-10)) throw new Error('対応点が直線上またはほぼ直線上です。組織全体に分散して配置してください');
    }
    return { cx, cy, scale, points: pts.map(p => [(p[0] - cx) / scale, (p[1] - cy) / scale]) };
  }

  // =====================================================================
  // 半自動: 対応点 → 相似変換の最小二乗
  // =====================================================================

  /**
   * 真の相似変換 (回転 + 等方スケール + 平行移動、鏡映なし) の複素数閉形式最小二乗。
   * 鏡映は Flip チェックボックスが持つので、呼び出し側で事前に符号を掛けること。
   */
  function solveSimilarity(srcPts, dstPts) {
    if (srcPts.length < 2 || srcPts.length !== dstPts.length) {
      throw new Error('対応点が 2 組以上必要です');
    }
    validatePointSet(srcPts, 'HE'); validatePointSet(dstPts, 'MSI');
    const N = srcPts.length;
    let sxs = 0, sys = 0, sxd = 0, syd = 0;
    for (let i = 0; i < N; i++) {
      sxs += srcPts[i][0]; sys += srcPts[i][1];
      sxd += dstPts[i][0]; syd += dstPts[i][1];
    }
    const meanS = [sxs / N, sys / N];
    const meanD = [sxd / N, syd / N];
    let num_re = 0, num_im = 0, den = 0;
    for (let i = 0; i < N; i++) {
      const xs = srcPts[i][0] - meanS[0], ys = srcPts[i][1] - meanS[1];
      const xd = dstPts[i][0] - meanD[0], yd = dstPts[i][1] - meanD[1];
      num_re += xd * xs + yd * ys;
      num_im += yd * xs - xd * ys;
      den += xs * xs + ys * ys;
    }
    if (den < 1e-12) throw new Error('退化した対応点 (全て同じ位置?) です');
    const a_re = num_re / den, a_im = num_im / den;
    const s = Math.hypot(a_re, a_im);
    if (!Number.isFinite(s) || !(s > 1e-15)) throw new Error('対応点から有効な相似変換を推定できません');
    const theta = Math.atan2(a_im, a_re);
    const tx = meanD[0] - (a_re * meanS[0] - a_im * meanS[1]);
    const ty = meanD[1] - (a_im * meanS[0] + a_re * meanS[1]);
    return { s: s, theta: theta, tx: tx, ty: ty };
  }

  /**
   * ランドマークから 5 パラメータを解く。
   * ★ Flip が ON のときは HE 点に先に符号を掛ける。solveSimilarity は鏡映を含まない
   *   ので、生の (鏡像の) 対応を渡すとスケールが 0 に潰れる。
   */
  function solveAlignFromLandmarks(landmarks, flip_lr, flip_ud) {
    const he = (landmarks && landmarks.he) || [];
    const msi = (landmarks && landmarks.msi) || [];
    if (he.length !== msi.length) throw new Error('HE と MSI の対応点数を揃えてください');
    if (he.length < 2) return null;
    const points = includedLandmarks(landmarks, 2);
    const sgnx = flip_lr ? -1 : 1;
    const sgny = flip_ud ? -1 : 1;
    const heAdj = points.he.map(p => [sgnx * p[0], sgny * p[1]]);
    const r = solveSimilarity(heAdj, points.msi);
    return {
      flip_lr: !!flip_lr,
      flip_ud: !!flip_ud,
      scale_pct: r.s * 100,
      rotate_deg: r.theta * 180 / Math.PI,
      offx: r.tx,
      offy: r.ty,
    };
  }

  /** Both determinant signs are evaluated; the current flip is not a constraint. */
  function solveSimilarityCandidates(landmarks) {
    const points = includedLandmarks(landmarks, 2);
    const candidates = [];
    for (const reflected of [false, true]) {
      try {
        const state = Object.assign({ model: 'similarity' }, solveAlignFromLandmarks(landmarks, reflected, false));
        const T = buildHeToMsiAffine(state);
        candidates.push({ T, state, reflected, n: points.he.length, residuals: computeLandmarkResiduals(landmarks, T) });
      } catch (error) {
        // A reflection candidate may collapse to zero scale for a symmetric set.
        // Validation was done before the loop, so another valid candidate is usable.
        if (!String(error.message).includes('有効な相似変換')) throw error;
      }
    }
    if (!candidates.length) throw new Error('対応点から有効な相似変換を推定できません');
    return candidates.sort((a, b) => a.residuals.rmse_px - b.residuals.rmse_px);
  }

  /** Householder QR, never normal equations (AᵀA), for the two affine outputs. */
  function solveQr(A, B) {
    const n = A.length, p = 3;
    for (let k = 0; k < p; k++) {
      const v = A.slice(k).map(row => row[k]);
      const norm = Math.hypot(...v);
      if (!(norm > 1e-12)) throw new Error('対応点の配置が不安定でアフィン変換を推定できません');
      v[0] += (v[0] >= 0 ? 1 : -1) * norm;
      const vn = Math.hypot(...v);
      for (let i = 0; i < v.length; i++) v[i] /= vn;
      for (const matrix of [A, B]) {
        const start = matrix === A ? k : 0, columns = matrix === A ? p : 2;
        for (let j = start; j < columns; j++) {
          let dot = 0;
          for (let i = k; i < n; i++) dot += v[i - k] * matrix[i][j];
          for (let i = k; i < n; i++) matrix[i][j] -= 2 * v[i - k] * dot;
        }
      }
    }
    const X = Array.from({ length: p }, () => [0, 0]);
    for (let j = 0; j < 2; j++) for (let k = p - 1; k >= 0; k--) {
      let value = B[k][j];
      for (let l = k + 1; l < p; l++) value -= A[k][l] * X[l][j];
      X[k][j] = value / A[k][k];
    }
    return X;
  }

  function solveAffineFromLandmarks(landmarks) {
    const points = includedLandmarks(landmarks, 3);
    const source = normalizedPoints(points.he, true), target = normalizedPoints(points.msi, true);
    const coeff = solveQr(source.points.map(p => [p[0], p[1], 1]), target.points.map(p => p.slice()));
    const ratio = target.scale / source.scale;
    const a = coeff[0][0] * ratio, b = coeff[1][0] * ratio;
    const c = coeff[0][1] * ratio, d = coeff[1][1] * ratio;
    const T = [
      [a, b, target.cx + coeff[2][0] * target.scale - a * source.cx - b * source.cy],
      [c, d, target.cy + coeff[2][1] * target.scale - c * source.cx - d * source.cy],
      [0, 0, 1],
    ];
    if (!validateAffine(T)) throw new Error('推定したアフィン変換が退化しています。対応点を確認してください');
    const state = Object.assign(decomposeAffine(T), { model: 'affine' });
    return { T, state, n: points.he.length, residuals: computeLandmarkResiduals(landmarks, T) };
  }

  /** 現在の T における各対応点の残差。読むだけで state は変えない。 */
  function computeLandmarkResiduals(landmarks, T, umPerPx) {
    const he = (landmarks && landmarks.he) || [];
    const msi = (landmarks && landmarks.msi) || [];
    const n = Math.min(he.length, msi.length);
    if (!n || !validateAffine(T)) return null;
    const excluded = new Set((landmarks && landmarks.excluded) || []);
    const ux = Number(umPerPx && umPerPx.x) || 0;
    const uy = Number(umPerPx && umPerPx.y) || 0;
    const hasUm = ux > 0 && uy > 0;
    const perPoint = [];
    let sum2 = 0, maxPx = 0, sum2um = 0, maxUm = 0, includedCount = 0, maxIndex = null;
    for (let i = 0; i < n; i++) {
      const p = applyAffinePoint(T, he[i][0], he[i][1]);
      const dx = p[0] - msi[i][0];
      const dy = p[1] - msi[i][1];
      const d = Math.hypot(dx, dy);
      // µm は軸ごとのピッチを使う (異方性グリッドでも嘘をつかないため)
      const dUm = hasUm ? Math.hypot(dx * ux, dy * uy) : NaN;
      const included = !excluded.has(i);
      perPoint.push({ i: i, dx: dx, dy: dy, d: d, dUm: dUm, included: included,
        transformed: p, target: msi[i].slice() });
      if (!included) continue;
      includedCount++;
      sum2 += d * d;
      if (maxIndex === null || d > maxPx) { maxPx = d; maxIndex = i; }
      if (hasUm) { sum2um += dUm * dUm; if (dUm > maxUm) maxUm = dUm; }
    }
    return {
      n: includedCount, total: n, perPoint: perPoint, maxIndex: maxIndex,
      rmse_px: includedCount ? Math.sqrt(sum2 / includedCount) : NaN,
      max_px: includedCount ? maxPx : NaN,
      rmse_um: hasUm && includedCount ? Math.sqrt(sum2um / includedCount) : NaN,
      max_um: hasUm && includedCount ? maxUm : NaN,
    };
  }

  /** 対応点の散らばり具合 (回転半径 ÷ ラスタ半径)。狭い範囲に固まっていると外挿が効かない。 */
  function assessLandmarkGeometry(pts, W, H) {
    const n = (pts && pts.length) || 0;
    if (n < 2) return { n: n, spread: 0 };
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += pts[i][0]; cy += pts[i][1]; }
    cx /= n; cy /= n;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const dx = pts[i][0] - cx, dy = pts[i][1] - cy;
      sum += dx * dx + dy * dy;
    }
    const rg = Math.sqrt(sum / n);
    const R = Math.sqrt(Math.max(1, W * H)) / 2;
    return { n: n, spread: R > 0 ? rg / R : 0 };
  }

  // =====================================================================
  // マスクのモルフォロジー
  // =====================================================================

  function maskDilate3(m, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let on = 0;
        for (let dy = -1; dy <= 1 && !on; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            if (m[yy * w + xx]) { on = 1; break; }
          }
        }
        out[y * w + x] = on;
      }
    }
    return out;
  }

  // ★ 境界は「外側を前景とみなす」クランプ。外側を背景扱いにすると dilate→erode の
  //   closing がキャンバス端に接した組織の外周 1px を毎回削り、面積比から出す
  //   スケールに系統誤差が乗る。
  function maskErode3(m, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let all = 1;
        for (let dy = -1; dy <= 1 && all; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue; // 外側は前景扱い
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            if (!m[yy * w + xx]) { all = 0; break; }
          }
        }
        out[y * w + x] = all;
      }
    }
    return out;
  }

  /** 外周から背景を塗りつぶし、届かなかった背景 = 穴を前景にする */
  function maskFillHoles(m, w, h) {
    const n = w * h;
    const outside = new Uint8Array(n);
    const stack = [];
    for (let x = 0; x < w; x++) {
      if (!m[x]) { outside[x] = 1; stack.push(x); }
      const b = (h - 1) * w + x;
      if (!m[b] && !outside[b]) { outside[b] = 1; stack.push(b); }
    }
    for (let y = 0; y < h; y++) {
      const l = y * w, r = y * w + w - 1;
      if (!m[l] && !outside[l]) { outside[l] = 1; stack.push(l); }
      if (!m[r] && !outside[r]) { outside[r] = 1; stack.push(r); }
    }
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i / w) | 0;
      if (x > 0) { const j = i - 1; if (!m[j] && !outside[j]) { outside[j] = 1; stack.push(j); } }
      if (x < w - 1) { const j = i + 1; if (!m[j] && !outside[j]) { outside[j] = 1; stack.push(j); } }
      if (y > 0) { const j = i - w; if (!m[j] && !outside[j]) { outside[j] = 1; stack.push(j); } }
      if (y < h - 1) { const j = i + w; if (!m[j] && !outside[j]) { outside[j] = 1; stack.push(j); } }
    }
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (m[i] || !outside[i]) ? 1 : 0;
    return out;
  }

  /**
   * ★ 破片を全部落とさない: post-MSI の H&E はレーザー痕・切片裂けで組織が数片に
   *   割れているのが普通なので、最大成分の minFrac 未満だけを捨て、面積比 coverFrac に
   *   達するまでは複数成分を残す。
   */
  function maskKeepMainComponents(src, w, h, minFrac, coverFrac) {
    const n = w * h;
    const labels = new Int32Array(n);
    const parent = [0];
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
    let next = 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!src[i]) continue;
      const up = y > 0 ? labels[i - w] : 0;
      const left = x > 0 ? labels[i - 1] : 0;
      if (up && left) { labels[i] = up; if (up !== left) union(up, left); }
      else if (up) { labels[i] = up; }
      else if (left) { labels[i] = left; }
      else { labels[i] = next; parent[next] = next; next++; }
    }
    const area = new Map();
    for (let i = 0; i < n; i++) {
      if (!labels[i]) continue;
      const r = find(labels[i]); labels[i] = r;
      area.set(r, (area.get(r) || 0) + 1);
    }
    if (!area.size) return src;
    const sorted = [...area.entries()].sort((a, b) => b[1] - a[1]);
    const biggest = sorted[0][1];
    let total = 0; for (let i = 0; i < sorted.length; i++) total += sorted[i][1];
    const keep = new Set(); let acc = 0;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i][1] < biggest * minFrac) break;
      keep.add(sorted[i][0]); acc += sorted[i][1];
      if (acc >= total * coverFrac) break;
    }
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (labels[i] && keep.has(labels[i])) out[i] = 1;
    return out;
  }

  /** 数値配列 → Otsu 二値化 → closing → 穴埋め → 主成分抽出 */
  function otsuMaskFromArray(vals, W, H, useLog) {
    const n = W * H;
    const scored = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = vals[i];
      if (!Number.isFinite(v)) { scored[i] = NaN; continue; }
      scored[i] = useLog ? Math.log10(Math.max(0, v) + 1) : v;
    }
    const res = global.Otsu.computeOtsuThreshold(scored, global.Otsu.NBINS);
    if (!res || res.degenerate) return null;
    let m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = (Number.isFinite(scored[i]) && scored[i] > res.threshold) ? 1 : 0;
    m = maskErode3(maskDilate3(m, W, H), W, H);
    m = maskFillHoles(m, W, H);
    return maskKeepMainComponents(m, W, H, 0.01, 0.98);
  }

  // =====================================================================
  // シルエット抽出
  // =====================================================================

  /**
   * 面積・重心・主軸角・異方性を、すべて「生ピクセル単位」で返す
   * (マスク空間のモーメントを sx/sy で先に換算するので、非正方の間引きでも軸が歪まない)。
   * aniso = (λ1−λ2)/(λ1+λ2): 0 = 完全な円盤、1 = 直線。
   * ★ 0 に近い値は「このシルエットは回転情報を持たない」という意味で、
   *   Dice はどの角度でも ~0.997 を返してしまう。これが唯一の事前警告。
   */
  function maskMoments(mask, w, h, sx, sy) {
    sx = sx || 1; sy = sy || 1;
    let n = 0, cx = 0, cy = 0;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) if (mask[row + x]) { n++; cx += x; cy += y; }
    }
    if (!n) return null;
    cx /= n; cy /= n;
    let mu20 = 0, mu02 = 0, mu11 = 0;
    for (let y = 0; y < h; y++) {
      const row = y * w, dy = y - cy;
      for (let x = 0; x < w; x++) if (mask[row + x]) { const dx = x - cx; mu20 += dx * dx; mu02 += dy * dy; mu11 += dx * dy; }
    }
    const m20 = (mu20 / n) * sx * sx;
    const m02 = (mu02 / n) * sy * sy;
    const m11 = (mu11 / n) * sx * sy;
    const tr = m20 + m02;
    const det = m20 * m02 - m11 * m11;
    const disc = Math.sqrt(Math.max(tr * tr / 4 - det, 0));
    const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
    return {
      n: n, cx: cx * sx, cy: cy * sy, area: n * sx * sy,
      axis: 0.5 * Math.atan2(2 * m11, m20 - m02),
      aniso: (l1 + l2) > 0 ? (l1 - l2) / (l1 + l2) : 0,
    };
  }

  /** H&E の組織シルエット。彩度で組織とスライド背景を分ける。 */
  function heTissueMask(imgEl, maxEdge) {
    maxEdge = maxEdge || HE_MASK_MAX_EDGE;
    if (!imgEl || !imgEl.complete) return null;
    const rawW = imgEl.naturalWidth || imgEl.width;
    const rawH = imgEl.naturalHeight || imgEl.height;
    if (!rawW || !rawH) return null;
    const k = Math.max(1, Math.max(rawW, rawH) / maxEdge);
    const w = Math.max(8, Math.round(rawW / k));
    const h = Math.max(8, Math.round(rawH / k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    // 縮小時に面積平均を効かせる (細い実質が丸ごと消えないように)
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    let d;
    try { ctx.drawImage(imgEl, 0, 0, w, h); d = ctx.getImageData(0, 0, w, h).data; }
    catch (e) { console.warn('heTissueMask: getImageData failed', e); return null; }
    let m = new Uint8Array(w * h);
    for (let i = 0, p = 0; p < m.length; i += 4, p++) {
      if (d[i + 3] === 0) continue;              // 透明 = 背景
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (mx === 0) continue;                    // 真っ黒 = 背景
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if ((mx - mn) / mx > HE_MASK_SAT_MIN && mx / 255 < HE_MASK_VAL_MAX) m[p] = 1;
    }
    m = maskErode3(maskDilate3(m, w, h), w, h); // closing
    m = maskFillHoles(m, w, h);
    m = maskKeepMainComponents(m, w, h, 0.01, 0.98);
    let n = 0;
    for (let i = 0; i < m.length; i++) n += m[i];
    if (n < 16 || n > m.length * 0.995) return null; // 退化
    return { mask: m, w: w, h: h, sx: rawW / w, sy: rawH / h };
  }

  /** MSI の生値ラスタから組織シルエットを作る (log10(v+1) に Otsu) */
  function msiTissueMaskFromValues(values, W, H) {
    const raw = otsuMaskFromArray(values, W, H, true);
    if (!raw) return null;
    let n = 0;
    for (let i = 0; i < raw.length; i++) n += raw[i];
    if (n < 16 || n > raw.length * 0.995) return null;
    // Dice 評価のためのダウンサンプル (多数決)
    const k = Math.max(1, Math.max(W, H) / ALIGN_DICE_MAX_EDGE);
    if (k <= 1) return { mask: raw, w: W, h: H, sx: 1, sy: 1 };
    const w2 = Math.max(8, Math.round(W / k)), h2 = Math.max(8, Math.round(H / k));
    const out = new Uint8Array(w2 * h2);
    const sx = W / w2, sy = H / h2;
    for (let j = 0; j < h2; j++) {
      for (let i = 0; i < w2; i++) {
        let on = 0, tot = 0;
        const x0 = Math.floor(i * sx), x1 = Math.min(W, Math.ceil((i + 1) * sx));
        const y0 = Math.floor(j * sy), y1 = Math.min(H, Math.ceil((j + 1) * sy));
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { tot++; on += raw[y * W + x]; }
        out[j * w2 + i] = tot && on * 2 >= tot ? 1 : 0;
      }
    }
    return { mask: out, w: w2, h: h2, sx: sx, sy: sy };
  }

  // =====================================================================
  // 自動整合
  // =====================================================================

  /**
   * rho = -1 は「HE を鏡映する必要がある」の意味。鏡映は必ず flip_lr に寄せる:
   * 両方の flip を立てるのは theta+180° の純回転と同じで、1 つの変換に 2 通りの
   * 表現ができてしまうため。
   * オフセットは T が HE 生原点まわりに回すことから T(c_he) = c_msi を解いて求める。
   */
  function alignStateFromSimilarity(theta, s, rho, cHe, cMsi) {
    const sx = (rho < 0 ? -1 : 1) * s, sy = s;
    const cos = Math.cos(theta), sin = Math.sin(theta);
    return {
      flip_lr: rho < 0,
      flip_ud: false,
      scale_pct: s * 100,
      rotate_deg: theta * 180 / Math.PI,
      offx: cMsi[0] - (cos * sx * cHe[0] - sin * sy * cHe[1]),
      offy: cMsi[1] - (sin * sx * cHe[0] + cos * sy * cHe[1]),
    };
  }

  /**
   * T で歪めた HE マスクと MSI マスクの Dice 係数を MSI グリッド上で評価する。
   * 収束まで ~51 回の評価で済み、グリッドは ALIGN_DICE_MAX_EDGE で頭打ちなので
   * メインスレッドで数十 ms。Worker は不要。
   */
  function maskDiceUnderAffine(heM, msiM, T) {
    const Ti = invertAffine(T);
    if (!Ti) return 0;
    const a = Ti[0][0], b = Ti[0][1], tx = Ti[0][2];
    const c = Ti[1][0], d = Ti[1][1], ty = Ti[1][2];
    const hw = heM.w, hh = heM.h, hm = heM.mask;
    const isx = 1 / heM.sx, isy = 1 / heM.sy;
    let inter = 0, nHe = 0, nMsi = 0;
    for (let j = 0; j < msiM.h; j++) {
      const my = (j + 0.5) * msiM.sy;
      const row = j * msiM.w;
      for (let i = 0; i < msiM.w; i++) {
        const mx = (i + 0.5) * msiM.sx;
        // MSI 生 → HE 生 → HE マスク添字 (最近傍)
        const hxf = (a * mx + b * my + tx) * isx;
        const hyf = (c * mx + d * my + ty) * isy;
        let inHe = 0;
        if (hxf >= 0 && hyf >= 0) {
          const hx = hxf | 0, hy = hyf | 0;
          if (hx < hw && hy < hh) inHe = hm[hy * hw + hx];
        }
        const inMsi = msiM.mask[row + i];
        if (inHe) nHe++;
        if (inMsi) nMsi++;
        if (inHe && inMsi) inter++;
      }
    }
    return (nHe + nMsi) ? (2 * inter) / (nHe + nMsi) : 0;
  }

  /**
   * 2 つの組織シルエットから HE→MSI の相似変換を自動推定する。
   *   1. モーメントで初期化 (角度を連続値で入れるのが、方位ボックス探索との決定的な差。
   *      5〜10° のずれは離散探索では直せない)
   *   2. 主軸の 180° 不定性 × 鏡映の 4 分岐から Dice で選ぶ
   *   3. (theta, scale, cx, cy) の粗→細の座標降下
   * opts.lockScale — 両側の物理ピッチが判っていればスケールは自由変数ではない。
   */
  function autoAlignSilhouette(heM, msiM, opts) {
    opts = opts || {};
    const hM = maskMoments(heM.mask, heM.w, heM.h, heM.sx, heM.sy);
    const mM = maskMoments(msiM.mask, msiM.w, msiM.h, msiM.sx, msiM.sy);
    if (!hM || !mM || !(hM.area > 0) || !(mM.area > 0)) return null;
    const cHe = [hM.cx, hM.cy];
    const lock = Number(opts.lockScale);
    const scaleLocked = Number.isFinite(lock) && lock > 0;
    const s0 = scaleLocked ? lock : Math.sqrt(mM.area / hM.area);
    const evalAt = (theta, s, rho, cx, cy) => {
      const st = alignStateFromSimilarity(theta, s, rho, cHe, [cx, cy]);
      return { st: st, dice: maskDiceUnderAffine(heM, msiM, buildHeToMsiAffine(st)) };
    };
    // 鏡映は HE 主軸角の符号を反転させるので、ここで符号を切り替える
    let best = null;
    for (const rho of [1, -1]) {
      const base = rho > 0 ? (mM.axis - hM.axis) : (mM.axis + hM.axis);
      for (const add of [0, Math.PI]) {
        const r = evalAt(base + add, s0, rho, mM.cx, mM.cy);
        if (!best || r.dice > best.dice) {
          best = { dice: r.dice, theta: base + add, s: s0, rho: rho, cx: mM.cx, cy: mM.cy };
        }
      }
    }
    // 粗→細の精密化。平行移動の刻みは MSI px なので、最終段は 1/4 px を解像する。
    const STEPS = [[4 * Math.PI / 180, 0.04, 4], [1 * Math.PI / 180, 0.01, 1], [0.25 * Math.PI / 180, 0.0025, 0.25]];
    let evals = 4;
    for (const step of STEPS) {
      const dth = step[0], ds = step[1], dt = step[2];
      let moved = true;
      while (moved) {
        moved = false;
        for (let pj = 0; pj < 4; pj++) {
          if (pj === 1 && scaleLocked) continue; // スケールは既知の定数
          for (const sgn of [1, -1]) {
            let th = best.theta, s = best.s, cx = best.cx, cy = best.cy;
            if (pj === 0) th += sgn * dth;
            else if (pj === 1) s *= (1 + sgn * ds);
            else if (pj === 2) cx += sgn * dt;
            else cy += sgn * dt;
            if (!(s > 0)) continue;
            const r = evalAt(th, s, best.rho, cx, cy);
            evals++;
            if (r.dice > best.dice + 1e-6) {
              best = { dice: r.dice, theta: th, s: s, rho: best.rho, cx: cx, cy: cy };
              moved = true;
            }
          }
        }
      }
    }
    const state = alignStateFromSimilarity(best.theta, best.s, best.rho, cHe, [best.cx, best.cy]);
    const aniso = Math.min(hM.aniso, mM.aniso);
    return {
      state: state, dice: best.dice, evals: evals, scaleLocked: scaleLocked,
      sigmaPx: scaleLocked ? AUTO_ALIGN_SIGMA_LOCKED_PX : AUTO_ALIGN_SIGMA_PX,
      aniso: aniso,
      reliableRotation: aniso >= ALIGN_ANISO_MIN,
      heArea: hM.area, msiArea: mM.area,
      areaScaleRatio: scaleLocked ? Math.sqrt(mM.area / hM.area) / lock : 1,
    };
  }

  /**
   * 2 つの変換の食い違いを HE 組織上で測り、MSI px で返す。
   * 「この 2 つの整合はどれくらい離れているか」への唯一まともな答え。
   * 行列や角度を直接比べても、スケールと平行移動が絡む以上意味がない。
   */
  function transformDisagreementPx(heM, TA, TB, stride) {
    if (!heM || !TA || !TB) return NaN;
    stride = stride || 4;
    let sum = 0, n = 0;
    for (let y = 0; y < heM.h; y += stride) {
      const row = y * heM.w;
      for (let x = 0; x < heM.w; x += stride) {
        if (!heM.mask[row + x]) continue;
        const rx = (x + 0.5) * heM.sx, ry = (y + 0.5) * heM.sy;
        const a = applyAffinePoint(TA, rx, ry);
        const b = applyAffinePoint(TB, rx, ry);
        const dx = a[0] - b[0], dy = a[1] - b[1];
        sum += dx * dx + dy * dy; n++;
      }
    }
    return n ? Math.sqrt(sum / n) : NaN;
  }

  /**
   * 対応点フィットの期待誤差 (MSI px)。
   * ★ 生の残差をそのまま信用してはいけない: 4-DOF の相似変換は 2 点なら必ず残差 0 で
   *   通る。自由度で不偏化してクリック誤差 sigma を逆算し、実測の n スケーリング
   *   (RMS ≈ 2.1·sigma/√n) に載せ替える。
   */
  function estimateLandmarkFitSigmaPx(resid) {
    if (!resid || resid.n < 2) return null;
    const n = resid.n;
    let sigmaClick = (n <= 2) ? 1.0 : resid.rmse_px / Math.sqrt(2 * (1 - 2 / n));
    if (!(sigmaClick > 0) || !Number.isFinite(sigmaClick)) sigmaClick = 1.0;
    return Math.max(0.05, 2.1 * sigmaClick / Math.sqrt(n));
  }

  /**
   * 2 つの整合の逆分散ブレンド。パラメータ空間で行う。
   * ★ 行列を直接平均してはいけない (相似変換でなくなる)。角度は円周平均。
   */
  function blendAlignStates(a, wA, b, wB) {
    if (!a || !b) return null;
    // This legacy scalar blend is only defined for similarities. An affine
    // candidate must remain a complete matrix and be chosen explicitly.
    if (a.model === 'affine' || b.model === 'affine') return null;
    if (!!a.flip_lr !== !!b.flip_lr || !!a.flip_ud !== !!b.flip_ud) return null;
    const w = wA + wB;
    if (!(w > 0) || !Number.isFinite(w)) return null;
    const ra = a.rotate_deg * Math.PI / 180, rb = b.rotate_deg * Math.PI / 180;
    const ang = Math.atan2(wA * Math.sin(ra) + wB * Math.sin(rb),
                           wA * Math.cos(ra) + wB * Math.cos(rb));
    return {
      flip_lr: !!a.flip_lr, flip_ud: !!a.flip_ud,
      scale_pct: (wA * a.scale_pct + wB * b.scale_pct) / w,
      rotate_deg: ang * 180 / Math.PI,
      offx: (wA * a.offx + wB * b.offx) / w,
      offy: (wA * a.offy + wB * b.offy) / w,
    };
  }

  // =====================================================================
  // シルエット整合の合成マスク自己テスト
  // 合成マスクに既知の変換をかけ、ソルバが復元できるかを見る。
  // コンソールで Align.selfTest() を実行する。
  // =====================================================================
  function selfTest(opts) {
    opts = opts || {};
    const TOL = opts.tol || 1.0; // MSI px
    const results = [];
    let allOk = true;

    // ★ 合成シルエットは「明確にキラル」でなければならない。左右対称や 180° 対称の
    //   形だと、真の変換と別の分岐が同じ (むしろ高い) Dice を出してしまい、
    //   ソルバではなくフィクスチャのせいでテストが落ちる。
    //   半径の違う 3 つの円を非共線に置いて、鏡映対称も 180° 対称も壊す。
    const DISCS = [
      { cx: 110, cy: 150, r: 45 },
      { cx: 185, cy: 132, r: 30 },
      { cx: 208, cy: 192, r: 17 },
    ];
    function blobAt(x, y) {
      for (const d of DISCS) {
        const dx = x - d.cx, dy = y - d.cy;
        if (dx * dx + dy * dy <= d.r * d.r) return 1;
      }
      return 0;
    }
    function blobMask(w, h) {
      const m = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = blobAt(x + 0.5, y + 0.5);
      return m;
    }

    const heRaw = { mask: blobMask(300, 300), w: 300, h: 300, sx: 1, sy: 1 };

    for (const deg of [0, 15, -30, 60, 120, -150, 179]) {
      for (const mirror of [false, true]) {
        const truth = {
          flip_lr: mirror, flip_ud: false,
          scale_pct: 40, rotate_deg: deg, offx: 0, offy: 0,
        };
        // T が HE 原点まわりに回るので、HE 重心が MSI の中心に来るよう offset を解く
        const T0 = buildHeToMsiAffine(truth);
        const hm = maskMoments(heRaw.mask, heRaw.w, heRaw.h, 1, 1);
        const mapped = applyAffinePoint(T0, hm.cx, hm.cy);
        truth.offx = 60 - mapped[0];
        truth.offy = 60 - mapped[1];
        const T = buildHeToMsiAffine(truth);

        // 真の T で HE 形状を MSI グリッド (120×120) に焼く。
        // 0.4× の縮小なので、点サンプリングだと 6 割の画素を取りこぼして
        // マスクが虫食いになる。3×3 の多数決で面積平均する。
        const MW = 120, MH = 120;
        const mm = new Uint8Array(MW * MH);
        const Ti = invertAffine(T);
        for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
          let on = 0;
          for (let sy2 = 0; sy2 < 3; sy2++) for (let sx2 = 0; sx2 < 3; sx2++) {
            const p = applyAffinePoint(Ti, x + (sx2 + 0.5) / 3, y + (sy2 + 0.5) / 3);
            on += blobAt(p[0], p[1]);
          }
          if (on >= 5) mm[y * MW + x] = 1;
        }
        const msiM = { mask: mm, w: MW, h: MH, sx: 1, sy: 1 };

        const auto = autoAlignSilhouette(heRaw, msiM, null);
        const ok = !!auto;
        let err = NaN;
        if (ok) err = transformDisagreementPx(heRaw, T, buildHeToMsiAffine(auto.state), 2);
        const pass = ok && Number.isFinite(err) && err <= TOL;
        if (!pass) allOk = false;
        results.push({
          deg: deg, mirror: mirror,
          dice: auto ? +auto.dice.toFixed(4) : NaN,
          err_px: Number.isFinite(err) ? +err.toFixed(3) : NaN,
          aniso: auto ? +auto.aniso.toFixed(3) : NaN,
          pass: pass,
        });
      }
    }

    // 分解の厳密性: alignStateFromSimilarity は T(c_he) = c_msi をきっちり満たすこと
    {
      const st = alignStateFromSimilarity(0.7, 0.4, -1, [123, 45], [60, 70]);
      const p = applyAffinePoint(buildHeToMsiAffine(st), 123, 45);
      const exact = Math.abs(p[0] - 60) < 1e-9 && Math.abs(p[1] - 70) < 1e-9;
      if (!exact) allOk = false;
      results.push({ deg: 'decompose', mirror: '-', dice: NaN, err_px: Math.hypot(p[0] - 60, p[1] - 70), aniso: NaN, pass: exact });
    }

    // 円盤では異方性ガードが必ず発火すること
    {
      const w = 200, h = 200;
      const disc = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if ((x - 100) ** 2 + (y - 100) ** 2 <= 60 * 60) disc[y * w + x] = 1;
      }
      const dM = { mask: disc, w: w, h: h, sx: 1, sy: 1 };
      const a = autoAlignSilhouette(dM, dM, null);
      const fired = !!a && !a.reliableRotation;
      if (!fired) allOk = false;
      results.push({ deg: 'disc-guard', mirror: '-', dice: a ? +a.dice.toFixed(4) : NaN, err_px: NaN, aniso: a ? +a.aniso.toFixed(4) : NaN, pass: fired });
    }

    if (typeof console.table === 'function') console.table(results);
    else console.log(results);
    console.log(allOk ? '✅ align selfTest: all passed' : '❌ align selfTest: FAILURES above');
    return { ok: allOk, results: results };
  }

  global.Align = {
    HE_MASK_MAX_EDGE, HE_MASK_SAT_MIN, HE_MASK_VAL_MAX,
    ALIGN_DICE_MAX_EDGE, ALIGN_ANISO_MIN,
    AUTO_ALIGN_SIGMA_PX, AUTO_ALIGN_SIGMA_LOCKED_PX,
    applyAffinePoint, invertAffine, validateAffine, decomposeAffine, buildHeToMsiAffine, defaultAlignState,
    solveSimilarity, solveAlignFromLandmarks, solveSimilarityCandidates, solveAffineFromLandmarks,
    computeLandmarkResiduals, assessLandmarkGeometry,
    maskDilate3, maskErode3, maskFillHoles, maskKeepMainComponents,
    otsuMaskFromArray, maskMoments, heTissueMask, msiTissueMaskFromValues,
    alignStateFromSimilarity, maskDiceUnderAffine, autoAlignSilhouette,
    transformDisagreementPx, estimateLandmarkFitSigmaPx, blendAlignStates,
    selfTest,
  };
})(window);
