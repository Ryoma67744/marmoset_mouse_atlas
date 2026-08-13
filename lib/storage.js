/*
 * storage.js — 登録データの保存層 (IndexedDB)
 *
 * このサイトはサーバを持たない静的サイトなので、ユーザーが登録したデータは
 * ブラウザ内 IndexedDB に置く。ZIP は「持ち出し / 別環境での再開」用の可搬形式で、
 * 保存の代替ではない。
 *
 * ストア構成:
 *   projects : { id, displayName, folderId, ... } — プロジェクト本体 (メタのみ。実データは blobs)
 *   blobs    : { id, blob, mime, filename } — HE 画像の原本と、分子ごとの生値ラスタ
 *   folders  : { id, name, parentId, createdAt, updatedAt } — 整理用のフォルダ
 *
 * ★ 生の imzML/ibd は保存しない。1 分子あたり 19 MB あるのに対し、解析後の生値ラスタは
 *   89×120×4 B = 42 KB で、表示・解析・ZIP 出力に必要な情報はすべて含まれる。
 *
 * ★ フォルダは「入れ子の JSON 1 本」ではなく parentId を持つ平坦なレコードで表す。
 *   移動が親の付け替えだけで済み、木が壊れても (親が消えた等) 各レコードは独立して
 *   生き残るので、ルートに拾い上げるだけで復旧できる。
 */
