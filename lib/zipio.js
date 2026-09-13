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
    if (Object.is(v, -0)) return '-0';
    if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
    return String(Number(v.toPrecision(9)));
  }

  // CSV のヘッダに使える形に正規化する。
  // ★ 分子名はファイル名の先頭トークンがそのまま入るので、カンマや改行が
  //   紛れ込みうる。素通しすると列がずれて、後続の分子が丸ごと NaN になる。
  function csvHeaderCell(name) {
    return String(name == null ? '' : name).replace(/[\r\n\t,"]/g, ' ').trim();
  }

  // 同名の列があると import 側の名前引きが最初の 1 本しか当たらないので、
  // 書き出す時点で一意にしておく。
  function uniqueHeaders(names) {
    const seen = new Map();
    return names.map((raw, i) => {
      let h = csvHeaderCell(raw) || ('col' + (i + 1));
      if (seen.has(h)) {
        const n = seen.get(h) + 1;
        seen.set(h, n);
        h = h + '#' + n;
      } else {
        seen.set(h, 1);
      }
      return h;
    });
  }

  function validRoiPolygon(value) {
    return Array.isArray(value) && value.length >= 3 && value.every(point =>
      Array.isArray(point) && point.length >= 2 &&
      typeof point[0] === 'number' && Number.isFinite(point[0]) &&
      typeof point[1] === 'number' && Number.isFinite(point[1]));
  }

  function normalizedRoiName(value) {
    let name = value == null ? '' : String(value).trim();
    try { name = name.normalize('NFC'); } catch (e) { /* 古いブラウザではそのまま使う */ }
    return name;
  }

  /**
   * Project の保存済み生値と ROI を、CSV/XLSX 共通の表定義へ展開する。
   *
   * strict=true (既定) は下流解析向けの完全な表を保証するため、グリッド、
   * 分子、ラスタに不備があれば例外にする。従来の復元用 Export は互換性を
   * 保つため strict=false を使い、欠損ラスタを空列として扱う。
   */
  async function prepareProjectTable(project, deps, options) {
    project = project || {};
    const storage = (deps && deps.storage) || global.ProjectStorage;
    const strict = !options || options.strict !== false;
    const groupRoisByName = !!(options && options.groupRoisByName);
    const warnings = [];
    const grid = project.grid || {};
    const W = grid.W | 0, H = grid.H | 0;
    const rawW = Number(grid.W), rawH = Number(grid.H);
    const validGrid = Number.isInteger(rawW) && Number.isInteger(rawH) &&
      rawW > 0 && rawH > 0 && rawW === W && rawH === H &&
      Number.isSafeInteger(W * H);

    if (!validGrid) {
      const msg = `グリッドサイズが不正です (W=${String(grid.W)}, H=${String(grid.H)})`;
      if (strict) throw new Error(msg);
      warnings.push(msg);
    }

    const mols = project.molecules || [];
    if (!Array.isArray(mols)) throw new Error('分子データの形式が不正です');
    if (!mols.length) {
      const msg = '分子データがありません';
      if (strict) throw new Error(msg);
      warnings.push(msg);
    }

    const molHeaders = uniqueHeaders(mols.map(m => m.name));
    const moleculeDefs = [];
    for (let i = 0; i < mols.length; i++) {
      const m = mols[i];
      const r = m.blobId ? await storage.getValueRaster(m.blobId) : null;
      if (!r) {
        const msg = strict
          ? '登録済み分子 ' + m.name + ' の生値ラスタが見つからないため、不完全な Data を避けるためこのファイルを書き出せません (d4 分子自体の未登録や補正設定なしとは異なります)'
          : m.name + ' の生値ラスタが見つかりません (空の列として書き出します)';
        if (strict) throw new Error(msg);
        warnings.push(msg);
      } else if (W && H && r.length !== W * H) {
        const msg = `${m.name} のラスタ長 ${r.length} がグリッド ${W}×${H} (${W * H}) と一致しません`;
        if (strict) throw new Error(msg);
        warnings.push(msg);
      }
      moleculeDefs.push({
        index: i,
        key: m.key,
        name: m.name,
        header: molHeaders[i],
        blobId: m.blobId || null,
        raster: r,
        definition: m,
      });
    }

    // ROI は「有効な全ポリゴンの和集合」として 1 列にする。
    const roiItems = (project.roi && project.roi.roi_items) || {};
    const roiNames = (project.roi && project.roi.roi_names) || {};
    const roiKeys = [];
    const roiPolysByKey = new Map();
    for (const k of Object.keys(roiItems)) {
      const recs = roiItems[k];
      if (!Array.isArray(recs)) {
        warnings.push(`${roiNames[k] || k} の ROI レコード形式が不正なため除外しました`);
        continue;
      }
      const polys = recs.map(r => r && r.poly_msi).filter(validRoiPolygon);
      const validCount = polys.length;
      const invalidCount = recs.length - validCount;
      if (invalidCount) {
        warnings.push(`${roiNames[k] || k} の無効な ROI レコード ${invalidCount} 件を除外しました`);
      }
      if (validCount) {
        roiKeys.push(k);
        roiPolysByKey.set(k, polys);
      }
      else if (!invalidCount) {
        warnings.push(`${roiNames[k] || k} は有効な ROI ポリゴンがないため除外しました`);
      }
    }
    let roiDefs = roiKeys.map((k, i) => {
      const records = roiItems[k];
      const polys = roiPolysByKey.get(k);
      const invalidRecordCount = records.length - polys.length;
      return {
        index: i,
        key: k,
        keys: [k],
        name: roiNames[k] || k,
        polys: polys,
        records: records,
        invalidRecordCount: invalidRecordCount,
      };
    });

    // 解析用 Excel では、旧版や外部由来データに別キーの同名 ROI があっても
    // 1 列にする。同じ表示名に属する全ポリゴンの和集合を ROI 所属とみなす。
    // 復元用 CSV は従来どおりキー単位の列構成を保つ。
    if (groupRoisByName) {
      const grouped = [];
      const byName = new Map();
      for (const roi of roiDefs) {
        const normalizedName = normalizedRoiName(roi.name) || String(roi.key);
        let target = byName.get(normalizedName);
        if (!target) {
          target = Object.assign({}, roi, {
            name: normalizedName,
            keys: roi.keys.slice(),
            polys: roi.polys.slice(),
            records: roi.records.slice(),
          });
          byName.set(normalizedName, target);
          grouped.push(target);
        } else {
          target.keys.push.apply(target.keys, roi.keys);
          target.key = target.keys.join(' | ');
          target.polys.push.apply(target.polys, roi.polys);
          target.records.push.apply(target.records, roi.records);
          target.invalidRecordCount += roi.invalidRecordCount;
        }
      }
      roiDefs = grouped;
    }

    const roiHeaders = uniqueHeaders(roiDefs.map(roi => roi.name))
      .map(h => molHeaders.indexOf(h) >= 0 ? h + '_roi' : h);
    roiDefs.forEach((roi, index) => { roi.header = roiHeaders[index]; });

    const pointInPolygon = deps && typeof deps.pointInPolygon === 'function'
      ? deps.pointInPolygon
      : global.MSIRaster && global.MSIRaster.pointInPolygon;
    if (roiDefs.length && typeof pointInPolygon !== 'function') {
      throw new Error('ROI の内外判定処理を利用できません');
    }

    return {
      project: project,
      grid: grid,
      W: W,
      H: H,
      headers: ['x', 'y'].concat(molHeaders).concat(roiHeaders),
      moleculeHeaders: molHeaders,
      roiHeaders: roiHeaders,
      molecules: moleculeDefs,
      rois: roiDefs,
      warnings: warnings,
      pointInPolygon: pointInPolygon,
    };
  }

  /**
   * 有限な分子値を 1 つ以上持つ画素だけを y→x 順に走査する。
   * callback(row, rowIndex) の row は [x(1-based), y(1-based), 生値..., ROI 0/1...]。
   */
  function forEachProjectTableRow(table, callback) {
    if (!table || typeof callback !== 'function') {
      throw new TypeError('表定義と callback が必要です');
    }
    const W = table.W | 0, H = table.H | 0;
    const molecules = table.molecules || [];
    const rois = table.rois || [];
    const pointInPolygon = table.pointInPolygon ||
      (global.MSIRaster && global.MSIRaster.pointInPolygon);
    let rowIndex = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const row = [x + 1, y + 1];
        let any = false;
        for (const m of molecules) {
          const r = m.raster;
          const v = r && i < r.length ? r[i] : NaN;
          if (Number.isFinite(v)) any = true;
          row.push(v);
        }
        for (const roi of rois) {
          row.push(roi.polys.some(p => pointInPolygon(x, y, p)) ? 1 : 0);
        }
        if (any) callback(row, rowIndex++);
      }
    }
    return rowIndex;
  }

  // 従来 CSV と同じ丸め・空欄・改行規則で表を文字列化する。
  function projectTableToCsv(table) {
    const moleculeCount = (table.molecules || []).length;
    const lines = [table.headers.join(',')];
    forEachProjectTableRow(table, row => {
      const cells = [String(row[0]), String(row[1])];
      for (let i = 0; i < moleculeCount; i++) cells.push(fmtValue(row[2 + i]));
      for (let i = 2 + moleculeCount; i < row.length; i++) cells.push(row[i] ? '1' : '0');
      lines.push(cells.join(','));
    });
    return lines.join('\n') + '\n';
  }

  // =====================================================================
  // Export
  // =====================================================================
  async function exportProject(project, deps) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip が読み込まれていません');
    const storage = (deps && deps.storage) || global.ProjectStorage;
    const zip = new JSZip();
    const base = safeName(project.displayName || project.id);

    // ---- 生値 CSV -------------------------------------------------------
    const table = await prepareProjectTable(project, { storage: storage }, { strict: false });
    const grid = table.grid;
    const W = table.W, H = table.H;
    const warnings = table.warnings;
    const mols = table.molecules.map(m => m.definition);
    const roiCols = table.rois;
    const molHeaders = table.moleculeHeaders;
    const roiHeaders = table.roiHeaders;

    const dataPath = 'Data/' + base + '.csv';
    zip.file(dataPath, projectTableToCsv(table));
    if (warnings.length) console.warn('[export] 警告:', warnings);

    // ---- HE 画像の原本 ---------------------------------------------------
    const images = {};
    for (const key of Object.keys(project.images || {})) {
      const im = project.images[key];
      if (!im || !im.blobId) continue;
      const rec = await storage.getBlob(im.blobId);
      if (!rec || !rec.blob) continue;
      const fname = im.filename || (key + '.png');
      // ZIP を開いた人が中身を見て分かるよう、参照画像は別フォルダに入れる
      // (読み込み側はマニフェストの path を見るので、置き場所は自由)。
      const dir = key === (global.ATLAS_KEY || 'ATLAS') ? 'Atlas/'
                : key === (global.IMMUNO_KEY || 'IMMUNO') ? 'Immuno/'
                : 'HE/';
      const path = dir + safeName(fname.replace(/\.[^.]+$/, '')) + (/\.[^.]+$/.exec(fname) || ['.png'])[0];
      zip.file(path, rec.blob);
      images[key] = { path: path, mime: im.mime || rec.mime || '', filename: fname };
    }

    // ---- マニフェスト ----------------------------------------------------
    const manifest = {
      format: FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      displayName: project.displayName || base,
      // ★ フォルダは id ではなく「名前の配列」で持つ。id は別の PC では通用しない。
      folderPath: Array.isArray(project.folderPath) ? project.folderPath : [],
      orientation: project.orientation || '',
      plane: project.plane || '',
      sliceId: project.sliceId || '',
      grid: Object.assign({}, grid, { W: W, H: H,
        umPerPxX: grid.umPerPxX == null ? null : grid.umPerPxX,
        umPerPxY: grid.umPerPxY == null ? null : grid.umPerPxY }),
      data: {
        path: dataPath, xHeader: 'x', yHeader: 'y',
        // ROI 列は import では読み飛ばす (ROI 自体は roi キーから復元する)
        roiColumns: roiCols.map((r, i) => ({ key: r.key, header: roiHeaders[i] })),
      },
      molecules: mols.map((m, i) => ({
        key: m.key, name: m.name,
        // ★ 列の対応は名前ではなく添字で持つ。名前引きだと、同名の分子や
        //   区切り文字を含む名前で別の列を読んでしまう。
        colIndex: 2 + i,
        column: molHeaders[i],
        filterString: m.filterString || '', mode: m.mode || '',
        nSpectra: m.nSpectra || 0, stats: m.stats || null,
        // 測定範囲を判定済みかどうか。これが往復で消えると、戻したデータへ
        // 「測定範囲を修復」を二度掛けできてしまう (lib/imzml.js を参照)。
        acqQc: m.acqQc || null,
        grid: m.grid || null,
      })),
      images: images,
      world_coords: project.world_coords || {},
      alignment: project.alignment || {},
      layerDisplay: project.layerDisplay || {},
      normalization: project.normalization || null,
      normalizationBinding: project.normalizationBinding || undefined,
      valueDisplay: project.valueDisplay || null,
      otsu: project.otsu || { applied: false, strength: 0, manualThreshold: null },
      visibleLayers: project.visibleLayers || [],
      viewerTransform: project.viewerTransform || { tx: 0, ty: 0, scale: 1 },
      rotation: project.rotation || { all: 0, he: 0, msi: 0 },
      // 保存済みラスタから測定範囲を推定し直したデータの目印。
      // undefined は JSON.stringify が落とすので、無ければキーごと消える。
      acquisitionRepair: project.acquisitionRepair || undefined,
      roi: project.roi || { roi_items: {}, roi_names: {}, palette: {}, roi_show_flags: {} },
    };
    zip.file(base + '.json', JSON.stringify(manifest, null, 2));

    return await zip.generateAsync({ type: 'blob' });
  }

  // =====================================================================
  // Import
  // =====================================================================

  /**
   * *.json を舐めて、既知の format を持つものを探す。
   * 一度展開してフォルダごと再圧縮された ZIP でも読めるよう、浅い順に全階層を見る。
   */
  async function findManifest(zip) {
    const roots = Object.keys(zip.files)
      .filter(p => /\.json$/i.test(p) && !zip.files[p].dir)
      .sort((a, b) => (a.split('/').length - b.split('/').length) || a.localeCompare(b));
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

  /**
   * ZIP 内のパス解決。大文字小文字・URI エンコード・フォルダ階層の差を吸収する。
   * (一度展開して再圧縮すると全体が 1 段深くなるため)
   */
  function makePicker(zip) {
    const index = new Map();
    for (const p of Object.keys(zip.files)) {
      if (zip.files[p].dir) continue;
      const add = (k) => { if (k && !index.has(k)) index.set(k, p); };
      add(p); add(p.toLowerCase());
      try { add(decodeURI(p).toLowerCase()); } catch (e) { /* 不正な % 列は無視 */ }
      add(p.split('/').pop().toLowerCase());
    }
    return function pick(rel) {
      if (!rel) return null;
      const cands = [rel, rel.toLowerCase()];
      try { cands.push(decodeURI(rel), decodeURI(rel).toLowerCase()); } catch (e) { /* noop */ }
      cands.push(String(rel).split('/').pop().toLowerCase());
      for (const c of cands) if (index.has(c)) return zip.file(index.get(c));
      return null;
    };
  }

  async function importZip(file, deps) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip が読み込まれていません');
    const options = Object.assign({}, deps || {});
    const storage = options.storage || global.ProjectStorage;
    if (typeof storage.commitImportedProject !== 'function') throw new Error('安全な取り込み処理がありません。アプリを再読み込みしてください');
    // Capture before parsing/staging. Cloud callers supply a guard captured even
    // earlier, before the download; expected null explicitly means absent.
    const previous = options.id && typeof storage.getProject === 'function' ? await storage.getProject(options.id) : null;
    if (!Object.prototype.hasOwnProperty.call(options, 'expectedUpdatedAt')) options.expectedUpdatedAt = previous ? previous.updatedAt : null;
    if (!Object.prototype.hasOwnProperty.call(options, 'expectedFolders') && typeof storage.listFolders === 'function') {
      options.expectedFolders = await storage.listFolders();
    }
    const staged = [];
    const stagedStorage = Object.create(storage);
    stagedStorage.putValueRaster = async values => {
      const id = await storage.putValueRaster(values); staged.push(id); return id;
    };
    stagedStorage.putBlob = async record => {
      const id = await storage.putBlob(record); staged.push(id); return id;
    };
    stagedStorage.commitImportedProject = async (project, commitOptions) => {
      if (typeof options.canApplyRemote === 'function' && !await options.canApplyRemote()) {
        const error = new Error('取得中に編集中の内容が変わりました。編集を保持したまま取得を中止しました');
        error.code = 'LOCAL_CONFLICT';
        throw error;
      }
      const metadata = options.cloudMetadata || (options.cloudRow && global.Cloud ? {
        cloudRev: options.cloudRow.bundle_rev | 0,
        cloudBundlePath: options.cloudRow.bundle_path,
        cloudUpdatedAt: options.cloudRow.updated_at,
        cloudDisplayName: options.cloudRow.display_name,
        cloudStateHash: global.Cloud.hashState(options.cloudRow.state || {}),
        cloudPending: false,
      } : null);
      if (metadata) for (const key of ['cloudRev', 'cloudBundlePath', 'cloudUpdatedAt', 'cloudDisplayName', 'cloudStateHash', 'cloudPending']) {
        if (Object.prototype.hasOwnProperty.call(metadata, key)) project[key] = metadata[key];
      }
      return storage.commitImportedProject(project, Object.assign({}, options, commitOptions));
    };
    try {
      const zip = await JSZip.loadAsync(file);
      const found = await findManifest(zip);
      if (!found) throw new Error('この ZIP には読み込めるマニフェストがありません。このアプリが Export した ZIP か、既存ビューアの Download が出す ZIP を選んでください。');
      let result;
      if (found.kind === FORMAT) {
        const doc = Object.assign({}, found.doc);
        if (Object.prototype.hasOwnProperty.call(options, 'state')) {
          if (!global.Cloud || typeof global.Cloud.applyState !== 'function') throw new Error('クラウドの最新設定を復元できません。アプリを再読み込みしてください');
          if (options.cloudRow || options.cloudMetadata) {
            if (typeof global.Cloud.replaceState !== 'function') throw new Error('クラウド設定の完全復元処理がありません。再読み込みしてください');
            global.Cloud.replaceState(doc, options.state);
          } else global.Cloud.applyState(doc, options.state);
        }
        if (Object.prototype.hasOwnProperty.call(options, 'folderPath')) doc.folderPath = options.folderPath;
        if (options.displayName) doc.displayName = options.displayName;
        result = await importNative(zip, doc, stagedStorage, options.id);
      } else {
        result = await importRoiBundle(zip, found.doc, stagedStorage, options);
      }
      // Existing blobs may be shared by merged projects. Never remove a blob
      // before successful replacement or while another current project uses it.
      if (previous && typeof storage.deleteUnreferencedBlobs === 'function') {
        try { await storage.deleteUnreferencedBlobs(storage.collectBlobIds(previous)); }
        catch (error) { console.warn('[zipio] 未使用データの整理に失敗', error); }
      }
      return result;
    } catch (error) {
      // The staging IDs are fresh and belong only to this attempt. The guarded
      // commit has aborted, so old project data and folders remain intact.
      if (typeof storage.deleteUnreferencedBlobs === 'function') {
        try { await storage.deleteUnreferencedBlobs(staged); } catch (cleanupError) { console.warn('[zipio] 一時データの整理に失敗', cleanupError); }
      } else if (typeof storage.deleteBlob === 'function') {
        for (const id of staged) try { await storage.deleteBlob(id); } catch (cleanupError) { console.warn('[zipio] 一時データの整理に失敗', cleanupError); }
      }
      throw error;
    }
  }

  // ---- 新形式 -----------------------------------------------------------
  /**
   * @param {string} [forceId]
   *   取り込み先の id を指定する。省略すると今までどおり新しい id を作る
   *   (手で ZIP を読み込んだときは「別のデータが 1 件増える」のが期待される動き)。
   *   ★ クラウドから落とした ZIP は、どの PC でも同じ id でなければ
   *     同じデータが端末の数だけ増えてしまうので、ここで id を引き継ぐ。
   */
  async function importNative(zip, doc, storage, forceId) {
    const warnings = [];
    const pick = makePicker(zip);
    const W = doc.grid.W | 0, H = doc.grid.H | 0;
    const csvFile = pick(doc.data.path);
    if (!csvFile) throw new Error('ZIP に ' + doc.data.path + ' がありません');
    const csv = await csvFile.async('string');

    const lines = csv.split(/\r?\n/);
    const head = (lines[0] || '').split(',').map(s => s.trim());
    const xi = head.indexOf(doc.data.xHeader || 'x');
    const yi = head.indexOf(doc.data.yHeader || 'y');
    if (xi < 0 || yi < 0) throw new Error('CSV に x / y 列がありません');

    const mols = doc.molecules || [];
    // 列の対応は添字を最優先。古い ZIP には colIndex が無いので名前引きに落とす。
    const colIdx = mols.map(m => {
      if (Number.isInteger(m.colIndex) && m.colIndex >= 0 && m.colIndex < head.length) return m.colIndex;
      return head.indexOf(m.column || m.name);
    });
    for (let k = 0; k < mols.length; k++) {
      if (colIdx[k] < 0) warnings.push('CSV に ' + (mols[k].column || mols[k].name) + ' 列がありません');
    }
    const rasters = mols.map(() => { const a = new Float32Array(W * H); a.fill(NaN); return a; });

    let shortRows = 0;
    for (let li = 1; li < lines.length; li++) {
      const line = lines[li];
      if (!line) continue;
      const tok = line.split(',');
      if (tok.length < head.length) shortRows++;
      const x = Number(tok[xi]), y = Number(tok[yi]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const gi = (y - 1) * W + (x - 1);
      if (gi < 0 || gi >= W * H) continue;
      for (let k = 0; k < mols.length; k++) {
        const ci = colIdx[k];
        if (ci < 0) continue;
        const s = tok[ci];
        if (s === undefined || String(s).trim() === '') continue;
        const v = Number(s);
        if (Number.isFinite(v)) rasters[k][gi] = Math.fround(v);
      }
    }
    if (shortRows) warnings.push(shortRows + ' 行で列数が足りません (CSV が壊れている可能性があります)');

    const project = {
      id: forceId || storage.uid('proj'),
      displayName: doc.displayName || 'Imported',
      source: 'zip',
      folderId: null,
      orientation: doc.orientation || '',
      plane: doc.plane || '',
      sliceId: doc.sliceId || '',
      grid: Object.assign({}, doc.grid, { W: W, H: H,
        umPerPxX: doc.grid.umPerPxX == null ? null : doc.grid.umPerPxX,
        umPerPxY: doc.grid.umPerPxY == null ? null : doc.grid.umPerPxY }),
      molecules: [],
      images: {},
      world_coords: doc.world_coords || {},
      alignment: doc.alignment || {},
      layerDisplay: doc.layerDisplay || {},
      // Snapshot references/factors are immutable; new project/blob IDs must not
      // cause a subset-dependent recalculation during restoration.
      normalization: doc.normalization || null,
      valueDisplay: doc.valueDisplay || null,
      otsu: doc.otsu || { applied: false, strength: 0, manualThreshold: null },
      visibleLayers: doc.visibleLayers || [],
      viewerTransform: doc.viewerTransform || { tx: 0, ty: 0, scale: 1 },
      rotation: doc.rotation || { all: 0, he: 0, msi: 0 },
      roi: doc.roi || { roi_items: {}, roi_names: {}, palette: {}, roi_show_flags: {} },
    };
    if (doc.acquisitionRepair) project.acquisitionRepair = doc.acquisitionRepair;
    if (Object.prototype.hasOwnProperty.call(doc, 'normalizationBinding')) {
      project.normalizationBinding = doc.normalizationBinding;
    }

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
        acqQc: m.acqQc || undefined,
        grid: m.grid || undefined,
      });
    }

    for (const key of Object.keys(doc.images || {})) {
      const im = doc.images[key];
      const f = im && im.path ? pick(im.path) : null;
      if (!f) { warnings.push('ZIP に ' + (im && im.path) + ' がありません'); continue; }
      const raw = await f.async('blob');
      const blob = new Blob([raw], { type: im.mime || raw.type || 'application/octet-stream' });
      const blobId = await storage.putBlob({ blob: blob, mime: im.mime || '', filename: im.filename || key });
      project.images[key] = { blobId: blobId, mime: im.mime || '', filename: im.filename || key };
    }

    await storage.commitImportedProject(project, { folderPath: doc.folderPath || [] });
    return { project: project, warnings: warnings };
  }

  // ---- 既存形式 (roi_bundle_v1) -------------------------------------------
  async function importRoiBundle(zip, atlas, storage, options) {
    const warnings = [];
    const meta = atlas.meta || {};

    // ZIP 内のパスは atlas.json の相対パスそのもの。
    const pick = makePicker(zip);

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
        rastersToStore.push({ key: key, name: key.replace(/^MSI_/i, ''), values: r.values, W: r.W, H: r.H });
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
        rastersToStore.push({ key: key, name: key.replace(/^MSI_/i, ''), values: r.values, W: r.W, H: r.H });
      } catch (e) {
        warnings.push(key + ' の読み込みに失敗: ' + e.message);
      }
    }

    if (!rastersToStore.length) {
      throw new Error('この ZIP には MSI データが含まれていません。' +
        '既存ビューアの Download は、元データが同梱されていないと atlas.json だけを出すことがあります。');
    }

    // ★ 分子ごとにグリッドが違うことがある (値が空の行が落ちて幅が 1 減る等)。
    //   プロジェクトは 1 つのグリッドしか持てないので、最も多い形を採り、
    //   違う形のものは黙って歪ませずに除外する。
    const shapeCount = new Map();
    for (const r of rastersToStore) {
      const k = r.W + 'x' + r.H;
      shapeCount.set(k, (shapeCount.get(k) || 0) + 1);
    }
    const majority = [...shapeCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
    [W, H] = majority.split('x').map(Number);
    for (let i = rastersToStore.length - 1; i >= 0; i--) {
      const r = rastersToStore[i];
      if (r.W === W && r.H === H) continue;
      warnings.push(`${r.key} のグリッド ${r.W}×${r.H} が他の分子 ${W}×${H} と一致しないため除外しました`);
      rastersToStore.splice(i, 1);
    }
    if (!rastersToStore.length) throw new Error('グリッドの一致する MSI データがありませんでした。');

    const wc = atlas.world_coords || {};
    const project = {
      id: (options && options.id) || storage.uid('proj'),
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

    if (options && Object.prototype.hasOwnProperty.call(options, 'state')) {
      if (!global.Cloud || typeof global.Cloud.applyState !== 'function') throw new Error('クラウドの最新設定を復元できません');
      if (options.cloudRow || options.cloudMetadata) {
        if (typeof global.Cloud.replaceState !== 'function') throw new Error('クラウド設定の完全復元処理がありません。再読み込みしてください');
        global.Cloud.replaceState(project, options.state);
      } else global.Cloud.applyState(project, options.state);
    }
    if (options && options.displayName) project.displayName = options.displayName;
    await storage.commitImportedProject(project, { folderPath: (options && options.folderPath) || [] });
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
    prepareProjectTable: prepareProjectTable,
    forEachProjectTableRow: forEachProjectTableRow,
    projectTableToCsv: projectTableToCsv,
    importZip: importZip,
    safeName: safeName,
    stateFromT: stateFromT,
  };
})(window);
