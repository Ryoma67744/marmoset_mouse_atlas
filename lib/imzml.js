/*
 * imzml.js — imzML (XML) + ibd (バイナリ) をブラウザ内で解析する
 *
 * 1 ピクセルの値 = そのスペクトルの intensity 配列の全要素の単純和。
 * この定義は添付データ (NE/DA_Cor_1_10) と既存データセット
 * datasets/cor_slide_1_10/data/260421_msi_full_data_with_rois_1_10.xlsx の
 * DA 列 / NE 列を 10,680 px 全点で突き合わせて確定した
 * (最大相対差 2.3e-7 = float32 の丸め)。m/z 窓や重み付けは不要。
 *
 * 対応:
 *   - IMS:1000030 continuous / IMS:1000031 processed の両方
 *   - m/z, intensity の 32/64-bit float, 32/64-bit integer
 *   - MS:1000576 no compression のみ (zlib 圧縮は明示エラー。pako を足さない方針)
 *
 * 17 MB 級の XML をメインスレッドで舐めると UI が固まるので Web Worker で実行する。
 * Worker が使えない環境では同じ関数をメインスレッドで走らせるフォールバックを持つ。
 */
(function (global) {
  'use strict';

  // =======================================================================
  // 解析本体。Worker にも文字列として送り込むので、外部のクロージャを参照しない
  // 完全に自己完結した関数にしておくこと。
  // =======================================================================
  function parseImzmlCore(text, ibdBuffer, report) {
    // ---- 小さなユーティリティ ------------------------------------------
    // cvParam の value="..." を accession から引く。
    // cvParam の属性順は cvRef, accession, name, value なので、accession の直後の
    // value= は必ず同じタグのもの。
    function cvValue(s, acc, from) {
      const i = s.indexOf('accession="' + acc + '"', from || 0);
      if (i < 0) return null;
      const j = s.indexOf('value="', i);
      if (j < 0) return null;
      const k = s.indexOf('"', j + 7);
      if (k < 0) return null;
      return s.slice(j + 7, k);
    }
    function cvNum(s, acc) {
      const v = cvValue(s, acc);
      if (v === null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    // 数値型 accession → 読み出し方
    function detectDtype(s) {
      if (s.indexOf('MS:1000523') >= 0) return 'f64'; // 64-bit float
      if (s.indexOf('MS:1000521') >= 0) return 'f32'; // 32-bit float
      if (s.indexOf('MS:1000519') >= 0) return 'i32'; // 32-bit integer
      if (s.indexOf('MS:1000522') >= 0) return 'i64'; // 64-bit integer
      if (s.indexOf('MS:1000520') >= 0) return 'f16'; // 16-bit float (非対応)
      return null;
    }
    function dtypeSize(d) {
      return d === 'f64' || d === 'i64' ? 8 : d === 'f32' || d === 'i32' ? 4 : d === 'f16' ? 2 : 0;
    }

    const warnings = [];

    // <spectrum の開始位置を探す。属性なし (<spectrum>) の書き方もあるので、
    // 直後が空白か '>' のものだけを本物とみなす (<spectrumList> を弾くため)。
    function nextSpectrumStart(s, from) {
      let i = s.indexOf('<spectrum', from);
      while (i >= 0) {
        const c = s.charCodeAt(i + 9);
        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 62) return i;
        i = s.indexOf('<spectrum', i + 9);
      }
      return -1;
    }

    // ---- ヘッダ (最初の <spectrum より前) -------------------------------
    const firstSpecAt = nextSpectrumStart(text, 0);
    const header = firstSpecAt > 0 ? text.slice(0, firstSpecAt) : text;

    // 走査設定
    let W = cvNum(header, 'IMS:1000042'); // max count of pixel x
    let H = cvNum(header, 'IMS:1000043'); // max count of pixel y
    const umX = cvNum(header, 'IMS:1000046'); // pixel size x (µm)
    const umY = cvNum(header, 'IMS:1000047'); // pixel size y (µm)
    const uuid = (cvValue(header, 'IMS:1000080') || '').replace(/[{}]/g, '').toLowerCase();
    const filterString = cvValue(header, 'MS:1000512') || '';
    const isContinuous = header.indexOf('IMS:1000030') >= 0;

    // ---- referenceableParamGroup を解決 ---------------------------------
    // 各グループが m/z 配列なのか intensity 配列なのか、その型と圧縮を控えておく。
    const groups = Object.create(null);
    const gRe = /<referenceableParamGroup\s+id="([^"]+)"([\s\S]*?)<\/referenceableParamGroup>/g;
    let gm;
    while ((gm = gRe.exec(header)) !== null) {
      const id = gm[1];
      const body = gm[2];
      let kind = null;
      if (body.indexOf('MS:1000515') >= 0) kind = 'intensity';
      else if (body.indexOf('MS:1000514') >= 0) kind = 'mz';
      groups[id] = {
        kind: kind,
        dtype: detectDtype(body),
        compressed: body.indexOf('MS:1000574') >= 0, // zlib compression
      };
    }

    // ---- ibd の UUID 照合 ------------------------------------------------
    const ibdBytes = new Uint8Array(ibdBuffer);
    if (ibdBytes.length >= 16 && uuid) {
      let hex = '';
      for (let i = 0; i < 16; i++) hex += ibdBytes[i].toString(16).padStart(2, '0');
      if (hex !== uuid.replace(/-/g, '')) {
        warnings.push('ibd の UUID (' + hex + ') が imzML の UUID (' + uuid + ') と一致しません。ペアが違う可能性があります。');
      }
    }

    const dv = new DataView(ibdBuffer);
    const ibdLen = ibdBuffer.byteLength;

    // ---- スペクトルを 1 本ずつ切り出して走査 -------------------------------
    // DOMParser は使わない: 17 MB の XML から数百 MB の DOM ができてしまう。
    const nHint = Number((/<spectrumList\s+count="(\d+)"/.exec(text) || [])[1]) || 0;
    const cap = nHint || 4096;
    let xs = new Int32Array(cap), ys = new Int32Array(cap), vs = new Float64Array(cap);
    let n = 0;
    function grow() {
      const cap2 = Math.max(8, n * 2);
      const nx = new Int32Array(cap2); nx.set(xs); xs = nx;
      const ny = new Int32Array(cap2); ny.set(ys); ys = ny;
      const nv = new Float64Array(cap2); nv.set(vs); vs = nv;
    }

    let pos = firstSpecAt < 0 ? -1 : firstSpecAt;
    let lastReport = 0;
    let skipped = 0;

    while (pos >= 0) {
      const end = text.indexOf('</spectrum>', pos);
      if (end < 0) break;
      const spec = text.slice(pos, end);

      const px = cvNum(spec, 'IMS:1000050'); // position x
      const py = cvNum(spec, 'IMS:1000051'); // position y

      if (px !== null && py !== null) {
        // intensity の binaryDataArray を探す
        const parts = spec.split('<binaryDataArray');
        let sum = null;
        for (let bi = 1; bi < parts.length; bi++) {
          const b = parts[bi];
          let kind = null, dtype = null, compressed = false;
          const rm = /referenceableParamGroupRef\s+ref="([^"]+)"/.exec(b);
          if (rm && groups[rm[1]]) {
            kind = groups[rm[1]].kind;
            dtype = groups[rm[1]].dtype;
            compressed = groups[rm[1]].compressed;
          }
          if (!kind) {
            if (b.indexOf('MS:1000515') >= 0) kind = 'intensity';
            else if (b.indexOf('MS:1000514') >= 0) kind = 'mz';
          }
          if (kind !== 'intensity') continue;
          if (!dtype) dtype = detectDtype(b);
          if (b.indexOf('MS:1000574') >= 0) compressed = true;

          if (compressed) throw new Error('zlib 圧縮された imzML には対応していません (MS:1000574)。非圧縮で書き出し直してください。');
          if (!dtype) throw new Error('intensity 配列のデータ型を判定できませんでした。');
          if (dtype === 'f16') throw new Error('16-bit float の intensity 配列には対応していません。');

          const off = cvNum(b, 'IMS:1000102'); // external offset
          const len = cvNum(b, 'IMS:1000103'); // external array length
          if (off === null || len === null) break;

          const sz = dtypeSize(dtype);
          if (off + len * sz > ibdLen) {
            throw new Error('ibd の範囲外を参照しています (offset=' + off + ', length=' + len + ', ibd=' + ibdLen + ' B)。imzML と ibd の組み合わせを確認してください。');
          }

          // ★ ピクセル値 = intensity 配列の全要素の和
          let s = 0;
          if (dtype === 'f32') {
            for (let k = 0, o = off; k < len; k++, o += 4) s += dv.getFloat32(o, true);
          } else if (dtype === 'f64') {
            for (let k = 0, o = off; k < len; k++, o += 8) s += dv.getFloat64(o, true);
          } else if (dtype === 'i32') {
            for (let k = 0, o = off; k < len; k++, o += 4) s += dv.getInt32(o, true);
          } else { // i64
            for (let k = 0, o = off; k < len; k++, o += 8) s += Number(dv.getBigInt64(o, true));
          }
          sum = s;
          break;
        }

        if (sum === null) { skipped++; }
        else {
          if (n >= xs.length) grow();
          xs[n] = px; ys[n] = py; vs[n] = sum; n++;
        }
      }

      pos = nextSpectrumStart(text, end);
      if (report && n - lastReport >= 500) {
        lastReport = n;
        report(nHint ? n / nHint : 0);
      }
    }

    if (!n) throw new Error('スペクトルを 1 本も読み取れませんでした。imzML の形式を確認してください。');
    if (skipped) warnings.push(skipped + ' 本のスペクトルで intensity 配列を解決できず、スキップしました。');

    // ---- グリッド化 ------------------------------------------------------
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      if (xs[i] < minX) minX = xs[i];
      if (xs[i] > maxX) maxX = xs[i];
      if (ys[i] < minY) minY = ys[i];
      if (ys[i] > maxY) maxY = ys[i];
    }
    // imzML の position x/y は 1 始まりが仕様。0 始まりで書かれた非準拠ファイルも
    // 実在するので、実際に現れた最小値が 0 以下のときだけ 0 始まりとみなす。
    // (途中から始まる部分取得では原点を 1 に保ちたいので、minX をそのまま
    //  原点にしてはいけない)
    const originX = minX <= 0 ? 0 : 1;
    const originY = minY <= 0 ? 0 : 1;
    const spanX = maxX - originX + 1;
    const spanY = maxY - originY + 1;
    // scanSettings の宣言値を優先しつつ、実データがはみ出す場合は実測に合わせる
    W = (W && W >= spanX) ? W : spanX;
    H = (H && H >= spanY) ? H : spanY;

    const values = new Float32Array(W * H);
    const counts = new Uint16Array(W * H);
    values.fill(NaN);
    for (let i = 0; i < n; i++) {
      const gi = (ys[i] - originY) * W + (xs[i] - originX);
      if (gi < 0 || gi >= values.length) continue;
      values[gi] = counts[gi] ? values[gi] + vs[i] : vs[i];
      counts[gi]++;
    }
    let dup = 0;
    for (let i = 0; i < values.length; i++) {
      if (counts[i] > 1) { values[i] /= counts[i]; dup++; }
    }
    if (dup) warnings.push(dup + ' 画素で座標が重複していたため平均しました。');

    if (report) report(1);

    return {
      values: values,
      W: W, H: H,
      umPerPx: { x: umX || null, y: umY || null },
      uuid: uuid,
      filterString: filterString,
      mode: isContinuous ? 'continuous' : 'processed',
      nSpectra: n,
      warnings: warnings,
    };
  }

  // =======================================================================
  // Worker 版
  // =======================================================================
  const WORKER_SRC =
    parseImzmlCore.toString() + '\n' +
    // 起動できたことを先に知らせる。呼び出し側はこれを見てから ibd を転送するので、
    // 「Worker が使えなかった」場合にメインスレッドへ安全に切り替えられる。
    'self.postMessage({ type: "ready" });\n' +
    'self.onmessage = function (e) {\n' +
    '  try {\n' +
    '    var r = parseImzmlCore(e.data.text, e.data.ibd, function (p) { self.postMessage({ type: "progress", value: p }); });\n' +
    '    self.postMessage({ type: "done", result: r }, [r.values.buffer]);\n' +
    '  } catch (err) {\n' +
    '    self.postMessage({ type: "error", message: (err && err.message) || String(err) });\n' +
    '  }\n' +
    '};\n';

  let workerUrl = null;
  function getWorkerUrl() {
    if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'application/javascript' }));
    return workerUrl;
  }

  // Worker 起動失敗 (= メインスレッドに切り替えるべき) と、解析そのものの失敗
  // (= そのままユーザーに見せるべき) を区別する。
  function workerUnavailable(msg) {
    const e = new Error(msg);
    e.workerUnavailable = true;
    return e;
  }

  function runInWorker(text, ibdBuffer, onProgress) {
    return new Promise((resolve, reject) => {
      let w;
      try { w = new Worker(getWorkerUrl()); }
      catch (e) { reject(workerUnavailable(e.message || String(e))); return; }

      let alive = false;
      const timer = setTimeout(() => {
        if (alive) return;
        w.terminate();
        reject(workerUnavailable('Worker が応答しません'));
      }, 10000);

      w.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'ready') {
          // ★ ibd の転送はここまで待つ。転送してしまうと元の ArrayBuffer は
          //   detach されてメインスレッドでは二度と読めないので、
          //   「Worker が生きている」と判った後でしか渡さない。
          alive = true;
          clearTimeout(timer);
          w.postMessage({ text: text, ibd: ibdBuffer }, [ibdBuffer]);
          return;
        }
        if (d.type === 'progress') { if (onProgress) onProgress(d.value); return; }
        if (d.type === 'done') { w.terminate(); resolve(d.result); return; }
        if (d.type === 'error') { w.terminate(); reject(new Error(d.message)); }
      };
      w.onerror = (e) => {
        clearTimeout(timer);
        w.terminate();
        reject(alive ? new Error(e.message || 'imzML worker error')
                     : workerUnavailable(e.message || 'imzML worker を起動できませんでした'));
      };
    });
  }

  // =======================================================================
  // 公開 API
  // =======================================================================

  /**
   * imzML + ibd のペアを解析する。
   * @returns {Promise<{values:Float32Array, W:number, H:number, umPerPx:{x,y},
   *                    uuid:string, filterString:string, mode:string,
   *                    nSpectra:number, warnings:string[]}>}
   */
  async function parsePair(imzmlFile, ibdFile, onProgress) {
    // imzML の宣言は ISO-8859-1 のことが多い (Windows のパスが混ざる)。
    // 宣言を先頭 1 KB から読んで、その encoding でデコードし直す。
    const headBuf = await imzmlFile.slice(0, 1024).arrayBuffer();
    const headTxt = new TextDecoder('ascii').decode(headBuf);
    const encMatch = /encoding=["']([^"']+)["']/i.exec(headTxt);
    let enc = (encMatch ? encMatch[1] : 'utf-8').toLowerCase();
    let text;
    const buf = await imzmlFile.arrayBuffer();
    try {
      text = new TextDecoder(enc).decode(buf);
    } catch (e) {
      text = new TextDecoder('iso-8859-1').decode(buf);
    }
    const ibdBuffer = await ibdFile.arrayBuffer();
    try {
      return await runInWorker(text, ibdBuffer, onProgress);
    } catch (e) {
      // 解析そのものの失敗 (非対応の圧縮、壊れた ibd など) はそのまま伝える。
      // ここで握りつぶすと、原因の分かるメッセージが「detached ArrayBuffer」に化ける。
      if (!e.workerUnavailable) throw e;
      // Worker が使えない環境でのみメインスレッドで実行する。
      // ibd はまだ転送されていないので安全に読める。
      console.warn('[imzml] Worker を使えないためメインスレッドで解析します:', e.message);
      return parseImzmlCore(text, ibdBuffer, onProgress);
    }
  }

  /**
   * ファイル名から分子名 / 切片方向 / 切片 ID を取り出す。
   *   NE_Cor_1_10.imzML → { molecule:'NE', orientation:'Cor', sliceId:'1_10' }
   * 先頭の _ より前が分子名、2 つ目の _ の前が Cor ならコロナル切片。
   */
  function parseFileName(name) {
    const base = String(name).replace(/\.(imzml|ibd)$/i, '');
    const tok = base.split('_');
    const molecule = tok[0] || base;
    const orientation = tok.length > 1 ? tok[1] : '';
    const sliceId = tok.slice(2).join('_');
    let plane = '';
    const o = orientation.toLowerCase();
    if (o === 'cor') plane = 'coronal';
    else if (o === 'sag') plane = 'sagittal';
    else if (o === 'ax' || o === 'axi' || o === 'hor') plane = 'axial';
    return {
      molecule: molecule,
      orientation: orientation,
      plane: plane,
      sliceId: sliceId,
      // 同じ切片としてまとめるためのキー
      groupKey: [orientation, sliceId].filter(Boolean).join('_') || base,
    };
  }

  /**
   * 選択されたファイル一覧を .imzML / .ibd のペアにまとめ、切片ごとにグループ化する。
   * @returns {{groups: Array, problems: string[]}}
   */
  function groupFiles(files) {
    const imz = new Map(), ibd = new Map();
    const problems = [];
    for (const f of files) {
      const m = /\.(imzml|ibd)$/i.exec(f.name);
      if (!m) { problems.push(f.name + ': .imzML / .ibd 以外は無視しました'); continue; }
      const stem = f.name.replace(/\.(imzml|ibd)$/i, '');
      if (m[1].toLowerCase() === 'imzml') imz.set(stem, f); else ibd.set(stem, f);
    }
    const byGroup = new Map();
    for (const [stem, imzFile] of imz) {
      const ibdFile = ibd.get(stem);
      if (!ibdFile) { problems.push(stem + '.imzML に対応する ' + stem + '.ibd がありません'); continue; }
      const info = parseFileName(stem);
      if (!byGroup.has(info.groupKey)) {
        byGroup.set(info.groupKey, {
          groupKey: info.groupKey,
          orientation: info.orientation,
          plane: info.plane,
          sliceId: info.sliceId,
          items: [],
        });
      }
      byGroup.get(info.groupKey).items.push({ molecule: info.molecule, stem: stem, imzmlFile: imzFile, ibdFile: ibdFile });
    }
    for (const stem of ibd.keys()) {
      if (!imz.has(stem)) problems.push(stem + '.ibd に対応する ' + stem + '.imzML がありません');
    }
    const groups = [...byGroup.values()];
    for (const g of groups) g.items.sort((a, b) => a.molecule.localeCompare(b.molecule));
    return { groups: groups, problems: problems };
  }

  global.ImzML = {
    parsePair: parsePair,
    parseFileName: parseFileName,
    groupFiles: groupFiles,
    _core: parseImzmlCore,
  };
})(window);
