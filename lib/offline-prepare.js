/* Collect every local dataset and the current cloud inventory without uploading,
 * resolving conflicts, or silently skipping records. */
(function (global) {
  'use strict';
  function check(signal) {
    if (signal && signal.aborted) throw new DOMException('キャンセルしました', 'AbortError');
  }
  function inventory(rows) {
    return JSON.stringify(rows.map(r => [r.id, r.updated_at, r.bundle_path || '', r.bundle_rev,
      r.folder_path || [], r.display_name || '', r.state || {}]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  }
  async function collect(options) {
    const { storage, cloud, sync, zip, signal } = options;
    const report = options.onProgress || function () {};
    check(signal);
    const before = await storage.listProjects();
    const required = new Set(before.map(p => p.id));
    const checked = new Map();
    const useCloud = cloud && cloud.configured();
    let rows = [];
    if (useCloud) {
      if (!cloud.signedIn()) throw new Error('全データを取得するため、クラウドへログインしてください。');
      if (typeof cloud.listAllProjects !== 'function') throw new Error('全データの一覧を取得する機能がありません。アプリを再読み込みしてください。');
      report('クラウドとこのPCのデータ一覧を確認しています…');
      rows = await cloud.listAllProjects({ signal });
      if (!Array.isArray(rows)) throw new Error('クラウドの全データ一覧を取得できませんでした。');
      for (let i = 0; i < rows.length; i++) {
        check(signal);
        const row = rows[i];
        required.add(row.id);
        report('データを取得・確認しています (' + (i + 1) + '/' + rows.length + ')：' + (row.display_name || row.id));
        const project = await sync.ensureLocal(row.id, {
          storage, cloud, zip, pendingFolderChanges: options.pendingFolderChanges,
          confirmReplace: async () => false,
        });
        const status = sync.statusOf(project);
        if (!project || !['current', 'updated', 'local-edits'].includes(status.status)) {
          throw new Error((row.display_name || row.id) + '：' + (status.reason || '最新版を確認できません。同期状況を確認してください。'));
        }
        const remote = status.remoteRow;
        if (!remote || inventory([remote]) !== inventory([row])) {
          throw new Error('取得中にクラウドの内容が変更されました。もう一度出力してください。');
        }
        checked.set(project.id, project.updatedAt);
      }
      check(signal);
      const after = await cloud.listAllProjects({ signal });
      if (!Array.isArray(after) || inventory(rows) !== inventory(after)) {
        throw new Error('取得中にクラウドの一覧が変更されました。もう一度出力してください。');
      }
    }
    check(signal);
    report('画像・強度データ・ROI・フォルダをまとめています…');
    const snapshot = await storage.exportWorkspaceSnapshot();
    const captured = new Map(snapshot.projects.map(p => [p.id, p]));
    for (const id of required) {
      if (!captured.has(id)) throw new Error('出力準備中にデータが削除されました。もう一度出力してください。');
    }
    for (const [id, revision] of checked) {
      if (captured.get(id).updatedAt !== revision) {
        throw new Error('出力準備中に別の画面でデータが変更されました。保存を終えてから再実行してください。');
      }
    }
    check(signal);
    return snapshot;
  }
  global.OfflinePrepare = { collect };
})(window);
