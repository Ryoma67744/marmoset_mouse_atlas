/* Display-only band at the exterior of the acquired MSI footprint.
 * Finite raw samples, including zero, define acquisition. Enclosed missing
 * holes do not seed the band. This is not an anatomical tissue mask.
 */
(function (global) {
  'use strict';
  const MAX_PIXELS = 16777216, UNVISITED = 65535;
  function unavailable(reason, width = 0, height = 0, bandWidth = 0) {
    return { status: 'unavailable', reason, hiddenMask: new Uint8Array(0),
      width, height, bandWidth, measuredPixels: 0, hiddenPixels: 0 };
  }
  function numericValues(values, size) {
    if (!values || values.length !== size) return false;
    if (Array.isArray(values)) {
      // NaN and infinities denote missing samples; strings, holes and other
      // nonnumeric entries are malformed data, not unmeasured pixels.
      for (let i = 0; i < size; i++) if (typeof values[i] !== 'number') return false;
      return true;
    }
    // Numeric typed arrays have homogeneous element types. This excludes
    // DataView, BigInt arrays and objects that merely expose a length.
    return ArrayBuffer.isView(values) && typeof values[0] === 'number';
  }
  function compatibleCoordinates(section, entries, W, H) {
    const axes = { x: null, y: null }, definitions = section.project?.molecules || [];
    const records = [section.project?.grid, section.grid];
    let fingerprint;
    for (const [key, raster] of entries) records.push(definitions.find(m => m.key === key)?.grid, raster);
    for (const record of records) {
      if (!record) continue;
      if (record.W != null && Number(record.W) !== W || record.H != null && Number(record.H) !== H ||
          record.width != null && Number(record.width) !== W || record.height != null && Number(record.height) !== H) return false;
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
    return true;
  }
  function fromSection(section, width = 2) {
    const W = section?.W ?? section?.width, H = section?.H ?? section?.height, size = W * H;
    if (!Number.isSafeInteger(W) || !Number.isSafeInteger(H) || W < 1 || H < 1 || size > MAX_PIXELS)
      return unavailable('invalid-grid');
    if (section.width != null && section.width !== W || section.height != null && section.height !== H)
      return unavailable('coordinate-mismatch', W, H);
    if (!Number.isSafeInteger(width) || width < 0) return unavailable('invalid-band-width', W, H);
    if (section.released) return unavailable('released-section', W, H, width);
    const entries = Object.entries(section.rasters || {});
    if (!entries.length) return unavailable('missing-raw-rasters', W, H, width);
    // A partial union could create a false edge: explicitly incompatible raw
    // contributors invalidate the mask instead of silently dropping a channel.
    if (entries.some(([, r]) => !r || (r.W ?? r.width) !== W || (r.H ?? r.height) !== H ||
        !numericValues(r.values, size)) || !compatibleCoordinates(section, entries, W, H))
      return unavailable('coordinate-mismatch', W, H, width);

    const measured = new Uint8Array(size), hiddenMask = new Uint8Array(size);
    let measuredPixels = 0, hiddenPixels = 0;
    for (const [, raster] of entries) {
      for (let i = 0; i < size; i++) if (!measured[i] && Number.isFinite(raster.values[i])) {
        measured[i] = 1; measuredPixels++;
      }
    }
    const result = { status: 'available', reason: null, hiddenMask, width: W, height: H,
      bandWidth: width, measuredPixels, hiddenPixels: 0 };
    if (!width || !measuredPixels) return result;

    const distance = new Uint16Array(size); distance.fill(UNVISITED);
    const queue = new Uint32Array(size);
    let head = 0, tail = 0;
    function exterior(i) {
      if (!measured[i] && distance[i] === UNVISITED) { distance[i] = 0; queue[tail++] = i; }
    }
    // Equivalent to a one-pixel unmeasured pad flooded from outside using
    // four neighbors. Diagonally connected missing cells remain enclosed.
    for (let x = 0; x < W; x++) { exterior(x); exterior((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { exterior(y * W); exterior(y * W + W - 1); }
    while (head < tail) {
      const i = queue[head++], x = i % W, y = Math.floor(i / W);
      if (x) exterior(i - 1); if (x + 1 < W) exterior(i + 1);
      if (y) exterior(i - W); if (y + 1 < H) exterior(i + W);
    }
    function border(i) {
      if (distance[i] === UNVISITED) { distance[i] = 1; queue[tail++] = i; }
    }
    // Every image-border cell is one chessboard step from the virtual pad.
    // Zero-distance exterior seeds precede these distance-one seeds in FIFO.
    for (let x = 0; x < W; x++) { border(x); border((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { border(y * W); border(y * W + W - 1); }
    head = 0;
    while (head < tail) {
      const i = queue[head++], nextDistance = distance[i] + 1;
      if (nextDistance > width) continue;
      const x = i % W, y = Math.floor(i / W);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || x + dx < 0 || x + dx >= W || y + dy < 0 || y + dy >= H) continue;
        const j = i + dy * W + dx;
        if (distance[j] === UNVISITED) { distance[j] = nextDistance; queue[tail++] = j; }
      }
    }
    // Distance travels through every cell, including enclosed missing cells;
    // only acquired pixels are hidden. Neither values nor statistics change.
    for (let i = 0; i < size; i++) if (measured[i] && distance[i] !== UNVISITED && distance[i] <= width) {
      hiddenMask[i] = 1; hiddenPixels++;
    }
    result.hiddenPixels = hiddenPixels;
    return result;
  }
  global.Stack3DEdgeMask = Object.freeze({ fromSection });
})(window);