(function (global) {
  'use strict';

  const DB_NAME = 'marmoset-atlas';
  // v2: folders ストアを追加
  const DB_VERSION = 2;
  const STORE_PROJECTS = 'projects';
  const STORE_BLOBS = 'blobs';
  const STORE_FOLDERS = 'folders';

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
          db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_BLOBS)) {
          db.createObjectStore(STORE_BLOBS, { keyPath: 'id' });
        }
        // v1 → v2: 既存の projects / blobs はそのまま。folders を足すだけなので、
        // 既に登録済みのデータは folderId 未設定 = ルート扱いで見え続ける。
        if (!db.objectStoreNames.contains(STORE_FOLDERS)) {
          db.createObjectStore(STORE_FOLDERS, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // 別タブが新しいバージョンを開いたらこちらは閉じる (blocked を出さないため)
        db.onversionchange = () => { try { db.close(); } catch (e) {} dbPromise = null; };
        resolve(db);
      };
      // ★ 失敗した Promise をキャッシュに残すと、以後どの操作も同じエラーで
      //   落ち続け、リロードするまで復帰できない。失敗時はキャッシュを捨てる。
      req.onerror = () => { dbPromise = null; reject(req.error || new Error('IndexedDB を開けませんでした')); };
      req.onblocked = () => { dbPromise = null; reject(new Error('IndexedDB がほかのタブでロックされています。ほかのタブを閉じて再読み込みしてください。')); };
    });
    return dbPromise;
  }

  function tx(storeName, mode, fn) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      let result;
      try { result = fn(store); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
    }));
  }

  function reqOf(request) { return { __req: request }; }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 8);
  }

  const ProjectStorage = {
    uid: uid,

    // ---- projects -------------------------------------------------------
    putProject(project) {
      project.updatedAt = new Date().toISOString();
      if (!project.createdAt) project.createdAt = project.updatedAt;
      return tx(STORE_PROJECTS, 'readwrite', s => reqOf(s.put(project))).then(() => project);
    },
    getProject(id) {
      return tx(STORE_PROJECTS, 'readonly', s => reqOf(s.get(id)));
    },
    listProjects() {
      return tx(STORE_PROJECTS, 'readonly', s => reqOf(s.getAll())).then(rows => {
        rows = rows || [];
        rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        return rows;
      });
    },
    async deleteProject(id) {
      const p = await this.getProject(id);
      if (p) {
        for (const bid of collectBlobIds(p)) {
          try { await this.deleteBlob(bid); } catch (e) { console.warn('[storage] blob 削除失敗', bid, e); }
        }
      }
      return tx(STORE_PROJECTS, 'readwrite', s => reqOf(s.delete(id)));
    },
    /**
     * レコードだけ消し、blob は残す。
     * ★ 統合のように blob の持ち主を別のプロジェクトへ移したあとで使う。
     *   ここで deleteProject を使うと、移した先が参照している blob まで消える。
     */
    deleteProjectRecord(id) {
      return tx(STORE_PROJECTS, 'readwrite', s => reqOf(s.delete(id)));
    },

    // ---- blobs ----------------------------------------------------------
    putBlob(rec) {
      if (!rec.id) rec.id = uid('blob');
      return tx(STORE_BLOBS, 'readwrite', s => reqOf(s.put(rec))).then(() => rec.id);
    },
    getBlob(id) {
      return tx(STORE_BLOBS, 'readonly', s => reqOf(s.get(id)));
    },
    deleteBlob(id) {
      return tx(STORE_BLOBS, 'readwrite', s => reqOf(s.delete(id)));
    },

    // ---- folders ---------------------------------------------------------
    putFolder(folder) {
      folder.updatedAt = new Date().toISOString();
      if (!folder.createdAt) folder.createdAt = folder.updatedAt;
      if (!folder.id) folder.id = uid('fld');
      if (folder.parentId === undefined) folder.parentId = null;
      return tx(STORE_FOLDERS, 'readwrite', s => reqOf(s.put(folder))).then(() => folder);
    },
    getFolder(id) {
      return tx(STORE_FOLDERS, 'readonly', s => reqOf(s.get(id)));
    },
    listFolders() {
      return tx(STORE_FOLDERS, 'readonly', s => reqOf(s.getAll())).then(rows => {
        rows = rows || [];
        rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ja'));
        return rows;
      });
    },
    /**
     * フォルダを削除する。中身 (サブフォルダと登録データ) は親に繰り上げる。
     * ★ 中身ごと消さないのは、登録データの削除が取り返しのつかない操作だから。
     *   データを消したいときは明示的に「削除」を選ぶ経路だけにする。
     */
    async deleteFolder(id) {
      const f = await this.getFolder(id);
      const parentId = f ? (f.parentId || null) : null;
      const [folders, projects] = await Promise.all([this.listFolders(), this.listProjects()]);
      for (const child of folders) {
        if (child.parentId === id) { child.parentId = parentId; await this.putFolder(child); }
      }
      for (const p of projects) {
        if (p.folderId === id) { p.folderId = parentId; await this.putProject(p); }
      }
      return tx(STORE_FOLDERS, 'readwrite', s => reqOf(s.delete(id)));
    },

    // ---- 全削除 ----------------------------------------------------------
    // ★ 画面からは呼ばない。まとめて消すボタンは「取り消せない事故」になりやすいので
    //   撤去した (削除はデータごと / 選択したぶんだけ)。ブラウザテストの初期化専用。
    async clearAll() {
      await tx(STORE_PROJECTS, 'readwrite', s => reqOf(s.clear()));
      await tx(STORE_BLOBS, 'readwrite', s => reqOf(s.clear()));
      await tx(STORE_FOLDERS, 'readwrite', s => reqOf(s.clear()));
    },

    // ---- 生値ラスタ (Float32Array) の出し入れ ------------------------------
    async putValueRaster(values) {
      const buf = values.buffer.byteLength === values.byteLength
        ? values.buffer
        : values.slice().buffer;
      return this.putBlob({
        id: uid('raster'),
        blob: new Blob([buf], { type: 'application/octet-stream' }),
        mime: 'application/octet-stream',
        filename: 'raster.f32',
      });
    },
    async getValueRaster(blobId) {
      const rec = await this.getBlob(blobId);
      if (!rec || !rec.blob) return null;
      return new Float32Array(await rec.blob.arrayBuffer());
    },

    // ---- 使用量の目安 -----------------------------------------------------
    async estimate() {
      if (navigator.storage && navigator.storage.estimate) {
        try { return await navigator.storage.estimate(); } catch (e) { /* noop */ }
      }
      return null;
    },
  };

  // =====================================================================
  // フォルダツリーの補助
  // =====================================================================

  /**
   * 平坦なフォルダ配列を「親が実在するか」で正規化する。
   * ★ 親が消えている / 自分を先祖に含む (循環) フォルダはルートに拾い上げる。
   *   こうしておかないと、そのフォルダ配下がツリーのどこにも現れず、
   *   中の登録データに二度と辿り着けなくなる。
   * @returns {{byId: Map, roots: Array, childrenOf: Map, repaired: Array}}
   */
  function buildFolderTree(folders) {
    const byId = new Map(folders.map(f => [f.id, f]));
    const repaired = [];

    // 親を辿って循環・行方不明を検出する
    for (const f of folders) {
      let p = f.parentId || null;
      const seen = new Set([f.id]);
      while (p) {
        if (!byId.has(p) || seen.has(p)) { repaired.push(f); f.parentId = null; break; }
        seen.add(p);
        p = byId.get(p).parentId || null;
      }
    }

    const childrenOf = new Map();
    for (const f of folders) {
      const k = f.parentId || '';
      if (!childrenOf.has(k)) childrenOf.set(k, []);
      childrenOf.get(k).push(f);
    }
    for (const arr of childrenOf.values()) {
      arr.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ja'));
    }
    return { byId, roots: childrenOf.get('') || [], childrenOf, repaired };
  }

  /** フォルダ id → ルートからの名前の配列 (["A","B"])。ルート直下は [] */
  function folderPathNames(folderId, byId) {
    const out = [];
    let id = folderId || null;
    const guard = new Set();
    while (id && byId.has(id) && !guard.has(id)) {
      guard.add(id);
      const f = byId.get(id);
      out.unshift(f.name);
      id = f.parentId || null;
    }
    return out;
  }

  /** target が folderId の子孫 (または自身) か。フォルダ移動の循環防止用。 */
  function isDescendantFolder(targetId, folderId, byId) {
    let id = targetId || null;
    const guard = new Set();
    while (id && !guard.has(id)) {
      if (id === folderId) return true;
      guard.add(id);
      const f = byId.get(id);
      if (!f) return false;
      id = f.parentId || null;
    }
    return false;
  }

  /** 名前の配列 (["A","B"]) を辿り、無ければ作って、最深のフォルダ id を返す */
  async function ensureFolderPath(names) {
    let parentId = null;
    for (const raw of (names || [])) {
      const name = String(raw || '').trim();
      if (!name) continue;
      const folders = await ProjectStorage.listFolders();
      const hit = folders.find(f => (f.parentId || null) === parentId && f.name === name);
      if (hit) { parentId = hit.id; continue; }
      const created = await ProjectStorage.putFolder({ name: name, parentId: parentId });
      parentId = created.id;
    }
    return parentId;
  }

  // プロジェクトが参照している blobId をすべて集める (削除時の孤児防止)
  function collectBlobIds(p) {
    const ids = [];
    for (const m of (p.molecules || [])) if (m.blobId) ids.push(m.blobId);
    for (const k of Object.keys(p.images || {})) {
      const im = p.images[k];
      if (im && im.blobId) ids.push(im.blobId);
    }
    return ids;
  }
  ProjectStorage.collectBlobIds = collectBlobIds;
  ProjectStorage.buildFolderTree = buildFolderTree;
  ProjectStorage.folderPathNames = folderPathNames;
  ProjectStorage.isDescendantFolder = isDescendantFolder;
  ProjectStorage.ensureFolderPath = ensureFolderPath;

  global.ProjectStorage = ProjectStorage;
})(window);
