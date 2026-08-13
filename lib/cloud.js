/*
 * cloud.js — Supabase とのやりとり (window.Cloud)
 *
 * 保存先を Supabase にして、どの PC で開いても同じ一覧が出るようにするための層。
 * 追加ライブラリは使わず fetch / XMLHttpRequest だけで REST・Storage・Auth を叩く。
 *
 * ── 何をどこに置くか ────────────────────────────────────────────────
 *   projects の行 (REST)   … 名前・フォルダ・表示設定・ROI  … 数 KB。よく変わる
 *   Storage の ZIP         … 生値ラスタの CSV と HE 画像     … 数 MB〜。滅多に変わらない
 *
 *   ★ 全部を 1 つの ZIP にして毎回上げ直す作りにはしない。理由は 2 つ。
 *     ① Free プランは 1 ファイル 50 MB まで。HE を含んだ ZIP は超えることがある
 *     ② ROI を 1 つ動かすたびに数十 MB 送るのは、待たされるだけで意味がない
 *     ROI や重ね合わせは行の state 列 (JSON) に入れるので、保存は一瞬で終わる。
 *
 *   ★ ZIP のパスは bundle_rev で毎回変える ({id}/bundle-3.zip)。
 *     同じパスに上書きすると CDN が古いほうを返すことがあり、
 *     「保存したのに別の PC では前のまま」という一番わかりにくい壊れ方をする。
 *
 * ── 権限 ────────────────────────────────────────────────────────
 *   共有アカウント 1 つ + そのパスワード。パスワードを知っている人は全員、
 *   全データを読み書きできる (個人ごとの区分けはしない)。
 *   実際に守っているのは Supabase 側の RLS で、この JS ではない。
 */
