/* Shared project synchronization. Local revisions and cloud baselines always
 * describe the content that was actually read; no stale-list or force saves. */
(function (global) {
  'use strict';

  const freshness = new WeakMap();
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function conflict(message) {
    const error = new Error(message);
    error.name = 'ProjectSyncConflict'; error.code = 'PROJECT_SYNC_CONFLICT';
    return error;
  }
  function deps(options) {
    const o = options || {};
    const provided = key => Object.prototype.hasOwnProperty.call(o, key);
    return { o, storage: provided('storage') ? o.storage : global.ProjectStorage,
      cloud: provided('cloud') ? o.cloud : global.Cloud, zip: provided('zip') ? o.zip : global.ZipIO };
  }
  function usable(cloud) {
    return !!cloud && (typeof cloud.configured !== 'function' || cloud.configured()) &&
      (typeof cloud.signedIn !== 'function' || cloud.signedIn());
  }
  function marked(project, status, reason, extra) {
    const row = extra && extra.remoteRow;
    if (project) freshness.set(project, Object.assign({ status, reason: reason || '',
      remoteUpdatedAt: row && row.updated_at, remoteBundlePath: row && row.bundle_path }, extra || {}));
    return project;
  }
  function statusOf(project) { return freshness.get(project) || { status: 'unknown', reason: '' }; }
  function hash(cloud, project) { return cloud.hashState(cloud.stateOf(project)); }
  function remoteHash(cloud, row) { return cloud.hashState(row.state || {}); }
  function sameBundle(project, row) {
    return !!project && !!row && !!row.bundle_path && project.cloudBundlePath === row.bundle_path &&
      (project.cloudRev | 0) === (row.bundle_rev | 0);
  }
  function baseline(row, cloud) {
    return { cloudRev: row.bundle_rev | 0, cloudBundlePath: row.bundle_path,
      cloudUpdatedAt: row.updated_at, cloudStateHash: remoteHash(cloud, row), cloudDisplayName: row.display_name,
      cloudPending: false };
  }
  function sameProfile(cloud, a, b) { return cloud.hashState(a || null) === cloud.hashState(b || null); }
  function sameProfileOrInvalidated(cloud, local, remote) {
    if (sameProfile(cloud, local, remote)) return true;
    if (!local || !remote || !local.invalidated || local.invalidated.code !== 'NORMALIZATION_PROFILE_STALE') return false;
    const a = clone(local), b = clone(remote);
    delete a.invalidated; delete b.invalidated;
    // Ordinary edits may invalidate the same saved profile, but may never
    // remove an invalidation or alter its calibration, references or factors.
    return sameProfile(cloud, a, b);
  }
  async function getRemote(cloud, id) {
    if (typeof cloud.getProject === 'function') return await cloud.getProject(id);
    if (typeof cloud.listProjects === 'function') return (await cloud.listProjects()).find(row => row.id === id) || null;
    throw new Error('クラウドの最新設定を取得できません。アプリを再読み込みしてください');
  }
  async function patchCAS(storage, id, fields, expected) {
    if (typeof storage.patchProjectFields !== 'function') {
      throw new Error('変更項目を安全に保存できません。アプリを再読み込みしてください');
    }
    const saved = await storage.patchProjectFields(id, fields, { expectedUpdatedAt: expected });
    return saved || await storage.getProject(id);
  }
  function pendingFor(options, id) {
    const pending = typeof options.pendingFolderChanges === 'function'
      ? options.pendingFolderChanges() : options.pendingFolderChanges;
    return pending instanceof Map ? pending.has(id) : !!(pending && pending[id]);
  }
  async function authorityFor(row, folders, cloud, storage) {
    const wanted = row.state && row.state.normalizationBinding && row.state.normalizationBinding.groupId;
    if (!wanted || !Array.isArray(row.folder_path) || row.folder_path.length < 2) return undefined;
    let parent = null, second = null;
    for (let i = 0; i < 2; i++) {
      const folder = (folders || []).find(f => (f.parentId || null) === parent && f.name === row.folder_path[i]);
      if (!folder) return undefined;
      parent = folder.id; second = folder;
    }
    let needsRepair = !!second.normalizationGroupId && second.normalizationGroupId !== wanted;
    if (!needsRepair && typeof storage.listProjects === 'function') {
      const byId = new Map((folders || []).map(folder => [folder.id, folder]));
      const projects = await storage.listProjects();
      needsRepair = projects.some(project => {
        if (!project.normalizationBinding || !project.normalizationBinding.groupId || project.normalizationBinding.groupId === wanted) return false;
        const seen = new Set(); let id = project.folderId;
        while (id && !seen.has(id)) {
          if (id === second.id) return true;
          seen.add(id); const folder = byId.get(id); id = folder && folder.parentId;
        }
        return false;
      });
    }
    if (!needsRepair) return undefined;
    if (typeof cloud.listProjects !== 'function') throw conflict('補正グループの最新の所属を確認できません');
    return await cloud.listProjects();
  }

  async function ensureLocal(projectId, options) {
    const { o, storage, cloud, zip } = deps(options);
    const local = await storage.getProject(projectId);
    if (!usable(cloud)) {
      if (!local) throw new Error('このデータは未取得です。クラウドに接続してください');
      return marked(local, 'local-only', 'クラウドの最新設定は未確認です');
    }
    if (pendingFor(o, projectId)) {
      if (!local) throw conflict('フォルダー変更の同期が完了していません');
      return marked(local, 'pending', 'フォルダー変更の同期が完了していません');
    }
    // These guards are captured before any remote request or ZIP download.
    const expectedUpdatedAt = local ? local.updatedAt : null;
    const expectedFolders = typeof storage.listFolders === 'function' ? await storage.listFolders() : undefined;
    let row;
    try { row = await getRemote(cloud, projectId); }
    catch (error) {
      if (!local) throw error;
      return marked(await storage.getProject(projectId) || local, 'offline', 'クラウドの最新設定を確認できません', { error });
    }
    if (!row) {
      if (!local) throw new Error('クラウドにデータが見つかりません');
      return marked(await storage.getProject(projectId) || local, local.cloudUpdatedAt ? 'missing-remote' : 'local-only',
        local.cloudUpdatedAt ? 'クラウドから削除されたデータです。手元のデータを保持しています' : '未アップロードのデータです');
    }
    const current = await storage.getProject(projectId);
    if ((current ? current.updatedAt : null) !== expectedUpdatedAt) {
      if (current) return marked(current, 'conflict', '取得の確認中に手元のデータが更新されました', { remoteRow: row });
      throw conflict('取得の確認中に手元のデータが削除されました');
    }
    const exactState = local && hash(cloud, local) === remoteHash(cloud, row);
    const sameRaw = sameBundle(local, row);
    if (local && sameRaw && exactState && !local.cloudPending && local.displayName === row.display_name &&
        local.cloudUpdatedAt === row.updated_at) {
      // Adopt a metadata baseline for legacy caches only when the name agrees.
      const upgraded = local.cloudDisplayName !== row.display_name
        ? await patchCAS(storage, local.id, { cloudDisplayName: row.display_name }, expectedUpdatedAt) : local;
      return marked(upgraded, 'current', '', { remoteRow: row });
    }
    const remoteUnchanged = local && sameRaw && local.cloudUpdatedAt === row.updated_at &&
      local.cloudStateHash === remoteHash(cloud, row);
    const dirty = local && (local.cloudPending || !local.cloudStateHash || hash(cloud, local) !== local.cloudStateHash);
    const dirtyName = local && local.displayName !== row.display_name &&
      (!Object.prototype.hasOwnProperty.call(local, 'cloudDisplayName') || local.displayName !== local.cloudDisplayName);
    if (remoteUnchanged && (dirty || dirtyName)) return marked(local, 'local-edits', '手元に未同期の編集があります', { remoteRow: row });
    // A missing profile on the server is never silently treated as permission
    // to delete the only surviving local copy, even for a formerly clean cache.
    const losesProfile = local && local.normalization && !(row.state && row.state.normalization);
    if (local && ((dirty && !exactState) || dirtyName || local.cloudPending || losesProfile)) {
      const confirmed = typeof o.confirmReplace === 'function' && await o.confirmReplace(clone(local), clone(row));
      if (!confirmed) return marked(local, 'conflict', '手元の編集を保持しています。クラウドにも更新があります', { remoteRow: row });
    }
    const authoritativeRows = await authorityFor(row, expectedFolders, cloud, storage);
    const cloudMetadata = baseline(row, cloud);
    const importOptions = { storage, id: projectId, expectedUpdatedAt, expectedFolders,
      state: row.state || {}, folderPath: row.folder_path || [], displayName: row.display_name,
      cloudMetadata, cloudRow: row, authoritativeRows, pendingFolderChanges: o.pendingFolderChanges,
      canApplyRemote: o.canApplyRemote };
    let project;
    if (local && sameRaw) {
      if (typeof o.canApplyRemote === 'function' && !await o.canApplyRemote()) {
        return marked(await storage.getProject(projectId) || local, 'conflict', '画面上の未保存の編集を保持しています', { remoteRow: row });
      }
      if (typeof storage.commitImportedProject !== 'function' || typeof cloud.replaceState !== 'function') {
        throw new Error('最新設定を安全に取り込めません。アプリを再読み込みしてください');
      }
      project = clone(local);
      cloud.replaceState(project, clone(row.state || {}));
      project.displayName = row.display_name || project.displayName;
      Object.assign(project, cloudMetadata);
      const saved = await storage.commitImportedProject(project, importOptions);
      project = saved && saved.project || saved || await storage.getProject(projectId);
    } else {
      if (!row.bundle_path) throw new Error('クラウドにデータ本体がありません (アップロードが未完了です)');
      if (!zip || typeof zip.importZip !== 'function') throw new Error('ZIPの復元処理が利用できません');
      const blob = await cloud.downloadBundle(row.bundle_path, o.onProgress);
      // A newer row may point to a different bundle or settings by this point.
      // Refuse the old snapshot instead of overwriting it or acknowledging it.
      const latest = await getRemote(cloud, projectId);
      if (!latest || latest.updated_at !== row.updated_at || latest.bundle_path !== row.bundle_path ||
          remoteHash(cloud, latest) !== remoteHash(cloud, row)) {
        throw conflict('取得中にクラウドのデータが更新されました。もう一度取得してください');
      }
      if (typeof o.canApplyRemote === 'function' && !await o.canApplyRemote()) {
        if (local) return marked(await storage.getProject(projectId) || local, 'conflict', '画面上の未保存の編集を保持しています', { remoteRow: row });
        throw conflict('画面上の編集が始まったため、取得を確定しませんでした');
      }
      const result = await zip.importZip(blob, importOptions);
      project = result.project;
    }
    return marked(project, 'updated', '最新の設定を読み込みました', { remoteRow: row });
  }

  // Only exact state/bundle agreement permits a clean acknowledgement. This
  // helper is safe for uploads too; it never blesses stale scientific contents.
  function cloudAcknowledgement(project, row, options) {
    const cloud = options && options.cloud || global.Cloud;
    if (!project || !row || !cloud || !sameBundle(project, row) || hash(cloud, project) !== remoteHash(cloud, row)) return null;
    return baseline(row, cloud);
  }

  function assertStateWrite(project, row, options) {
    const o = options || {}, cloud = o.cloud || global.Cloud;
    if (!row) throw conflict('クラウドにデータがありません。Masterから登録してください');
    if ((!o.allowPendingBundle && project.cloudPending) || !sameBundle(project, row)) {
      throw conflict('データ本体の版が一致しません。Masterで同期してください');
    }
    if (!project.cloudUpdatedAt || project.cloudUpdatedAt !== row.updated_at ||
        (o.expectedCloudUpdatedAt && o.expectedCloudUpdatedAt !== row.updated_at) ||
        !project.cloudStateHash || project.cloudStateHash !== remoteHash(cloud, row)) {
      throw conflict('クラウドの内容が更新されています。最新の設定を読み込んでください');
    }
    if (!o.allowNormalizationChange && (!sameProfileOrInvalidated(cloud, project.normalization, row.state && row.state.normalization) ||
        !sameProfile(cloud, project.normalizationBinding, row.state && row.state.normalizationBinding))) {
      throw conflict('補正設定がクラウドと一致しません。通常の保存では補正設定を置き換えられません');
    }
    return true;
  }

  async function saveState(project, options) {
    const { o, storage, cloud } = deps(options);
    if (!usable(cloud)) throw new Error('クラウドに接続してください');
    const source = await storage.getProject(project.id);
    if (!source || source.updatedAt !== project.updatedAt || hash(cloud, source) !== hash(cloud, project)) {
      throw conflict('別の画面でデータが更新されました。最新の設定を読み込んでください');
    }
    if (pendingFor(o, project.id)) throw conflict('フォルダー変更の同期を完了してから保存してください');
    const row = await getRemote(cloud, project.id);
    if (row && !source.cloudPending && sameBundle(source, row) && hash(cloud, source) === remoteHash(cloud, row)) {
      // A previous request may have reached the server while its local
      // acknowledgement failed. Exact content equality makes retry idempotent.
      const acknowledged = await patchCAS(storage, source.id, baseline(row, cloud), source.updatedAt);
      return marked(acknowledged, 'saved', 'クラウドの保存済み内容を確認しました', { remoteRow: row });
    }
    assertStateWrite(source, row, Object.assign({}, o, { cloud }));
    // The local selection may have changed while fetching the remote row.
    const beforeSend = await storage.getProject(project.id);
    if (!beforeSend || beforeSend.updatedAt !== source.updatedAt) {
      throw conflict('保存の確認中に手元のデータが更新されました');
    }
    const state = clone(cloud.stateOf(source));
    if (typeof cloud.patchRowIfUnchanged !== 'function') throw new Error('クラウドの競合を確認して保存できません');
    const summary = cloud.metaOf(source);
    const meta = Object.assign({}, row.meta || {}, { normalization: summary.normalization,
      normalizationBinding: summary.normalizationBinding });
    const savedRow = await cloud.patchRowIfUnchanged(source.id, { state, meta }, row.updated_at);
    if (!savedRow) throw conflict('保存中に別の画面からクラウドが更新されました');
    const latest = await storage.getProject(project.id);
    if (!latest) return marked(source, 'saved-local-deleted', 'クラウドには保存されましたが、手元のデータは削除されました');
    // Preserve edits made during the request. The acknowledgement records the
    // sent snapshot, never the state of those later edits.
    if (latest.cloudUpdatedAt !== source.cloudUpdatedAt || latest.cloudStateHash !== source.cloudStateHash ||
        !sameBundle(latest, savedRow)) {
      return marked(latest, 'saved-local-unacknowledged', 'クラウドには保存されました。手元の新しい編集を保持しています');
    }
    const fields = baseline(savedRow, cloud);
    fields.cloudPending = !!latest.cloudPending;
    try {
      const acknowledged = await patchCAS(storage, latest.id, fields, latest.updatedAt);
      return marked(acknowledged, 'saved', 'クラウドに保存しました', { remoteRow: savedRow });
    } catch (error) {
      return marked(await storage.getProject(project.id) || latest, 'saved-local-unacknowledged',
        'クラウドには保存されました。手元の新しい編集を保持しています', { error, remoteRow: savedRow });
    }
  }

  async function patchMetadata(projectId, patch, options) {
    const { storage, cloud } = deps(options);
    if (!usable(cloud)) throw new Error('クラウドに接続してください');
    const allowed = new Set(['display_name', 'folder_path', 'meta']);
    if (!patch || Object.keys(patch).some(key => !allowed.has(key))) {
      throw new Error('メタデータ更新ではデータ本体や補正設定を変更できません');
    }
    const local = await storage.getProject(projectId);
    const row = await getRemote(cloud, projectId);
    if (!row) throw conflict('クラウドにデータがありません');
    if (typeof cloud.patchRowIfUnchanged !== 'function') throw new Error('クラウドの競合を確認して保存できません');
    const fields = clone(patch);
    // A stale list's summary must not erase newer normalization metadata.
    if (fields.meta) {
      fields.meta = Object.assign({}, row.meta || {}, fields.meta);
      fields.meta.normalization = row.meta && row.meta.normalization || null;
      if (row.meta && Object.prototype.hasOwnProperty.call(row.meta, 'normalizationBinding')) {
        fields.meta.normalizationBinding = clone(row.meta.normalizationBinding);
      } else delete fields.meta.normalizationBinding;
    }
    const saved = await cloud.patchRowIfUnchanged(projectId, fields, row.updated_at);
    if (!saved) throw conflict('名前などの更新中にクラウドが更新されました');
    const latest = await storage.getProject(projectId);
    // The metadata update need not load/replace a stale local scientific state.
    // Only advance its baseline if it already described this remote state.
    const acknowledgement = {};
    if (local && latest && sameBundle(latest, saved) && local.cloudUpdatedAt === row.updated_at &&
        local.cloudStateHash === remoteHash(cloud, row) && remoteHash(cloud, row) === remoteHash(cloud, saved) &&
        latest.cloudUpdatedAt === local.cloudUpdatedAt && latest.cloudStateHash === local.cloudStateHash) {
      acknowledgement.cloudUpdatedAt = saved.updated_at;
      acknowledgement.cloudStateHash = remoteHash(cloud, saved);
    }
    // A successful name patch acknowledges only that name, even if local
    // scientific state is too old to advance its independent state baseline.
    if (local && latest && Object.prototype.hasOwnProperty.call(fields, 'display_name') &&
        latest.cloudUpdatedAt === local.cloudUpdatedAt && latest.cloudStateHash === local.cloudStateHash) {
      acknowledgement.cloudDisplayName = saved.display_name;
    }
    if (latest && Object.keys(acknowledgement).length) {
      try {
        await patchCAS(storage, projectId, acknowledgement, latest.updatedAt);
      } catch (error) { /* Newer local edits/acknowledgements are retained. */ }
    }
    return saved;
  }

  global.ProjectSync = { ensureLocal, saveState, patchMetadata, cloudAcknowledgement, assertStateWrite, statusOf };
})(window);
