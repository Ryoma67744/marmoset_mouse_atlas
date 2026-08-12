/*
 * ingest.js — imzML 以外の取り込み経路 (xlsx / Analyte txt / TIFF)
 *
 * もともと viewer/index.html にインラインで書かれていた buildPngFromTxt /
 * buildPngFromXlsx / decodeTiffToPngDataUrl を、URL 前提から ArrayBuffer 前提に
 * 一般化して切り出したもの。ZIP import からも同じコードで読めるようにするため。
 *
 * すべて [{x,y,v}] の行配列に落とし、そこから先は MSIRaster.rasterFromRows が
 * 生値ラスタに変換する。
 */
(function (global) {
  'use strict';

  // =====================================================================
  // Analyte テキスト (imzML から外部ツールで変換したもの)
  //   1 行目: "Analyte (converted from imzML)"
  //   2 行目: "windows: 231.6-232.6"
  //   3 行目: precursor m/z を空白区切り
  //   4 行目: product m/z を空白区切り
  //   5 行目以降: idx  x  y  v0 [v1 v2 …]
  // =====================================================================
  function rowsFromText(raw, def) {
    def = def || {};
    const linesAll = raw.split(/\r?\n/);
    const lines = linesAll.filter(s => s.trim().length > 0);
    if (lines.length < 1) throw new Error('テキストが空です');
    const isAnalyte = /^\s*Analyte\s*\(converted from imzML\)\s*$/i.test(lines[0]);
    const rows = [];

    if (isAnalyte) {
      if (lines.length < 5) throw new Error('Analyte 形式としては行数が足りません');
      const precs = lines[2].trim().split(/\s+/).map(Number).filter(Number.isFinite);
      const prods = lines[3].trim().split(/\s+/).map(Number).filter(Number.isFinite);
      const nCh = Math.min(precs.length, prods.length);
      let valueColIndex;
      if (typeof def.v_index === 'number' && def.v_index >= 0 && def.v_index < nCh) {
        valueColIndex = 3 + def.v_index;
      } else {
        const targetMz = (typeof def.v_mz === 'number') ? def.v_mz : null;
        const targetPair = (Array.isArray(def.v_mz_pair) && def.v_mz_pair.length === 2)
          ? def.v_mz_pair.map(Number) : null;
        let pick = 0;
        if (Number.isFinite(targetMz)) {
          let best = Infinity;
          for (let i = 0; i < nCh; i++) {
            const d = Math.abs(precs[i] - targetMz);
            if (d < best) { best = d; pick = i; }
          }
        } else if (targetPair && targetPair.every(Number.isFinite)) {
          let best = Infinity;
          for (let i = 0; i < nCh; i++) {
            const d = Math.abs(precs[i] - targetPair[0]) + Math.abs(prods[i] - targetPair[1]);
            if (d < best) { best = d; pick = i; }
          }
        }
        valueColIndex = 3 + pick;
      }
      for (let i = 4; i < lines.length; i++) {
        const tok = lines[i].trim().split(/\s+/).map(Number);
        if (tok.length >= 4 && Number.isFinite(tok[1]) && Number.isFinite(tok[2])) {
          const v = tok[valueColIndex];
          if (Number.isFinite(v)) rows.push({ x: tok[1], y: tok[2], v: v });
        }
      }
      return { rows: rows, compounds: buildCompoundList(precs, prods, nCh) };
    }

    // 汎用: 1 行目がヘッダ、区切りは自動判定
    const sep = def.sep || (lines[0].indexOf('\t') >= 0 ? '\t' : (lines[0].indexOf(',') >= 0 ? ',' : /\s+/));
    const head = lines[0].split(sep).map(s => s.trim());
    const idx = (nameOrPos, fallback) => {
      if (typeof nameOrPos === 'number') return nameOrPos;
      if (typeof nameOrPos === 'string') {
        const i = head.indexOf(nameOrPos);
        if (i >= 0) return i;
      }
      return fallback;
    };
    const xi = idx(def.x, head.indexOf('x') >= 0 ? head.indexOf('x') : 0);
    const yi = idx(def.y, head.indexOf('y') >= 0 ? head.indexOf('y') : 1);
    const vi = idx(def.v, 2);
    for (let i = 1; i < lines.length; i++) {
      const tok = lines[i].split(sep);
      const x = Number(tok[xi]), y = Number(tok[yi]), v = Number(tok[vi]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(v)) rows.push({ x, y, v });
    }
    return { rows: rows, compounds: [] };
  }

  function buildCompoundList(precs, prods, nCh) {
    const out = [];
    for (let i = 0; i < nCh; i++) {
      if (!(precs[i] > 0)) continue; // m/z = 0 はメタ埋め
      out.push({ index: i, precursor: precs[i], product: prods[i] });
    }
    return out;
  }

  // =====================================================================
  // xlsx (SheetJS)
  // =====================================================================
  function a1ColToIndex(colRef) {
    if (typeof colRef === 'number') return colRef;
    const s = String(colRef).toUpperCase();
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 65 || c > 90) return NaN;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  function workbookFromArrayBuffer(buf) {
    if (typeof XLSX === 'undefined') throw new Error('SheetJS (XLSX) が読み込まれていません');
    return XLSX.read(new Uint8Array(buf), { type: 'array' });
  }

  function rowsFromWorkbook(wb, def) {
    const sheetName = def.sheet || wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    if (!sheet) throw new Error(`シート '${sheetName}' が見つかりません`);
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
    const startIdx = Math.max(0, (def.data_start_row || 1) - 1);
    const xi = a1ColToIndex(def.col_x);
    const yi = a1ColToIndex(def.col_y);
    const vi = a1ColToIndex(def.col_v);
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(vi)) {
      throw new Error('xlsx の列指定が不正です: ' + JSON.stringify(def));
    }
    const rows = [];
    for (let i = startIdx; i < aoa.length; i++) {
      const r = aoa[i];
      if (!r) continue;
      const x = Number(r[xi]), y = Number(r[yi]), v = Number(r[vi]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(v)) rows.push({ x, y, v });
    }
    if (!rows.length) throw new Error(`xlsx に数値行がありません (sheet=${sheetName})`);
    return rows;
  }

  // =====================================================================
  // TIFF (UTIF)
  // =====================================================================
  function decodeTiffArrayBuffer(buf) {
    if (typeof UTIF === 'undefined') throw new Error('UTIF が読み込まれていません');
    const ifds = UTIF.decode(buf);
    if (!ifds || !ifds.length) throw new Error('TIFF に IFD がありません');
    UTIF.decodeImage(buf, ifds[0]);
    const rgba = UTIF.toRGBA8(ifds[0]);
    const W = ifds[0].width, H = ifds[0].height;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(W, H);
    imgData.data.set(rgba);
    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL('image/png');
  }

  function isTiffName(name) { return /\.(tiff?)(\?|#|$)/i.test(String(name || '')); }

  /** Blob / File → 表示できる data URL。TIFF は UTIF で PNG に変換する。 */
  async function imageBlobToDataUrl(blob, filename) {
    const name = filename || blob.name || '';
    const mime = blob.type || '';
    if (isTiffName(name) || /tiff/i.test(mime)) {
      return decodeTiffArrayBuffer(await blob.arrayBuffer());
    }
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error('画像の読み込みに失敗しました'));
      fr.readAsDataURL(blob);
    });
  }

  /** data URL / URL から <img> を作って読み込み完了まで待つ */
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
      img.src = src;
    });
  }

  global.Ingest = {
    rowsFromText, rowsFromWorkbook, workbookFromArrayBuffer, a1ColToIndex,
    decodeTiffArrayBuffer, imageBlobToDataUrl, isTiffName, loadImage,
  };
})(window);
