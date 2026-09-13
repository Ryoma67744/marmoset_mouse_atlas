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

  /*
   * project.images のキー。
   *   HE_Stain … 染色画像。MSI と重ねて表示する
   *   ATLAS    … 領域名の入った脳図など。重ねずにビューアの左半分へ並べて出す
   *   IMMUNO   … 免疫染色画像。ATLAS と同じ扱いで、左半分に切り替えて出す
   * ★ Master と Viewer の両方で使うので、文字列を 2 箇所に書かないようここに置く。
   *   'MSI' や 'HE_STAIN' を含まない名前にしてあるのは、描画側がレイヤの種類を
   *   キー名の正規表現で見分けているため (含めると分子や染色として扱われる)。
   */
  global.ATLAS_KEY = 'ATLAS';
  global.IMMUNO_KEY = 'IMMUNO';

  let dbPromise = null;
  const changeListeners = new Set();
  const changeChannel = typeof global.BroadcastChannel === 'function'
    ? new global.BroadcastChannel('marmoset-atlas-commits') : null;
  function deliverChange(change) {
    if (!change || !Array.isArray(change.projectIds) || !Array.isArray(change.folderIds)) return;
    for (const listener of changeListeners) {
      try { listener(change); } catch (error) { console.warn('[storage] 更新通知の処理に失敗', error); }
    }
  }
  if (changeChannel) changeChannel.onmessage = event => deliverChange(event.data);
  function notifyChange(projectIds, folderIds) {
    const change = { projectIds: Array.from(new Set(projectIds || [])), folderIds: Array.from(new Set(folderIds || [])) };
    deliverChange(change);
    if (changeChannel) changeChannel.postMessage(change);
  }
  function revisionAfter(project) {
    return new Date(Math.max(Date.now(), (Date.parse(project && project.updatedAt) || 0) + 1)).toISOString();
  }
  function conflictError(message) {
    const error = new Error(message || '別の画面でデータが更新されました。最新の内容を確認してください');
    error.code = 'LOCAL_CONFLICT';
    return error;
  }
  function checkRevision(old, expected) {
    if (expected === null ? !!old : !old || old.updatedAt !== expected) throw conflictError();
  }
  function folderSnapshot(folders) {
    return JSON.stringify((folders || []).map(f => ({ id: f.id, name: f.name, parentId: f.parentId || null,
      normalizationGroupId: f.normalizationGroupId || null, updatedAt: f.updatedAt || null })).sort((a, b) => String(a.id).localeCompare(String(b.id))));
  }


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
    subscribeChanges(listener) {
      if (typeof listener !== 'function') throw new Error('更新通知の受信処理が不正です');
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    /** Ordinary edits patch only explicit fields, reading the latest record under the write lock. */
    async patchProjectFields(id, fields, options) {
      const forbidden = ['id', 'createdAt', 'updatedAt', 'normalization', 'normalizationBinding', '__proto__', 'constructor', 'prototype'];
      if (!id || !fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).some(k => forbidden.includes(k))) {
        throw new Error('通常編集では変更できない項目が含まれています');
      }
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE_PROJECTS, 'readwrite'), s = t.objectStore(STORE_PROJECTS);
        let result, failure;
        t.oncomplete = () => { notifyChange([id]); resolve(result); };
        t.onerror = t.onabort = () => reject(failure || t.error || new Error('データの更新に失敗しました'));
        const req = s.get(id);
        req.onsuccess = () => {
          try {
            if (!req.result) throw conflictError('対象データが削除されています');
            if (options && Object.prototype.hasOwnProperty.call(options, 'expectedUpdatedAt')) checkRevision(req.result, options.expectedUpdatedAt);
            result = Object.assign({}, req.result, fields, { updatedAt: revisionAfter(req.result) });
            s.put(result);
          } catch (error) { failure = error; t.abort(); }
        };
      });
    },
    /** Full replacement is explicit CAS. null means the id must still be absent. */
    async saveProjectIfUnchanged(project, expectedUpdatedAt) {
      if (!project || !project.id || expectedUpdatedAt === undefined) throw new Error('保存対象と更新確認が必要です');
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE_PROJECTS, 'readwrite'), s = t.objectStore(STORE_PROJECTS);
        let result, failure;
        t.oncomplete = () => { Object.assign(project, result); notifyChange([project.id]); resolve(result); };
        t.onerror = t.onabort = () => reject(failure || t.error || new Error('データの保存に失敗しました'));
        const req = s.get(project.id);
        req.onsuccess = () => {
          try {
            checkRevision(req.result, expectedUpdatedAt);
            const updatedAt = revisionAfter(req.result);
            result = Object.assign({}, project, { updatedAt, createdAt: (req.result && req.result.createdAt) || project.createdAt || updatedAt });
            s.put(result);
          } catch (error) { failure = error; t.abort(); }
        };
      });
    },

    // ---- projects -------------------------------------------------------
    putProject(project) {
      // A revision must advance even for two writes within one millisecond.
      project.updatedAt = new Date(Math.max(Date.now(), (Date.parse(project.updatedAt) || 0) + 1)).toISOString();
      if (!project.createdAt) project.createdAt = project.updatedAt;
      return tx(STORE_PROJECTS, 'readwrite', s => reqOf(s.put(project))).then(() => { notifyChange([project.id]); return project; });
    },
    /** Merge metadata and transfer blob ownership atomically after checking every source. */
    async commitProjectMerge(target, options) {
      const expected = options && options.expectedRevisions;
      if (!target || !target.id || !Array.isArray(expected) || !expected.some(item => item.id === target.id) ||
          new Set(expected.map(item => item.id)).size !== expected.length || expected.some(item => !item.id || item.updatedAt === undefined)) {
        throw new Error('統合元と保存先の更新確認が必要です');
      }
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE_PROJECTS, 'readwrite'), store = t.objectStore(STORE_PROJECTS);
        let result, failure;
        t.oncomplete = () => { Object.assign(target, result); notifyChange(expected.map(item => item.id)); resolve(result); };
        t.onerror = t.onabort = () => reject(failure || t.error || new Error('統合の保存に失敗しました'));
        const req = store.getAll();
        req.onsuccess = () => {
          try {
            const byId = new Map((req.result || []).map(project => [project.id, project]));
            for (const item of expected) checkRevision(byId.get(item.id), item.updatedAt);
            const old = byId.get(target.id), updatedAt = revisionAfter(old);
            result = Object.assign({}, target, { updatedAt, createdAt: (old && old.createdAt) || target.createdAt || updatedAt });
            store.put(result);
            for (const item of expected) if (item.id !== target.id) store.delete(item.id);
          } catch (error) { failure = error; t.abort(); }
        };
      });
    },
    /** Final import commit: resolve folders and identity under the same lock as project CAS. */
    async commitImportedProject(project, options) {
      const opts = options || {};
      if (!project || !project.id || !Object.prototype.hasOwnProperty.call(opts, 'expectedUpdatedAt') || opts.expectedUpdatedAt === undefined) {
        throw new Error('取り込み開始時の更新確認が必要です');
      }
      const names = (opts.folderPath || []).map(value => String(value == null ? '' : value).trim()).filter(Boolean);
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const t = db.transaction([STORE_PROJECTS, STORE_FOLDERS], 'readwrite');
        const ps = t.objectStore(STORE_PROJECTS), fs = t.objectStore(STORE_FOLDERS);
        let projects, folders, result, failure;
        const changedFolders = [], changedProjects = [project.id];
        t.oncomplete = () => { Object.assign(project, result); notifyChange(changedProjects, changedFolders); resolve(result); };
        t.onerror = t.onabort = () => reject(failure || t.error || new Error('取り込みの確定に失敗しました'));
        const finish = () => {
          if (!projects || !folders || failure) return;
          try {
            const old = projects.find(p => p.id === project.id);
            checkRevision(old, opts.expectedUpdatedAt);
            const pending = typeof opts.pendingFolderChanges === 'function' ? opts.pendingFolderChanges() : opts.pendingFolderChanges;
            if (pending && typeof pending.then === 'function') throw new Error('所属の確認は同期関数で指定してください');
            const targetPending = pending instanceof Map ? pending.has(project.id) : Array.isArray(pending) ? pending.includes(project.id) : pending && pending[project.id];
            if (targetPending) throw conflictError('取得中にフォルダーの所属が変更されました。同期が完了してから再取得してください');
            if (typeof opts.canApplyRemote === 'function') {
              const allowed = opts.canApplyRemote();
              if (allowed && typeof allowed.then === 'function') throw new Error('取り込み確定時の編集確認は同期関数で指定してください');
              if (!allowed) throw conflictError('取得中に編集中の内容が変わりました。編集を保持したまま取得を中止しました');
            }
            if (opts.expectedFolders && folderSnapshot(opts.expectedFolders) !== folderSnapshot(folders)) {
              throw conflictError('取得中にフォルダーが変更されました。最新の所属を確認して再取得してください');
            }
            let parentId = null;
            for (const name of names) {
              const matches = folders.filter(f => (f.parentId || null) === parentId && f.name === name);
              if (matches.length > 1) throw conflictError('保存先に同名のフォルダーが複数あります。フォルダーを整理してください');
              let folder = matches[0];
              if (!folder) {
                const now = new Date().toISOString();
                folder = { id: uid('fld'), name, parentId, createdAt: now, updatedAt: now };
                folders.push(folder); fs.put(folder); changedFolders.push(folder.id);
              }
              parentId = folder.id;
            }
            result = Object.assign({}, project, { folderId: parentId, updatedAt: revisionAfter(old) });
            result.createdAt = (old && old.createdAt) || project.createdAt || result.updatedAt;
            const binding = result.normalizationBinding;
            if (binding && binding.groupId && names.length >= 2) {
              if (!global.NormalizationScope) throw new Error('補正グループの確認処理がありません');
              const descriptor = global.NormalizationScope.groupForFolder(parentId, folders);
              if (!descriptor) throw new Error('保存先の補正グループを特定できません');
              const folder = folders.find(f => f.id === descriptor.folderId);
              const groups = global.NormalizationScope.buildGroups(projects, folders).groups;
              const group = groups.find(g => g.folderId === descriptor.folderId);
              const identityConflict = group && (group.identityConflict || (group.groupId && group.groupId !== binding.groupId));
              if (groups.some(g => g.folderId !== folder.id && g.groupId === binding.groupId)) {
                throw new Error('取り込み先の補正グループIDが別のフォルダーで使用されています');
              }
              if (identityConflict) {
                const authority = opts.authoritativeRows || opts.authorityRows;
                const cloud = global.Cloud;
                const hasPending = pending instanceof Map ? pending.size > 0 : Array.isArray(pending) ? pending.length > 0 : pending && Object.keys(pending).length > 0;
                if (!Array.isArray(authority) || !cloud || typeof cloud.hashState !== 'function' || hasPending) {
                  throw new Error('ZIP の補正グループIDが保存先フォルダーと一致しません。既存設定は変更していません');
                }
                const pathKey = JSON.stringify(names.slice(0, 2));
                const rows = authority.filter(row => JSON.stringify((row.folder_path || []).slice(0, 2)) === pathKey);
                const byId = new Map(rows.map(row => [row.id, row]));
                if (!rows.length || byId.size !== rows.length || !byId.has(project.id) || rows.some(row => !row.state || !row.state.normalizationBinding || row.state.normalizationBinding.groupId !== binding.groupId || JSON.stringify(row.state.normalizationBinding.folderPath) !== pathKey)) {
                  throw conflictError('クラウドの補正グループ全体の所属が一致しないため、グループIDを復元できません');
                }
                for (const sibling of (group.projects || [])) {
                  if (sibling.id === project.id) continue;
                  const row = byId.get(sibling.id);
                  if (!row || sibling.cloudPending || !sibling.cloudStateHash || cloud.hashState(cloud.stateOf(sibling)) !== sibling.cloudStateHash ||
                      global.NormalizationScope.memberId(sibling) !== (row.state.normalizationBinding.memberId || row.id)) {
                    throw conflictError('未同期のデータがあるため補正グループIDを更新できません: ' + (sibling.displayName || sibling.id));
                  }
                  const next = Object.assign({}, sibling, { normalizationBinding: row.state.normalizationBinding, updatedAt: revisionAfter(sibling) });
                  // A location-only reconciliation does not claim that scientific
                  // state from a newer remote revision has already been read.
                  next.cloudStateHash = cloud.hashState(cloud.stateOf(next));
                  ps.put(next); changedProjects.push(next.id);
                }
              }
              if (folder.normalizationGroupId !== binding.groupId) {
                folder.normalizationGroupId = binding.groupId;
                folder.updatedAt = revisionAfter(folder);
                fs.put(folder); changedFolders.push(folder.id);
              }
            }
            ps.put(result);
          } catch (error) { failure = error; t.abort(); }
        };
        const preq = ps.getAll(); preq.onsuccess = () => { projects = preq.result || []; finish(); };
        const freq = fs.getAll(); freq.onsuccess = () => { folders = freq.result || []; finish(); };
      });
    },
    /** Delete only blobs no current project references, after an import succeeds. */
    async deleteUnreferencedBlobs(ids) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const t = db.transaction([STORE_PROJECTS, STORE_BLOBS], 'readwrite');
        t.oncomplete = () => resolve();
        t.onerror = t.onabort = () => reject(t.error || new Error('未使用データの整理に失敗しました'));
        const req = t.objectStore(STORE_PROJECTS).getAll();
        req.onsuccess = () => {
          const used = new Set((req.result || []).flatMap(collectBlobIds));
          for (const id of new Set(ids || [])) if (!used.has(id)) t.objectStore(STORE_BLOBS).delete(id);
        };
      });
    },
    /** Commit a reviewed profile batch atomically; never overwrite another tab's newer project. */
    async putProjectsIfUnchanged(updates, scopeGuard) {
      if (!Array.isArray(updates) || updates.some(item => !item || !item.project || !item.project.id) ||
          new Set(updates.map(item => item.project.id)).size !== updates.length) {
        throw new Error('一括保存の対象データが不正または重複しています');
      }
      if (scopeGuard && (!global.NormalizationScope || !scopeGuard.folderId)) {
        throw new Error('補正グループの構成を確認できません。再読み込みしてください');
      }
      const db = await openDb();
      return new Promise((resolve, reject) => {
        // Scope membership and folder identity must be checked under the same
        // write lock as the profiles, including changes made by another tab.
        const t = db.transaction(scopeGuard ? [STORE_PROJECTS, STORE_FOLDERS] : STORE_PROJECTS, 'readwrite');
        const s = t.objectStore(STORE_PROJECTS);
        let failure = null;
        const now = new Date(Math.max(Date.now(), ...updates.map(item => (Date.parse(item.expectedUpdatedAt) || 0) + 1))).toISOString();
        let projects, folders;
        const abort = error => {
          if (failure) return;
          failure = error;
          t.abort();
        };
        const commitReviewed = () => {
          if (failure || !projects || (scopeGuard && !folders)) return;
          try {
            const byId = new Map(projects.map(p => [p.id, p]));
            for (const item of updates) {
              const old = byId.get(item.project.id);
              if (!old || old.updatedAt !== item.expectedUpdatedAt) {
                throw new Error('プレビュー後にデータが変更されました。再読み込みして設定をやり直してください: ' + item.project.displayName);
              }
            }
            if (scopeGuard) {
              const current = global.NormalizationScope.snapshot(projects, folders, scopeGuard.folderId);
              const expectedIds = (scopeGuard.memberIds || []).slice().sort();
              const updateIds = updates.map(item => item.project.id).sort();
              if (!current || !global.NormalizationScope.equalsSnapshot(scopeGuard, current) ||
                  JSON.stringify(expectedIds) !== JSON.stringify(updateIds)) {
                throw new Error('プレビュー後に補正グループのフォルダー構成または対象データが変更されました。再読み込みして設定をやり直してください');
              }
              const reassign = scopeGuard.reassignGroupId === true;
              if (reassign && (!scopeGuard.groupId || !updates.length || updates.some(item => {
                const profile = item.project.normalization, binding = item.project.normalizationBinding;
                return !global.Normalization || typeof global.Normalization.isSupportedScopedProfile !== 'function' ||
                  !global.Normalization.isSupportedScopedProfile(profile) ||
                  profile.scope.groupId !== scopeGuard.groupId || !binding || binding.groupId !== scopeGuard.groupId;
              }))) {
                throw new Error('補正グループIDを修復するには、対象全件の新しい補正設定と現在の所属IDを一致させてください');
              }
              if (scopeGuard.groupId != null) {
                if (typeof scopeGuard.groupId !== 'string' || !scopeGuard.groupId.trim()) {
                  throw new Error('補正グループIDが不正です');
                }
                const folder = folders.find(f => f.id === scopeGuard.folderId);
                if (!folder || (!reassign && folder.normalizationGroupId && folder.normalizationGroupId !== scopeGuard.groupId)) {
                  throw new Error('補正グループIDが変更されています。再読み込みして設定をやり直してください');
                }
                // A deliberate whole-group reconfiguration may repair duplicated
                // identities. The reviewed snapshot still pins the old identity;
                // all new profiles/bindings must agree, and other groups remain
                // untouched. Reusing another group's UUID is never a repair.
                if (reassign && global.NormalizationScope.buildGroups(projects, folders).groups.some(group =>
                  group.folderId !== folder.id && group.groupId === scopeGuard.groupId)) {
                  throw new Error('修復先の補正グループIDが別のフォルダーで使用されています');
                }
                t.objectStore(STORE_FOLDERS).put(Object.assign({}, folder, {
                  normalizationGroupId: scopeGuard.groupId,
                  updatedAt: now,
                }));
              }
            }
            for (const item of updates) s.put(Object.assign({}, item.project, { updatedAt: now }));
          } catch (error) { abort(error); }
        };
        t.oncomplete = () => {
          updates.forEach(item => { item.project.updatedAt = now; });
          notifyChange(updates.map(item => item.project.id), scopeGuard && scopeGuard.groupId ? [scopeGuard.folderId] : []);
          resolve(updates.map(item => item.project));
        };
        t.onerror = () => reject(failure || t.error || new Error('一括保存に失敗しました'));
        t.onabort = () => reject(failure || t.error || new Error('一括保存を中止しました'));
        const projectReq = s.getAll();
        projectReq.onsuccess = () => { projects = projectReq.result || []; commitReviewed(); };
        if (scopeGuard) {
          const folderReq = t.objectStore(STORE_FOLDERS).getAll();
          folderReq.onsuccess = () => { folders = folderReq.result || []; commitReviewed(); };
        }
      });
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
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const t = db.transaction([STORE_PROJECTS, STORE_BLOBS], 'readwrite'), store = t.objectStore(STORE_PROJECTS);
        t.oncomplete = () => { notifyChange([id]); resolve(); };
        t.onerror = t.onabort = () => reject(t.error || new Error('データを削除できませんでした'));
        const req = store.getAll();
        req.onsuccess = () => {
          const projects = req.result || [], target = projects.find(p => p.id === id);
          const used = new Set(projects.filter(p => p.id !== id).flatMap(collectBlobIds));
          if (target) for (const bid of collectBlobIds(target)) if (!used.has(bid)) t.objectStore(STORE_BLOBS).delete(bid);
          store.delete(id);
        };
      });
    },

    /**
     * レコードだけ消し、blob は残す。
     * ★ 統合のように blob の持ち主を別のプロジェクトへ移したあとで使う。
     *   ここで deleteProject を使うと、移した先が参照している blob まで消える。
     */
    deleteProjectRecord(id) {
      return tx(STORE_PROJECTS, 'readwrite', s => reqOf(s.delete(id))).then(() => notifyChange([id]));
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
    async patchFolderFields(id, fields, options) {
      if (!id || !fields || Object.keys(fields).some(key => !['name', 'parentId'].includes(key))) throw new Error('フォルダーの変更項目が不正です');
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE_FOLDERS, 'readwrite'), store = t.objectStore(STORE_FOLDERS);
        let result, failure;
        t.oncomplete = () => { notifyChange([], [id]); resolve(result); };
        t.onerror = t.onabort = () => reject(failure || t.error || new Error('フォルダーを更新できませんでした'));
        const req = store.getAll();
        req.onsuccess = () => {
          try {
            const folders = req.result || [], old = folders.find(folder => folder.id === id);
            if (!old) throw conflictError('フォルダーが削除されています');
            if (options && Object.prototype.hasOwnProperty.call(options, 'expectedUpdatedAt')) checkRevision(old, options.expectedUpdatedAt);
            result = Object.assign({}, old, fields, { updatedAt: revisionAfter(old) });
            if (Object.prototype.hasOwnProperty.call(fields, 'parentId') && result.parentId) {
              const byId = new Map(folders.map(folder => [folder.id, folder]));
              if (!byId.has(result.parentId) || isDescendantFolder(result.parentId, id, byId)) throw conflictError('移動先のフォルダー構成が変わっています');
            }
            store.put(result);
          } catch (error) { failure = error; t.abort(); }
        };
      });
    },
    putFolder(folder) {
      folder.updatedAt = new Date().toISOString();
      if (!folder.createdAt) folder.createdAt = folder.updatedAt;
      if (!folder.id) folder.id = uid('fld');
      if (folder.parentId === undefined) folder.parentId = null;
      return tx(STORE_FOLDERS, 'readwrite', s => reqOf(s.put(folder))).then(() => { notifyChange([], [folder.id]); return folder; });
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
    /** Restore a portable group UUID without overwriting another local group's identity. */
    async restoreNormalizationGroup(folderId, groupId) {
      if (typeof groupId !== 'string' || !groupId.trim() || !global.NormalizationScope) {
        throw new Error('ZIP の補正グループIDまたはフォルダー確認処理が不正です');
      }
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const t = db.transaction([STORE_FOLDERS, STORE_PROJECTS], 'readwrite');
        const s = t.objectStore(STORE_FOLDERS);
        let failure = null, result, folders, projects;
        t.oncomplete = () => { if (result && result.restored) notifyChange([], [result.folderId]); resolve(result); };
        t.onerror = () => reject(failure || t.error || new Error('補正グループの復元に失敗しました'));
        t.onabort = () => reject(failure || t.error || new Error('補正グループの復元を中止しました'));
        const restore = () => {
          if (failure || !folders || !projects) return;
          try {
            const descriptor = global.NormalizationScope.groupForFolder(folderId, folders);
            const group = descriptor && global.NormalizationScope.buildGroups(projects, folders).groups.find(g => g.folderId === descriptor.folderId);
            const folder = group && folders.find(f => f.id === group.folderId);
            if (!folder) throw new Error('ZIP の保存先に第2階層の補正グループがありません');
            if (group.identityConflict || (group.groupId && group.groupId !== groupId)) {
              throw new Error('ZIP の補正グループIDが保存先フォルダーと一致しません。既存設定は変更していません: ' + group.label);
            }
            result = { folderId: folder.id, groupId: groupId, restored: !folder.normalizationGroupId };
            if (result.restored) s.put(Object.assign({}, folder, {
              normalizationGroupId: groupId,
              updatedAt: new Date().toISOString(),
            }));
          } catch (error) { failure = error; t.abort(); }
        };
        const folderReq = s.getAll();
        folderReq.onsuccess = () => { folders = folderReq.result || []; restore(); };
        const projectReq = t.objectStore(STORE_PROJECTS).getAll();
        projectReq.onsuccess = () => { projects = projectReq.result || []; restore(); };
      });
    },
    /**
     * フォルダを削除する。中身 (サブフォルダと登録データ) は親に繰り上げる。
     * ★ 中身ごと消さないのは、登録データの削除が取り返しのつかない操作だから。
     *   データを消したいときは明示的に「削除」を選ぶ経路だけにする。
     */
    async deleteFolder(id) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const t = db.transaction([STORE_PROJECTS, STORE_FOLDERS], 'readwrite');
        let folders, projects;
        const changedFolders = [id], changedProjects = [];
        t.oncomplete = () => { notifyChange(changedProjects, changedFolders); resolve(); };
        t.onerror = t.onabort = () => reject(t.error || new Error('フォルダーを削除できませんでした'));
        const finish = () => {
          if (!folders || !projects) return;
          const folder = folders.find(f => f.id === id), parentId = folder ? folder.parentId || null : null;
          for (const child of folders) if (child.parentId === id) {
            t.objectStore(STORE_FOLDERS).put(Object.assign({}, child, { parentId, updatedAt: revisionAfter(child) }));
            changedFolders.push(child.id);
          }
          for (const project of projects) if (project.folderId === id) {
            t.objectStore(STORE_PROJECTS).put(Object.assign({}, project, { folderId: parentId, updatedAt: revisionAfter(project) }));
            changedProjects.push(project.id);
          }
          t.objectStore(STORE_FOLDERS).delete(id);
        };
        const freq = t.objectStore(STORE_FOLDERS).getAll(); freq.onsuccess = () => { folders = freq.result || []; finish(); };
        const preq = t.objectStore(STORE_PROJECTS).getAll(); preq.onsuccess = () => { projects = preq.result || []; finish(); };
      });
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
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE_FOLDERS, 'readwrite'), store = t.objectStore(STORE_FOLDERS);
      let parentId = null;
      const createdIds = [];
      t.oncomplete = () => { if (createdIds.length) notifyChange([], createdIds); resolve(parentId); };
      t.onerror = t.onabort = () => reject(t.error || new Error('フォルダーの作成に失敗しました'));
      const req = store.getAll();
      req.onsuccess = () => {
        const folders = req.result || [];
        for (const raw of names || []) {
          const name = String(raw == null ? '' : raw).trim();
          if (!name) continue;
          const hit = folders.find(f => (f.parentId || null) === parentId && f.name === name);
          if (hit) { parentId = hit.id; continue; }
          const now = new Date().toISOString();
          const created = { id: uid('fld'), name, parentId, createdAt: now, updatedAt: now };
          folders.push(created); store.put(created); createdIds.push(created.id); parentId = created.id;
        }
      };
    });
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
