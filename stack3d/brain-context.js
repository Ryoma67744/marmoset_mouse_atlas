/* Optional, procedural marmoset brain illustration.
 * This is a schematic context, NOT an anatomical atlas or registered surface.
 * Its display dimensions follow the complete section stack. No acquired data,
 * hemisphere assignment, anatomical coordinates, or measurements are inferred.
 */
(function (global) {
  'use strict';

  function createContext(T) {
    const objects = [], geometries = [], materials = [];
    const modelBounds = new T.Box3(), displayBounds = new T.Box3();
    let opacity = 0.12, visible = false, disposed = false;
    const point = new T.Vector3();

    // The common marmoset has a relatively smooth cerebral surface. These
    // rounded hemispheres deliberately omit the deep gyri of a human brain.
    // Cor numbering advances along +Z: cerebellum to olfactory bulb.
    const parts = [
      { name: 'cerebrum-a', center: [-0.40, 0.10, 0.12], radius: [0.385, 0.64, 0.84], tone: [0.64, 0.77, 0.83], cortex: true },
      { name: 'cerebrum-b', center: [ 0.40, 0.10, 0.12], radius: [0.385, 0.64, 0.84], tone: [0.64, 0.77, 0.83], cortex: true },
      { name: 'cerebellum-a', center: [-0.27, -0.26, -0.78], radius: [0.38, 0.31, 0.35], tone: [0.65, 0.74, 0.76], folia: true },
      { name: 'cerebellum-b', center: [ 0.27, -0.26, -0.78], radius: [0.38, 0.31, 0.35], tone: [0.65, 0.74, 0.76], folia: true },
      { name: 'brainstem', center: [0, -0.63, -0.58], radius: [0.14, 0.49, 0.17], tone: [0.70, 0.74, 0.73], stem: true },
      { name: 'olfactory-a', center: [-0.17, -0.25, 1.00], radius: [0.105, 0.12, 0.22], tone: [0.75, 0.79, 0.79] },
      { name: 'olfactory-b', center: [ 0.17, -0.25, 1.00], radius: [0.105, 0.12, 0.22], tone: [0.75, 0.79, 0.79] }
    ];

    function surfacePoint(part, latitude, longitude) {
      const ring = Math.sin(latitude), nx = ring * Math.cos(longitude);
      const ny = Math.cos(latitude), nz = ring * Math.sin(longitude);
      // A broad dorsal surface and gently tapering frontal pole, with only
      // low-amplitude contour variation; this is an illustration, not a fit.
      const taper = part.cortex ? 1 - 0.10 * Math.max(0, nz) : 1;
      const fold = part.folia ? 1 + 0.022 * Math.cos(latitude * 24) : 1;
      return [part.center[0] + nx * part.radius[0] * taper * fold,
        part.center[1] + ny * part.radius[1] * fold,
        part.center[2] + nz * part.radius[2] * fold + (part.stem ? -0.20 * ny : 0)];
    }

    function addSurface(part) {
      const positions = [], colors = [], rows = 28, columns = 48;
      function vertex(row, column) {
        const latitude = row / rows * Math.PI, longitude = column / columns * Math.PI * 2;
        const xyz = surfacePoint(part, latitude, longitude);
        positions.push(...xyz);
        const shade = 0.50 + 0.30 * Math.max(0, Math.cos(latitude)) +
          0.20 * Math.max(0, Math.sin(latitude) * Math.cos(longitude - 0.7));
        // MeshBasicMaterial has no scene-light dependency. Vertex shading
        // makes the thin translucent shell legible without affecting MSI.
        colors.push(...part.tone.map(channel => channel * shade));
      }
      for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
        vertex(row, column); vertex(row + 1, column + 1); vertex(row + 1, column);
        vertex(row, column); vertex(row, column + 1); vertex(row + 1, column + 1);
      }
      const geometry = new T.BufferGeometry();
      geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
      geometry.computeBoundingBox(); modelBounds.union(geometry.boundingBox);
      const material = new T.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity,
        side: T.DoubleSide, depthWrite: false, depthTest: true, toneMapped: false });
      material.forceSinglePass = true;
      const mesh = new T.Mesh(geometry, material);
      mesh.name = 'schematic-' + part.name; mesh.renderOrder = -10000;
      mesh.userData.schematic = true; mesh.userData.opacityFactor = 0.62;
      geometries.push(geometry); materials.push(material); objects.push(mesh);
    }

    function addContour(part, latitude, strength = 1) {
      const positions = [];
      for (let i = 0; i < 96; i++) positions.push(...surfacePoint(part, latitude, i / 96 * Math.PI * 2));
      const geometry = new T.BufferGeometry();
      geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
      const material = new T.LineBasicMaterial({ color: 0xb8d3df, transparent: true, opacity,
        depthWrite: false, depthTest: true, toneMapped: false });
      const line = new T.LineLoop(geometry, material);
      line.name = 'schematic-contour-' + part.name; line.renderOrder = -9999;
      line.userData.schematic = true; line.userData.opacityFactor = strength;
      geometries.push(geometry); materials.push(material); objects.push(line);
    }

    for (const part of parts) {
      addSurface(part);
      if (part.cortex) {
        // Sparse surface contours, not parcel boundaries or anatomical ROIs.
        for (const fraction of [0.27, 0.50, 0.72]) addContour(part, Math.PI * fraction, fraction === 0.50 ? 1.15 : 0.60);
      } else if (part.folia) {
        for (let i = 2; i <= 10; i++) addContour(part, Math.PI * i / 12, 0.90);
      } else addContour(part, Math.PI / 2, 0.90);
    }

    function setBounds(box) {
      if (disposed || !box || box.isEmpty()) return;
      const size = box.getSize(new T.Vector3()), center = box.getCenter(new T.Vector3());
      const nativeSize = modelBounds.getSize(new T.Vector3()), nativeCenter = modelBounds.getCenter(new T.Vector3());
      // Keep an anatomical-looking illustration for a single section as well
      // as a long stack. Z remains an ordinal display axis, not real distance.
      const width = Math.max(size.x, 1), height = Math.max(size.y, 1);
      const desiredSize = new T.Vector3(width * 1.65, height * 1.50, Math.max(size.z * 1.12, Math.sqrt(width * height) * 1.25));
      const scale = desiredSize.divide(nativeSize);
      center.y -= height * 0.10;
      const position = center.sub(nativeCenter.multiply(scale));
      for (const object of objects) {
        object.scale.copy(scale); object.position.copy(position); object.updateMatrixWorld();
      }
      displayBounds.makeEmpty();
      for (const x of [modelBounds.min.x, modelBounds.max.x]) for (const y of [modelBounds.min.y, modelBounds.max.y]) {
        for (const z of [modelBounds.min.z, modelBounds.max.z]) displayBounds.expandByPoint(point.set(x, y, z).multiply(scale).add(position));
      }
    }
    function setOpacity(value) {
      if (disposed) return;
      opacity = Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : opacity;
      for (const object of objects) object.material.opacity = Math.min(1, opacity * object.userData.opacityFactor);
      setVisible(visible);
    }
    function setVisible(value) { visible = !!value; for (const object of objects) object.visible = !disposed && visible && opacity > 0; }
    function getBounds() { return displayBounds.clone(); }
    function getStats() {
      return { objectCount: disposed ? 0 : objects.length, bounds: displayBounds.isEmpty() ? null :
        { min: displayBounds.min.toArray(), max: displayBounds.max.toArray() }, schematic: true, registered: false };
    }
    function dispose() {
      if (disposed) return; disposed = true;
      for (const object of objects) object.visible = false;
      geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose());
    }
    setOpacity(opacity); setVisible(false);
    return { objects, setBounds, setOpacity, setVisible, getBounds, getStats, dispose };
  }
  global.Stack3DBrainContext = { createContext };
})(window);
