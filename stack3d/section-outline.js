/* Measured-footprint outlines share the MSI plane's raw pixel-edge frame.
 * They are a presentation layer and never depend on intensity or ROI filters. */
(function (global) {
  'use strict';
  const DEFAULT_COLOR = '#ff3b30';
  function colorValue(value, fallback = DEFAULT_COLOR) {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
  }
  function create(T, section) {
    const group = new T.Scene(), records = [];
    const result = global.Stack3DOutline?.fromSection(section) || {
      status: 'unavailable', source: 'measured-footprint', reason: 'outline-helper-unavailable'
    };
    const width = Number(section.sceneWidth ?? section.widthMm), height = Number(section.sceneHeight ?? section.heightMm);
    const validGrid = Number.isSafeInteger(section.W) && section.W > 0 && Number.isSafeInteger(section.H) && section.H > 0 &&
      Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
    const contours = result.status === 'available' && validGrid && Array.isArray(result.contours) ? result.contours : [];
    for (const contour of contours) {
      if (!Array.isArray(contour) || contour.length < 3 ||
          contour.some(point => !Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) continue;
      const points = contour.map(([x, y]) => new T.Vector3((x / section.W - 0.5) * width, (0.5 - y / section.H) * height, 0));
      const geometry = new T.BufferGeometry().setFromPoints(points);
      const material = new T.LineBasicMaterial({ color: DEFAULT_COLOR, transparent: true, opacity: 0.8,
        depthWrite: false, depthTest: false, toneMapped: false, linewidth: 1 });
      const line = new T.LineLoop(geometry, material);
      // Keep region borders and their names above the complete section edge.
      line.renderOrder = 880000; group.add(line); records.push(line);
    }
    const status = records.length ? 'available' : 'unavailable';
    const reason = status === 'available' ? null : result.reason || (!validGrid ? 'invalid-grid' :
      result.status === 'available' ? 'invalid-contours' : 'footprint-unavailable');
    let settings = { visible: true, color: DEFAULT_COLOR, opacity: 0.8 }, disposed = false;
    function update(next = {}) {
      if (disposed) return;
      if (Object.hasOwn(next, 'visible')) settings.visible = !!next.visible;
      if (Object.hasOwn(next, 'color')) settings.color = colorValue(next.color, settings.color);
      if (Object.hasOwn(next, 'opacity') && Number.isFinite(Number(next.opacity))) settings.opacity = Math.max(0, Math.min(1, Number(next.opacity)));
      group.visible = status === 'available' && settings.visible && settings.opacity > 0;
      for (const line of records) { line.material.color.set(settings.color); line.material.opacity = settings.opacity; }
    }
    update();
    return { group, update, stats() {
      return { status, contours: records.length, visible: group.visible && !disposed, source: result.source || 'measured-footprint',
        reason, pixelCount: Number.isFinite(result.pixelCount) ? result.pixelCount : null, color: settings.color, opacity: settings.opacity,
        position: group.position.toArray(), rotationDeg: group.rotation.z * 180 / Math.PI };
    }, dispose() {
      if (disposed) return; disposed = true; group.visible = false;
      records.forEach(line => { line.geometry.dispose(); line.material.dispose(); }); group.clear();
    } };
  }
  global.Stack3DSectionOutline = { create };
})(window);
