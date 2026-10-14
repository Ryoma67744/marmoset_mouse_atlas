/*
 * roi-distribution.js — immutable, full-population ROI intensity summaries.
 * Quantiles use linear interpolation at h=(n-1)p (P0/P99 whiskers).
 * Only the displayed cloud is sampled; quartiles and tail counts use all data.
 */
(function (global) {
  'use strict';
  const QUANTILE_METHOD = 'linear-h-n-minus-1';
  const DEFAULT_MAX_POINTS = 2000;
  const isFiniteNumber = Number.isFinite;

  function quantile(sorted, p) {
    const h = (sorted.length - 1) * p, low = Math.floor(h), fraction = h - low;
    if (!fraction) return sorted[low];
    // A weighted sum avoids overflow in (b-a) for finite opposite-sign values.
    return sorted[low] * (1 - fraction) + sorted[low + 1] * fraction;
  }
  function firstAbove(sorted, threshold) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (sorted[mid] > threshold) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }
  function appendRanks(points, sorted, start, length, count, upperTail) {
    for (let i = 0; i < count; i++) {
      const offset = count === 1 ? (upperTail ? length - 1 : 0) : Math.round(i * (length - 1) / (count - 1));
      const rank = start + offset;
      points.push({ value: sorted[rank], rank: rank, upperTail: upperTail });
    }
  }
  function summarize(values, options) {
    const maxPoints = options && options.maxPoints !== undefined ? options.maxPoints : DEFAULT_MAX_POINTS;
    if (!Number.isInteger(maxPoints) || maxPoints < 2) throw new RangeError('maxPoints must be an integer of at least 2');
    if (!values || !Number.isSafeInteger(values.length) || values.length < 0) throw new TypeError('ROI values must be an array or typed array');
    // Keep a single compact, private numeric buffer. Sorting never changes input.
    const length = values.length, copy = new Float64Array(length);
    let n = 0;
    for (let i = 0; i < length; i++) {
      const value = values[i];
      if (isFiniteNumber(value)) copy[n++] = value;
    }
    if (!n) return null;
    const sorted = copy.subarray(0, n); sorted.sort();
    const whiskerHigh = quantile(sorted, 0.99), tailStart = firstAbove(sorted, whiskerHigh), tailCount = n - tailStart;
    const points = [], budget = Math.min(n, maxPoints);
    if (n <= budget) {
      appendRanks(points, sorted, 0, tailStart, tailStart, false);
      appendRanks(points, sorted, tailStart, tailCount, tailCount, true);
    } else {
      // Keep the sparse red tail represented independently of the blue cloud.
      // Endpoints preserve min/max, and both red extremes when the budget allows.
      const tailBudget = tailCount ? Math.min(tailCount, budget - 1,
        Math.max(budget >= 4 && tailCount > 1 ? 2 : 1, Math.round(budget * tailCount / n))) : 0;
      const mainBudget = budget - tailBudget;
      appendRanks(points, sorted, 0, tailStart, mainBudget, false);
      appendRanks(points, sorted, tailStart, tailCount, tailBudget, true);
    }
    const distribution = { n: n, min: sorted[0], max: sorted[n - 1],
      q1: quantile(sorted, 0.25), median: quantile(sorted, 0.5), q3: quantile(sorted, 0.75),
      whiskerLow: sorted[0], whiskerHigh: whiskerHigh, upperTailCount: tailCount,
      quantileMethod: QUANTILE_METHOD, points: points, sampled: points.length < n };
    // 3D resolves a shared P99-based axis only after all groups are summarized.
    // Keep just its exact upper tail temporarily, never the complete sorted
    // buffer. Default/2D callers retain their original summary shape.
    if (options && options.includeUpperTailValues === true) distribution.upperTailValues = sorted.slice(tailStart);
    return distribution;
  }
  global.RoiDistribution = { summarize: summarize, QUANTILE_METHOD: QUANTILE_METHOD, DEFAULT_MAX_POINTS: DEFAULT_MAX_POINTS };
})(typeof window !== 'undefined' ? window : globalThis);
