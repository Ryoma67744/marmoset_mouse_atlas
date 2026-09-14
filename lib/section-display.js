/* Shared raster presentation for section stacks. Values are never modified. */
(function (global) {
  'use strict';
  // Keep the established Viewer compound colours (NE is yellow).
  const COLORS = Object.freeze({ DA: Object.freeze([255, 0, 0]), NE: Object.freeze([255, 255, 0]), '5-HT': Object.freeze([0, 255, 0]) });
  const clamp = value => Math.max(0, Math.min(1, value));
  function paintChannel(values, rawValues, W, H, options) {
    const opts = options || {};
    const canvas = global.MSIRaster.paintRasterToCanvas(values, W, H, {
      color: COLORS[opts.analyte] || null, win: opts.range, gamma: 1
    });
    if (opts.derived) {
      const ctx = canvas.getContext('2d'), pixels = ctx.getImageData(0, 0, W, H);
      for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(values[i]) && Number.isFinite(rawValues[i])) pixels.data.set([128, 128, 128, 255], i * 4);
      }
      ctx.putImageData(pixels, 0, 0);
    }
    return canvas;
  }
  function mergeChannels(layers, W, H, options) {
    const opts = options || {}, threshold = clamp(Number(opts.threshold) || 0);
    const preview = document.createElement('canvas'); preview.width = W; preview.height = H;
    const ctx = preview.getContext('2d', { willReadFrequently: true });
    // Native additive composition matches the 2D Viewer, within one section.
    ctx.globalCompositeOperation = 'lighter';
    for (const layer of layers) {
      ctx.globalAlpha = Number.isFinite(layer.opacity) ? clamp(layer.opacity) : 1;
      ctx.drawImage(layer.canvas, 0, 0);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    const image = ctx.getImageData(0, 0, W, H);
    const measured = new Uint8Array(W * H), invalid = new Uint8Array(W * H);
    const signal = new Float32Array(W * H), invalidSignal = new Float32Array(W * H);
    for (const layer of layers) {
      const opacity = Number.isFinite(layer.opacity) ? clamp(layer.opacity) : 1;
      for (let i = 0; i < W * H; i++) {
        if (Number.isFinite(layer.rawValues[i])) measured[i] = 1;
        if (layer.derived && Number.isFinite(layer.rawValues[i]) && !Number.isFinite(layer.values[i])) {
          invalid[i] = 1; invalidSignal[i] = Math.max(invalidSignal[i], 0.35 * opacity);
        }
        if (Number.isFinite(layer.values[i])) signal[i] = Math.max(signal[i], global.MSIRaster.msiValueEval(layer.values[i], layer.range) * opacity);
      }
    }
    const texture = document.createElement('canvas'); texture.width = W; texture.height = H;
    const textureCtx = texture.getContext('2d'), pixels = textureCtx.createImageData(W, H);
    let measuredPixels = 0, invalidPixels = 0, visiblePixels = 0;
    for (let i = 0; i < W * H; i++) {
      const p = i * 4;
      if (measured[i]) measuredPixels++;
      if (invalid[i]) invalidPixels++;
      // Native canvas reads unpremultiplied RGB. Flatten against black before
      // assigning the independent, explicitly display-only 3D opacity.
      const a = image.data[p + 3] / 255;
      pixels.data[p] = Math.round(image.data[p] * a);
      pixels.data[p + 1] = Math.round(image.data[p + 1] * a);
      pixels.data[p + 2] = Math.round(image.data[p + 2] * a);
      const strength = Math.max(invalidSignal[i], signal[i]);
      const alpha = invalidSignal[i] > 0 ? strength : strength > threshold ? (strength - threshold) / (1 - threshold) : 0;
      pixels.data[p + 3] = measured[i] ? Math.round(255 * clamp(alpha)) : 0;
      if (pixels.data[p + 3]) visiblePixels++;
    }
    textureCtx.putImageData(pixels, 0, 0);
    return { canvas: texture, previewCanvas: preview, measuredPixels, invalidPixels, visiblePixels };
  }
  global.SectionDisplay = { COLORS, paintChannel, mergeChannels };
})(window);