(function (global) {
  'use strict';

  const SESSION_KEY = 'marmoset:cloudSession';
  const WHO_KEY = 'marmoset:cloudWho';
  const TABLE = 'projects';
  // 期限のこれくらい手前で先に取り直す。大きめの ZIP を送っている最中に
  // 切れると、待たされた末に 401 で終わるため。
  const REFRESH_SKEW_MS = 5 * 60 * 1000;

  function cfg() { return global.CLOUD_CONFIG || {}; }
  function configured() { return !!(cfg().url && cfg().anonKey); }
  function base() { return String(cfg().url || '').replace(/\/+$/, ''); }
  function bucket() { return cfg().bucket || 'atlas'; }

  // ---- エラー -------------------------------------------------------------
  /** status を保った Error。呼ぶ側が 401 や 540 を見分けられるようにする。 */
  function CloudError(message, status, body) {
    const e = new Error(message);
    e.name = 'CloudError';
    e.status = status || 0;
    e.body = body || '';
    return e;
  }

  /** Supabase から返ってきた失敗を、画面に出して意味の通る日本語にする。 */
  function describe(status, body) {
    if (status === 540) {
      return 'Supabase のプロジェクトが休止しています。' +
        'Supabase のダッシュボードで Restore すると元に戻ります (データは消えていません)。';
    }
    if (status === 401 || status === 403) return 'クラウドの認証が切れました。パスワードを入れ直してください。';
    if (status === 413) return 'ファイルが大きすぎて送れませんでした (Free プランは 1 ファイル 50 MB まで)。';
    if (status === 0) return 'クラウドに接続できませんでした (ネットワークを確認してください)。';
    let detail = '';
    try {
      const j = JSON.parse(body);
      detail = j.message || j.msg || j.error_description || j.error || '';
    } catch (e) { detail = String(body || '').slice(0, 200); }
    return 'クラウドとの通信に失敗しました (' + status + ')' + (detail ? ': ' + detail : '');
  }

  // ---- セッション ---------------------------------------------------------
  function readSession() {
    try {
      const raw = global.localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      return (s && s.access_token && s.refresh_token) ? s : null;
    } catch (e) { return null; }
  }
  function writeSession(s) {
    try {
      if (s) global.localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else global.localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* プライベートモードなどで書けないことがある。無視して続ける */ }
  }
  function toSession(json) {
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      // expires_in は秒。手元の時計でだいたい合っていれば十分。
      expires_at: Date.now() + (Number(json.expires_in) || 3600) * 1000,
      user_id: (json.user && json.user.id) || '',
    };
  }

  /** 「誰が更新したか」の表示用の名前。認証ではなく、ただの札。 */
  function who() {
    try { return global.localStorage.getItem(WHO_KEY) || ''; } catch (e) { return ''; }
  }
  function setWho(name) {
    try { global.localStorage.setItem(WHO_KEY, String(name || '')); } catch (e) { /* noop */ }
  }

  // ---- 認証 ---------------------------------------------------------------
  async function authPost(query, body) {
    let res;
    try {
      res = await fetch(base() + '/auth/v1/token?' + query, {
        method: 'POST',
        headers: { 'apikey': cfg().anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) { throw CloudError(describe(0, ''), 0, String(e && e.message)); }
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 400) {
        let msg = 'パスワードが違います。';
        try {
          const j = JSON.parse(text);
          if (/not confirmed/i.test(j.error_description || j.msg || '')) {
            msg = '共有アカウントのメールが未確認です。Supabase 側で Auto Confirm にしてください。';
          }
        } catch (e) { /* noop */ }
        throw CloudError(msg, 400, text);
      }
      throw CloudError(describe(res.status, text), res.status, text);
    }
    return toSession(JSON.parse(text));
  }

  async function signIn(password) {
    if (!configured()) throw new Error('クラウドの接続先が設定されていません');
    const s = await authPost('grant_type=password', { email: cfg().email, password: String(password || '') });
    writeSession(s);
    return s;
  }

  function signOut() { writeSession(null); }
  function session() { return readSession(); }
  function signedIn() { return !!readSession(); }

  // 同時に refresh を投げると、Supabase 側のトークン回転で
  // 「Already Used」になって両方ログアウトする。走っている 1 本を共有する。
  let refreshing = null;

  async function ensureToken() {
    let s = readSession();
    if (!s) throw CloudError('クラウドにログインしていません', 401, '');
    if (s.expires_at - Date.now() > REFRESH_SKEW_MS) return s.access_token;
    if (!refreshing) {
      refreshing = (async () => {
        // 別のタブが先に取り直しているかもしれないので、直前にもう一度読む。
        const cur = readSession();
        if (cur && cur.expires_at - Date.now() > REFRESH_SKEW_MS) return cur;
        try {
          const ns = await authPost('grant_type=refresh_token', { refresh_token: (cur || s).refresh_token });
          writeSession(ns);
          return ns;
        } catch (e) {
          // 取り直せないなら、粘らずに捨ててログインし直してもらう。
          // ここで再試行を繰り返すと、切れたトークンで延々と叩き続ける。
          writeSession(null);
          throw CloudError('クラウドの認証が切れました。パスワードを入れ直してください。', 401, '');
        }
      })().finally(() => { refreshing = null; });
    }
    s = await refreshing;
    return s.access_token;
  }

  // ---- 共通の呼び出し -----------------------------------------------------
  async function call(path, opts, retried) {
    const token = await ensureToken();
    const o = opts || {};
    const headers = Object.assign({
      'apikey': cfg().anonKey,
      'Authorization': 'Bearer ' + token,
    }, o.headers || {});
    let res;
    try {
      res = await fetch(base() + path, { method: o.method || 'GET', headers: headers, body: o.body });
    } catch (e) { throw CloudError(describe(0, ''), 0, String(e && e.message)); }
    if (res.status === 401 && !retried) {
      // 期限の見積もりが外れた場合。1 回だけ取り直して同じことをやってみる。
      const cur = readSession();
      if (cur) { cur.expires_at = 0; writeSession(cur); }
      return call(path, opts, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw CloudError(describe(res.status, text), res.status, text);
    }
    return res;
  }

  // ---- projects の行 (REST) -----------------------------------------------
  async function listProjects() {
    const res = await call('/rest/v1/' + TABLE + '?select=*&order=updated_at.desc');
    return await res.json();
  }

  async function getProject(id) {
    const res = await call('/rest/v1/' + TABLE + '?select=*&id=eq.' + encodeURIComponent(id));
    const rows = await res.json();
    return rows && rows[0] ? rows[0] : null;
  }

  /** 行をまるごと入れ直す (無ければ作る)。 */
  async function putRow(row) {
    const body = Object.assign({}, row, { updated_at: new Date().toISOString(), updated_by: who() });
    const res = await call('/rest/v1/' + TABLE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(body),
    });
    const rows = await res.json();
    return rows && rows[0] ? rows[0] : body;
  }

  /** 行の一部だけ更新する (ZIP は送り直さない)。 */
  async function patchRow(id, patch) {
    const body = Object.assign({}, patch, { updated_at: new Date().toISOString(), updated_by: who() });
    const res = await call('/rest/v1/' + TABLE + '?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(body),
    });
    const rows = await res.json();
    return rows && rows[0] ? rows[0] : null;
  }

  /**
   * 手元が見ていた updated_at と一致するときだけ書き換える。
   * 一致しなければ 0 行返るので、「別の PC が先に保存した」と分かる。
   * ★ これをやらないと、2 台で開いていたとき後から押したほうが黙って全部を上書きする。
   */
  async function patchRowIfUnchanged(id, patch, expectedUpdatedAt) {
    if (!expectedUpdatedAt) return await patchRow(id, patch);
    const body = Object.assign({}, patch, { updated_at: new Date().toISOString(), updated_by: who() });
    const q = '/rest/v1/' + TABLE + '?id=eq.' + encodeURIComponent(id) +
      '&updated_at=eq.' + encodeURIComponent(expectedUpdatedAt);
    const res = await call(q, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(body),
    });
    const rows = await res.json();
    if (!rows || !rows.length) return null;   // 誰かが先に書いていた
    return rows[0];
  }

  async function removeRow(id) {
    await call('/rest/v1/' + TABLE + '?id=eq.' + encodeURIComponent(id), { method: 'DELETE' });
  }

  // ---- Storage の ZIP -----------------------------------------------------
  function bundlePath(id, rev) { return id + '/bundle-' + (rev | 0) + '.zip'; }

  /**
   * ZIP を送る。fetch ではなく XHR なのは、進み具合が取れるのがこちらだけだから。
   * 数十 MB を無反応で待たされると、固まったようにしか見えない。
   */
  async function uploadBundle(path, blob, onProgress) {
    const token = await ensureToken();
    const url = base() + '/storage/v1/object/' + bucket() + '/' + path;
    return await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('apikey', cfg().anonKey);
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.setRequestHeader('Content-Type', 'application/zip');
      // rev ごとに別のパスにしているので普段は衝突しないが、
      // 送信の途中で失敗した残骸に当たったときのために許しておく。
      xhr.setRequestHeader('x-upsert', 'true');
      if (onProgress && xhr.upload) {
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) onProgress(ev.loaded / ev.total);
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) { resolve(path); return; }
        reject(CloudError(describe(xhr.status, xhr.responseText || ''), xhr.status, xhr.responseText || ''));
      };
      xhr.onerror = () => reject(CloudError(describe(0, ''), 0, ''));
      xhr.send(blob);
    });
  }

  async function downloadBundle(path, onProgress) {
    const res = await call('/storage/v1/object/' + bucket() + '/' + path);
    // Content-Length があれば進み具合を出す。無ければ最後に 1 回だけ知らせる。
    const total = Number(res.headers.get('content-length') || 0);
    if (!onProgress || !total || !res.body || !res.body.getReader) {
      const b = await res.blob();
      if (onProgress) onProgress(1);
      return b;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      got += r.value.length;
      onProgress(Math.min(1, got / total));
    }
    return new Blob(chunks, { type: 'application/zip' });
  }

  async function removeBundle(path) {
    try {
      await call('/storage/v1/object/' + bucket() + '/' + path, { method: 'DELETE' });
    } catch (e) {
      // 実体が消せなくても行を消すほうを優先する。
      // 逆 (行だけ残る) にすると、どの PC で開いても必ず失敗するデータができる。
      if (e.status !== 404 && e.status !== 400) throw e;
    }
  }

  // ---- プロジェクト ↔ 行の対応 --------------------------------------------
  // 行の state 列に入れるもの。「どの PC で見ても同じであってほしい」ものだけ。
  //   ★ viewerTransform (どこを拡大して見ているか) は入れない。あれはその PC での
  //     見え方の話で、共有するものではない。入れると画面をドラッグしただけで
  //     「未保存の変更あり」になり、保存ボタンが常に光って意味を失う。
  //   ★ rotation (表示の向き) は入れる。あれは「そのデータがどちらを向いているか」で、
  //     どの PC で見ても同じであってほしいもの。カメラ位置とは別物。
  const STATE_KEYS = ['roi', 'alignment', 'layerDisplay', 'otsu', 'visibleLayers',
                      'world_coords', 'rotation'];

  function stateOf(project) {
    const s = {};
    for (const k of STATE_KEYS) if (project && project[k] !== undefined) s[k] = project[k];
    return s;
  }

  /** クラウドの state を手元のプロジェクトに載せる (無い項目はそのまま)。 */
  function applyState(project, state) {
    if (!state) return project;
    for (const k of STATE_KEYS) if (state[k] !== undefined) project[k] = state[k];
    return project;
  }

  /** キーの順番に左右されない JSON 文字列。ハッシュを安定させるため。 */
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    const keys = Object.keys(v).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }

  /**
   * 「クラウドに送ったときと中身が変わったか」を見るための短い指紋 (FNV-1a)。
   * ★ updatedAt では判定できない。putProject が必ず時刻を書き換えるので、
   *   画面をドラッグしただけ・落としてきた直後でも「新しい」になってしまう。
   */
  function hashState(state) {
    const s = stable(state);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16);
  }

  /** 一覧に出すための軽い情報。SQL から引くわけではないので 1 列にまとめる。 */
  function metaOf(project) {
    const g = project.grid || {};
    return {
      source: project.source || '',
      grid: { W: g.W || 0, H: g.H || 0, umPerPxX: g.umPerPxX || null, umPerPxY: g.umPerPxY || null },
      molecules: (project.molecules || []).map(m => m.name),
      hasHe: !!(project.images && Object.keys(project.images).length),
      orientation: project.orientation || '',
      plane: project.plane || '',
      sliceId: project.sliceId || '',
      createdAt: project.createdAt || '',
    };
  }

  global.Cloud = {
    configured: configured,
    describe: describe,
    signIn: signIn,
    signOut: signOut,
    signedIn: signedIn,
    session: session,
    ensureToken: ensureToken,
    who: who,
    setWho: setWho,
    listProjects: listProjects,
    getProject: getProject,
    putRow: putRow,
    patchRow: patchRow,
    patchRowIfUnchanged: patchRowIfUnchanged,
    removeRow: removeRow,
    bundlePath: bundlePath,
    uploadBundle: uploadBundle,
    downloadBundle: downloadBundle,
    removeBundle: removeBundle,
    stateOf: stateOf,
    applyState: applyState,
    hashState: hashState,
    metaOf: metaOf,
  };
})(window);
