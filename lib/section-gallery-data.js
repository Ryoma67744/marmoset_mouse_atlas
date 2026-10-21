/* Read-only gallery presentation. Remote-only bundles may be cached locally;
 * existing projects, raw arrays and editable display settings are never written. */
(function (global) {
  'use strict';
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const text = value => String(value || '').normalize('NFC').trim();
  const identity = molecule => text(molecule && (molecule.analyteId || molecule.name || molecule.key));
  const sameSeries = (a, b) => {
    const x = global.SectionNavigation.seriesOf(a), y = global.SectionNavigation.seriesOf(b);
    return x.id === y.id && x.species === y.species && x.coordinateMode === y.coordinateMode;
  };
  function abort() { const error = new Error('サムネイルの読み込みを中止しました。'); error.name = 'AbortError'; return error; }
  function remoteProject(row) {
    return { id: row.id, displayName: row.display_name || '', atlas: clone(row.meta?.atlas || row.state?.atlas || null),
      plane: row.meta?.plane || '', molecules: (row.meta?.molecules || []).map(name => ({ name })),
      images: row.meta?.hasHe ? { HE_Stain: {} } : {}, _hasImmuno: !!row.meta?.hasImmuno };
  }
  function sourcesOf(projects) {
    const sources = new Map();
    for (const project of projects) for (const molecule of project.molecules || []) {
      const id = identity(molecule); if (!id) continue;
      const key = 'msi:' + id;
      if (!sources.has(key)) sources.set(key, { key, label: text(molecule.name) || id, kind: 'msi', identity: id });
    }
    sources.set('he', { key: 'he', label: 'HE', kind: 'he', imageKey: 'HE_Stain' });
    sources.set('atlas', { key: 'atlas', label: 'Atlas', kind: 'reference', imageKey: global.ATLAS_KEY || 'ATLAS' });
    sources.set('if:IF_Stain', { key: 'if:IF_Stain', label: 'IF', kind: 'if', imageKey: 'IF_Stain' });
    for (const project of projects) {
      for (const key of Object.keys(project.images || {})) if (/^IF[_-]/i.test(key) && key !== 'IF_Stain') {
        sources.set('if:' + key, { key: 'if:' + key, label: 'IF · ' + key, kind: 'if', imageKey: key });
      }
      if (project._hasImmuno || project.images?.IMMUNO) sources.set('if:IMMUNO', {
        key: 'if:IMMUNO', label: '免疫染色（参照画像）', kind: 'reference', imageKey: 'IMMUNO' });
    }
    return [...sources.values()];
  }
  function create(options) {
    const opts = options || {}, storage = opts.storage || global.ProjectStorage,
      cloud = opts.cloud || global.Cloud, zip = opts.zip || global.ZipIO;
    let disposed = false;
    const contexts = new WeakMap();
    const current = () => typeof opts.getCurrentProject === 'function' ? opts.getCurrentProject() : null;
    const check = signal => { if (disposed || signal?.aborted) throw abort(); };
    async function loadCatalog(request) {
      const req = request || {}; check(req.signal);
      let remoteRows = null, cloudNotice = '';
      const cloudUsable = cloud && (typeof cloud.configured !== 'function' || cloud.configured()) &&
        (typeof cloud.signedIn !== 'function' || cloud.signedIn());
      const [locals, remote] = await Promise.all([storage.listProjects(), cloudUsable ? Promise.resolve().then(() => cloud.listProjects())
        .then(rows => ({ rows })).catch(error => ({ error })) : Promise.resolve(null)]);
      check(req.signal);
      if (Array.isArray(remote?.rows)) remoteRows = remote.rows;
      else cloudNotice = remote?.error ? 'クラウド一覧を取得できないため、手元の切片だけを表示します。' : '手元にある切片の一覧です。クラウド全体の登録状況は未確認です。';
      const localProjects = clone(locals || []), draft = clone(req.currentProject || current());
      if (draft?.id) { const index = localProjects.findIndex(p => p.id === draft.id); if (index < 0) localProjects.push(draft); else localProjects[index] = draft; }
      const remoteById = new Map((remoteRows || []).map(row => [row.id, row]));
      const merged = new Map((remoteRows || []).map(row => [row.id, remoteProject(row)]));
      for (const project of localProjects) {
        if (remoteRows && !remoteById.has(project.id) && project.cloudUpdatedAt && !project.cloudPending) continue;
        merged.set(project.id, project);
      }
      const candidates = global.SectionNavigation.sortCoronal([...merged.values()]);
      const seriesMap = new Map();
      for (const project of candidates) { const series = global.SectionNavigation.seriesOf(project); if (!seriesMap.has(series.id)) seriesMap.set(series.id, series); }
      const requested = req.seriesId || (draft ? global.SectionNavigation.seriesOf(draft).id : null);
      const seriesId = seriesMap.has(requested) ? requested : seriesMap.keys().next().value || null;
      const anchor = candidates.find(p => global.SectionNavigation.seriesOf(p).id === seriesId);
      let ordered = anchor ? global.SectionNavigation.buildCatalog(anchor, localProjects, remoteRows) : null;
      const items = (ordered?.items || []).map(item => ({ ...item,
        sectionNumber: item.atlas?.sectionNumber != null ? Number(item.atlas.sectionNumber) : undefined }));
      const result = { series: [...seriesMap.values()], seriesId, items,
        sources: sourcesOf(items.map(item => merged.get(item.id)).filter(Boolean)), complete: Array.isArray(remoteRows),
        status: ordered?.status || 'unavailable', notice: [cloudNotice, ordered?.status !== 'ready' && ordered?.reason,
          !items.length && '番号・系列を確認できる切片がありません。'].filter(Boolean).join(' ') };
      contexts.set(result, { remoteById, localProjects, draft });
      return result;
    }
    async function workers(items, task, signal, onProgress) {
      let cursor = 0, completed = 0;
      const results = new Array(items.length);
      await Promise.all(Array.from({ length: Math.min(2, items.length) }, async () => {
        while (cursor < items.length) {
          check(signal); const index = cursor++;
          try { results[index] = await task(items[index], index); }
          catch (error) { if (error.name === 'AbortError') throw error; results[index] = { id: items[index].id, status: 'error', notice: error.message || '読込失敗' }; }
          check(signal); completed++;
          if (onProgress) onProgress({ completed, total: items.length });
        }
      }));
      return results;
    }
    async function projectFor(item, ctx, signal) {
      check(signal);
      const active = current(), draft = active?.id === item.id ? active : ctx.draft?.id === item.id ? ctx.draft : null;
      let project = draft ? clone(draft) : await storage.getProject(item.id);
      check(signal);
      if (!project) {
        if (!ctx.remoteById.has(item.id) || !global.ProjectSync) throw new Error('未取得：手元に切片データがありません。');
        project = await global.ProjectSync.ensureLocal(item.id, { storage, cloud, zip,
          canApplyRemote: async () => !disposed && !signal?.aborted && current()?.id !== item.id && !await storage.getProject(item.id) });
        check(signal);
      }
      if (!project) throw new Error('切片データを取得できません。');
      if (!sameSeries(item, project) || global.SectionNavigation.naturalCor(item)?.canonical !== global.SectionNavigation.naturalCor(project)?.canonical) {
        throw new Error('切片の系列または番号が更新されました。一覧を開き直してください。');
      }
      return clone(project);
    }
    function shapeOf(project) {
      try { return { shape: global.Stack3D.geometry(project), notice: '' }; }
      catch (error) {
        const W = Number(project.grid?.W), H = Number(project.grid?.H);
        if (!Number.isSafeInteger(W) || !Number.isSafeInteger(H) || W < 1 || H < 1 || W * H > 16777216) throw error;
        // A thumbnail can still show native pixels; no physical spacing is invented.
        return { shape: { W, H, coordinateMode: 'pixel', angleDeg: 0, heAngleDeg: 0,
          rotationDeg: 0, previewPitchX: 1, previewPitchY: 1 }, notice: '画素サイズ・配置が未確認のため、元画像の向きと縦横比で表示。' };
      }
    }
    function orient(project, source, shape, he) {
      const pose = global.Stack3D.scenePlacement(shape, he);
      return global.Stack3D.orientCanvas({ ...shape, angleDeg: -pose.angleDeg, heAngleDeg: -pose.angleDeg }, source, { he: !!he, pixelScale: he ? 240 : 1, maxSize: 240 });
    }
    function fixedMouse(project) {
      const series = global.SectionNavigation.seriesOf(project);
      return series.id === 'mouse_tissue_1set' && series.species === 'mouse' && series.coordinateMode === 'pixel';
    }
    async function prepareMsi(project, source, folders, projects) {
      const matches = (project.molecules || []).filter(molecule => identity(molecule) === source.identity || text(molecule.name) === source.identity);
      if (!matches.length) return { id: project.id, project, status: 'missing', notice: 'この分子は未登録です。' };
      if (matches.length !== 1) return { id: project.id, project, status: 'unavailable', notice: '同じ分子名・識別子が複数あるため選べません。' };
      const molecule = matches[0], rasters = await global.Normalization.loadRasters(project, { storage });
      const { shape, notice } = shapeOf(project), raster = rasters[molecule.key];
      if (!raster || raster.W !== shape.W || raster.H !== shape.H || raster.values?.length !== shape.W * shape.H) {
        throw new Error('分子の測定データが欠損、または画像サイズが一致しません。');
      }
      const standard = molecule.key === project.normalization?.mapping?.d4 ||
        ['Serotonin-d4-DPP', 'D4-5-HT'].includes(identity(molecule));
      let values = raster.values, derived = false, mask = null, mode = standard ? '原値QC・外側を含む' : '原値';
      if (fixedMouse(project) && !standard) {
        if (project.normalization?.mode !== 'pixel_ratio') throw new Error('この切片の画素d4補正プロファイルを確認できません。原値には切り替えません。');
        const effective = global.NormalizationScope.resolveContext(project, folders, projects).project;
        const corrected = global.Normalization.evaluate(effective, rasters).channels[molecule.key];
        if (!corrected?.values || corrected.method !== 'pixel_ratio' || corrected.applicable === false || !['PROVISIONAL', 'PARTIAL', 'VALID'].includes(corrected.status)) {
          throw new Error('画素d4補正を表示できません：' + (corrected?.reasonCodes || ['補正データなし']).join(', '));
        }
        values = corrected.values; derived = true; mode = '画素d4補正・外側2画素を非表示';
        // Do not compute a false footprint from an incomplete subset of raw channels.
        if ((project.molecules || []).some(m => !rasters[m.key])) throw new Error('外側2画素の判定に必要な原値データが不足しています。');
        mask = global.Stack3DEdgeMask.fromSection({ ...shape, project, rasters }, 2);
        if (mask.status !== 'available') throw new Error('外側2画素の判定を確認できません：' + mask.reason);
      }
      if (!values.some(Number.isFinite)) return { id: project.id, project, status: 'unavailable', notice: '有限の測定値がありません。' };
      return { id: project.id, project, molecule, shape, values, raw: raster.values, derived, mask, mode, status: 'prepared', notice };
    }
    async function referenceThumbnail(project, source) {
      const meta = project.images?.[source.imageKey];
      if (!meta) return { id: project.id, status: 'missing', notice: source.label + ' は未登録です。' };
      if (!meta.blobId) return { id: project.id, status: 'unavailable', notice: source.label + ' の画像データは未取得です。' };
      const section = { project, _storage: storage, _images: new Map(), released: false };
      try {
        const image = await global.Stack3D.loadReferenceImage(section, source.imageKey);
        if (!image) throw new Error('画像データがありません。');
        const T = project.world_coords?.T_he_to_msi;
        if (source.kind === 'he' && T) {
          const { shape, notice } = shapeOf(project); Object.assign(section, shape);
          try {
            const plane = await global.Stack3D.renderHePlane(section, { maxSize: 480 });
            const canvas = orient(project, plane, shape, true); plane.width = 0; plane.height = 0;
            return { id: project.id, status: 'ready', canvas, notice: [notice, '保存済みHE位置合わせ・切片姿勢を使用。'].filter(Boolean).join(' ') };
          } catch (error) {
            // A broken saved transform must not be presented as successful alignment.
            return nativeReference(image, project.id, '保存済みHE位置合わせを確認できないため、元画像を表示。');
          }
        }
        return nativeReference(image, project.id, source.kind === 'he' ? '未位置合わせ：元のHE画像を表示。' : '参照画像の元の向きで表示。MSIとの位置合わせは適用していません。');
      } finally { global.Stack3D.releaseSection(section); }
    }
    function nativeReference(image, id, notice) {
      const canvas = document.createElement('canvas'), W = image.naturalWidth || image.width, H = image.naturalHeight || image.height;
      if (!(W > 0) || !(H > 0)) throw new Error('画像サイズを取得できません。');
      const scale = Math.min(1, 240 / Math.max(W, H)); canvas.width = Math.max(1, Math.round(W * scale)); canvas.height = Math.max(1, Math.round(H * scale));
      const context = canvas.getContext('2d'); context.imageSmoothingEnabled = true; context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return { id, canvas, status: 'ready', notice };
    }
    async function renderThumbnails(catalog, sourceKey, request) {
      const req = request || {}, ctx = contexts.get(catalog); check(req.signal);
      if (!ctx) throw new Error('一覧を再読み込みしてください。');
      let source = catalog.sources.find(s => s.key === sourceKey);
      if (!source && String(sourceKey).startsWith('msi:')) source = { key: sourceKey, kind: 'msi', identity: String(sourceKey).slice(4), label: String(sourceKey).slice(4) };
      if (!source) throw new Error('画像の種類を選択してください。');
      const [folders, projects] = await Promise.all([storage.listFolders ? storage.listFolders() : [], storage.listProjects()]);
      check(req.signal);
      const hydrated = [];
      const emit = item => { check(req.signal); if (req.onThumbnail) req.onThumbnail({ ...item, sourceKey }); };
      const results = await workers(catalog.items, async item => {
        const project = await projectFor(item, ctx, req.signal); hydrated.push(project); check(req.signal);
        if (source.kind !== 'msi') {
          const result = await referenceThumbnail(project, source); check(req.signal); emit(result); return result;
        }
        return prepareMsi(project, source, folders, projects);
      }, req.signal, req.onProgress);
      let range = null, loaded = 0;
      if (source.kind === 'msi') {
        let count = 0;
        for (const result of results) if (result.status === 'prepared') { loaded++; for (const value of result.values) if (Number.isFinite(value)) count++; }
        const pooled = new Float64Array(count); let index = 0;
        for (const result of results) if (result.status === 'prepared') for (const value of result.values) if (Number.isFinite(value)) pooled[index++] = value;
        range = global.DisplayRange.stats(pooled);
        for (const result of results) {
          check(req.signal);
          if (result.status !== 'prepared') { emit(result); continue; }
          const sourceCanvas = global.SectionDisplay.paintChannel(result.values, result.raw, result.shape.W, result.shape.H, {
            analyte: identity(result.molecule), range, derived: result.derived });
          if (result.mask) {
            const context = sourceCanvas.getContext('2d'), pixels = context.getImageData(0, 0, result.shape.W, result.shape.H);
            for (let i = 0; i < result.mask.hiddenMask.length; i++) if (result.mask.hiddenMask[i]) pixels.data[i * 4 + 3] = 0;
            context.putImageData(pixels, 0, 0);
          }
          const canvas = orient(result.project, sourceCanvas, result.shape, false); sourceCanvas.width = 0; sourceCanvas.height = 0;
          emit({ id: result.id, canvas, status: 'ready', mode: result.mode, range,
            notice: [result.mode, result.notice].filter(Boolean).join(' '), edgeHiddenPixels: result.mask?.hiddenPixels || 0 });
        }
      } else {
        loaded = results.filter(result => result.status === 'ready').length;
        for (const result of results) if (result.status === 'error') emit(result);
      }
      const sources = sourcesOf(hydrated);
      // Retain options advertised by metadata even when a bundle could not be read.
      const allSources = new Map(catalog.sources.map(s => [s.key, s])); for (const s of sources) allSources.set(s.key, s);
      const failures = results.filter(result => ['error', 'unavailable'].includes(result.status)).length;
      const modes = source.kind === 'msi' ? [...new Set(results.map(result => result.mode).filter(Boolean))].join(' / ') : '';
      const modeNotice = modes ? '表示値：' + modes + '。' : '';
      const coverage = source.kind === 'msi' ? `取得できた ${loaded}/${catalog.items.length} 切片の共通P99（外側非表示前の値）で表示。` : `画像 ${loaded}/${catalog.items.length} 切片。`;
      return { sources: [...allSources.values()], range, complete: catalog.complete && !failures, loaded,
        notice: [modeNotice, coverage, !catalog.complete && 'クラウド全体の登録状況は未確認です。', failures && `${failures} 切片はデータを表示できません。`].filter(Boolean).join(' ') };
    }
    return { loadCatalog, renderThumbnails, dispose() { disposed = true; } };
  }
  global.SectionGalleryData = Object.freeze({ create });
})(window);
