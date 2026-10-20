/* Serial-section renderer. XY is mm or explicit uncalibrated pixels;
 * Z is an ordinal display axis in the same scene coordinate system.
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
    let entries = [], byId = new Map(), hiddenSectionIds = new Set(), selected = -1, spacing = 0.595, opacity = 1, range = [0, -1], zCenter = 0;
    let heVisible = false, heOpacity = 0.12;
    let brainVisible = false, brainOpacity = 0.12, brainContext = null;
    let disposed = false, contextLost = false, pendingFrame = null, renderCount = 0, pointerDown = null, viewSet = false;
    let roiSettings = { visible: true, regions: null, labelsVisible: true };
    let sectionOutlineSettings = { visible: true, color: '#ff3b30', opacity: 0.8 };
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
      const visible = entries.filter(entry => entry.mesh.visible || entry.he.mesh.visible);
      for (const entry of visible) entry.depth = -Math.abs(entry.mesh.position.z - camera.position.z);
      visible.sort((a, b) => a.depth - b.depth || a.index - b.index);
      // HE and MSI occupy the exact same scientific section plane. Neither
      // writes depth, and this explicit order composites HE first, then MSI,
      // without introducing an artificial Z offset or depth-buffer fighting.
      visible.forEach((entry, index) => { entry.he.mesh.renderOrder = index * 2; entry.mesh.renderOrder = index * 2 + 1; });
      entries.forEach(entry => entry.roi?.faceCamera(camera));
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
      const d = entry.descriptor, placement = global.Stack3D.scenePlacement(d);
      entry.mesh.rotation.z = placement.angleDeg * RAD;
      entry.mesh.position.set(placement.x, placement.y, (entry.zIndex - zCenter) * spacing);
      entry.mesh.updateMatrixWorld();
      if (entry.roi) { entry.roi.group.position.copy(entry.mesh.position); entry.roi.group.rotation.copy(entry.mesh.rotation); }
      if (entry.sectionOutline) {
        entry.sectionOutline.group.position.copy(entry.mesh.position);
        entry.sectionOutline.group.quaternion.copy(entry.mesh.quaternion);
        entry.sectionOutline.group.updateMatrixWorld();
      }
      entry.he.mesh.rotation.z = global.Stack3D.scenePlacement(d, true).angleDeg * RAD;
      entry.he.mesh.position.copy(entry.mesh.position); entry.he.mesh.updateMatrixWorld();
    }
    function updateOutline() {
      const entry = entries[selected]; outline.visible = !!entry && (entry.mesh.visible || entry.he.mesh.visible);
      if (!entry) return;
      const plane = entry.mesh.visible ? entry.mesh : entry.he.mesh;
      outline.position.copy(plane.position); outline.quaternion.copy(plane.quaternion);
      outline.scale.set(entry.descriptor.sceneWidth, entry.descriptor.sceneHeight, 1); outline.updateMatrixWorld();
    }
    function updateVisibility() {
      for (const entry of entries) {
        const enabled = entry.index >= range[0] && entry.index <= range[1] && !hiddenSectionIds.has(entry.descriptor.id);
        entry.mesh.visible = enabled && !!entry.texture;
        entry.he.mesh.visible = enabled && heVisible && heOpacity > 0 && !!entry.he.texture;
      }
      updateRoi(); updateSectionOutlines(); updateOutline(); scheduleRender();
    }
    function updateRoi() {
      for (const entry of entries) entry.roi?.update({ ...roiSettings,
        visible: roiSettings.visible && entry.index >= range[0] && entry.index <= range[1] && !hiddenSectionIds.has(entry.descriptor.id),
        labelsVisible: roiSettings.labelsVisible && entry.index === selected });
    }
    function setRoiOverlay(settings) {
      roiSettings = { ...roiSettings, ...settings };
      if (Object.hasOwn(settings, 'region') && !Object.hasOwn(settings, 'regions')) roiSettings.regions = settings.region ? [settings.region] : null;
      updateRoi(); scheduleRender();
    }
    function updateSectionOutlines() {
      for (const entry of entries) entry.sectionOutline?.update({ ...sectionOutlineSettings,
        visible: sectionOutlineSettings.visible && entry.index >= range[0] && entry.index <= range[1] &&
          !hiddenSectionIds.has(entry.descriptor.id) });
    }
    function setSectionOutlines(settings = {}) {
      if (disposed) return;
      if (Object.hasOwn(settings, 'visible')) sectionOutlineSettings.visible = !!settings.visible;
      if (typeof settings.color === 'string' && /^#[0-9a-f]{6}$/i.test(settings.color)) sectionOutlineSettings.color = settings.color.toLowerCase();
      if (Object.hasOwn(settings, 'opacity')) sectionOutlineSettings.opacity = Math.max(0, Math.min(1, finite(settings.opacity, sectionOutlineSettings.opacity)));
      updateSectionOutlines(); scheduleRender();
    }
    function setTexture(entry, source, { smooth = false, name = entry.descriptor?.name || 'HE' } = {}) {
      if (!source || !source.width || !source.height) {
        if (entry.texture) entry.texture.dispose();
        entry.texture = null; entry.alphaPixels = null; entry.mesh.material.map = null; entry.mesh.material.needsUpdate = true;
        return;
      }
      if (Math.max(source.width, source.height) > renderer.capabilities.maxTextureSize) throw new Error(`${name}: 画像サイズがGPUの上限を超えています。`);
      if (entry.texture) { entry.texture.image = source; entry.texture.needsUpdate = true; }
      else {
        entry.texture = new T.CanvasTexture(source); entry.texture.colorSpace = T.SRGBColorSpace;
        entry.texture.minFilter = smooth ? T.LinearFilter : T.NearestFilter;
        entry.texture.magFilter = smooth ? T.LinearFilter : T.NearestFilter; entry.texture.generateMipmaps = false;
        entry.mesh.material.map = entry.texture; entry.mesh.material.needsUpdate = true;
      }
      entry.textureWidth = source.width; entry.textureHeight = source.height;
      try {
        const pixels = source.getContext('2d').getImageData(0, 0, source.width, source.height).data;
        // Retain only alpha for picking, especially for higher-resolution HE.
        entry.alphaPixels = new Uint8Array(source.width * source.height);
        for (let i = 0; i < entry.alphaPixels.length; i++) entry.alphaPixels[i] = pixels[i * 4 + 3];
      }
      catch (_) { entry.alphaPixels = null; }
    }
    function release(entry) {
      if (entry.roi) { scene.remove(entry.roi.group); entry.roi.dispose(); }
      if (entry.sectionOutline) { scene.remove(entry.sectionOutline.group); entry.sectionOutline.dispose(); }
      scene.remove(entry.mesh); entry.mesh.geometry.dispose(); entry.mesh.material.dispose();
      if (entry.texture) entry.texture.dispose(); entry.alphaPixels = null;
      scene.remove(entry.he.mesh); entry.he.mesh.material.dispose();
      if (entry.he.texture) entry.he.texture.dispose(); entry.he.alphaPixels = null;
    }
    function setSections(descriptors) {
      if (disposed) return;
      if (!Array.isArray(descriptors)) throw new TypeError('切片一覧は配列で指定してください。');
      const ids = new Set();
      const checked = descriptors.map(d => {
        const width = d?.sceneWidth ?? d?.widthMm, height = d?.sceneHeight ?? d?.heightMm;
        if (!d || d.id == null || !Number.isFinite(Number(width)) || Number(width) <= 0 ||
            !Number.isFinite(Number(height)) || Number(height) <= 0) throw new TypeError('切片のIDまたはXYサイズが不正です。');
        const id = String(d.id); if (ids.has(id)) throw new Error(`切片IDが重複しています: ${id}`); ids.add(id);
        return { ...d, id, name: String(d.name || id), sceneWidth: Number(width), sceneHeight: Number(height),
          angleDeg: finite(d.angleDeg), heAngleDeg: finite(d.heAngleDeg, finite(d.angleDeg)),
          rotationDeg: finite(d.rotationDeg), ...(d.coordinateMode === 'pixel'
            ? { offsetXPx: finite(d.offsetXPx), offsetYPx: finite(d.offsetYPx) }
            : { offsetXUm: finite(d.offsetXUm), offsetYUm: finite(d.offsetYUm) }) };
      });
      if (new Set(checked.map(d => d.coordinateMode === 'pixel' ? 'pixel' : 'physical')).size > 1) {
        throw new Error('画素単位と実寸単位の切片を同じ3Dには表示できません。');
      }
      if (entries.length && checked.length && global.Stack3D.seriesOf(entries[0].descriptor).id !== global.Stack3D.seriesOf(checked[0]).id) viewSet = false;
      const selectedId = entries[selected]?.descriptor.id, previous = byId; byId = new Map();
      entries = checked.map((d, index) => {
        let entry = previous.get(d.id);
        if (entry) {
          previous.delete(d.id);
          if (entry.descriptor.sceneWidth !== d.sceneWidth || entry.descriptor.sceneHeight !== d.sceneHeight) {
            entry.mesh.geometry.dispose(); entry.mesh.geometry = new T.PlaneGeometry(d.sceneWidth, d.sceneHeight);
            entry.he.mesh.geometry = entry.mesh.geometry;
          }
          entry.descriptor = d; entry.index = index;
        } else {
          const material = new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity, side: T.DoubleSide,
            depthWrite: false, depthTest: true, alphaTest: 0.001, toneMapped: false });
          material.forceSinglePass = true;
          const mesh = new T.Mesh(new T.PlaneGeometry(d.sceneWidth, d.sceneHeight), material);
          const heMaterial = material.clone(); heMaterial.opacity = heOpacity;
          heMaterial.forceSinglePass = true;
          const heMesh = new T.Mesh(mesh.geometry, heMaterial);
          entry = { descriptor: d, index, mesh, texture: null, alphaPixels: null,
            he: { mesh: heMesh, texture: null, alphaPixels: null } };
          scene.add(heMesh, mesh);
        }
        entry.zIndex = (d.project?.atlas || d.atlas) && Number.isFinite(d.zIndex) ? d.zIndex : index;
        if (entry.roi) { scene.remove(entry.roi.group); entry.roi.dispose(); }
        entry.roi = global.Stack3DRoi.create(T, doc, d); scene.add(entry.roi.group);
        if (entry.sectionOutline) { scene.remove(entry.sectionOutline.group); entry.sectionOutline.dispose(); }
        entry.sectionOutline = global.Stack3DSectionOutline?.create(T, d) || null;
        if (entry.sectionOutline) scene.add(entry.sectionOutline.group);
        entry.mesh.userData.sectionId = d.id; entry.mesh.userData.layer = 'msi';
        entry.he.mesh.userData.sectionId = d.id; entry.he.mesh.userData.layer = 'he'; byId.set(d.id, entry);
        if (Object.hasOwn(d, 'textureCanvas')) setTexture(entry, d.textureCanvas);
        return entry;
      });
      zCenter = entries.length ? (Math.min(...entries.map(e => e.zIndex)) + Math.max(...entries.map(e => e.zIndex))) / 2 : 0;
      for (const entry of previous.values()) release(entry);
      hiddenSectionIds = new Set([...hiddenSectionIds].filter(id => byId.has(id)));
      range = [0, entries.length - 1]; selected = entries.findIndex(e => e.descriptor.id === selectedId);
      if (selected < 0 && entries.length) selected = 0;
      entries.forEach(position); syncBrainContext(); updateVisibility(); if (!viewSet) resetView();
    }
    function updateTextures(textures) {
      if (disposed) return;
      for (const [id, source] of textures instanceof Map ? textures : Object.entries(textures || {})) {
        const entry = byId.get(String(id)); if (entry) setTexture(entry, source);
      }
      updateVisibility();
    }
    // Sources must already contain the saved HE→MSI affine transform, in the
    // unrotated MSI bounds. The renderer applies the saved HE rotation itself.
    // Keep each source canvas alive while its texture is installed.
    function updateHeTextures(textures) {
      if (disposed) return;
      for (const [id, source] of textures instanceof Map ? textures : Object.entries(textures || {})) {
        const entry = byId.get(String(id));
        if (entry && (!source || entry.he.texture?.image !== source)) setTexture(entry.he, source, { smooth: true, name: entry.descriptor.name + ' HE' });
      }
      updateVisibility();
    }
    function setHeOverlay(settings = {}) {
      if (disposed) return;
      if (Object.hasOwn(settings, 'visible')) heVisible = !!settings.visible;
      if (Object.hasOwn(settings, 'opacity')) heOpacity = Math.max(0, Math.min(1, finite(settings.opacity, heOpacity)));
      for (const entry of entries) entry.he.mesh.material.opacity = heOpacity;
      updateVisibility();
    }
    function releaseBrainContext() {
      if (!brainContext) return;
      for (const object of brainContext.objects) scene.remove(object);
      brainContext.dispose(); brainContext = null;
    }
    function syncBrainContext() {
      if (!entries.length) { releaseBrainContext(); return; }
      if (entries.some(entry => entry.descriptor.coordinateMode === 'pixel' || global.Stack3D.seriesOf(entry.descriptor).species !== 'marmoset')) {
        brainVisible = false; releaseBrainContext(); return;
      }
      if (!brainContext && brainVisible) {
        if (!global.Stack3DBrainContext?.createContext) throw new Error('脳模式図を読み込めませんでした。ページを再読み込みしてください。');
        brainContext = global.Stack3DBrainContext.createContext(T);
        for (const object of brainContext.objects) scene.add(object);
      }
      if (!brainContext) return;
      // Use the COMPLETE stack, never the visibility/cutoff range. Changing
      // the section being viewed cannot imply a changing anatomical outline.
      brainContext.setBounds(bounds()); brainContext.setOpacity(brainOpacity); brainContext.setVisible(brainVisible);
    }
    function setBrainContext(settings = {}) {
      if (disposed) return;
      if (Object.hasOwn(settings, 'visible')) brainVisible = !!settings.visible;
      if (Object.hasOwn(settings, 'opacity')) brainOpacity = Math.max(0, Math.min(1, finite(settings.opacity, brainOpacity)));
      syncBrainContext(); scheduleRender();
    }
    function setSpacing(value) {
      if (disposed) return; spacing = Math.max(0.001, Math.min(100, finite(value, spacing)));
      entries.forEach(position); syncBrainContext(); updateOutline(); scheduleRender();
    }
    function setRange(start, end) {
      const last = entries.length - 1, a = Math.min(last, Math.max(0, Math.round(finite(start)))), b = Math.min(last, Math.max(0, Math.round(finite(end, last))));
      range = [Math.min(a, b), Math.max(a, b)]; updateVisibility();
    }
    function setHiddenSections(ids = []) {
      if (disposed) return;
      if (!ids || typeof ids === 'string' || typeof ids[Symbol.iterator] !== 'function') throw new TypeError('非表示にする切片IDは配列またはSetで指定してください。');
      hiddenSectionIds = new Set([...ids].map(String).filter(id => byId.has(id)));
      // Visibility alone changes: retain the complete stack's ordinal positions,
      // bounds, textures, camera, and schematic brain geometry.
      updateVisibility();
    }
    function select(index) { selected = Number.isInteger(index) && index >= 0 && index < entries.length ? index : -1; updateRoi(); updateOutline(); scheduleRender(); }
    function setPlacement(id, values = {}) {
      const entry = byId.get(String(id)); if (!entry) return;
      const keys = entry.descriptor.coordinateMode === 'pixel' ? ['offsetXPx', 'offsetYPx', 'rotationDeg'] : ['offsetXUm', 'offsetYUm', 'rotationDeg'];
      for (const key of keys) if (Object.hasOwn(values, key)) entry.descriptor[key] = finite(values[key], entry.descriptor[key]);
      position(entry); syncBrainContext(); updateOutline(); scheduleRender();
    }
    function bounds() {
      const box = new T.Box3();
      for (const entry of entries) {
        const d = entry.descriptor;
        for (const plane of [entry.mesh, entry.he.mesh]) {
          for (const x of [-d.sceneWidth / 2, d.sceneWidth / 2]) for (const y of [-d.sceneHeight / 2, d.sceneHeight / 2]) {
            box.expandByPoint(scratch.set(x, y, 0).applyMatrix4(plane.matrixWorld));
          }
        }
      }
      if (box.isEmpty()) { box.min.set(-10, -10, -10); box.max.set(10, 10, 10); } return box;
    }
    function resetView() {
      if (disposed) return; resize();
      const box = bounds();
      if (brainVisible && brainOpacity > 0 && brainContext) box.union(brainContext.getBounds());
      const center = box.getCenter(new T.Vector3()), radius = Math.max(box.getSize(new T.Vector3()).length() / 2, 1);
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
      if (disposed || contextLost) return;
      const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return;
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      camera.updateMatrixWorld(); raycaster.setFromCamera(pointer, camera);
      const planes = entries.flatMap(entry => [entry.mesh, entry.he.mesh]).filter(mesh => mesh.visible && mesh.material.opacity > 0);
      for (const hit of raycaster.intersectObjects(planes, false)) {
        const entry = byId.get(hit.object.userData.sectionId); if (!entry) continue;
        const layer = hit.object.userData.layer === 'he' ? entry.he : entry;
        if (layer.alphaPixels && hit.uv) {
          const x = Math.min(layer.textureWidth - 1, Math.max(0, Math.floor(hit.uv.x * layer.textureWidth)));
          const y = Math.min(layer.textureHeight - 1, Math.max(0, Math.floor((1 - hit.uv.y) * layer.textureHeight)));
          if (layer.alphaPixels[y * layer.textureWidth + x] * hit.object.material.opacity / 255 < hit.object.material.alphaTest) continue;
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
    function onContextRestored() {
      contextLost = false;
      for (const entry of entries) for (const layer of [entry, entry.he]) if (layer.texture) layer.texture.needsUpdate = true;
      scheduleRender();
    }
    const events = { pointerdown: onPointerDown, pointermove: onPointerMove, pointerup: onPointerUp, pointercancel: onPointerCancel,
      webglcontextlost: onContextLost, webglcontextrestored: onContextRestored };
    controls.addEventListener('change', scheduleRender);
    for (const [name, handler] of Object.entries(events)) canvas.addEventListener(name, handler);
    const observer = win.ResizeObserver ? new win.ResizeObserver(resize) : null;
    if (observer) observer.observe(container); else win.addEventListener('resize', resize);
    resize(); resetView();
    function capturePNG() {
      if (disposed || contextLost) throw new Error('3D描画を利用できないため画像を保存できません。');
      render();
      const pixelMode = entries.some(entry => entry.descriptor.coordinateMode === 'pixel');
      if (!pixelMode && (!brainVisible || brainOpacity <= 0 || !brainContext)) return canvas.toDataURL('image/png');
      // The DOM badge is not part of the WebGL canvas. Bake the schematic
      // qualification into exported images so it survives sharing/cropping
      // of the surrounding application controls.
      const output = doc.createElement('canvas'); output.width = canvas.width; output.height = canvas.height;
      const context = output.getContext('2d');
      if (!context) throw new Error('画像保存用の描画を開始できません。');
      context.drawImage(canvas, 0, 0);
      const fontSize = Math.max(12, Math.round(Math.min(output.width, output.height) / 48));
      const padding = Math.round(fontSize * 0.7), label = pixelMode
        ? 'PIXEL COORDINATES / PHYSICAL SPACING UNKNOWN' : 'SCHEMATIC / NOT REGISTERED';
      context.font = `600 ${fontSize}px sans-serif`;
      const width = Math.ceil(context.measureText(label).width) + padding * 2, height = fontSize + padding * 2;
      context.fillStyle = 'rgba(11, 20, 32, 0.88)'; context.fillRect(padding, output.height - height - padding, width, height);
      context.fillStyle = '#c8d8e5'; context.textBaseline = 'middle';
      context.fillText(label, padding * 2, output.height - height / 2 - padding);
      return output.toDataURL('image/png');
    }
    function setOpacity(value) { opacity = Math.max(0, Math.min(1, finite(value, opacity))); for (const entry of entries) entry.mesh.material.opacity = opacity; scheduleRender(); }
    function getStats() {
      const sectionOutlines = entries.map(e => ({ id: e.descriptor.id, ...(e.sectionOutline?.stats() || {
        status: 'unavailable', contours: 0, visible: false, source: 'measured-footprint', reason: 'outline-module-unavailable', pixelCount: null
      }) }));
      return { roi: entries.map(e => ({ id: e.descriptor.id, ...e.roi.stats() })), threeVersion: '186', sectionCount: entries.length, visibleCount: entries.filter(e => e.mesh.visible).length,
        sectionOutlines: { ...sectionOutlineSettings, availableCount: sectionOutlines.filter(s => s.status === 'available').length,
          visibleCount: sectionOutlines.filter(s => s.visible).length, sections: sectionOutlines },
        textureCount: entries.filter(e => e.texture).length, selectedIndex: selected, spacing, range: [...range], opacity,
        coordinateMode: entries[0]?.descriptor.coordinateMode || 'physical',
        placements: entries.map(e => ({ id: e.descriptor.id, position: e.mesh.position.toArray(),
          rotationDeg: e.mesh.rotation.z / RAD, width: e.descriptor.sceneWidth, height: e.descriptor.sceneHeight })),
        heVisible, heOpacity, heTextureCount: entries.filter(e => e.he.texture).length,
        brainVisible, brainOpacity, brainObjectCount: brainContext?.getStats().objectCount || 0,
        brainModelBounds: brainContext?.getStats().bounds || null,
        brainContextRendered: brainVisible && brainOpacity > 0 && !!brainContext,
        heVisibleCount: entries.filter(e => e.he.mesh.visible).length,
        visibleSectionCount: entries.filter(e => e.mesh.visible || e.he.mesh.visible).length,
        hiddenSectionIds: entries.filter(e => hiddenSectionIds.has(e.descriptor.id)).map(e => e.descriptor.id),
        enabledSectionIds: entries.filter(e => !hiddenSectionIds.has(e.descriptor.id)).map(e => e.descriptor.id),
        visibleSectionIds: entries.filter(e => e.mesh.visible || e.he.mesh.visible).map(e => e.descriptor.id),
        heVisibleSectionIds: entries.filter(e => e.he.mesh.visible).map(e => e.descriptor.id),
        contextLost, disposed, renderCount, canvasWidth: canvas.width, canvasHeight: canvas.height,
        gpuGeometries: renderer.info.memory.geometries, gpuTextures: renderer.info.memory.textures,
        drawOrder: entries.filter(e => e.mesh.visible).sort((a, b) => a.mesh.renderOrder - b.mesh.renderOrder).map(e => e.descriptor.id),
        layerDrawOrder: entries.flatMap(e => [e.he.mesh, e.mesh]).filter(mesh => mesh.visible)
          .sort((a, b) => a.renderOrder - b.renderOrder).map(mesh => ({ id: mesh.userData.sectionId, layer: mesh.userData.layer })) };
    }
    function dispose() {
      if (disposed) return; disposed = true;
      if (pendingFrame !== null) win.cancelAnimationFrame(pendingFrame);
      if (observer) observer.disconnect(); else win.removeEventListener('resize', resize);
      controls.removeEventListener('change', scheduleRender); controls.dispose();
      for (const [name, handler] of Object.entries(events)) canvas.removeEventListener(name, handler);
      entries.forEach(release); entries = []; byId.clear(); hiddenSectionIds.clear(); releaseBrainContext(); outlineGeometry.dispose(); outlineMaterial.dispose();
      renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
    }
    return { setRoiOverlay, setSectionOutlines, setSections, updateTextures, updateHeTextures, setHeOverlay, setBrainContext, setSpacing, setRange, setHiddenSections, select, setPlacement, resetView, getView, setView, capturePNG, setOpacity, dispose, getStats };
  }
  global.Stack3DRenderer = { createRenderer };
})(window);
