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

  /**
   * Draw one molecular channel using already-computed ROI distributions.
   * Returns CSS-pixel geometry for callers that need to inspect the layout.
   * The caller owns resize observation, scrolling, legends, and numeric tables.
   */
  function draw(canvas, options) {
    options = options || {};
    const rois = Array.isArray(options.rois) ? options.rois : [];
    const requestedWidth = Number.isFinite(options.width) ? options.width : 600;
    const width = Math.max(300, Math.ceil(requestedWidth), rois.length * 100 + 110);
    const height = HEIGHT;
    const ratio = Math.max(1, Number(global.devicePixelRatio) || 1);
    canvas.width = Math.ceil(width * ratio);
    canvas.height = Math.ceil(height * ratio);
    Object.assign(canvas.style, { width: width + 'px', height: height + 'px', display: 'block', cursor: typeof options.onSelect === 'function' ? 'pointer' : 'default' });
    const title = String(options.title || 'Intensity Box Plot');
    const unit = String(options.unit || 'Intensity (a.u.)');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', title + ' Intensity Box Plot。' + unit + '。箱は P25–P75、中央線は中央値、ひげは P0–P99。青点は P99 以下、赤点は P99 超。' + rois.map(roi => String(roi.name || roi.key) + ': ' + (finiteDistribution(roi.distribution) ? 'n = ' + roi.distribution.n : 'データなし')).join('。'));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    const left = 84, right = width - 20, top = 47, bottom = height - 48;
    const domain = axisDomain(rois);
    const scale = Math.max(Math.abs(domain[0]), Math.abs(domain[1]), Number.MIN_VALUE);
    const normalizedLow = domain[0] / scale;
    const normalizedSpan = domain[1] / scale - normalizedLow;
    const y = value => bottom - (value / scale - normalizedLow) / normalizedSpan * (bottom - top);

    ctx.fillStyle = COLORS.ink;
    ctx.font = '600 13px ' + FONT;
    ctx.textAlign = 'left';
    ctx.fillText(shorten(ctx, title, width - 24), 12, 22);
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
          if (!Number.isFinite(point.value)) continue;
          const upperTail = point.value > d.whiskerHigh;
          ctx.fillStyle = upperTail ? COLORS.upperTail : COLORS.point;
          ctx.globalAlpha = upperTail ? 0.9 : 0.7;
          ctx.beginPath();
          ctx.arc(pointsX + jitter(point.rank, hash), y(point.value), 1.1, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
        ctx.strokeStyle = COLORS.ink;
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
    return { width, height, domain, groups };
  }

  global.IntensityBoxPlot = { draw };
})(typeof window !== 'undefined' ? window : globalThis);
