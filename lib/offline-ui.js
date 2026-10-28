/* Master controls for a self-contained offline copy. No authentication/session
 * storage is copied. A fresh package identity separates each downloaded copy. */
(function (global) {
  'use strict';
  const MAX_APP_BYTES = 256 * 1024 * 1024;
  function offline() { return !!(global.ATLAS_OFFLINE && global.ATLAS_OFFLINE.enabled); }
  function check(signal) {
    if (signal && signal.aborted) throw new DOMException('キャンセルしました', 'AbortError');
  }
  async function digest(blob) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), v => v.toString(16).padStart(2, '0')).join('');
  }
  async function read(url, signal, maximum) {
    const response = await fetch(url, { signal, cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('必要なファイルを取得できませんでした (' + response.status + ')。再読み込みして再試行してください。');
    const max = maximum || MAX_APP_BYTES;
    if (Number(response.headers.get('Content-Length')) > max) throw new Error('ファイルのサイズが上限を超えています。');
    const reader = response.body && response.body.getReader();
    if (!reader) {
      const blob = await response.blob();
      if (blob.size > max) throw new Error('ファイルのサイズが上限を超えています。');
      return blob;
    }
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        check(signal);
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > max) throw new Error('ファイルのサイズが上限を超えています。');
        chunks.push(part.value);
      }
      return new Blob(chunks);
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  function safePath(path) {
    return typeof path === 'string' && /^[A-Za-z0-9_./ -]+$/.test(path) &&
      !path.startsWith('/') && !path.split('/').some(p => !p || p === '.' || p === '..');
  }
  async function template(signal, report) {
    if (!offline()) {
      report('Windows用アプリを取得しています…');
      const manifest = JSON.parse(await (await read('offline/atlas-app.manifest.json', signal, 1024 * 1024)).text());
      if (manifest.format !== 'marmoset-atlas-app-template' || manifest.schemaVersion !== 1 ||
          manifest.platform !== 'win32-x64' || manifest.runtimeIncluded !== true || manifest.archive !== 'atlas-app.zip' ||
          manifest.appVersion !== global.APP_VERSION || !Number.isSafeInteger(manifest.size) ||
          manifest.size <= 0 || manifest.size > MAX_APP_BYTES || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
        throw new Error('画面と配布アプリの版が一致しません。画面を再読み込みしてください。');
      }
      const blob = await read('offline/atlas-app.zip', signal, manifest.size);
      if (blob.size !== manifest.size || await digest(blob) !== manifest.sha256) throw new Error('アプリファイルの検証に失敗しました。再試行してください。');
      return blob;
    }
    report('このオフライン版のアプリをまとめています…');
    const manifest = JSON.parse(await (await read('/__atlas_files.json', signal, 2 * 1024 * 1024)).text());
    if (manifest.format !== 'marmoset-atlas-package-files' || !Array.isArray(manifest.files) || manifest.files.length > 5000) {
      throw new Error('起動プログラムからアプリの一覧を取得できません。START_ATLAS.cmd で起動してください。');
    }
    const seen = new Set();
    let total = 0;
    const zip = new global.JSZip();
    for (let i = 0; i < manifest.files.length; i++) {
      check(signal);
      const f = manifest.files[i];
      if (!safePath(f.path) || seen.has(f.path) || f.path === 'app/data/workspace.zip' ||
          !Number.isSafeInteger(f.size) || f.size < 0 || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new Error('アプリのファイル一覧が不正です。');
      seen.add(f.path);
      total += f.size;
      if (total > MAX_APP_BYTES) throw new Error('アプリのサイズが上限を超えています。');
      report('アプリをまとめています (' + (i + 1) + '/' + manifest.files.length + ')');
      const blob = await read('/__atlas_package/' + f.path.split('/').map(encodeURIComponent).join('/'), signal, Math.max(1, f.size));
      if (blob.size !== f.size || await digest(blob) !== f.sha256) throw new Error('アプリファイルが変更されました。再起動して再試行してください。');
      zip.file(f.path, await blob.arrayBuffer(), { createFolders: false });
    }
    if (!seen.has('runtime/node.exe') || !seen.has('app/index.html')) throw new Error('起動に必要なアプリファイルが不足しています。');
    return zip.generateAsync({ type: 'blob', compression: 'STORE' }, () => check(signal));
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function init(options) {
    const button = document.getElementById('offline-export');
    const panel = document.getElementById('offline-panel');
    const status = document.getElementById('offline-status');
    const cancel = document.getElementById('offline-cancel');
    const label = document.getElementById('offline-mode-label');
    let active = null;
    function report(message, error) {
      panel.classList.remove('hidden');
      status.textContent = message;
      status.style.color = error ? '#b91c1c' : '#1e40af';
    }
    function busy(value) {
      options.setBusy(value);
      cancel.disabled = !value;
      cancel.classList.toggle('hidden', !value);
    }
    if (offline()) {
      button.textContent = '更新後のアプリ＋全データを保存';
      label.classList.remove('hidden');
    }
    cancel.addEventListener('click', () => {
      if (active) { active.abort(); cancel.disabled = true; report('キャンセルしています…'); }
    });
    button.addEventListener('click', async () => {
      if (active) return;
      const controller = new AbortController(); active = controller;
      busy(true);
      try {
        const app = await template(controller.signal, report);
        const snapshot = await options.prepareSnapshot({ signal: controller.signal, onProgress: report });
        check(controller.signal);
        const workspaceId = crypto.randomUUID();
        const version = global.APP_VERSION;
        report('全データの検証とZIPの作成中…');
        const data = await global.OfflineWorkspace.encode(snapshot, {
          workspaceId, appVersion: version, signal: controller.signal,
        });
        check(controller.signal);
        report('アプリとデータをひとつのZIPにまとめています…');
        const blob = await global.OfflineWorkspace.packageApp(app, data, {
          workspaceId, appVersion: version, signal: controller.signal,
        });
        check(controller.signal);
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_');
        download(blob, 'Atlas_offline_Windows_' + stamp + '.zip');
        report('出力しました：データ ' + snapshot.projects.length + ' 件、フォルダ ' + snapshot.folders.length +
          ' 件。ZIPを展開し、START_ATLAS.cmd で起動してください。');
      } catch (error) {
        report(error.name === 'AbortError' ? '出力をキャンセルしました。' : '出力できませんでした：' + error.message, error.name !== 'AbortError');
      } finally { active = null; busy(false); }
    });
    async function bootstrap() {
      if (!offline()) return;
      const config = global.ATLAS_OFFLINE;
      busy(true); cancel.classList.add('hidden');
      let restored = false;
      report('同梱データを確認しています。初回の復元が終わるまでお待ちください…');
      try {
        if (!await global.ProjectStorage.hasWorkspaceRestore()) {
          const blob = await read('data/workspace.zip', undefined, global.OfflineWorkspace.LIMITS.archive);
          const decoded = await global.OfflineWorkspace.decode(blob);
          if (decoded.manifest.workspaceId !== config.workspaceId) throw new Error('同梱データとアプリの識別情報が一致しません。');
          const estimate = await global.ProjectStorage.estimate();
          const required = decoded.snapshot.blobs.reduce((sum, record) => sum + record.blob.size, 0);
          if (estimate && Number.isFinite(estimate.quota) && required > estimate.quota - (estimate.usage || 0)) {
            throw new Error('ブラウザの保存領域が不足しています。空き容量を確保してから再起動してください。');
          }
          report('登録データを復元しています…');
          try { await global.ProjectStorage.restoreWorkspaceSnapshot(decoded.snapshot); }
          catch (error) {
            // Simultaneous tabs may have completed the same atomic restore.
            if (error.code !== 'WORKSPACE_NOT_EMPTY' || !await global.ProjectStorage.hasWorkspaceRestore()) throw error;
          }
        }
        restored = true;
        report('オフライン版を開きました。編集後は「更新後のアプリ＋全データを保存」で持ち出せます。');
      } catch (error) {
        report('同梱データを復元できませんでした：' + error.message + '\n元のZIPを保管し、原因を解消して再読み込みしてください。', true);
        throw error;
      } finally { if (restored) busy(false); }
    }
    return { bootstrap };
  }
  global.OfflineUI = { init };
})(window);
