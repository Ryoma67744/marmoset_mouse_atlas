/*
 * storage.js — 登録データの保存層 (IndexedDB)
 *
 * このサイトはサーバを持たない静的サイトなので、ユーザーが登録したデータは
 * ブラウザ内 IndexedDB に置く。ZIP は「持ち出し / 別環境での再開」用の可搬形式で、
 * 保存の代替ではない。
 *
 * ストア構成:
 *   projects : { id, displayName, ... } — プロジェクト本体 (メタのみ。実データは blobs)
 *   blobs    : { id, blob, mime, filename } — HE 画像の原本と、分子ごとの生値ラスタ
 *
 * ★ 生の imzML/ibd は保存しない。1 分子あたり 19 MB あるのに対し、解析後の生値ラスタは
 *   89×120×4 B = 42 KB で、表示・解析・ZIP 出力に必要な情報はすべて含まれる。
 */
(function (global) {
  'use strict';

  const DB_NAME = 'marmoset-atlas';
  const DB_VERSION = 1;
  const STORE_PROJECTS = 'projects';
  const STORE_BLOBS = 'blobs';

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

    // ---- 全削除 ----------------------------------------------------------
    async clearAll() {
      await tx(STORE_PROJECTS, 'readwrite', s => reqOf(s.clear()));
      await tx(STORE_BLOBS, 'readwrite', s => reqOf(s.clear()));
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

  global.ProjectStorage = ProjectStorage;
})(window);
