/* Display-only exterior + local high-value mask, with an interior keep region.
 * Thresholds and neighborhoods always use the original loaded series. Neither
 * a display toggle, ROI nor a previous mask is input to this calculation.
 */
(function (global) {
  'use strict';
  const ANALYTES = Object.freeze(['GABA-DPP', 'Histamine-DPP', 'Dopamine-DPP', 'Norepinephrine-DPP', 'Serotonin-DPP']);
  const DEFAULT_DEPTH = 8, MIN_DEPTH = 5, MAX_DEPTH = 20;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  function median(values) {
    values.sort((a, b) => a - b);
    const n = values.length, middle = Math.floor(n / 2);
    return n % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  }
  function usable(section, analyte) {
    const channel = section.channels?.[analyte];
    return !section.released && channel?.normalized &&
      ['VALID', 'PROVISIONAL', 'PARTIAL'].includes(channel.corrected?.status) ? channel : null;
  }
  function create(sections) {
    if (!Array.isArray(sections)) throw new TypeError('Loaded sections are required');
    if (!global.Stack3DEdgeMask) throw new Error('外周表示マスクを読み込めませんでした');
    const thresholds = {}, records = new WeakMap();
    for (const analyte of ANALYTES) {
      const pooled = [];
      for (const section of sections) {
        const channel = usable(section, analyte); if (!channel) continue;
        if (channel.normalized.length !== section.W * section.H)
          throw new Error('高値表示マスクの画素数が一致しません');
        for (const value of channel.normalized) if (finite(value)) pooled.push(value);
      }
      pooled.sort((a, b) => a - b);
      const quantile = p => pooled.length ? pooled[Math.ceil(pooled.length * p) - 1] : NaN;
      thresholds[analyte] = Object.freeze({ p95: quantile(.95), p99: quantile(.99), finiteCount: pooled.length });
    }
    Object.freeze(thresholds);
    for (const section of sections) {
      // No supported threshold hides depth >= 20. A bounded distance field is
      // enough; deeper UNVISITED cells are conservatively kept at every setting.
      const edge = global.Stack3DEdgeMask.fromSection(section, MAX_DEPTH, true);
      if (edge.status !== 'available') throw new Error(`高値表示マスクを計算できませんでした：${edge.reason}`);
      const { W, H } = section, size = W * H, candidates = {};
      for (const analyte of ANALYTES) {
        const channel = usable(section, analyte); if (!channel) continue;
        const values = channel.normalized, { p95, p99 } = thresholds[analyte], mask = new Uint8Array(size);
        candidates[analyte] = mask;
        if (!edge.measuredPixels) continue;
        const tolerance = Math.max(1e-12, Math.abs(p99) * 1e-6);
        for (let i = 0; i < size; i++) {
          const depth = edge.distance[i], center = values[i];
          if (!edge.measuredMask[i] || depth < 3 || depth >= MAX_DEPTH || !finite(center)) continue;
          if (depth <= 4 && center > p99) { mask[i] = 1; continue; }
          if (!(center > p95)) continue;
          const x = i % W, y = Math.floor(i / W), neighbors = [];
          let complete = true;
          for (let dy = -2; dy <= 2 && complete; dy++) for (let dx = -2; dx <= 2; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy, j = ny * W + nx;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H || !edge.measuredMask[j] || !finite(values[j])) {
              complete = false; break;
            }
            neighbors.push(values[j]);
          }
          if (!complete) continue;
          const localMedian = median(neighbors), mad = median(neighbors.map(value => Math.abs(value - localMedian)));
          if (mad > tolerance && (center - localMedian) / (1.4826 * mad) > 6) mask[i] = 1;
        }
      }
      records.set(section, { edge, candidates, masks: new Map() });
    }
    function masksFor(section, protectDepth = DEFAULT_DEPTH) {
      if (!Number.isInteger(protectDepth) || protectDepth < MIN_DEPTH || protectDepth > MAX_DEPTH)
        throw new RangeError('Protection distance must be an integer from 5 to 20');
      const record = records.get(section);
      if (!record || section.released) throw new Error('Loaded section is unavailable for this high-value mask');
      if (!record.masks.has(protectDepth)) {
        const masks = {};
        for (const [analyte, candidate] of Object.entries(record.candidates)) {
          const mask = new Uint8Array(candidate.length);
          for (let i = 0; i < candidate.length; i++)
            if (candidate[i] && record.edge.distance[i] < protectDepth) mask[i] = 1;
          masks[analyte] = mask;
        }
        record.masks.set(protectDepth, Object.freeze(masks));
      }
      return record.masks.get(protectDepth);
    }
    return Object.freeze({ masksFor, thresholds });
  }
  global.Stack3DHighValueMask = Object.freeze({ create, DEFAULT_DEPTH, MIN_DEPTH, MAX_DEPTH });
})(window);
