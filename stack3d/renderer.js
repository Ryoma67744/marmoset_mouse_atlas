/* Serial-section renderer. XY is measured in mm; Z is an ordinal display axis.
 * Three.js / OrbitControls are vendored separately under their MIT license.
 * Rendering and camera changes never modify measured raster values. */
(function (global) {
  'use strict';
  const T = global.AtlasThree;
  const RAD = Math.PI / 180;
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

  function createRenderer(container, { onSelect = () => {}, onError = () => {} } = {}) {
    if (!container || !container.ownerDocument) throw new TypeError('3D表示先が見つかりません。');
    const doc = container.ownerDocument, win = doc.defaultView;
    const canvas = doc.createElement('canvas');
    canvas.className = 'stack3d-canvas'; canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', '3D切片モデル。ドラッグで回転、ホイールで拡大縮小、右ドラッグで移動。');
    Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none' });
    let renderer;
    try { renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: false }); }
    catch (cause) { throw new Error('3D表示を開始できません。WebGL 2が利用可能なブラウザーで開いてください。', { cause }); }
    renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.NoToneMapping;
    renderer.setClearColor(0x0b1420, 1); container.appendChild(canvas);
    const scene = new T.Scene(), camera = new T.PerspectiveCamera(36, 1, 0.01, 10000);
    const controls = new T.OrbitControls(camera, canvas);
    controls.enableDamping = false; controls.screenSpacePanning = true;
    controls.minDistance = 0.2; controls.maxDistance = 5000;
    const raycaster = new T.Raycaster(), pointer = new T.Vector2(), scratch = new T.Vector3();
    let entries = [], byId = new Map(), selected = -1, spacing = 0.35, opacity = 1, range = [0, -1];
    let disposed = false, contextLost = false, pendingFrame = null, renderCount = 0, pointerDown = null, viewSet = false;
    const pointers = new Set();
    const outlineGeometry = new T.BufferGeometry();
    outlineGeometry.setAttribute('position', new T.Float32BufferAttribute([-0.5,-0.5,0, 0.5,-0.5,0, 0.5,0.5,0, -0.5,0.5,0], 3));
    const outlineMaterial = new T.LineBasicMaterial({ color: 0xffb568, depthTest: false, transparent: true, opacity: 0.95 });
    const outline = new T.LineLoop(outlineGeometry, outlineMaterial);
    outline.renderOrder = 1000000; outline.visible = false; scene.add(outline);

    function report(error) { if (!disposed) onError(error instanceof Error ? error : new Error(String(error))); }
    function render() {
      if (disposed || contextLost) return;
      camera.updateMatrixWorld();
      // Parallel planes are composited from the farthest Z plane. The order
      // reverses as the camera crosses the stack; per-pixel depth still applies.
      const visible = entries.filter(entry => entry.mesh.visible);
      for (const entry of visible) entry.depth = -Math.abs(entry.mesh.position.z - camera.position.z);
      visible.sort((a, b) => a.depth - b.depth || a.index - b.index);
      visible.forEach((entry, index) => { entry.mesh.renderOrder = index; });
      try { renderer.render(scene, camera); renderCount++; } catch (error) { report(error); }
    }
    function scheduleRender() {
      if (disposed || contextLost || pendingFrame !== null) return;
      pendingFrame = win.requestAnimationFrame(() => { pendingFrame = null; render(); });
    }
    function resize() {
      if (disposed) return;
      const width = Math.max(1, container.clientWidth || 640), height = Math.max(1, container.clientHeight || 480);
      renderer.setSize(width, height, false); camera.aspect = width / height;
      camera.updateProjectionMatrix(); scheduleRender();
    }
    function position(entry) {
      const d = entry.descriptor;
      entry.mesh.rotation.z = -(d.angleDeg + d.rotationDeg) * RAD;
      entry.mesh.position.set(d.offsetXUm / 1000, -d.offsetYUm / 1000, (entry.index - (entries.length - 1) / 2) * spacing);
      entry.mesh.updateMatrixWorld();
    }
    function updateOutline() {
      const entry = entries[selected]; outline.visible = !!entry && entry.mesh.visible;
      if (!entry) return;
      outline.position.copy(entry.mesh.position); outline.quaternion.copy(entry.mesh.quaternion);
      outline.scale.set(entry.descriptor.widthMm, entry.descriptor.heightMm, 1); outline.updateMatrixWorld();
    }
    function updateVisibility() {
      for (const entry of entries) entry.mesh.visible = entry.index >= range[0] && entry.index <= range[1] && !!entry.texture;
      updateOutline(); scheduleRender();
    }
    function setTexture(entry, source) {
      if (!source || !source.width || !source.height) {
        if (entry.texture) entry.texture.dispose();
        entry.texture = null; entry.alphaPixels = null; entry.mesh.material.map = null; entry.mesh.material.needsUpdate = true;
        return;
      }
      if (Math.max(source.width, source.height) > renderer.capabilities.maxTextureSize) throw new Error(`${entry.descriptor.name}: 画像サイズがGPUの上限を超えています。`);
      if (entry.texture) { entry.texture.image = source; entry.texture.needsUpdate = true; }
      else {
        entry.texture = new T.CanvasTexture(source); entry.texture.colorSpace = T.SRGBColorSpace;
        entry.texture.minFilter = T.NearestFilter; entry.texture.magFilter = T.NearestFilter; entry.texture.generateMipmaps = false;
        entry.mesh.material.map = entry.texture; entry.mesh.material.needsUpdate = true;
      }
      entry.textureWidth = source.width; entry.textureHeight = source.height;
      try { entry.alphaPixels = source.getContext('2d').getImageData(0, 0, source.width, source.height).data; }
      catch (_) { entry.alphaPixels = null; }
    }
    function release(entry) {
      scene.remove(entry.mesh); entry.mesh.geometry.dispose(); entry.mesh.material.dispose();
      if (entry.texture) entry.texture.dispose(); entry.alphaPixels = null;
    }
    function setSections(descriptors) {
      if (disposed) return;
      if (!Array.isArray(descriptors)) throw new TypeError('切片一覧は配列で指定してください。');
      const ids = new Set();
      const checked = descriptors.map(d => {
        if (!d || d.id == null || !Number.isFinite(Number(d.widthMm)) || Number(d.widthMm) <= 0 ||
            !Number.isFinite(Number(d.heightMm)) || Number(d.heightMm) <= 0) throw new TypeError('切片のIDまたはXYサイズが不正です。');
        const id = String(d.id); if (ids.has(id)) throw new Error(`切片IDが重複しています: ${id}`); ids.add(id);
        return { ...d, id, name: String(d.name || id), widthMm: Number(d.widthMm), heightMm: Number(d.heightMm),
          angleDeg: finite(d.angleDeg), rotationDeg: finite(d.rotationDeg), offsetXUm: finite(d.offsetXUm), offsetYUm: finite(d.offsetYUm) };
      });
      const selectedId = entries[selected]?.descriptor.id, previous = byId; byId = new Map();
      entries = checked.map((d, index) => {
        let entry = previous.get(d.id);
        if (entry) {
          previous.delete(d.id);
          if (entry.descriptor.widthMm !== d.widthMm || entry.descriptor.heightMm !== d.heightMm) {
            entry.mesh.geometry.dispose(); entry.mesh.geometry = new T.PlaneGeometry(d.widthMm, d.heightMm);
          }
          entry.descriptor = d; entry.index = index;
        } else {
          const material = new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity, side: T.DoubleSide,
            depthWrite: false, depthTest: true, alphaTest: 0.001, toneMapped: false });
          material.forceSinglePass = true;
          const mesh = new T.Mesh(new T.PlaneGeometry(d.widthMm, d.heightMm), material);
          entry = { descriptor: d, index, mesh, texture: null, alphaPixels: null }; scene.add(mesh);
        }
        entry.mesh.userData.sectionId = d.id; byId.set(d.id, entry);
        if (Object.hasOwn(d, 'textureCanvas')) setTexture(entry, d.textureCanvas);
        return entry;
      });
      for (const entry of previous.values()) release(entry);
      range = [0, entries.length - 1]; selected = entries.findIndex(e => e.descriptor.id === selectedId);
      if (selected < 0 && entries.length) selected = 0;
      entries.forEach(position); updateVisibility(); if (!viewSet) resetView();
    }
    function updateTextures(textures) {
      if (disposed) return;
      for (const [id, source] of textures instanceof Map ? textures : Object.entries(textures || {})) {
        const entry = byId.get(String(id)); if (entry) setTexture(entry, source);
      }
      updateVisibility();
    }
    function setSpacing(value) {
      if (disposed) return; spacing = Math.max(0.001, Math.min(100, finite(value, spacing)));
      entries.forEach(position); updateOutline(); scheduleRender();
    }
    function setRange(start, end) {
      const last = entries.length - 1, a = Math.min(last, Math.max(0, Math.round(finite(start)))), b = Math.min(last, Math.max(0, Math.round(finite(end, last))));
      range = [Math.min(a, b), Math.max(a, b)]; updateVisibility();
    }
    function select(index) { selected = Number.isInteger(index) && index >= 0 && index < entries.length ? index : -1; updateOutline(); scheduleRender(); }
    function setPlacement(id, values = {}) {
      const entry = byId.get(String(id)); if (!entry) return;
      for (const key of ['offsetXUm', 'offsetYUm', 'rotationDeg']) if (Object.hasOwn(values, key)) entry.descriptor[key] = finite(values[key], entry.descriptor[key]);
      position(entry); updateOutline(); scheduleRender();
    }
    function bounds() {
      const box = new T.Box3();
      for (const entry of entries) {
        const d = entry.descriptor;
        for (const x of [-d.widthMm / 2, d.widthMm / 2]) for (const y of [-d.heightMm / 2, d.heightMm / 2]) box.expandByPoint(scratch.set(x, y, 0).applyMatrix4(entry.mesh.matrixWorld));
      }
      if (box.isEmpty()) { box.min.set(-10, -10, -10); box.max.set(10, 10, 10); } return box;
    }
    function resetView() {
      if (disposed) return; resize();
      const box = bounds(), center = box.getCenter(new T.Vector3()), radius = Math.max(box.getSize(new T.Vector3()).length() / 2, 1);
      const vertical = camera.fov * RAD / 2, horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
      const distance = radius / Math.sin(Math.min(vertical, horizontal)) * 1.12;
      camera.zoom = 1; camera.position.copy(center).add(new T.Vector3(0.82, 0.45, 1.25).normalize().multiplyScalar(distance));
      camera.up.set(0, 1, 0); controls.target.copy(center); camera.near = Math.max(0.001, distance / 10000); camera.far = Math.max(10000, distance * 20);
      camera.updateProjectionMatrix(); controls.update(); controls.saveState(); viewSet = entries.length > 0; scheduleRender();
    }
    function getView() { return { version: 1, position: camera.position.toArray(), target: controls.target.toArray(), up: camera.up.toArray(), zoom: camera.zoom }; }
    function setView(view) {
      if (disposed || !view) return false;
      const valid = value => Array.isArray(value) && value.length === 3 && value.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 1e8);
      if (!valid(view.position) || !valid(view.target) || new T.Vector3(...view.position).distanceTo(new T.Vector3(...view.target)) < 1e-5) return false;
      camera.position.fromArray(view.position); controls.target.fromArray(view.target);
      if (valid(view.up) && new T.Vector3(...view.up).lengthSq() > 0) camera.up.fromArray(view.up).normalize();
      camera.zoom = Math.max(0.01, Math.min(100, finite(view.zoom, 1))); camera.updateProjectionMatrix();
      controls.update(); viewSet = true; scheduleRender(); return true;
    }
    function pick(event) {
      if (disposed || contextLost || opacity <= 0) return;
      const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return;
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      camera.updateMatrixWorld(); raycaster.setFromCamera(pointer, camera);
      for (const hit of raycaster.intersectObjects(entries.filter(e => e.mesh.visible).map(e => e.mesh), false)) {
        const entry = byId.get(hit.object.userData.sectionId); if (!entry) continue;
        if (entry.alphaPixels && hit.uv) {
          const x = Math.min(entry.textureWidth - 1, Math.max(0, Math.floor(hit.uv.x * entry.textureWidth)));
          const y = Math.min(entry.textureHeight - 1, Math.max(0, Math.floor((1 - hit.uv.y) * entry.textureHeight)));
          if (entry.alphaPixels[(y * entry.textureWidth + x) * 4 + 3] === 0) continue;
        }
        select(entry.index); onSelect(entry.index); break;
      }
    }
    function onPointerDown(event) {
      pointers.add(event.pointerId);
      if (event.button !== 0 || pointers.size > 1) { pointerDown = null; return; }
      pointerDown = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    }
    function onPointerMove(event) { if (pointerDown && pointerDown.id === event.pointerId && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5) pointerDown.moved = true; }
    function onPointerUp(event) {
      pointers.delete(event.pointerId); const down = pointerDown; pointerDown = null;
      if (down && down.id === event.pointerId && !down.moved && Math.hypot(event.clientX - down.x, event.clientY - down.y) <= 5) pick(event);
    }
    function onPointerCancel(event) { pointers.delete(event.pointerId); pointerDown = null; }
    function onContextLost(event) {
      event.preventDefault(); contextLost = true;
      if (pendingFrame !== null) { win.cancelAnimationFrame(pendingFrame); pendingFrame = null; }
      report(new Error('3D描画が中断されました。表示データを減らすか、ページを再読み込みしてください。保存済みの測定値は保持されています。'));
    }
    function onContextRestored() { contextLost = false; for (const entry of entries) if (entry.texture) entry.texture.needsUpdate = true; scheduleRender(); }
    const events = { pointerdown: onPointerDown, pointermove: onPointerMove, pointerup: onPointerUp, pointercancel: onPointerCancel,
      webglcontextlost: onContextLost, webglcontextrestored: onContextRestored };
    controls.addEventListener('change', scheduleRender);
    for (const [name, handler] of Object.entries(events)) canvas.addEventListener(name, handler);
    const observer = win.ResizeObserver ? new win.ResizeObserver(resize) : null;
    if (observer) observer.observe(container); else win.addEventListener('resize', resize);
    resize(); resetView();
    function capturePNG() {
      if (disposed || contextLost) throw new Error('3D描画を利用できないため画像を保存できません。');
      render(); return canvas.toDataURL('image/png');
    }
    function setOpacity(value) { opacity = Math.max(0, Math.min(1, finite(value, opacity))); for (const entry of entries) entry.mesh.material.opacity = opacity; scheduleRender(); }
    function getStats() {
      return { threeVersion: '186', sectionCount: entries.length, visibleCount: entries.filter(e => e.mesh.visible).length,
        textureCount: entries.filter(e => e.texture).length, selectedIndex: selected, spacing, range: [...range], opacity,
        contextLost, disposed, renderCount, canvasWidth: canvas.width, canvasHeight: canvas.height,
        gpuGeometries: renderer.info.memory.geometries, gpuTextures: renderer.info.memory.textures,
        drawOrder: entries.filter(e => e.mesh.visible).sort((a, b) => a.mesh.renderOrder - b.mesh.renderOrder).map(e => e.descriptor.id) };
    }
    function dispose() {
      if (disposed) return; disposed = true;
      if (pendingFrame !== null) win.cancelAnimationFrame(pendingFrame);
      if (observer) observer.disconnect(); else win.removeEventListener('resize', resize);
      controls.removeEventListener('change', scheduleRender); controls.dispose();
      for (const [name, handler] of Object.entries(events)) canvas.removeEventListener(name, handler);
      entries.forEach(release); entries = []; byId.clear(); outlineGeometry.dispose(); outlineMaterial.dispose();
      renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
    }
    return { setSections, updateTextures, setSpacing, setRange, select, setPlacement, resetView, getView, setView, capturePNG, setOpacity, dispose, getStats };
  }
  global.Stack3DRenderer = { createRenderer };
})(window);
