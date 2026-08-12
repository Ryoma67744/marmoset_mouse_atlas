/*
 * zipio.js — 作業状態の ZIP 書き出し / 読み込み
 *
 * Export した ZIP をそのまま Import すれば続きから作業できる、が要件。
 * そのため ZIP には「表示に必要な生値」と「作業状態のすべて」を入れる。
 *
 *   <name>.json        マニフェスト (作業状態のすべて)
 *   Data/<name>.csv    x,y,<分子1>,<分子2>,… の生値
 *   HE/<filename>      登録した HE 画像の原本 (TIFF なら TIFF のまま)
 *
 * 生の imzML/ibd は入れない。1 分子 19 MB あるのに対し CSV の生値で完全に足りる。
 *
 * Import は 2 形式を受ける:
 *   marmoset_atlas_v1  … 上記 (このアプリが出すもの)
 *   roi_bundle_v1      … 既存 viewer の Download ボタンが出す ZIP
 *                        (atlas.json + xlsx/txt + TIFF)
 */
(function (global) {
  'use strict';

  const FORMAT = 'marmoset_atlas_v1';

  function safeName(s) {
    return String(s || 'atlas').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'atlas';
  }

  // float32 は有効数字 9 桁で厳密に往復する
  function fmtValue(v) {
    if (!Number.isFinite(v)) return '';
    if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
    return String(Number(v.toPrecision(9)));
  }

  // =====================================================================
  // Export
  // =====================================================================
  async function exportProject(project, deps) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip が読み込まれていません');
    const storage = (deps && deps.storage) || global.ProjectStorage;
    const zip = new JSZip();
    const base = safeName(project.displayName || project.id);

    const grid = project.grid || {};
    const W = grid.W | 0, H = grid.H | 0;

    // ---- 生値 CSV -------------------------------------------------------
    const mols = project.molecules || [];
    const rasters = [];
    for (const m of mols) {
      rasters.push(m.blobId ? await storage.getValueRaster(m.blobId) : null);
    }
    // ROI は 0/1 の列として CSV に載せる (Excel などで下流解析にそのまま使えるように)
    const roiItems = (project.roi && project.roi.roi_items) || {};
    const roiNames = (project.roi && project.roi.roi_names) || {};
    const roiKeys = Object.keys(roiItems).filter(k => {
      const p = roiItems[k] && roiItems[k][0] && roiItems[k][0].poly_msi;
      return Array.isArray(p) && p.length >= 3;
    });
    const roiCols = roiKeys.map(k => ({
      key: k,
      header: String(roiNames[k] || k).replace(/[\r\n\t,]/g, ' ').trim() || k,
      poly: roiItems[k][0].poly_msi,
    }));

    const dataPath = 'Data/' + base + '.csv';
    const head = ['x', 'y'].concat(mols.map(m => m.name)).concat(roiCols.map(r => r.header));
    const lines = [head.join(',')];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const cells = [String(x + 1), String(y + 1)];
        let any = false;
        for (let k = 0; k < mols.length; k++) {
          const r = rasters[k];
          const v = r ? r[i] : NaN;
          if (Number.isFinite(v)) any = true;
          cells.push(fmtValue(v));
        }
        for (const rc of roiCols) {
          cells.push(global.MSIRaster.pointInPolygon(x, y, rc.poly) ? '1' : '0');
        }
        if (any) lines.push(cells.join(','));
      }
    }
    zip.file(dataPath, lines.join('\n') + '\n');

    // ---- HE 画像の原本 ---------------------------------------------------
    const images = {};
    for (const key of Object.keys(project.images || {})) {
      const im = project.images[key];
      if (!im || !im.blobId) continue;
      const rec = await storage.getBlob(im.blobId);
      if (!rec || !rec.blob) continue;
      const fname = im.filename || (key + '.png');
      const path = 'HE/' + safeName(fname.replace(/\.[^.]+$/, '')) + (/\.[^.]+$/.exec(fname) || ['.png'])[0];
      zip.file(path, rec.blob);
      images[key] = { path: path, mime: im.mime || rec.mime || '', filename: fname };
    }

    // ---- マニフェスト ----------------------------------------------------
    const manifest = {
      format: FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      displayName: project.displayName || base,
      orientation: project.orientation || '',
      plane: project.plane || '',
      sliceId: project.sliceId || '',
      grid: { W: W, H: H, umPerPxX: grid.umPerPxX || null, umPerPxY: grid.umPerPxY || null },
      data: {
        path: dataPath, xHeader: 'x', yHeader: 'y',
        // ROI 列は import では読み飛ばす (ROI 自体は roi キーから復元する)
        roiColumns: roiCols.map(r => ({ key: r.key, header: r.header })),
      },
      molecules: mols.map(m => ({
        key: m.key, name: m.name, column: m.name,
        filterString: m.filterString || '', mode: m.mode || '',
        nSpectra: m.nSpectra || 0, stats: m.stats || null,
      })),
      images: images,
      world_coords: project.world_coords || {},
      alignment: project.alignment || {},
      layerDisplay: project.layerDisplay || {},
      otsu: project.otsu || { applied: false, strength: 0, manualThreshold: null },
      visibleLayers: project.visibleLayers || [],
      viewerTransform: project.viewerTransform || { tx: 0, ty: 0, scale: 1 },
      roi: project.roi || { roi_items: {}, roi_names: {}, palette: {}, roi_show_flags: {} },
    };
    zip.file(base + '.json', JSON.stringify(manifest, null, 2));

    return await zip.generateAsync({ type: 'blob' });
  }

  // =====================================================================
  // Import
  // =====================================================================

  /** root 直下の *.json を舐めて、既知の format を持つものを探す */
  async function findManifest(zip) {
    const roots = Object.keys(zip.files).filter(p => /^[^/]+\.json$/i.test(p) && !zip.files[p].dir);
    for (const p of roots) {
      try {
        const doc = JSON.parse(await zip.file(p).async('string'));
        if (doc && doc.format === FORMAT) return { path: p, doc: doc, kind: FORMAT };
        if (doc && doc.meta && doc.meta.format === 'roi_bundle_v1') return { path: p, doc: doc, kind: 'roi_bundle_v1' };
        if (doc && doc.format === 'roi_bundle_v1') return { path: p, doc: doc, kind: 'roi_bundle_v1' };
      } catch (e) { /* JSON でないものは無視 */ }
    }
    // 既存形式は必ず atlas.json という名前で入っている
    if (zip.file('atlas.json')) {
      try {
        const doc = JSON.parse(await zip.file('atlas.json').async('string'));
        return { path: 'atlas.json', doc: doc, kind: 'roi_bundle_v1' };
      } catch (e) { /* noop */ }
    }
    return null;
  }

  async function importZip(file, deps) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip が読み込まれていません');
    const storage = (deps && deps.storage) || global.ProjectStorage;
    const zip = await JSZip.loadAsync(file);
    const found = await findManifest(zip);
    if (!found) {
      throw new Error('この ZIP には読み込めるマニフェストがありません。' +
        'このアプリが Export した ZIP か、既存ビューアの Download が出す ZIP を選んでください。');
    }
    if (found.kind === FORMAT) return importNative(zip, found.doc, storage);
    return importRoiBundle(zip, found.doc, storage);
  }

  // ---- 新形式 -----------------------------------------------------------
  async function importNative(zip, doc, storage) {
    const warnings = [];
    const W = doc.grid.W | 0, H = doc.grid.H | 0;
    const csvFile = zip.file(doc.data.path);
    if (!csvFile) throw new Error('ZIP に ' + doc.data.path + ' がありません');
    const csv = await csvFile.async('string');

    const lines = csv.split(/\r?\n/);
    const head = (lines[0] || '').split(',').map(s => s.trim());
    const xi = head.indexOf(doc.data.xHeader || 'x');
    const yi = head.indexOf(doc.data.yHeader || 'y');
    if (xi < 0 || yi < 0) throw new Error('CSV に x / y 列がありません');

    const mols = doc.molecules || [];
    const colIdx = mols.map(m => head.indexOf(m.column || m.name));
    const rasters = mols.map(() => { const a = new Float32Array(W * H); a.fill(NaN); return a; });

    for (let li = 1; li < lines.length; li++) {
      const line = lines[li];
      if (!line) continue;
      const tok = line.split(',');
      const x = Number(tok[xi]), y = Number(tok[yi]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const gi = (y - 1) * W + (x - 1);
      if (gi < 0 || gi >= W * H) continue;
      for (let k = 0; k < mols.length; k++) {
        const ci = colIdx[k];
        if (ci < 0) continue;
        const s = tok[ci];
        if (s === undefined || s === '') continue;
        const v = Number(s);
        if (Number.isFinite(v)) rasters[k][gi] = Math.fround(v);
      }
    }
    for (let k = 0; k < mols.length; k++) {
      if (colIdx[k] < 0) warnings.push('CSV に ' + (mols[k].column || mols[k].name) + ' 列がありません');
    }

    const project = {
      id: storage.uid('proj'),
      displayName: doc.displayName || 'Imported',
      source: 'zip',
      orientation: doc.orientation || '',
      plane: doc.plane || '',
      sliceId: doc.sliceId || '',
      grid: { W: W, H: H, umPerPxX: doc.grid.umPerPxX || null, umPerPxY: doc.grid.umPerPxY || null },
      molecules: [],
      images: {},
      world_coords: doc.world_coords || {},
      alignment: doc.alignment || {},
      layerDisplay: doc.layerDisplay || {},
      otsu: doc.otsu || { applied: false, strength: 0, manualThreshold: null },
      visibleLayers: doc.visibleLayers || [],
      viewerTransform: doc.viewerTransform || { tx: 0, ty: 0, scale: 1 },
      roi: doc.roi || { roi_items: {}, roi_names: {}, palette: {}, roi_show_flags: {} },
    };

    for (let k = 0; k < mols.length; k++) {
      const m = mols[k];
      const blobId = await storage.putValueRaster(rasters[k]);
      project.molecules.push({
        key: m.key || ('MSI_' + m.name),
        name: m.name,
        blobId: blobId,
        filterString: m.filterString || '',
        mode: m.mode || '',
        nSpectra: m.nSpectra || 0,
        stats: m.stats || global.MSIRaster.deriveBakeStats(rasters[k]),
      });
    }

    for (const key of Object.keys(doc.images || {})) {
      const im = doc.images[key];
      const f = im && im.path ? zip.file(im.path) : null;
      if (!f) { warnings.push('ZIP に ' + (im && im.path) + ' がありません'); continue; }
      const raw = await f.async('blob');
      const blob = new Blob([raw], { type: im.mime || raw.type || 'application/octet-stream' });
      const blobId = await storage.putBlob({ blob: blob, mime: im.mime || '', filename: im.filename || key });
      project.images[key] = { blobId: blobId, mime: im.mime || '', filename: im.filename || key };
    }

    await storage.putProject(project);
    return { project: project, warnings: warnings };
  }

  // ---- 既存形式 (roi_bundle_v1) -------------------------------------------
  async function importRoiBundle(zip, atlas, storage) {
    const warnings = [];
    const meta = atlas.meta || {};

    // ZIP 内のパスは atlas.json の相対パスそのもの。大文字小文字やスペースの
    // 揺れに耐えるよう、正規化した名前でも引けるようにしておく。
    const index = new Map();
    for (const p of Object.keys(zip.files)) {
      if (zip.files[p].dir) continue;
      index.set(p, p);
      index.set(p.toLowerCase(), p);
      const bare = p.split('/').pop();
      if (!index.has(bare.toLowerCase())) index.set(bare.toLowerCase(), p);
    }
    const pick = (rel) => {
      if (!rel) return null;
      const cands = [rel, rel.toLowerCase(), decodeURI(rel), decodeURI(rel).toLowerCase(),
                     rel.split('/').pop().toLowerCase()];
      for (const c of cands) if (index.has(c)) return zip.file(index.get(c));
      return null;
    };

    const molecules = [];
    let W = 0, H = 0;
    const rastersToStore = [];

    // xlsx_series
    const xlsxSeries = atlas.xlsx_series || {};
    let wbCache = new Map();
    for (const [key, def] of Object.entries(xlsxSeries)) {
      try {
        const f = pick(def.src);
        if (!f) { warnings.push('ZIP に ' + def.src + ' がありません (' + key + ')'); continue; }
        if (!wbCache.has(def.src)) wbCache.set(def.src, global.Ingest.workbookFromArrayBuffer(await f.async('arraybuffer')));
        const rows = global.Ingest.rowsFromWorkbook(wbCache.get(def.src), def);
        const r = global.MSIRaster.rasterFromRows(rows);
        W = r.W; H = r.H;
        rastersToStore.push({ key: key, name: key.replace(/^MSI_/i, ''), values: r.values });
      } catch (e) {
        warnings.push(key + ' の読み込みに失敗: ' + e.message);
      }
    }

    // txt_series
    const txtSeries = atlas.txt_series || {};
    for (const [key, def] of Object.entries(txtSeries)) {
      try {
        const f = pick(def.src);
        if (!f) { warnings.push('ZIP に ' + def.src + ' がありません (' + key + ')'); continue; }
        const { rows } = global.Ingest.rowsFromText(await f.async('string'), def);
        const r = global.MSIRaster.rasterFromRows(rows);
        W = r.W; H = r.H;
        rastersToStore.push({ key: key, name: key.replace(/^MSI_/i, ''), values: r.values });
      } catch (e) {
        warnings.push(key + ' の読み込みに失敗: ' + e.message);
      }
    }

    if (!rastersToStore.length) {
      throw new Error('この ZIP には MSI データが含まれていません。' +
        '既存ビューアの Download は atlas.json だけを出す場合があります (test1 など)。');
    }

    const wc = atlas.world_coords || {};
    const project = {
      id: storage.uid('proj'),
      displayName: meta.dataset_id || 'Imported',
      source: 'zip',
      orientation: '', plane: '', sliceId: '',
      grid: {
        W: W, H: H,
        umPerPxX: (wc.msi_um_per_px && wc.msi_um_per_px.x) || null,
        umPerPxY: (wc.msi_um_per_px && wc.msi_um_per_px.y) || null,
      },
      molecules: [],
      images: {},
      world_coords: wc,
      alignment: {},
      layerDisplay: {},
      otsu: { applied: false, strength: 0, manualThreshold: null },
      visibleLayers: [],
      viewerTransform: { tx: 0, ty: 0, scale: 1 },
      roi: atlas.roi || { roi_items: {}, roi_names: {}, palette: {}, roi_show_flags: {} },
    };

    for (const r of rastersToStore) {
      const blobId = await storage.putValueRaster(r.values);
      project.molecules.push({
        key: r.key, name: r.name, blobId: blobId,
        filterString: '', mode: '', nSpectra: 0,
        stats: global.MSIRaster.deriveBakeStats(r.values),
      });
    }
    if (project.molecules.length) project.visibleLayers = [project.molecules[0].key];

    // 画像 (HE/IF)
    for (const [key, rel] of Object.entries(atlas.images || {})) {
      if (typeof rel !== 'string' || /^data:|^https?:/.test(rel)) continue;
      const f = pick(rel);
      if (!f) { warnings.push('ZIP に ' + rel + ' がありません (' + key + ')'); continue; }
      const fname = rel.split('/').pop();
      const raw = await f.async('blob');
      const mime = global.Ingest.isTiffName(fname) ? 'image/tiff' : (raw.type || '');
      const blob = new Blob([raw], { type: mime || 'application/octet-stream' });
      const blobId = await storage.putBlob({ blob: blob, mime: mime, filename: fname });
      project.images[key] = { blobId: blobId, mime: mime, filename: fname };
    }

    // 既存の位置合わせ情報 (landmark_points / he_transform) があれば拾う
    const ovPath = meta.source_overlay;
    if (ovPath) {
      const f = pick(ovPath);
      if (f) {
        try {
          const ov = JSON.parse(await f.async('string'));
          const heKey = Object.keys(project.images)[0];
          if (heKey && ov.landmark_points) {
            project.alignment[heKey] = Object.assign(
              global.Align.defaultAlignState(),
              stateFromT(wc.T_he_to_msi),
              {
                landmarks: {
                  he: ov.landmark_points.he_points || [],
                  msi: ov.landmark_points.msi_points || [],
                },
              }
            );
          }
        } catch (e) { warnings.push('overlay JSON の解析に失敗: ' + e.message); }
      }
    }

    await storage.putProject(project);
    return { project: project, warnings: warnings };
  }

  /** 3×3 の相似変換行列 → Align の 5 パラメータ (取り込み時の逆変換) */
  function stateFromT(T) {
    if (!Array.isArray(T) || T.length < 2) return {};
    const a = T[0][0], b = T[0][1], c = T[1][0], d = T[1][1];
    // buildHeToMsiAffine: [[cos*sx, -sin*sy],[sin*sx, cos*sy]]
    const s = Math.hypot(a, c);
    if (!(s > 0)) return {};
    const det = a * d - b * c;
    const flip_lr = det < 0;
    const sx = (flip_lr ? -1 : 1) * s;
    const theta = Math.atan2(c / sx, a / sx);
    return {
      flip_lr: flip_lr,
      flip_ud: false,
      scale_pct: s * 100,
      rotate_deg: theta * 180 / Math.PI,
      offx: T[0][2],
      offy: T[1][2],
    };
  }

  global.ZipIO = {
    FORMAT: FORMAT,
    exportProject: exportProject,
    importZip: importZip,
    safeName: safeName,
    stateFromT: stateFromT,
  };
})(window);
