/* Exterior of the acquired MSI footprint, in raw pixel-edge coordinates.
 * Finite raw samples (including zero) define acquisition, not tissue identity.
 * No displayed intensities, d4 ratios, ROI selection, or thresholds are used.
 * A fully acquired rectangular grid cannot establish a tissue boundary.
 */
(function (global) {
  'use strict';
  const MAX_PIXELS = 16777216, MAX_EDGES = 262144;
  const source = 'measured-footprint';
  function unavailable(reason, pixelCount = 0) {
    return { status: 'unavailable', contours: [], source, reason, pixelCount };
  }
  function signedArea(points) {
    let twice = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      twice += a[0] * b[1] - b[0] * a[1];
    }
    return twice / 2;
  }
  function corners(points) {
    // Remove only collinear vertices: no smoothing, hull, or shape inflation.
    return points.filter((b, i) => {
      const a = points[(i + points.length - 1) % points.length], c = points[(i + 1) % points.length];
      return (b[0] - a[0]) * (c[1] - b[1]) !== (b[1] - a[1]) * (c[0] - b[0]);
    });
  }
  function compatibleCoordinates(section, entries) {
    const W = section.W, H = section.H, axes = { x: null, y: null };
    let fingerprint;
    const definitions = section.project?.molecules || [];
    const records = [section.project?.grid, section.grid];
    for (const [key, raster] of entries)
      records.push(definitions.find(m => m.key === key)?.grid, raster);
    for (const record of records) {
      if (!record) continue;
      if (record.W != null && Number(record.W) !== W || record.H != null && Number(record.H) !== H) return false;
      for (const [axis, length, keys] of [['x', W, ['xs', 'xCoordinates']], ['y', H, ['ys', 'yCoordinates']]]) {
        for (const key of keys) {
          const values = record[key];
          if (values == null) continue;
          if (!(Array.isArray(values) || ArrayBuffer.isView(values)) || values.length !== length) return false;
          for (let i = 0; i < length; i++) {
            if (!Number.isFinite(values[i]) || axes[axis] && values[i] !== axes[axis][i]) return false;
          }
          axes[axis] = values;
        }
      }
      if (record.coordinateFingerprint != null) {
        if (fingerprint !== undefined && fingerprint !== record.coordinateFingerprint) return false;
        fingerprint = record.coordinateFingerprint;
      }
    }
    // Missing coordinate metadata does not establish or contradict calibration.
    return true;
  }
  function fromSection(section) {
    const W = section?.W, H = section?.H, size = W * H;
    if (!Number.isSafeInteger(W) || !Number.isSafeInteger(H) || W < 1 || H < 1 || size > MAX_PIXELS)
      return unavailable('invalid-grid');
    if (section.released) return unavailable('released-section');
    const entries = Object.entries(section.rasters || {}).filter(([, r]) =>
      r && r.W === W && r.H === H && r.values && r.values.length === size);
    if (!entries.length) return unavailable('missing-raw-rasters');
    // Never present a partial union as the complete outline when a contributor
    // explicitly describes a different grid, even if its W/H happen to match.
    if (!compatibleCoordinates(section, entries)) return unavailable('coordinate-mismatch');
    const mask = new Uint8Array(size);
    let pixelCount = 0;
    for (const [, raster] of entries) {
      for (let i = 0; i < size; i++) if (!mask[i] && Number.isFinite(raster.values[i])) {
        mask[i] = 1; pixelCount++;
      }
    }
    if (!pixelCount) return unavailable('no-measured-pixels');
    if (pixelCount === size) return unavailable('full-grid-coverage', pixelCount);

    // Clockwise directed edges keep the measured pixel on their right.
    // Count first, so a pathological sparse grid cannot allocate huge geometry.
    let edgeCount = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      if (!y || !mask[i - W]) edgeCount++;
      if (x === W - 1 || !mask[i + 1]) edgeCount++;
      if (y === H - 1 || !mask[i + W]) edgeCount++;
      if (!x || !mask[i - 1]) edgeCount++;
      if (edgeCount > MAX_EDGES) return unavailable('boundary-too-complex', pixelCount);
    }
    const stride = W + 1, edges = [], outgoing = new Map();
    function add(x, y, direction) {
      const from = y * stride + x;
      const to = from + [1, stride, -1, -stride][direction];
      const index = edges.length;
      edges.push({ from, to, direction, used: false });
      if (!outgoing.has(from)) outgoing.set(from, []);
      outgoing.get(from).push(index);
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      if (!y || !mask[i - W]) add(x, y, 0);
      if (x === W - 1 || !mask[i + 1]) add(x + 1, y, 1);
      if (y === H - 1 || !mask[i + W]) add(x + 1, y + 1, 2);
      if (!x || !mask[i - 1]) add(x, y + 1, 3);
    }
    const contours = [];
    // At a corner shared by diagonal pixels, turn right first. This preserves
    // both components as separate closed loops without inventing a bridge.
    const turnPriority = [1, 0, 3, 2];
    for (let start = 0; start < edges.length; start++) {
      if (edges[start].used) continue;
      const points = [];
      let index = start, closed = false;
      while (index !== undefined && !edges[index].used) {
        const edge = edges[index]; edge.used = true;
        points.push([edge.from % stride, Math.floor(edge.from / stride)]);
        if (edge.to === edges[start].from) { closed = true; break; }
        const candidates = outgoing.get(edge.to) || [];
        index = undefined;
        for (const turn of turnPriority) {
          const candidate = candidates.find(n =>
            !edges[n].used && (edges[n].direction - edge.direction + 4) % 4 === turn);
          if (candidate !== undefined) { index = candidate; break; }
        }
      }
      if (!closed) return unavailable('invalid-boundary', pixelCount);
      // Image Y increases downwards: exterior loops have positive area; hole
      // loops have negative area. Retain every exterior, not only the largest.
      if (signedArea(points) > 0) contours.push(corners(points));
    }
    if (!contours.length) return unavailable('no-exterior-boundary', pixelCount);
    return { status: 'available', contours, source, reason: null, pixelCount };
  }
  global.Stack3DOutline = Object.freeze({ fromSection });
})(window);
