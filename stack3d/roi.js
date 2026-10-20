/* ROI geometry uses the same raw MSI frame as the section plane. */
(function (global) {
  'use strict';
  global.Stack3DRoi = { create(T, doc, section) {
    const group = new T.Scene(), records = [];
    const pitchX = section.coordinateMode === 'pixel' ? 1 : section.umPerPxX / 1000;
    const pitchY = section.coordinateMode === 'pixel' ? 1 : section.umPerPxY / 1000;
    const point = ([x, y]) => new T.Vector3((x - section.W / 2) * pitchX,
      -(y - section.H / 2) * pitchY, 0);
    for (const polygon of global.Stack3D.roiPolygons(section).filter(p => p.visible)) {
      const points = polygon.vertices.map(point);
      const geometry = new T.BufferGeometry().setFromPoints(points);
      const material = new T.LineBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false, depthTest: false });
      material.color.setRGB(...polygon.color.map(v => v / 255));
      const line = new T.LineLoop(geometry, material);
      line.renderOrder = 900000; group.add(line);
      records.push({ name: polygon.name, line, points });
    }
    // One label per region on a section, even if it has disconnected contours.
    const labels = [];
    for (const name of new Set(records.map(r => r.name))) {
      const members = records.filter(r => r.name === name), anchor = new T.Vector3();
      const points = members.flatMap(r => r.points); points.forEach(p => anchor.add(p)); anchor.divideScalar(points.length);
      const canvas = doc.createElement('canvas'), ctx = canvas.getContext('2d');
      ctx.font = '24px sans-serif'; canvas.width = Math.min(2048, Math.ceil(ctx.measureText(name).width) + 24); canvas.height = 40;
      ctx.fillStyle = '#101824e8'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = '24px sans-serif'; ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'middle'; ctx.fillText(name, 12, 20, canvas.width - 24);
      const texture = new T.CanvasTexture(canvas); texture.colorSpace = T.SRGBColorSpace;
      const sprite = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false, side: T.DoubleSide }));
      sprite.position.copy(anchor); sprite.renderOrder = 950000;
      const height = Math.max(0.08, (section.sceneHeight ?? section.heightMm) * 0.035); sprite.scale.set(height * canvas.width / canvas.height, height, 1);
      group.add(sprite); labels.push({ name, sprite, texture });
    }
    return { group, faceCamera(camera) {
      for (const label of labels) { group.getWorldQuaternion(label.sprite.quaternion).invert().multiply(camera.quaternion); }
    }, update(settings) {
      const regions = Object.hasOwn(settings, 'regions') ? settings.regions : settings.region ? [settings.region] : null;
      const selected = Array.isArray(regions) ? new Set(regions) : null;
      group.visible = settings.visible;
      records.forEach(r => { r.line.visible = selected === null || selected.has(r.name); });
      labels.forEach(r => { r.sprite.visible = settings.labelsVisible && (selected === null || selected.has(r.name)); });
    }, stats() { return { contours: group.visible ? records.filter(r => r.line.visible).length : 0,
      labels: group.visible ? labels.filter(r => r.sprite.visible).map(r => r.name) : [] }; }, dispose() {
      records.forEach(r => { r.line.geometry.dispose(); r.line.material.dispose(); });
      labels.forEach(r => { r.texture.dispose(); r.sprite.geometry.dispose(); r.sprite.material.dispose(); }); group.clear();
    } };
  } };
})(window);
