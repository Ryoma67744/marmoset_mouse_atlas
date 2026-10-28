/* Portable workspace archives. No credentials, browser storage dumps, or CSV conversions. */
(function (global) {
  'use strict';
  const FORMAT = 'marmoset-atlas-offline-workspace';
  const VERSION = 1;
  const LIMITS = Object.freeze({ archive: 512 * 1024 * 1024, entry: 256 * 1024 * 1024,
    metadata: 16 * 1024 * 1024, entries: 20000, records: 10000, nodes: 1000000, depth: 100 });
  const SCALAR = '__atlas_scalar__';
  const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1;
    return n >>> 0;
  });
  function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8;
    return (value ^ 0xffffffff) >>> 0;
  }
  function fail(message) { throw new Error('オフライン保存: ' + message); }
  function checkSignal(signal) {
    if (signal && signal.aborted) { const error = new Error('保存を中止しました'); error.name = 'AbortError'; throw error; }
  }
  function progress(options, phase, completed, total) {
    checkSignal(options.signal);
    if (typeof options.onProgress === 'function') options.onProgress({ phase, completed, total });
  }
  function dependencies() {
    if (!global.JSZip) fail('JSZip が読み込まれていません');
    if (!global.crypto || !global.crypto.subtle) fail('この環境では SHA-256 検証を利用できません。HTTPS または同梱ランチャーで開いてください');
  }
  function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
  function string(value, label, max) {
    if (typeof value !== 'string' || !value.length || value.length > (max || 1024) || /[\u0000-\u001f]/.test(value)) fail(label + ' が不正です');
    return value;
  }
  function workspaceId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) fail('ワークスペース ID が不正です');
    return value;
  }
  function safePath(value) {
    string(value, 'ZIP 内のパス', 500);
    if (/[\\:*?"<>|]/.test(value) || value.startsWith('/') || value.endsWith(' ') || value.endsWith('.')) fail('ZIP 内のパスが不正です');
    const parts = value.replace(/\/$/, '').split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || FORBIDDEN.has(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('ZIP 内のパスが不正です');
    return value;
  }
  async function digest(bytes) {
    return Array.from(new Uint8Array(await global.crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  }
  async function bytesOf(blob) {
    if (!blob || !Number.isSafeInteger(blob.size) || typeof blob.arrayBuffer !== 'function') fail('ZIP ファイルが不正です');
    if (blob.size > LIMITS.archive) fail('ZIP が上限の 512 MiB を超えています');
    return new Uint8Array(await blob.arrayBuffer());
  }

  // Inspect the central directory before any decompression. JSZip normalizes ../
  // paths and overwrites duplicate names, so inspecting its result is too late.
  function inspectZip(bytes, storeOnly) {
    if (bytes.byteLength < 22 || bytes.byteLength > LIMITS.archive) fail('ZIP のサイズが不正です');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
    }
    if (end < 0) fail('ZIP 終端が見つかりません');
    const count = view.getUint16(end + 10, true), offset = view.getUint32(end + 16, true), size = view.getUint32(end + 12, true);
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== view.getUint16(end + 8, true) || count === 65535 || offset === 0xffffffff || size === 0xffffffff) fail('分割 ZIP / ZIP64 は対応していません');
    if (count > LIMITS.entries || offset + size !== end) fail('ZIP エントリ数または構造が不正です');
    let cursor = offset, total = 0;
    const entries = [], names = new Set(), ranges = [];
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) fail('ZIP エントリが破損しています');
      const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true);
      const compressed = view.getUint32(cursor + 20, true), uncompressed = view.getUint32(cursor + 24, true);
      const nameSize = view.getUint16(cursor + 28, true), extraSize = view.getUint16(cursor + 30, true), commentSize = view.getUint16(cursor + 32, true);
      const local = view.getUint32(cursor + 42, true), attrs = view.getUint32(cursor + 38, true);
      if (cursor + 46 + nameSize + extraSize + commentSize > end || !nameSize || view.getUint16(cursor + 34, true)) fail('ZIP エントリが不正です');
      // Own workspace archives never need extra fields. In particular, reject
      // Unicode-path and ZIP64 extras before JSZip can reinterpret checked names.
      if (storeOnly && extraSize) fail('ワークスペース ZIP に未対応の拡張フィールドがあります');
      if (flags & ~(0x800 | 8) || (method !== 0 && (storeOnly || method !== 8))) fail('対応していない ZIP 圧縮形式です');
      if (uncompressed > LIMITS.entry || compressed > LIMITS.entry || (method === 0 && compressed !== uncompressed)) fail('ZIP エントリのサイズが上限を超えています');
      total += uncompressed;
      if (total > LIMITS.archive) fail('展開後の合計サイズが上限を超えています');
      if ((attrs >>> 16 & 0xf000) === 0xa000) fail('シンボリックリンクは保存できません');
      const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
      if (!(flags & 0x800) && nameBytes.some(b => b > 127)) fail('ZIP のファイル名エンコーディングが不正です');
      const name = safePath(decoder.decode(nameBytes)), key = name.toLowerCase();
      if (names.has(key)) fail('ZIP 内のパスが重複しています');
      names.add(key);
      if (name.endsWith('/') && uncompressed) fail('ZIP ディレクトリが不正です');
      if (local + 30 > offset || view.getUint32(local, true) !== 0x04034b50) fail('ZIP ローカルヘッダーが不正です');
      const localNameSize = view.getUint16(local + 26, true), localExtraSize = view.getUint16(local + 28, true);
      if (storeOnly && localExtraSize) fail('ワークスペース ZIP に未対応の拡張フィールドがあります');
      const start = local + 30 + localNameSize + localExtraSize;
      if (start + compressed > offset || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method || localNameSize !== nameSize || decoder.decode(bytes.subarray(local + 30, local + 30 + localNameSize)) !== name) fail('ZIP ローカルヘッダーが一致しません');
      if (!(flags & 8) && (view.getUint32(local + 18, true) !== compressed || view.getUint32(local + 22, true) !== uncompressed || view.getUint32(local + 14, true) !== view.getUint32(cursor + 16, true))) fail('ZIP ローカルサイズが一致しません');
      if (method === 0 && crc32(bytes.subarray(start, start + compressed)) !== view.getUint32(cursor + 16, true)) fail('ZIP ファイルの CRC が一致しません');
      ranges.push([local, start + compressed]);
      entries.push({ name, size: uncompressed, compressed });
      cursor += 46 + nameSize + extraSize + commentSize;
    }
    if (cursor !== end) fail('ZIP ディレクトリの長さが一致しません');
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) fail('ZIP エントリが重なっています');
    return entries;
  }

  // Preserve uncommon numeric metadata and explicit undefined without changing
  // arbitrary user strings. Scientific raster bytes are stored independently.
  function transform(value, mode) {
    let nodes = 0;
    const active = new Set();
    function visit(item, depth) {
      if (++nodes > LIMITS.nodes || depth > LIMITS.depth) fail('メタデータが複雑すぎます');
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
      if (typeof item === 'number') {
        if (mode === 'encode' && (!Number.isFinite(item) || Object.is(item, -0))) return { [SCALAR]: Object.is(item, -0) ? '-0' : String(item) };
        if (!Number.isFinite(item)) fail('メタデータの数値が不正です');
        return item;
      }
      if (typeof item === 'undefined' && mode === 'encode') return { [SCALAR]: 'undefined' };
      if (!item || typeof item !== 'object' || active.has(item)) fail('メタデータの値が不正です');
      if (Object.keys(item).some(key => FORBIDDEN.has(key))) fail('メタデータに禁止されたキーがあります');
      if (Object.prototype.hasOwnProperty.call(item, SCALAR)) {
        if (mode !== 'decode' || Object.keys(item).length !== 1) fail('メタデータに予約済みキーがあります');
        const special = item[SCALAR];
        if (special === 'undefined') return undefined;
        if (special === 'NaN') return NaN;
        if (special === 'Infinity') return Infinity;
        if (special === '-Infinity') return -Infinity;
        if (special === '-0') return -0;
        fail('メタデータの特殊値が不正です');
      }
      if (Object.prototype.toString.call(item) !== '[object Object]' && !Array.isArray(item)) fail('対応していないメタデータ型です');
      active.add(item);
      const result = Array.isArray(item) ? Array.from(item, child => visit(child, depth + 1)) : {};
      if (!Array.isArray(item)) for (const key of Object.keys(item)) result[key] = visit(item[key], depth + 1);
      active.delete(item);
      return result;
    }
    return visit(value, 0);
  }
  function parseJSON(bytes) {
    if (bytes.length > LIMITS.metadata) fail('メタデータが上限を超えています');
    let parsed;
    try { parsed = JSON.parse(decoder.decode(bytes)); } catch (_) { fail('JSON メタデータが破損しています'); }
    // Run the bounded key/type check even on manifests that do not use scalars.
    transform(parsed, 'encode');
    return parsed;
  }
  function unique(records, label) {
    if (!Array.isArray(records) || records.length > LIMITS.records) fail(label + ' の件数が不正です');
    const map = new Map();
    for (const item of records) {
      if (!record(item)) fail(label + ' の構造が不正です');
      const id = string(item.id, label + ' ID');
      if (FORBIDDEN.has(id) || map.has(id)) fail(label + ' ID が重複または不正です');
      map.set(id, item);
    }
    return map;
  }
  function validateSnapshot(snapshot) {
    if (!record(snapshot)) fail('スナップショットが不正です');
    const projects = unique(snapshot.projects, 'データ'), folders = unique(snapshot.folders, 'フォルダ'), blobs = unique(snapshot.blobs, 'バイナリ');
    let total = 0;
    for (const item of blobs.values()) {
      if (!item.blob || typeof item.blob.arrayBuffer !== 'function' || !Number.isSafeInteger(item.blob.size) || item.blob.size > LIMITS.entry) fail('バイナリのサイズまたは型が不正です');
      total += item.blob.size;
      if (total > LIMITS.archive) fail('データ全体が上限の 512 MiB を超えています');
      if (item.mime != null && typeof item.mime !== 'string' || item.filename != null && typeof item.filename !== 'string') fail('バイナリの属性が不正です');
    }
    for (const folder of folders.values()) {
      if (folder.parentId != null && folder.parentId !== '' && !folders.has(folder.parentId)) fail('親フォルダが見つかりません');
    }
    const complete = new Set();
    for (const folder of folders.values()) {
      const seen = new Set();
      let parent = folder.id;
      while (parent) {
        if (complete.has(parent)) break;
        if (seen.has(parent)) fail('フォルダの階層が循環しています');
        seen.add(parent); parent = folders.get(parent).parentId;
      }
      for (const id of seen) complete.add(id);
    }
    for (const project of projects.values()) {
      if (project.folderId != null && project.folderId !== '' && !folders.has(project.folderId)) fail('データのフォルダが見つかりません');
      if (!Array.isArray(project.molecules) || (project.images != null && !record(project.images))) fail('データの分子または画像の構造が不正です');
      for (const reference of [...project.molecules, ...Object.values(project.images || {})]) {
        if (!record(reference) || typeof reference.blobId !== 'string' || !blobs.has(reference.blobId)) fail('参照先のバイナリが見つかりません');
        if (!blobs.get(reference.blobId).blob.size) fail('参照先のバイナリが空です');
      }
      if (project.molecules.length) {
        const grid = project.grid;
        if (!grid || !Number.isSafeInteger(grid.W) || !Number.isSafeInteger(grid.H) || grid.W <= 0 || grid.H <= 0 || !Number.isSafeInteger(grid.W * grid.H * 4)) fail('データの画素寸法が不正です');
        for (const molecule of project.molecules) if (blobs.get(molecule.blobId).blob.size !== grid.W * grid.H * 4) fail('分子ラスタの長さが画素寸法と一致しません');
      }
    }
  }
  function entryDescriptor(value, expectedPath) {
    if (!record(value) || value.path !== expectedPath || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > LIMITS.entry || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) fail('ファイル検証情報が不正です');
  }

  async function encode(snapshot, options) {
    options = options || {}; dependencies(); checkSignal(options.signal);
    validateSnapshot(snapshot);
    const id = workspaceId(options.workspaceId || global.crypto.randomUUID());
    const metadata = encoder.encode(JSON.stringify(transform({ projects: snapshot.projects, folders: snapshot.folders }, 'encode')));
    if (metadata.length > LIMITS.metadata) fail('メタデータが上限を超えています');
    const zip = new global.JSZip();
    zip.file('metadata.json', metadata, { compression: 'STORE', createFolders: false });
    const manifest = { format: FORMAT, version: VERSION, appVersion: String(options.appVersion || global.APP_VERSION || ''), workspaceId: id,
      createdAt: new Date().toISOString(), counts: { projects: snapshot.projects.length, folders: snapshot.folders.length, blobs: snapshot.blobs.length },
      metadata: { path: 'metadata.json', size: metadata.length, sha256: await digest(metadata) }, blobs: [] };
    for (let i = 0; i < snapshot.blobs.length; i++) {
      progress(options, 'encode', i, snapshot.blobs.length);
      const item = snapshot.blobs[i], bytes = new Uint8Array(await item.blob.arrayBuffer());
      const path = 'blobs/' + String(i + 1).padStart(8, '0') + '.bin';
      manifest.blobs.push({ id: item.id, path, size: bytes.length, sha256: await digest(bytes), mime: item.mime == null ? item.blob.type || '' : item.mime, filename: item.filename == null ? '' : item.filename });
      zip.file(path, bytes, { compression: 'STORE', createFolders: false });
    }
    const manifestBytes = encoder.encode(JSON.stringify(manifest));
    if (manifestBytes.length > LIMITS.metadata) fail('マニフェストが上限を超えています');
    zip.file('manifest.json', manifestBytes, { compression: 'STORE', createFolders: false });
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE', streamFiles: false }, () => checkSignal(options.signal));
    if (bytes.length > LIMITS.archive) fail('ZIP が上限の 512 MiB を超えています');
    progress(options, 'encode', snapshot.blobs.length, snapshot.blobs.length);
    return new Blob([bytes], { type: 'application/zip' });
  }

  async function decode(blob, options) {
    options = options || {}; dependencies(); checkSignal(options.signal);
    const bytes = await bytesOf(blob), entries = inspectZip(bytes, true), info = new Map(entries.map(entry => [entry.name, entry]));
    for (const entry of entries) if (entry.name !== 'manifest.json' && entry.name !== 'metadata.json' && !/^blobs\/[0-9]{8}\.bin$/.test(entry.name)) fail('予期しないファイルが含まれています');
    if (!info.has('manifest.json') || !info.has('metadata.json') || info.get('manifest.json').size > LIMITS.metadata || info.get('metadata.json').size > LIMITS.metadata) fail('マニフェストまたはメタデータが不正です');
    const zip = await global.JSZip.loadAsync(bytes);
    const manifest = parseJSON(await zip.file('manifest.json').async('uint8array'));
    if (manifest.format !== FORMAT || manifest.version !== VERSION) fail('対応していないワークスペース形式またはバージョンです');
    workspaceId(manifest.workspaceId);
    if (!record(manifest.counts) || !Array.isArray(manifest.blobs) || manifest.blobs.length > LIMITS.records || manifest.counts.blobs !== manifest.blobs.length || entries.length !== manifest.blobs.length + 2) fail('マニフェストの件数が一致しません');
    entryDescriptor(manifest.metadata, 'metadata.json');
    async function verified(descriptor) {
      checkSignal(options.signal);
      const entry = info.get(descriptor.path);
      if (!entry || entry.size !== descriptor.size) fail('ファイルのサイズまたは参照先が一致しません');
      const value = await zip.file(descriptor.path).async('uint8array');
      if (value.length !== descriptor.size || await digest(value) !== descriptor.sha256) fail('ファイルの SHA-256 が一致しません: ' + descriptor.path);
      return value;
    }
    const metadataBytes = await verified(manifest.metadata);
    let metadata;
    try { metadata = JSON.parse(decoder.decode(metadataBytes)); } catch (_) { fail('JSON メタデータが破損しています'); }
    metadata = transform(metadata, 'decode');
    if (!record(metadata) || !Array.isArray(metadata.projects) || !Array.isArray(metadata.folders) || metadata.projects.length !== manifest.counts.projects || metadata.folders.length !== manifest.counts.folders) fail('メタデータの件数が一致しません');
    const blobs = [];
    for (let i = 0; i < manifest.blobs.length; i++) {
      progress(options, 'decode', i, manifest.blobs.length);
      const item = manifest.blobs[i];
      entryDescriptor(item, 'blobs/' + String(i + 1).padStart(8, '0') + '.bin');
      string(item.id, 'バイナリ ID');
      if (typeof item.mime !== 'string' || typeof item.filename !== 'string') fail('バイナリ属性が不正です');
      blobs.push({ id: item.id, blob: new Blob([await verified(item)], { type: item.mime }), mime: item.mime, filename: item.filename });
    }
    const snapshot = { projects: metadata.projects, folders: metadata.folders, blobs };
    validateSnapshot(snapshot);
    progress(options, 'decode', blobs.length, blobs.length);
    return { snapshot, manifest };
  }

  async function packageApp(templateBlob, workspaceBlob, options) {
    options = options || {}; dependencies();
    const { manifest } = await decode(workspaceBlob, options), id = workspaceId(options.workspaceId || manifest.workspaceId);
    if (id !== manifest.workspaceId) fail('アプリとデータのワークスペース ID が一致しません');
    const templateBytes = await bytesOf(templateBlob), entries = inspectZip(templateBytes, false);
    if (entries.reduce((size, entry) => size + entry.size, 0) > LIMITS.entry) fail('アプリテンプレートの展開サイズが上限の 256 MiB を超えています');
    for (const entry of entries) {
      if (!/^(?:app\/|runtime\/|LICENSES\/|offline\/(?:server\.cjs|package-files\.json)$|START_ATLAS\.cmd$|launch[^/]*\.(?:cmd|ps1|sh)$|README[^/]*$|LICENSE[^/]*$|[^/]*manifest\.json$)/i.test(entry.name)) fail('アプリテンプレートに予期しないパスがあります');
      if (entry.name === 'app/data/workspace.zip' || entry.name === 'app/data/app-files.json') fail('アプリテンプレートにデータが含まれています');
    }
    if (!entries.some(entry => entry.name === 'app/index.html') || !entries.some(entry => /^(?:START_ATLAS|launch[^/]*)\.cmd$/i.test(entry.name))) fail('アプリテンプレートに本体またはランチャーがありません');
    // App templates are trusted release artifacts (verified by the caller),
    // unlike workspace files. Preserve JSZip's compressed streams on repack.
    const source = await global.JSZip.loadAsync(templateBytes), output = source;
    let total = workspaceBlob.size;
    let completed = 0;
    for (const entry of entries) {
      progress(options, 'package', completed++, entries.length);
      if (entry.name.endsWith('/')) continue;
      const bytes = await source.file(entry.name).async('uint8array');
      if (bytes.length !== entry.size) fail('アプリテンプレートのサイズが一致しません');
      total += bytes.length;
      if (total > LIMITS.archive) fail('アプリとデータの合計が上限の 512 MiB を超えています');
    }
    const config = { enabled: true, workspaceId: id, workspaceArchive: 'data/workspace.zip', appVersion: String(options.appVersion || manifest.appVersion || '') };
    output.file('app/lib/offline-config.js', 'window.ATLAS_OFFLINE = ' + JSON.stringify(config).replace(/</g, '\\u003c') + ';\nwindow.ATLAS_OFFLINE_WORKSPACE_ID = window.ATLAS_OFFLINE.workspaceId;\n', { compression: 'DEFLATE', createFolders: false });
    output.file('app/data/workspace.zip', await workspaceBlob.arrayBuffer(), { compression: 'STORE', createFolders: false });
    const bytes = await output.generateAsync({ type: 'uint8array', compression: 'DEFLATE', streamFiles: false }, () => checkSignal(options.signal));
    if (bytes.length > LIMITS.archive) fail('ZIP が上限の 512 MiB を超えています');
    progress(options, 'package', entries.length, entries.length);
    return new Blob([bytes], { type: 'application/zip' });
  }
  global.OfflineWorkspace = Object.freeze({ FORMAT, VERSION, LIMITS, encode, decode, packageApp });
})(window);
