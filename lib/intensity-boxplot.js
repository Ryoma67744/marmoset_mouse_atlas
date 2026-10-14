/* Intensity Box Plot presentation. All statistics and sampling are supplied by the caller. */
(function (global) {
  'use strict';

  const FONT = 'Arial, "Yu Gothic", sans-serif';
  const COLORS = { point: '#2496ed', upperTail: '#f08080', ink: '#111827', grid: '#e7e9ed' };
  const HEIGHT = 320;

  function finiteDistribution(distribution) {
    return distribution && distribution.n > 0 &&
      ['min', 'max', 'q1', 'median', 'q3', 'whiskerLow', 'whiskerHigh']
        .every(key => Number.isFinite(distribution[key]));
  }

  function numberLabel(value) {
    if (value === 0) return '0';
    const magnitude = Math.abs(value);
    if (magnitude >= 100000 || magnitude < 0.001) {
      return value.toExponential(2).replace(/\.?(0+)(?=e)/, '').replace('e+', 'e');
    }
    return String(Number(value.toPrecision(4)));
  }

  function shorten(ctx, value, width) {
    const text = String(value == null ? '' : value);
    if (ctx.measureText(text).width <= width) return text;
    const characters = Array.from(text);
    while (characters.length && ctx.measureText(characters.join('') + '…').width > width) characters.pop();
    return characters.join('') + '…';
  }

  function keyHash(key) {
    let hash = 2166136261;
    for (const char of String(key)) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash;
  }

  // The same observation stays in the same horizontal position after selection,
  // resize, or hiding another ROI. No random state or array order is involved.
  function jitter(rank, hash) {
    let value = Math.imul((Number(rank) || 0) + 1, 0x45d9f3b) ^ hash;
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value ^= value >>> 16;
    return ((value >>> 0) / 4294967295 - 0.5) * 30;
  }

  function axisDomain(rois) {
    let low = 0, high = 0, hasData = false;
    for (const roi of rois) {
      const d = roi.distribution;
      if (!finiteDistribution(d)) continue;
      hasData = true;
      low = Math.min(low, d.min);
      high = Math.max(high, d.max);
    }
    if (!hasData || low === high) return [low, high + 1];
    // Scale first so extreme finite values do not overflow when finding a span.
    const scale = Math.max(Math.abs(low), Math.abs(high));
    const padding = ((high / scale - low / scale) * 0.06) * scale;
    const paddedLow = low < 0 ? low - padding : low;
    const paddedHigh = high > 0 ? high + padding : high;
    return [Number.isFinite(paddedLow) ? paddedLow : low, Number.isFinite(paddedHigh) ? paddedHigh : high];
  }

  function axisTicks(domain) {
    const scale = Math.max(Math.abs(domain[0]), Math.abs(domain[1]), Number.MIN_VALUE);
    const span = domain[1] / scale - domain[0] / scale;
    const rough = (span / 5) * scale;
    const power = Math.pow(10, Math.floor(Math.log10(rough)));
    const fraction = rough / power;
    const step = (fraction >= 5 ? 5 : fraction >= 2 ? 2 : 1) * power;
    if (!(step > 0) || !Number.isFinite(step)) return [domain[0], domain[1]];
    const first = Math.ceil(domain[0] / step);
    const last = Math.floor(domain[1] / step);
    const ticks = [];
    for (let index = first; index <= last && ticks.length < 20; index++) ticks.push(index * step);
    return ticks;
  }

  function suppliedDomain(domain) {
    return Array.isArray(domain) && domain.length === 2 &&
      domain.every(Number.isFinite) && domain[0] < domain[1] ? domain.slice() : null;
  }

  // Only the aggregation layer has the complete population. Display samples
  // cannot supply an exact count of observations beyond the visible axis.
  function suppliedAboveCount(roi) {
    return Number.isSafeInteger(roi.aboveCount) && roi.aboveCount >= 0 &&
      finiteDistribution(roi.distribution) && roi.aboveCount <= roi.distribution.n ? roi.aboveCount : null;
  }

  /**
   * Draw one molecular channel using already-computed ROI distributions.
   * Returns CSS-pixel geometry for callers that need to inspect the layout.
   * The caller owns resize observation, scrolling, legends, and numeric tables.
   * Wrapped rows can provide all channel groups as axisRois to share a scale;
   * fitWidth opts out of the legacy scrollable minimum width for those rows.
   * An explicit domain overrides that scale. Each ROI can provide aboveCount,
   * computed from all observations for that domain, for an upper-edge marker.
   */
  function draw(canvas, options) {
    options = options || {};
    const rois = Array.isArray(options.rois) ? options.rois : [];
    const requestedWidth = Number.isFinite(options.width) ? options.width : 600;
    const width = options.fitWidth === true ? Math.max(220, Math.ceil(requestedWidth)) :
      Math.max(300, Math.ceil(requestedWidth), rois.length * 100 + 110);
    // 2D keeps its established height; compact 3D plots use the same geometry
    // and hit testing at an explicitly requested, readable height.
    const height = Number.isFinite(options.height) ? Math.max(228, Math.min(1200, Math.ceil(options.height))) : HEIGHT;
    const ratio = Math.max(1, Number(global.devicePixelRatio) || 1);
    canvas.width = Math.ceil(width * ratio);
    canvas.height = Math.ceil(height * ratio);
    Object.assign(canvas.style, { width: width + 'px', height: height + 'px', display: 'block', cursor: typeof options.onSelect === 'function' ? 'pointer' : 'default' });
    const title = String(options.title || 'Intensity Box Plot');
    const unit = String(options.unit || 'Intensity (a.u.)');
    const explicitDomain = suppliedDomain(options.domain);
    const domain = explicitDomain || axisDomain(Array.isArray(options.axisRois) ? options.axisRois : rois);
    const outsideCounts = Object.create(null);
    const outsideDescriptions = [];
    let hasAboveMarker = false;
    for (const roi of rois) {
      const d = roi.distribution;
      if (!finiteDistribution(d)) continue;
      const above = suppliedAboveCount(roi);
      outsideCounts[roi.key] = { above, min: d.min, max: d.max };
      if (above > 0) {
        hasAboveMarker = true;
        outsideDescriptions.push(String(roi.name || roi.key) + ': 表示上端を超える ' +
          above.toLocaleString('ja-JP') + '画素、最大 ' + String(d.max));
      }
    }
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', title + ' Intensity Box Plot。' + unit + '。箱は P25–P75、中央線は中央値、ひげは P0–P99。青点は P99 以下、赤点は P99 超。' + rois.map(roi => String(roi.name || roi.key) + ': ' + (finiteDistribution(roi.distribution) ? 'n = ' + roi.distribution.n : 'データなし')).join('。'));
    canvas.setAttribute('aria-description', (explicitDomain ? '縦軸の表示範囲 ' + domain[0] + '–' + domain[1] + '。' : '') +
      (hasAboveMarker ? '範囲外の値も統計に含みます。' + outsideDescriptions.join('。') : ''));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    const compactTitle = options.compactTitle === true;
    const left = 84, right = width - 20, top = compactTitle ? 48 : hasAboveMarker ? 70 : 47, bottom = height - 48;
    const scale = Math.max(Math.abs(domain[0]), Math.abs(domain[1]), Number.MIN_VALUE);
    const normalizedLow = domain[0] / scale;
    const normalizedSpan = domain[1] / scale - normalizedLow;
    // Values outside the domain are only used for clipped box/whisker geometry.
    // Bound that geometry beyond the clip rectangle to avoid overflow for a
    // very small explicit domain. Out-of-range observations are skipped below.
    const y = value => bottom - Math.max(-1, Math.min(2,
      (value / scale - normalizedLow) / normalizedSpan)) * (bottom - top);

    ctx.fillStyle = COLORS.ink;
    ctx.font = '600 13px ' + FONT;
    ctx.textAlign = 'left';
    if (!compactTitle) ctx.fillText(shorten(ctx, title, width - 24), 12, 22);
    ctx.font = '11px ' + FONT;
    for (const tick of axisTicks(domain)) {
      const py = y(tick);
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(left, py);
      ctx.lineTo(right, py);
      ctx.stroke();
      ctx.fillStyle = '#4b5563';
      ctx.textAlign = 'right';
      ctx.fillText(numberLabel(tick), left - 8, py + 4);
    }
    ctx.strokeStyle = '#4b5563';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(left, bottom);
    ctx.lineTo(right, bottom);
    ctx.stroke();
    ctx.save();
    ctx.translate(17, (top + bottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#374151';
    ctx.fillText(shorten(ctx, unit, bottom - top), 0, 0);
    ctx.restore();

    const slot = (right - left) / Math.max(1, rois.length);
    const groups = rois.map((roi, index) => {
      const center = left + slot * (index + 0.5);
      const boxX = center - 15, pointsX = center + 19;
      const selected = options.highlightRoiKey === roi.key;
      const d = roi.distribution;
      if (finiteDistribution(d)) {
        const hash = keyHash(roi.key);
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, top, right - left, bottom - top + 1);
        ctx.clip();
        for (const point of (d.points || [])) {
          if (!Number.isFinite(point.value) || point.value < domain[0] || point.value > domain[1]) continue;
          const upperTail = point.value > d.whiskerHigh;
          ctx.fillStyle = upperTail ? COLORS.upperTail : COLORS.point;
          ctx.globalAlpha = upperTail ? 0.9 : 0.7;
          ctx.beginPath();
          ctx.arc(pointsX + jitter(point.rank, hash), y(point.value), 1.1, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.strokeStyle = COLORS.ink;
        ctx.globalAlpha = 1;
        ctx.lineWidth = selected ? 1.8 : 1.1;
        ctx.beginPath();
        ctx.moveTo(boxX, y(d.whiskerLow));
        ctx.lineTo(boxX, y(d.whiskerHigh));
        for (const endpoint of [d.whiskerLow, d.whiskerHigh]) {
          ctx.moveTo(boxX - 8, y(endpoint));
          ctx.lineTo(boxX + 8, y(endpoint));
        }
        ctx.stroke();
        const boxTop = y(d.q3), boxHeight = Math.max(0.5, y(d.q1) - boxTop);
        ctx.fillStyle = '#fff';
        ctx.fillRect(boxX - 11, boxTop, 22, boxHeight);
        ctx.strokeRect(boxX - 11, boxTop, 22, boxHeight);
        ctx.lineWidth = selected ? 2.1 : 1.4;
        ctx.beginPath();
        ctx.moveTo(boxX - 11, y(d.median));
        ctx.lineTo(boxX + 11, y(d.median));
        ctx.stroke();
        ctx.restore();
        const above = outsideCounts[roi.key].above;
        if (above > 0) {
          ctx.font = '600 11px ' + FONT;
          ctx.fillStyle = '#b45309';
          ctx.textAlign = 'center';
          ctx.fillText(shorten(ctx, '↑ ' + above.toLocaleString('ja-JP') + '画素', slot - 8), center, top - 30);
          ctx.font = '10px ' + FONT;
          const maximumLabel = '最大 ' + numberLabel(d.max);
          ctx.fillText(shorten(ctx, maximumLabel, slot - 8), center, top - 14);
          // The arrow describes omitted observations, not a relocated point.
          ctx.strokeStyle = '#b45309';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(pointsX, top + 8);
          ctx.lineTo(pointsX, top + 1);
          ctx.moveTo(pointsX - 3, top + 4);
          ctx.lineTo(pointsX, top + 1);
          ctx.lineTo(pointsX + 3, top + 4);
          ctx.stroke();
        }
      } else {
        ctx.font = '12px ' + FONT;
        ctx.fillStyle = '#9ca3af';
        ctx.textAlign = 'center';
        ctx.fillText('データなし', center, (top + bottom) / 2);
      }
      ctx.font = (selected ? '600 ' : '') + '11px ' + FONT;
      ctx.fillStyle = selected ? COLORS.ink : '#374151';
      ctx.textAlign = 'center';
      ctx.fillText(shorten(ctx, roi.name || roi.key, slot - 10), center, bottom + 20);
      ctx.font = '11px ' + FONT;
      ctx.fillStyle = '#6b7280';
      ctx.fillText(finiteDistribution(d) ? 'n = ' + d.n.toLocaleString('en-US') : 'n = —', center, bottom + 36);
      return { key: roi.key, center, left: left + index * slot, right: left + (index + 1) * slot };
    });
    if (!rois.length) {
      ctx.font = '12px ' + FONT;
      ctx.fillStyle = '#9ca3af';
      ctx.textAlign = 'center';
      ctx.fillText('表示中の ROI がありません', (left + right) / 2, (top + bottom) / 2);
    }

    // Replaced on redraw, avoiding stale ROI closures and duplicate listeners.
    canvas.onclick = typeof options.onSelect === 'function' ? event => {
      const rect = canvas.getBoundingClientRect();
      if (!(rect.width > 0) || !(rect.height > 0)) return;
      const px = (event.clientX - rect.left) * width / rect.width;
      const py = (event.clientY - rect.top) * height / rect.height;
      if (py < top || py > height || px < left || px > right) return;
      const group = groups.find(group => px >= group.left && px <= group.right);
      if (group) options.onSelect(group.key);
    } : null;
    return { width, height, domain, groups, outsideCounts };
  }

  global.IntensityBoxPlot = { draw };
})(typeof window !== 'undefined' ? window : globalThis);
