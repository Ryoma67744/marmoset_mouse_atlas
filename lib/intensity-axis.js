/* Shared, data-only axes for exact 3D intensity distributions. */
(function (global) {
  'use strict';

  function autoDomain(distributions) {
    let low = Infinity, high = -Infinity;
    for (const distribution of distributions || []) {
      if (!distribution || !(distribution.n > 0) || !Number.isFinite(distribution.min) ||
          !Number.isFinite(distribution.whiskerHigh) || distribution.min > distribution.whiskerHigh) continue;
      low = Math.min(low, distribution.min);
      high = Math.max(high, distribution.whiskerHigh);
    }
    if (!Number.isFinite(low) || !Number.isFinite(high)) return [0, 1];
    if (low >= 0) low = 0;
    // A zero-valued P99 must not bring a sparse, arbitrarily large outlier back
    // into the automatic range. Statistics and the full-range view retain it.
    if (low === 0 && high === 0) return [0, 1];
    if (low === high) {
      const padding = Math.max(Math.abs(low) * 0.06, Number.MIN_VALUE);
      const lower = low - padding, upper = high + padding;
      if (Number.isFinite(lower)) low = lower;
      if (Number.isFinite(upper)) high = upper;
    }
    const scale = Math.max(Math.abs(low), Math.abs(high), Number.MIN_VALUE);
    const normalizedSpan = high / scale - low / scale;
    // Compute padding before scaling, avoiding overflow for opposite-sign
    // values near the largest finite number.
    const padding = (normalizedSpan * 0.06) * scale;
    const paddedLow = low < 0 && Number.isFinite(low - padding) ? low - padding : low;
    const paddedHigh = Number.isFinite(high + padding) ? high + padding : high;
    const rough = (normalizedSpan / 5) * scale;
    const power = Math.pow(10, Math.floor(Math.log10(rough)));
    const fraction = rough / power;
    const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
    if (!(step > 0) || !Number.isFinite(step)) return [paddedLow, paddedHigh];
    const roundedLow = Math.floor(paddedLow / step) * step;
    const roundedHigh = Math.ceil(paddedHigh / step) * step;
    // Rounding must never exclude the minimum or any included group's P99.
    return [Number.isFinite(roundedLow) ? Math.min(low, roundedLow) : paddedLow,
      Number.isFinite(roundedHigh) ? Math.max(high, roundedHigh) : paddedHigh];
  }

  function countAbove(sortedValues, threshold) {
    let low = 0, high = sortedValues.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (sortedValues[middle] > threshold) high = middle;
      else low = middle + 1;
    }
    return sortedValues.length - low;
  }

  global.IntensityAxis = { autoDomain, countAbove };
})(typeof window !== 'undefined' ? window : globalThis);
