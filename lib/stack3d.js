/* Serial coronal section data and display. Z is an ordinal display axis. */
(function (global) {
  'use strict';
  const ANALYTES = Object.freeze(['DA', 'NE', '5-HT']);
  const referenceCache = [];
  const referenceQueue = [];
  let activeReferenceLoads = 0;
  function enqueueReferenceLoad(run) {
    return new Promise((resolve, reject) => {
      referenceQueue.push({ run, resolve, reject });
      drainReferenceLoads();
    });
  }
  function drainReferenceLoads() {
    while (activeReferenceLoads < 2 && referenceQueue.length) {
      const job = referenceQueue.shift(); activeReferenceLoads++;
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
        activeReferenceLoads--; drainReferenceLoads();
      });
    }
  }
  const number = (value, fallback) => Number.isFinite(Number(value)) && value != null && value !== '' ? Number(value) : fallback;
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  function nameOf(project) { return typeof project === 'string' ? project : String(project && (project.displayName || project.name) || ''); }
  function naturalCor(project) {
    const match = nameOf(project).trim().match(/^Cor[_-](\d+)[_-](\d+)(?=$|[\s_.(\-])/i);
    return match ? { group: Number(match[1]), section: Number(match[2]), canonical: 'Cor_' + Number(match[1]) + '_' + Number(match[2]) } : null;
  }
  function sortCoronal(projects) {
    return (projects || []).filter(p => naturalCor(p)).slice().sort((a, b) => {
      const x = naturalCor(a), y = naturalCor(b);
      return x.group - y.group || x.section - y.section || nameOf(a).localeCompare(nameOf(b)) || String(a.id || '').localeCompare(String(b.id || ''));
    });
  }
  function alias(value) { return String(value || '').normalize('NFKC').replace(/^MSI[_-]/i, '').toLowerCase().replace(/[\s_\-‐‑‒–—―ー]/g, ''); }
  function channelMap(molecules) {
    const accepted = { DA: ['da', 'dopamine'], NE: ['ne', 'norepinephrine', 'noradrenaline'], '5-HT': ['5ht', 'serotonin', '5hydroxytryptamine'] };
    const result = {};
    for (const analyte of ANALYTES) {
      let found = (molecules || []).filter(m => accepted[analyte].includes(alias(m.name || m.key)));
      if (!found.length && analyte === 'NE') found = (molecules || []).filter(m => alias(m.name || m.key) === 'na');
      if (found.length > 1) {
        const exact = found.filter(m => alias(m.name || m.key) === alias(analyte));
        if (exact.length === 1) found = exact;
      }
      if (found.length > 1) throw new Error(analyte + ' に対応する分子が複数あります。分子名を確認してください。');
      if (found.length) result[analyte] = found[0];
    }
    return result;
  }
  function geometry(project) {
    const grid = project.grid || {}, W = number(grid.W, NaN), H = number(grid.H, NaN);
    if (!Number.isSafeInteger(W) || !Number.isSafeInteger(H) || W < 1 || H < 1 || W * H > 16777216) throw new Error('MSI グリッドの寸法が不正です');
    const pitch = project.world_coords && project.world_coords.msi_um_per_px || {};
    const umPerPxX = number(grid.umPerPxX, number(pitch.x, NaN)), umPerPxY = number(grid.umPerPxY, number(pitch.y, NaN));
    if (!(umPerPxX > 0) || !(umPerPxY > 0)) throw new Error('XY 画素サイズが未設定です。Master で設定してください。');
    const rotation = project.rotation || {}, placement = project.stack3d || {};
    return { W, H, umPerPxX, umPerPxY, widthMm: W * umPerPxX / 1000, heightMm: H * umPerPxY / 1000,
      // The existing Viewer applies CCW90 twice. Camera pan/zoom is excluded.
      angleDeg: number(rotation.all, 0) + number(rotation.msi, 0) - 180,
      heAngleDeg: number(rotation.all, 0) + number(rotation.he, 0) - 180,
      offsetXUm: number(placement.offsetXUm, 0), offsetYUm: number(placement.offsetYUm, 0), rotationDeg: number(placement.rotationDeg, 0) };
  }
  function createSection(project, rasters, options) {
    const opts = options || {}, shape = geometry(project), mappings = channelMap(project.molecules);
    const context = global.NormalizationScope.resolveContext(project, opts.folders, opts.projects);
    const effective = context.project, evaluation = global.Normalization.evaluate(effective, rasters);
    // DisplayRange migrates presentation preferences in place. Work only on a
    // separate copy: neither opening 3D nor changing its controls edits 2D state.
    const displayProject = Object.assign({}, effective, { layerDisplay: copy(project.layerDisplay || {}), valueDisplay: copy(project.valueDisplay || {}) });
    global.DisplayRange.prepareProject(displayProject);
    const channels = {};
    for (const analyte of ANALYTES) {
      const molecule = mappings[analyte]; if (!molecule) continue;
      const raster = rasters[molecule.key];
      if (!raster || !raster.values || raster.W !== shape.W || raster.H !== shape.H || raster.values.length !== shape.W * shape.H) {
        throw new Error(analyte + ' のラスタが欠損、または座標数が一致しません');
      }
      const corrected = evaluation.channels[molecule.key], ranges = {};
      for (const mode of ['raw', 'normalized']) {
        const values = mode === 'raw' ? raster.values : corrected && corrected.values;
        if (!values) continue;
        const state = global.DisplayRange.layerState(displayProject, molecule.key, mode);
        // Individual includes the saved manual window, but never borrows a
        // folder-wide common window while claiming to be section-specific.
        if (state.strategy === 'common') state.strategy = 'individual';
        ranges[mode] = global.DisplayRange.resolve({ project: displayProject, key: molecule.key, mode,
          values, channel: corrected, rawFingerprint: evaluation.fingerprint });
      }
      const settings = project.layerDisplay && project.layerDisplay[molecule.key] || {};
      channels[analyte] = { key: molecule.key, name: molecule.name, raw: raster.values,
        normalized: corrected && corrected.values || null, corrected, ranges,
        opacity: settings.applyOpacity === false ? 1 : number(settings.opacity, 1) };
    }
    if (!Object.keys(channels).length) throw new Error('DA・NE・5-HT の測定ラスタがありません');
    return Object.assign({ id: project.id, name: nameOf(project), project, channels, rasters, evaluation, scope: context.assessment,
      sourceRevision: project.updatedAt || null, sourceFingerprint: evaluation.fingerprint, _storage: opts.storage || global.ProjectStorage,
      _images: new Map(), released: false }, shape);
  }
  async function loadSections(projects, options) {
    const opts = options || {}, storage = opts.storage || global.ProjectStorage;
    let folders = opts.folders;
    if (folders === undefined && storage && storage.listFolders) folders = await storage.listFolders();
    const ordered = sortCoronal(projects), sections = [], errors = [];
    for (let i = 0; i < ordered.length; i++) {
      if (opts.signal && opts.signal.aborted) throw new Error('3D データの読み込みを中止しました');
      const project = ordered[i];
      try {
        const rasters = await global.Normalization.loadRasters(project, { storage });
        sections.push(createSection(project, rasters, { storage, folders, projects: opts.allProjects || projects }));
      } catch (error) { errors.push({ id: project.id, name: nameOf(project), message: error.message }); }
      if (opts.onProgress) opts.onProgress({ completed: i + 1, total: ordered.length, loaded: sections.length, project, errors: errors.slice() });
      // Yield between sections so progress and cancellation remain responsive.
      if (typeof global.requestAnimationFrame === 'function') await new Promise(resolve => global.setTimeout(resolve, 0));
    }
    sections.forEach((section, index) => { section.index = index; section.zIndex = index; });
    sections.errors = errors;
    return sections;
  }
  function usableChannel(section, analyte, mode) {
    const channel = section.channels[analyte];
    if (!channel || section.released) return null;
    if (mode !== 'normalized') return channel;
    return channel.normalized && channel.corrected && ['VALID', 'PROVISIONAL', 'PARTIAL'].includes(channel.corrected.status) ? channel : null;
  }
  function computeCommonRanges(sections, mode) {
    mode = mode === 'normalized' ? 'normalized' : 'raw';
    const ranges = {};
    for (const analyte of ANALYTES) {
      const arrays = [], memberIds = [], normalizationGroups = new Set(); let size = 0;
      for (const section of sections) {
        const channel = usableChannel(section, analyte, mode); if (!channel) continue;
        const values = channel[mode]; arrays.push(values); size += values.length; memberIds.push(section.id);
        const scope = section.project.normalization && section.project.normalization.scope;
        if (mode === 'normalized' && scope) normalizationGroups.add(scope.groupId);
      }
      const pooled = new Float64Array(size); let offset = 0;
      for (const values of arrays) { pooled.set(values, offset); offset += values.length; }
      ranges[analyte] = Object.assign(global.DisplayRange.stats(pooled), { mode, analyte, memberIds,
        normalizationGroups: Array.from(normalizationGroups), source: '3d-series', strategy: 'common' });
    }
    return ranges;
  }
  function renderSection(section, options) {
    if (section.released) throw new Error('読み込み済みデータは解放されています');
    const opts = options || {}, mode = opts.mode === 'normalized' ? 'normalized' : 'raw';
    const requested = Array.from(new Set(opts.channels || ANALYTES)).filter(a => ANALYTES.includes(a));
    const layers = [], ranges = {}, unavailableChannels = [];
    for (const analyte of requested) {
      const channel = usableChannel(section, analyte, mode);
      if (!channel) { unavailableChannels.push(analyte); continue; }
      const values = channel[mode];
      const common = opts.commonRanges && opts.commonRanges[analyte];
      if (opts.rangeMode === 'common' && (!common || common.mode !== mode)) throw new Error('現在の表示モードに対応する共通色範囲がありません');
      const range = opts.rangeMode === 'common' ? common : channel.ranges[mode];
      ranges[analyte] = range;
      layers.push({ canvas: global.SectionDisplay.paintChannel(values, channel.raw, section.W, section.H,
        { analyte, range, derived: mode === 'normalized' }), values, rawValues: channel.raw, derived: mode === 'normalized', range, opacity: channel.opacity });
    }
    const result = global.SectionDisplay.mergeChannels(layers, section.W, section.H, opts);
    const unavailable = requested.length > 0 && !layers.length;
    result.status = { code: unavailable ? 'UNAVAILABLE' : result.invalidPixels || unavailableChannels.length ? 'PARTIAL' : mode === 'raw' ? 'RAW' : section.evaluation.status,
      message: unavailable ? (mode === 'normalized' ? '補正値を表示できません。原値表示で確認できます。' : '選択分子の測定値がありません。')
        : result.invalidPixels ? '灰色は測定済み・補正値を算出できない画素です。' : '',
      mode, unavailableChannels, invalidPixels: result.invalidPixels, measuredPixels: result.measuredPixels,
      visiblePixels: result.visiblePixels, ranges, otsuApplied: false, scope: section.scope,
      reasonCodes: mode === 'normalized' ? section.evaluation.reasonCodes || [] : [] };
    const rawPreview = result.previewCanvas;
    result.previewCanvas = orientCanvas(section, rawPreview, { pixelScale: opts.previewPixelScale });
    if (opts.roi) paintRoiPreview(section, result.previewCanvas, {
      angleDeg: section.angleDeg, pixelScale: Math.max(0.01, number(opts.previewPixelScale, 1))
    });
    rawPreview.width = 0; rawPreview.height = 0;
    for (const layer of layers) { layer.canvas.width = 0; layer.canvas.height = 0; }
    result.ranges = ranges;
    return result;
  }
  function orientCanvas(section, source, options) {
    const opts = options || {};
    const angle = ((opts.he ? section.heAngleDeg : section.angleDeg) + number(opts.rotationDeg, 0)) * Math.PI / 180;
    // Render square screen pixels while preserving anisotropic source pitch.
    const scale = Math.min(section.umPerPxX, section.umPerPxY), width = section.W * section.umPerPxX / scale,
      height = section.H * section.umPerPxY / scale;
    const c = Math.cos(angle), s = Math.sin(angle), canvas = document.createElement('canvas');
    const boundsW = Math.abs(width * c) + Math.abs(height * s), boundsH = Math.abs(width * s) + Math.abs(height * c);
    let pixelScale = Math.max(0.01, number(opts.pixelScale, 1));
    if (number(opts.maxSize, 0) > 0) pixelScale = Math.min(pixelScale, opts.maxSize / Math.max(boundsW, boundsH));
    canvas.width = Math.max(1, Math.ceil(boundsW * pixelScale - 1e-9));
    canvas.height = Math.max(1, Math.ceil(boundsH * pixelScale - 1e-9));
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = !!opts.he;
    ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(angle);
    ctx.drawImage(source, -width * pixelScale / 2, -height * pixelScale / 2, width * pixelScale, height * pixelScale);
    return canvas;
  }
  function roiPolygons(section) {
    const roi = section.project.roi || {}, records = [];
    for (const [key, polygons] of Object.entries(roi.roi_items || {})) {
      if (!Array.isArray(polygons)) continue;
      const sourceColor = roi.palette && roi.palette[key];
      const color = Array.isArray(sourceColor) && sourceColor.length >= 3 && sourceColor.slice(0, 3).every(Number.isFinite)
        ? sourceColor.slice(0, 3).map(value => Math.round(Math.max(0, Math.min(255, value)))) : [160, 200, 255];
      for (const polygon of polygons) {
        const vertices = polygon && polygon.poly_msi;
        // Reject an invalid ring as a whole rather than joining points across
        // missing coordinates and displaying a different anatomical boundary.
        if (!Array.isArray(vertices) || vertices.length < 3 || vertices.some(vertex => !Array.isArray(vertex) || vertex.length < 2 ||
          !Number.isFinite(vertex[0]) || !Number.isFinite(vertex[1]))) continue;
        records.push({ vertices, color, visible: !(roi.roi_show_flags && roi.roi_show_flags[key] === false) });
      }
    }
    return records;
  }
  function roiSummary(section) {
    const polygons = roiPolygons(section);
    return { visiblePolygons: polygons.filter(polygon => polygon.visible).length, totalPolygons: polygons.length };
  }
  function paintRoiPreview(section, canvas, options) {
    const polygons = roiPolygons(section).filter(polygon => polygon.visible);
    if (!polygons.length) return;
    const pitch = Math.min(section.umPerPxX, section.umPerPxY), angle = options.angleDeg * Math.PI / 180;
    const xScale = options.pixelScale * section.umPerPxX / pitch, yScale = options.pixelScale * section.umPerPxY / pitch;
    const c = Math.cos(angle), s = Math.sin(angle), ctx = canvas.getContext('2d');
    const point = (x, y) => {
      const dx = (x - section.W / 2) * xScale, dy = (y - section.H / 2) * yScale;
      return [canvas.width / 2 + c * dx - s * dy, canvas.height / 2 + s * dx + c * dy];
    };
    const path = vertices => {
      ctx.beginPath(); ctx.moveTo(...point(vertices[0][0], vertices[0][1]));
      for (let i = 1; i < vertices.length; i++) ctx.lineTo(...point(vertices[i][0], vertices[i][1]));
      ctx.closePath();
    };
    ctx.save();
    // Clip in the ROI/MSI frame, independently of the HE layer's saved rotation.
    path([[0, 0], [section.W, 0], [section.W, section.H], [0, section.H]]); ctx.clip();
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    // Paint vectors at final preview resolution with a uniform screen-space
    // stroke. Anisotropic measurement pitch must not distort line thickness.
    ctx.lineWidth = Math.max(1.25, Math.max(canvas.width, canvas.height) / 400);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const polygon of polygons) {
      ctx.strokeStyle = `rgb(${polygon.color.join(',')})`; path(polygon.vertices); ctx.stroke();
    }
    ctx.restore();
  }
  async function loadReferenceImage(section, key) {
    if (section.released) throw new Error('データは解放されています');
    if (section._images.has(key)) return section._images.get(key);
    const meta = section.project.images && section.project.images[key];
    if (!meta || !meta.blobId) return null;
    const pending = enqueueReferenceLoad(async () => {
      if (section.released) throw new Error('データは解放されています');
      const record = await section._storage.getBlob(meta.blobId);
      if (!record || !record.blob) throw new Error('参照画像のデータがありません');
      const url = await global.Ingest.imageBlobToDataUrl(record.blob, meta.filename || record.filename);
      return new Promise((resolve, reject) => {
        const image = new global.Image();
        image.onload = () => resolve(image); image.onerror = () => reject(new Error('参照画像を読み込めません')); image.src = url;
      });
    });
    section._images.set(key, pending);
    referenceCache.push({ section, key, pending });
    // Decoded HE images are much larger than the MSI rasters. Bound the cache
    // across the whole stack, including during rapid section navigation.
    while (referenceCache.length > 4) {
      const oldest = referenceCache.shift();
      if (oldest.section._images.get(oldest.key) === oldest.pending) oldest.section._images.delete(oldest.key);
    }
    try { return await pending; } catch (error) {
      if (section._images.get(key) === pending) section._images.delete(key);
      throw error;
    }
  }
  function heTransform(section) {
    const T = section.project.world_coords && section.project.world_coords.T_he_to_msi;
    if (!Array.isArray(T) || T.length !== 3 || T.some(row => !Array.isArray(row) || row.length !== 3 || row.some(x => !Number.isFinite(x))) ||
        !Number.isFinite(T[0][0] * T[1][1] - T[0][1] * T[1][0]) ||
        Math.abs(T[0][0] * T[1][1] - T[0][1] * T[1][0]) < 1e-12) throw new Error('HE の保存済み位置合わせが不正です');
    return T;
  }
  function hePixelScale(T, xScale, yScale) {
    // The inverse smallest singular value preserves native HE samples in the
    // most compressed direction, including saved affine shear/reflection.
    const a = T[0][0] * xScale, b = T[0][1] * xScale, c = T[1][0] * yScale, d = T[1][1] * yScale;
    const largest = (Math.hypot(a + d, c - b) + Math.hypot(a - d, c + b)) / 2;
    return largest / Math.abs(a * d - b * c);
  }
  function heCanvasLimit(options, fallback) {
    return Math.max(1, Math.min(4096, Math.floor(number(options && options.maxSize, fallback))));
  }
  async function renderHePlane(section, options) {
    const image = await loadReferenceImage(section, 'HE_Stain'); if (!image) return null;
    if (section.released) throw new Error('データは解放されています');
    const T = heTransform(section), limit = heCanvasLimit(options, 768);
    const pixelScale = Math.min(hePixelScale(T, 1, 1), limit / Math.max(section.W, section.H));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(section.W * pixelScale - 1e-9));
    canvas.height = Math.max(1, Math.ceil(section.H * pixelScale - 1e-9));
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    // T maps native HE pixels into raw MSI coordinates. Keep this plane
    // unrotated: the 3D renderer applies heAngleDeg and placement rotation.
    ctx.scale(canvas.width / section.W, canvas.height / section.H);
    ctx.transform(T[0][0], T[1][0], T[0][1], T[1][1], T[0][2], T[1][2]); ctx.drawImage(image, 0, 0);
    return canvas;
  }
  async function renderHePreview(section, options) {
    const image = await loadReferenceImage(section, 'HE_Stain'); if (!image) return null;
    if (section.released) throw new Error('データは解放されています');
    const opts = options || {}, T = heTransform(section), limit = heCanvasLimit(opts, 2048);
    const pitch = Math.min(section.umPerPxX, section.umPerPxY), xScale = section.umPerPxX / pitch, yScale = section.umPerPxY / pitch;
    const angle = (section.heAngleDeg + number(opts.rotationDeg, 0)) * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const width = section.W * xScale, height = section.H * yScale;
    let boundsW = Math.abs(width * c) + Math.abs(height * s), boundsH = Math.abs(width * s) + Math.abs(height * c);
    const roiAngleDeg = section.angleDeg + number(opts.rotationDeg, 0);
    if (opts.roi && roiSummary(section).visiblePolygons) {
      // poly_msi belongs to the MSI plane, not to native HE pixels. Preserve
      // each layer's saved angle; use their union so a different HE rotation
      // cannot rotate the ROI coordinates or crop their measured plane.
      const roiAngle = roiAngleDeg * Math.PI / 180, rc = Math.cos(roiAngle), rs = Math.sin(roiAngle);
      boundsW = Math.max(boundsW, Math.abs(width * rc) + Math.abs(height * rs));
      boundsH = Math.max(boundsH, Math.abs(width * rs) + Math.abs(height * rc));
    }
    const pixelScale = Math.min(hePixelScale(T, xScale, yScale), limit / Math.max(boundsW, boundsH));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(boundsW * pixelScale - 1e-9));
    canvas.height = Math.max(1, Math.ceil(boundsH * pixelScale - 1e-9));
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(angle); ctx.scale(pixelScale * xScale, pixelScale * yScale);
    ctx.translate(-section.W / 2, -section.H / 2);
    // Clip to the same measured MSI plane before applying the saved HE warp.
    // Draw the native image once: no intermediate MSI-sized thumbnail can
    // discard tissue detail before the high-resolution preview is produced.
    ctx.beginPath(); ctx.rect(0, 0, section.W, section.H); ctx.clip();
    ctx.transform(T[0][0], T[1][0], T[0][1], T[1][1], T[0][2], T[1][2]); ctx.drawImage(image, 0, 0);
    ctx.restore();
    if (opts.roi) paintRoiPreview(section, canvas, { angleDeg: roiAngleDeg, pixelScale });
    return canvas;
  }
  function releaseSection(section) {
    section.released = true; section.channels = {}; section.rasters = null; section.evaluation = null;
    if (section._images) section._images.clear();
    for (let i = referenceCache.length - 1; i >= 0; i--) if (referenceCache[i].section === section) referenceCache.splice(i, 1);
  }
  global.Stack3D = { ANALYTES, COLORS: global.SectionDisplay.COLORS, naturalCor, sortCoronal, channelMap, geometry,
    createSection, loadSections, computeCommonRanges, renderSection, orientCanvas, roiSummary, loadReferenceImage, renderHePlane, renderHePreview, releaseSection };
})(window);
