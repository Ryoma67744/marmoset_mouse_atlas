/* Master-only setup workflow. Raw rasters remain immutable.
 * Simple relative correction and existing detailed profiles use separate builders.
 */
(function (global) {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = v => Number.isFinite(v) ? Number(v).toPrecision(6) : '—';
  const roles = [['ht','5-HT'], ['d4','d4-5-HT'], ['da','DA'], ['ne','NE']];
  const targetRoles = roles.filter(([role]) => role !== 'd4');
  function finiteCount(values) {
    let count = 0;
    if (values) for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) count++;
    return count;
  }
  function outputAvailability(entries, profiles) {
    return profiles.map(item => {
      const entry = entries.find(e => e.project.id === item.projectId);
      const project = Object.assign({}, entry.project, {normalization:item.normalization});
      const scope = item.normalization.scope;
      if (scope) project.normalizationBinding = {groupId:scope.groupId,folderPath:scope.folderPath.slice(),memberId:global.NormalizationScope.memberId(entry.project)};
      const evaluation = global.Normalization.evaluate(project, entry.rasters);
      const channels = {};
      targetRoles.forEach(([role]) => {
        const key = item.normalization.mapping[role], channel = key && evaluation.channels[key];
        const raw = key && entry.rasters[key];
        channels[role] = {finite:finiteCount(channel && channel.values), measured:finiteCount(raw && raw.values),
          reason:channel ? (channel.reasonCodes || []).map(global.Normalization.reasonText).join(' / ') : '分子対応が未指定、または分子が存在しません。'};
      });
      return {projectId:item.projectId,name:entry.project.displayName || item.projectId,channels};
    });
  }
  function numberField(form, name, optional) {
    const v = form.elements[name].value.trim();
    if (optional && !v) return null;
    if (!v || !Number.isFinite(Number(v))) throw new Error(name + ': 数値を入力してください');
    return Number(v);
  }
  function textField(form, name) {
    const v = form.elements[name].value.trim();
    if (!v) throw new Error(name + ': 入力が必要です');
    return v;
  }

  function open(options) {
    if (document.getElementById('normalization-dialog')) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'normalization-dialog';
    dialog.setAttribute('aria-labelledby', 'normalization-title');
    dialog.style.cssText = 'width:min(1100px,96vw);max-height:92vh;padding:22px;border:1px solid #cbd5e1;border-radius:10px;overflow:auto;color:#1e293b';
    dialog.innerHTML = '<h2 id="normalization-title" style="font-size:20px;font-weight:700">同位体5-HTでフォルダーを補正</h2>' +
      '<p style="font-size:13px;margin:10px 0">5-HT は同じ画素の d4-5-HT との比、その他の分子は d4 を基準にした切片係数で相対補正します。生値は保持します。</p>' +
      '<details style="font-size:12px;margin:10px 0"><summary>補正値と更新について</summary><p>切片係数はこのフォルダー内の比較用です。分子固有のイオン化差や実験条件の比較可能性を保証するものではありません。' +
      '同じブラウザの Viewer は設定の更新を通知します。旧版のタブは再読み込みしてください。別 PC の更新は Viewer を開く・戻る際に確認します。</p></details>' +
      '<div id="normalization-body"></div><p id="normalization-status" style="white-space:pre-wrap;font-size:13px;margin:12px 0" role="status"></p>' +
      '<button type="button" class="btn" id="normalization-close">閉じる</button>';
    document.body.appendChild(dialog);
    const body = dialog.querySelector('#normalization-body');
    const status = dialog.querySelector('#normalization-status');
    let busy = false, entries = [], preview = null, saved = null, cloudPending = new Set();
    const scoped = Array.isArray(options.folders);
    const Scope = global.NormalizationScope;
    let allProjects = options.projects || [], folders = options.folders || [];
    let currentFolderId = options.currentFolderId, activeGroup = null, mergedGuard = null, localGuard = null;
    const sessionGroupIds = new Map();
    const close = () => { if (!busy) { dialog.close(); dialog.remove(); if (options.onClose) options.onClose(); } };
    dialog.querySelector('#normalization-close').onclick = close;
    dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
    dialog.addEventListener('click', e => { if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
    }});
    function setBusy(on, message) {
      if (message != null) status.textContent = message;
      if (on) status.style.color = '#1e293b';
      if (busy === on) return;
      busy = on;
      dialog.querySelectorAll('button,input,select,textarea').forEach(el => {
        if (on) { el.dataset.prevDisabled = el.disabled ? '1' : '0'; el.disabled = true; }
        else { el.disabled = el.dataset.prevDisabled === '1'; delete el.dataset.prevDisabled; }
      });
    }
    function error(e) { status.textContent = e && e.message ? e.message : String(e); status.style.color = '#b91c1c'; }
    const selected = new Set(options.selectedIds || []);
    function projectPath(project) {
      const parts = [], seen = new Set();
      let id = project.folderId;
      while (id != null) {
        if (seen.has(id)) return 'フォルダー階層を確認できません';
        seen.add(id);
        const folder = folders.find(f => f.id === id);
        if (!folder) return 'フォルダー階層を確認できません';
        parts.unshift(folder.name); id = folder.parentId;
      }
      return parts.join(' / ') || '第2階層に所属しないデータ';
    }
    function groupRows(group) {
      return group.projects.map(project => {
        const assessed = Scope.assess(project, group);
        return '<tr data-group-project="' + esc(project.id) + '"><td style="padding:6px">' + esc(project.displayName || project.id) +
          '</td><td style="padding:6px">' + esc(projectPath(project)) + '</td><td style="padding:6px">' + esc(assessed.reason || assessed.status) + '</td></tr>';
      }).join('');
    }
    async function refreshState() {
      if (!scoped) return;
      const state = options.refreshScope ? await options.refreshScope() : {
        projects: await options.storage.listProjects(), folders: await options.storage.listFolders(), currentFolderId
      };
      if (!state || !Array.isArray(state.projects) || !Array.isArray(state.folders)) throw new Error('最新のフォルダー構成を取得できません。設定を閉じて再読み込みしてください。');
      allProjects = state.projects; folders = state.folders;
      if (Object.prototype.hasOwnProperty.call(state, 'currentFolderId')) currentFolderId = state.currentFolderId;
    }
    function findCurrentGroup(folderId) {
      const group = Scope.buildGroups(allProjects, folders).groups.find(g => g.folderId === folderId);
      if (!group || !group.projects.length) throw new Error('選択した第2階層フォルダーが削除・移動されたか、対象データがありません。設定を閉じて再読み込みしてください。');
      return group;
    }
    async function checkScope(expected) {
      if (!scoped) return;
      await refreshState();
      const next = Scope.snapshot(allProjects, folders, activeGroup.folderId);
      if (!Scope.equalsSnapshot(expected, next)) throw new Error('プレビュー対象のフォルダー構成・所属データが変更されました。設定を閉じて再読み込みしてください。');
      const current = findCurrentGroup(activeGroup.folderId);
      if ((current.groupId || null) !== activeGroup.previousGroupId) throw new Error('補正グループの識別情報が変更されました。設定を閉じて再読み込みしてください。');
    }
    async function readLocalGuard() {
      const [projects, currentFolders] = await Promise.all([options.storage.listProjects(), options.storage.listFolders()]);
      const guard = Scope.snapshot(projects, currentFolders, activeGroup.folderId);
      const loadedIds = entries.map(e => e.project.id).sort();
      if (JSON.stringify(guard.memberIds) !== JSON.stringify(loadedIds)) throw new Error('フォルダー内の全データをこの PC で確認できません。読み込みからやり直してください。');
      return guard;
    }
    function renderGroupSelection() {
      if (!Scope) { error(new Error('フォルダー補正の機能を読み込めませんでした。ページを再読み込みしてください。')); return; }
      const built = Scope.buildGroups(allProjects, folders);
      const current = Scope.groupForFolder(currentFolderId, folders);
      const parent = folders.find(f => f.id === currentFolderId && !f.parentId);
      const candidates = parent ? built.groups.filter(g => {
        const folder = folders.find(f => f.id === g.folderId); return folder && folder.parentId === parent.id;
      }) : built.groups;
      body.innerHTML = '<h3 style="font-weight:700;margin:16px 0 8px">1. 第2階層の補正グループを選択</h3>' +
        '<p style="font-size:13px;margin:8px 0">「すべて」を0階層として、第2階層フォルダーとその子フォルダーの全データを対象にします。1グループずつ設定します。</p>' +
        '<label style="display:block;font-size:13px">補正グループ<select id="normalization-group" style="display:block;width:100%;border:1px solid #94a3b8;padding:7px;margin:8px 0">' +
        '<option value="">フォルダーを選択してください</option>' + candidates.map(g => '<option value="' + esc(g.folderId) + '" ' +
          (current && current.folderId === g.folderId ? 'selected' : '') + '>' + esc(g.label) + '（' + g.projects.length + '件）</option>').join('') + '</select></label>' +
        '<div id="normalization-group-targets"></div>' +
        (built.ungrouped.length ? '<details style="font-size:12px;margin:10px 0"><summary>第2階層に所属しないデータ：' + built.ungrouped.length + '件（対象外）</summary>' +
          built.ungrouped.map(p => '<div>' + esc(p.displayName || p.id) + '</div>').join('') + '</details>' : '') +
        (built.errors.length ? '<p style="color:#b91c1c;font-size:12px">階層を確認できない項目：' + built.errors.map(e => esc(e.reason || e.code)).join(' / ') + '</p>' : '') +
        '<button type="button" class="btn btn-primary" id="normalization-load" style="margin:12px 0" disabled>このグループの全データを読み込み</button>';
      const selector = body.querySelector('#normalization-group');
      function showTargets() {
        activeGroup = candidates.find(g => String(g.folderId) === selector.value) || null;
        const guard = activeGroup && Scope.snapshot(allProjects, folders, activeGroup.folderId);
        body.querySelector('#normalization-load').disabled = !activeGroup || !activeGroup.projects.length || !guard.valid;
        body.querySelector('#normalization-group-targets').innerHTML = activeGroup ?
          '<p style="font-size:13px;margin:10px 0"><strong>' + esc(activeGroup.label) + '</strong> ／ 対象 ' + activeGroup.projects.length + '件（子フォルダーを含む）</p>' +
          (!guard.valid ? '<p style="color:#b91c1c;font-size:12px">このグループの階層に不整合があるため、全対象を確定できません。フォルダー構成を修復してから再読み込みしてください。</p>' : '') +
          (activeGroup.identityConflict ? '<p style="color:#92400e;font-size:12px">補正グループの所属情報が重複・混在しています。このフォルダー全体に独立した新しいグループとプロファイルを作成します。条件を確認してください。</p>' : '') +
          '<div style="max-height:30vh;overflow:auto;border:1px solid #e2e8f0"><table style="width:100%;font-size:12px;text-align:left"><thead><tr><th>データ</th><th>所属フォルダー</th><th>既存設定</th></tr></thead><tbody>' + groupRows(activeGroup) + '</tbody></table></div>' : '';
      }
      showTargets();
      const loadGroup = async () => {
        if (!activeGroup || busy) return;
        setBusy(true, 'フォルダー内の対象を確認中…');
        try {
          await refreshState();
          activeGroup = findCurrentGroup(activeGroup.folderId);
          const previousGroupId = activeGroup.groupId || null;
          let identity = sessionGroupIds.get(activeGroup.folderId);
          if (!identity || identity.previousGroupId !== previousGroupId || (activeGroup.identityConflict && identity.groupId === previousGroupId)) {
            identity = {previousGroupId,groupId:activeGroup.identityConflict ? options.storage.uid('normgroup') : previousGroupId || options.storage.uid('normgroup')};
            sessionGroupIds.set(activeGroup.folderId, identity);
          }
          activeGroup = Object.assign({}, activeGroup, identity, {reassignGroupId:!!previousGroupId && identity.groupId !== previousGroupId});
          mergedGuard = Scope.snapshot(allProjects, folders, activeGroup.folderId);
          if (!mergedGuard.valid) throw new Error('このグループの階層に不整合があるため、全対象を確定できません。フォルダー構成を修復してから再読み込みしてください。');
          await loadRows(activeGroup.projects);
          await checkScope(mergedGuard);
          localGuard = await readLocalGuard();
          setBusy(false, 'グループ内の全件を読み込みました。内部標準と補正対象を確認できます。');
          renderConfiguration();
        } catch (e) { setBusy(false); error(e); }
      };
      body.querySelector('#normalization-load').onclick = loadGroup;
      selector.onchange = () => { showTargets(); if (!body.querySelector('#normalization-load').disabled) loadGroup(); };
      // Defer until showModal has run; malformed groups remain visible and retryable.
      if (!body.querySelector('#normalization-load').disabled) Promise.resolve().then(loadGroup);
    }
    async function loadRows(rows) {
      entries = []; preview = null; saved = null;
      const failures = [];
      for (let i = 0; i < rows.length; i++) {
        status.textContent = (i + 1) + '/' + rows.length + ' ' + (rows[i].displayName || rows[i].id);
        try {
          const project = await options.loadProject(rows[i]);
          if (!project || project.id !== rows[i].id) throw new Error('対象データの識別情報が一致しません');
          const rasters = await global.Normalization.loadRasters(project, {storage:options.storage});
          entries.push({project, rasters, mapping:global.Normalization.suggestMapping(project.molecules || [])});
        } catch (e) { failures.push((rows[i].displayName || rows[i].id) + ': ' + (e.message || String(e))); }
      }
      if (failures.length) {
        const loaded = entries.length; entries = [];
        throw new Error('対象 ' + rows.length + '件／読み込み成功 ' + loaded + '件／失敗 ' + failures.length + '件。全件を読み込むまで計算・保存できません。\n' + failures.join('\n'));
      }
    }
    function renderLegacySelection() {
      body.innerHTML = '<h3 style="font-weight:700;margin:16px 0 8px">1. 同じ測定・散布バッチの対象を選択</h3>' +
      '<div style="max-height:32vh;overflow:auto;border:1px solid #e2e8f0;padding:8px">' +
      (options.projects || []).map((p, i) => '<label style="display:block;padding:4px"><input type="checkbox" data-project="' + i + '" ' +
        (selected.has(p.id) ? 'checked ' : '') + '> ' + esc(p.displayName || p.id) + ' <small>' +
        esc(options.folderName ? options.folderName(p) : '') + '</small></label>').join('') + '</div>' +
      '<button type="button" class="btn btn-primary" id="normalization-load" style="margin:12px 0">選択データを読み込み</button>';
    body.querySelector('#normalization-load').onclick = async () => {
      const rows = [...body.querySelectorAll('[data-project]:checked')].map(el => options.projects[Number(el.dataset.project)]);
      if (!rows.length) { error(new Error('対象データを選択してください。')); return; }
      setBusy(true, '生値と設定を読み込み中…');
      try {
        await loadRows(rows);
        setBusy(false, '分子の自動候補を確認し、基準データと条件を指定してください。');
        renderConfiguration();
      } catch (e) { setBusy(false); error(e); }
    };
    }
    if (scoped) renderGroupSelection(); else renderLegacySelection();

    function renderConfiguration() {
      if (scoped && !entries.some(e => e.project.normalization && e.project.normalization.schemaVersion !== 3)) {
        renderSimpleConfiguration(); return;
      }
      renderDetailedConfiguration();
    }

    function renderDetailedConfiguration() {
      const existing = entries.map(e => e.project.normalization).filter(Boolean);
      const same = existing.length === entries.length && existing.every(p => p.id === existing[0].id && p.revision === existing[0].revision &&
        (!scoped || (p.schemaVersion === 2 && p.scope && p.scope.groupId === activeGroup.groupId)));
      const prior = same ? existing[0] : null;
      const seed = prior || {};
      entries.forEach(e => { if (prior) e.mapping = Object.assign({}, e.project.normalization.mapping); });
      function input(name, label, value, type) {
        return '<label style="display:block;margin:8px 0;font-size:13px">' + label +
          '<input name="' + name + '" type="' + (type || 'text') + '" ' + (type === 'number' ? 'step="any" ' : '') +
          'value="' + esc(value == null ? '' : value) + '" style="border:1px solid #94a3b8;padding:5px;display:block;width:100%"></label>';
      }
      const mapRows = entries.map((entry, index) => '<tr><td style="padding:6px">' + esc(entry.project.displayName || entry.project.id) +
        (scoped ? '<small style="display:block">' + esc(projectPath(entry.project)) + '<br>' + esc(Scope.assess(entry.project, activeGroup).reason) + '</small>' : '') + '</td>' +
        '<td style="text-align:center"><input type="checkbox" name="ref_' + index + '" ' +
          (prior && prior.reference && (prior.reference.projectIds || []).includes(scoped ? Scope.memberId(entry.project) : entry.project.id) ? 'checked' : '') + '></td>' +
        roles.map(([role]) => '<td><select name="map_' + index + '_' + role + '" style="max-width:160px;border:1px solid #94a3b8;padding:4px">' +
          '<option value="">未指定／存在しない</option>' + (entry.project.molecules || []).map(m => '<option value="' + esc(m.key) + '" ' +
            (entry.mapping[role] === m.key ? 'selected' : '') + '>' + esc(m.name || m.key) + '</option>').join('') + '</select></td>').join('') + '</tr>').join('');
      body.innerHTML = (scoped ? '<div data-configuration-folder="' + esc(activeGroup.folderId) + '" style="padding:10px;background:#eff6ff;margin:12px 0"><strong>' + esc(activeGroup.label) + '</strong> ／ 対象 ' + entries.length +
        '件（子フォルダーを含む全件）<p style="font-size:12px;margin-top:6px">D_ref と固定共通レンジはこのグループ内で計算します。DA・NE はこのフォルダー内の比較用です。</p>' +
        '<button class="btn" type="button" id="normalization-back" style="margin-top:8px">別のグループを選ぶ</button></div>' : '') +
        (scoped ? '<p style="font-size:13px">従来の詳細設定です。保存済みの計算条件を維持します。</p><button class="btn" type="button" id="normalization-use-simple">簡単設定へ切り替える</button>' : '') +
        '<form id="normalization-form"><h3 style="font-weight:700;margin:16px 0 8px">2. 条件・固定基準・分子対応</h3>' +
        '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px">' +
        input('batchId', '測定・散布バッチ ID（両方を識別できる名称）', seed.batchId) +
        input('prepId', '前処理・誘導体化条件 ID', seed.prepId) +
        input('profileId', 'プロファイル ID（同じ ID の設定変更は revision を増加）', seed.id || options.storage.uid('d4')) +
        input('revision', 'revision（既存設定を更新する場合は前版より大きい整数）', prior ? Number(prior.revision) + 1 : 1, 'number') +
        input('minD4', 'd4 最小信号（この値以下は無効。実測に基づき指定）', seed.qc && seed.qc.minD4, 'number') +
        input('saturationD4', 'd4 飽和境界（以上を無効。空欄は判定不能・暫定扱い）', seed.qc && seed.qc.saturationD4, 'number') +
        input('minCoverage', '最低有効率 0–1（初期 0.8 は設定例であり検証値ではありません）', seed.qc ? seed.qc.minCoverage : 0.8, 'number') +
        '<label style="font-size:13px;margin:8px 0">係数の根拠<select name="quality" style="display:block;border:1px solid #94a3b8;padding:5px"><option value="provisional">暫定（初期・推奨）</option><option value="validated">妥当性を実験で検証済み</option></select></label>' +
        '</div>' + input('validationEvidence','DA・NE の測定差への適用を検証した資料・QC ID（検証済み選択時は必須）', seed.validationEvidence) +
        '<label style="display:block;font-size:13px">基準領域<select name="referenceKind" style="margin:8px;border:1px solid #94a3b8;padding:5px">' +
        '<option value="qc">共通 QC（下表で基準データを明示選択）</option><option value="roi">対応する解剖学的 ROI</option>' +
        '<option value="whole_tissue">全測定領域（比較可能な連続切片に限る・暫定）</option></select></label>' +
        '<label style="font-size:13px">固定基準 ROI 名（1 行に 1 名。ROI 方式では必須、QC 方式では省略時に全測定領域）' +
        '<textarea name="roiNames" rows="2" style="display:block;border:1px solid #94a3b8;width:100%;padding:5px">' + esc((seed.reference && seed.reference.roiNames || []).join('\n')) + '</textarea></label>' +
        '<p style="font-size:12px;margin:8px 0">各切片の基準領域で d4 の中央値 D_s を計算し、チェックした基準データの D_s の中央値を D_ref として固定します。' +
        'k = D_ref / D_s。対象や表示順を変えても基準は再計算しません。基準データは少なくとも 1 件必要です。</p>' +
        '<div style="overflow:auto"><table style="font-size:13px;width:100%"><thead><tr><th>データ</th><th>固定基準</th>' + roles.map(r=>'<th>'+r[1]+'</th>').join('') + '</tr></thead><tbody>' + mapRows + '</tbody></table></div>' +
        '<label style="display:block;font-size:13px;margin:14px 0"><input type="checkbox" name="comparability"> ' +
        '各分子の対応、同一切片・同一測定の座標対応、測定／散布／前処理条件の比較可能性を確認した（画像の見かけの位置合わせでは代用不可）。</label>' +
        '<fieldset style="border:1px solid #cbd5e1;padding:10px;margin:12px 0"><legend>Otsu の固定入力分子（d4 等の内部標準は除外）</legend>' +
        ['ht','da','ne'].map(role => '<label style="margin-right:15px"><input type="checkbox" name="otsu_' + role + '"> ' + roles.find(r=>r[0]===role)[1] + '</label>').join('') +
        '<p style="font-size:12px;margin-top:6px">未選択なら Otsu は利用不可です。選んだ分子が欠けるデータでは適用しません。これは登録分子の信号和であり、全スペクトル TIC ではありません。</p></fieldset>' +
        '<details style="border:1px solid #cbd5e1;padding:10px;margin:12px 0"><summary>3. 5-HT 絶対定量の検量線（任意・ROI 単位のみ）</summary>' +
        '<label style="display:block;margin:12px 0"><input name="calibrationEnabled" type="checkbox"> 検証済み検量線を登録する</label>' +
        '<p style="font-size:12px">対応モデルは R = a × C + b の直線です。単位は検量線で検証した単位を使用し、重量濃度への自動換算・範囲外への外挿・画素単位の絶対定量は行いません。</p>' +
        '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px">' +
        input('calibrationId','検量線 ID','') + input('unit','検証済みの出力単位（例 fmol/mm²）','') +
        input('slope','傾き a（正の値）','', 'number') + input('intercept','切片 b','', 'number') +
        input('lloq','定量下限 LLOQ（濃度・量）','', 'number') + input('uloq','定量上限 ULOQ（濃度・量）','', 'number') +
        input('responseMin','検量線の応答 R 下限','', 'number') + input('responseMax','検量線の応答 R 上限','', 'number') + '</div>' +
        '<label>検量線の応答集計<select name="responseAggregation" style="border:1px solid #94a3b8;padding:5px;margin:8px">' +
        '<option value="mean_pixel_ratio">画素ごとの比の平均</option><option value="ratio_of_sums">同じ有効画素集合での信号総和の比</option></select></label>' +
        input('calibrationSource','検量線・検証結果の出典（資料／実験 ID）','') +
        '<label style="display:block;font-size:13px"><input type="checkbox" name="calibrationConfirmed"> ' +
        'この集計方式・単位・測定／前処理条件で、組織からの回収・イオン化を含む検量線の妥当性を確認した。</label></details>' +
        '<button class="btn btn-primary" type="submit" id="normalization-preview">計算結果をプレビュー</button>' +
        '<div id="normalization-preview-result" style="margin:16px 0;overflow:auto"></div>' +
        '<button class="btn btn-primary" type="button" id="normalization-save" disabled>確認してこの PC に保存</button> ' +
        '<button class="btn" type="button" id="normalization-cloud" disabled>このプロファイルをクラウドに保存</button></form>';
      const form = body.querySelector('form');
      if (scoped) body.querySelector('#normalization-use-simple').onclick = () => {
        if (busy) return;
        const changed = '簡単設定では、全切片の d4 実測領域から基準を計算し、その他の分子にも切片係数を適用します。ROI の最低有効率による非表示は既定で解除されます。実行するまで保存済み設定は変更しません。切り替えますか？';
        if (!entries.some(e => e.project.normalization) || confirm(changed)) renderSimpleConfiguration(true);
      };
      if (scoped) body.querySelector('#normalization-back').onclick = async () => {
        if (busy) return;
        setBusy(true, '補正グループを再確認中…');
        try {
          await refreshState();
          entries = []; preview = null; saved = null; mergedGuard = null; localGuard = null;
          currentFolderId = null;
          setBusy(false, '補正グループを選択してください。'); renderGroupSelection();
        } catch (e) { setBusy(false); error(e); }
      };
      form.elements.quality.value = seed.quality || 'provisional';
      form.elements.referenceKind.value = seed.reference && seed.reference.kind || 'qc';
      function updateReferenceKind() {
        const whole = form.elements.referenceKind.value === 'whole_tissue';
        form.elements.roiNames.disabled = whole;
        if (whole) form.elements.roiNames.value = '';
      }
      updateReferenceKind();
      form.elements.referenceKind.addEventListener('change', updateReferenceKind);
      (seed.otsuSourceRoles || []).forEach(role => { if (form.elements['otsu_' + role]) form.elements['otsu_' + role].checked = true; });
      if (seed.calibration) {
        const c = seed.calibration;
        form.elements.calibrationEnabled.checked = true;
        for (const [field, key] of Object.entries({calibrationId:'id',unit:'unit',slope:'slope',intercept:'intercept',lloq:'lloq',uloq:'uloq',responseMin:'responseMin',responseMax:'responseMax',responseAggregation:'responseAggregation',calibrationSource:'source'})) {
          form.elements[field].value = c[key] == null ? '' : c[key];
        }
      }
      function invalidatePreview() {
        preview = null; saved = null; cloudPending.clear();
        form.querySelector('#normalization-save').disabled = true;
        form.querySelector('#normalization-cloud').disabled = true;
        form.querySelector('#normalization-preview-result').textContent = '設定変更後はプレビューを再実行してください。';
      }
      form.addEventListener('input', invalidatePreview);
      form.addEventListener('change', invalidatePreview);
      form.onsubmit = async e => {
        e.preventDefault();
        if (busy) return;
        try {
          setBusy(true, '固定基準・係数・共通表示レンジを計算中…');
          if (scoped) {
            await checkScope(mergedGuard);
            const currentLocal = await readLocalGuard();
            if (!Scope.equalsSnapshot(localGuard, currentLocal)) throw new Error('読み込み後にフォルダー構成が変更されました。設定を閉じて再読み込みしてください。');
          }
          const config = readConfiguration(form, prior);
          await new Promise(resolve => setTimeout(resolve, 0));
          preview = global.Normalization.createProfiles(entries, config);
          preview.outputs = outputAvailability(entries, preview.profiles);
          preview.hasOutput = preview.outputs.some(row => targetRoles.some(([role]) => row.channels[role].finite > 0));
          setBusy(false, 'プレビューのみです。まだ保存されていません。算出不可・暫定の理由を確認してください。');
          status.style.color = '#1e293b';
          const counts = preview.preview.reduce((out, row) => { out[row.status] = (out[row.status] || 0) + 1; return out; }, {});
          const ranges = preview.profiles[0] && preview.profiles[0].normalization.commonRanges || {};
          const availableByRole = Object.fromEntries(targetRoles.map(([role]) => [role,preview.outputs.filter(row => row.channels[role].finite > 0).length]));
          form.querySelector('#normalization-preview-result').innerHTML = '<p style="font-size:13px;margin:8px 0">対象 ' + entries.length + '件 ／ 係数算出可能 ' +
            preview.preview.filter(row => Number.isFinite(row.k)).length + '件（検証済み ' + (counts.VALID || 0) + '件・暫定 ' + (counts.PROVISIONAL || 0) +
            '件）／ 係数算出不可 ' + (counts.UNAVAILABLE || 0) + '件</p>' +
            '<p style="font-size:13px;margin:8px 0">補正値を算出できるデータ：' + targetRoles.map(([role,label]) => esc(label) + ' ' + availableByRole[role] + ' / ' + entries.length + '件').join(' ／ ') + '</p>' +
            '<table id="normalization-output-counts" style="font-size:12px;width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left;padding:6px">データ</th>' +
            targetRoles.map(([,label]) => '<th style="text-align:left;padding:6px">' + esc(label) + '</th>').join('') + '</tr></thead><tbody>' +
            preview.outputs.map(row => '<tr data-output-project="' + esc(row.projectId) + '"><td style="border-top:1px solid #cbd5e1;padding:6px">' + esc(row.name) + '</td>' +
              targetRoles.map(([role]) => { const ch = row.channels[role]; return '<td data-output-role="' + role + '" data-finite="' + ch.finite + '" style="border-top:1px solid #cbd5e1;padding:6px">' +
                ch.finite + ' / ' + ch.measured + '画素' + (ch.finite < ch.measured || !ch.finite ? '<small style="display:block">' + esc(ch.reason || '算出可能な画素がありません。') + '</small>' : '') + '</td>'; }).join('') + '</tr>').join('') + '</tbody></table>' +
            '<p style="font-size:12px;margin:8px 0">各欄は「算出可能画素 / その分子の測定済み画素」です。5-HT/D4 比は切片係数 k がなくても算出できる場合があります。ROI ごとの最低有効率は別に判定します。' +
            '算出不可のデータもグループに保持し、選択した固定基準を自動で減らしません。</p>' +
            (!preview.hasOutput ? '<p id="normalization-output-blocked" style="background:#fef2f2;color:#b91c1c;padding:10px">全対象の 5-HT・DA・NE に算出可能な補正値がないため保存できません。分子対応・固定基準・QC 条件を確認してください。既存の補正設定は保持されています。</p>' : '') +
            '<table style="font-size:12px;width:100%;border-collapse:collapse"><thead><tr>' +
            ['データ','D_s','D_ref','係数 k','有効率','状態／理由'].map(h => '<th style="text-align:left;padding:6px">'+h+'</th>').join('') + '</tr></thead><tbody>' +
            preview.preview.map(p => '<tr>' + [p.name || p.projectId,fmt(p.Ds),fmt(p.Dref),fmt(p.k),Number.isFinite(p.coverage)?(p.coverage*100).toFixed(1)+'%':'—',p.status + ' / ' + (p.reasonCodes || []).map(global.Normalization.reasonText).join(' / ')].map(v=>'<td style="border-top:1px solid #cbd5e1;padding:6px">'+esc(v)+'</td>').join('') + '</tr>').join('') + '</tbody></table>' +
            '<p style="font-size:12px;margin-top:8px">5-HT 絶対値: ' + (config.calibration ?
              config.qc.saturationD4 == null ? 'D4_SATURATION_UNKNOWN：検量線は登録されていますが、d4 の飽和境界が未設定のため算出不可です。' + (availableByRole.ht ? '信号比の算出可能画素は上表を参照してください。' : '') :
              'ROI ごとに有効率・検量線範囲を検証して算出します。' : 'CALIBRATION_MISSING：検量線未登録のため算出不可。' + (availableByRole.ht ? '信号比の算出可能画素は上表を参照してください。' : '信号比も現在の条件では算出できません。')) + '</p>' +
            '<p style="font-size:13px;margin:12px 0 4px">固定共通レンジ' + (scoped ? '（' + esc(activeGroup.label) + '）' : '') + '</p>' +
            '<table style="font-size:12px;width:100%;text-align:left;border-collapse:collapse"><thead><tr><th>分子</th><th>下限</th><th>上限</th></tr></thead><tbody>' +
            roles.filter(([role]) => role !== 'd4').map(([role, label]) => '<tr><td style="padding:5px;border-top:1px solid #cbd5e1">' + esc(label) + '</td><td style="padding:5px;border-top:1px solid #cbd5e1">' +
              (ranges[role] ? fmt(ranges[role].min) : '有効値なし') + '</td><td style="padding:5px;border-top:1px solid #cbd5e1">' +
              (ranges[role] ? fmt(ranges[role].max) : '—') + '</td></tr>').join('') + '</tbody></table>';
          form.querySelector('#normalization-save').disabled = !preview.hasOutput;
        } catch (e2) { if (busy) setBusy(false); invalidatePreview(); error(e2); }
      };
      form.querySelector('#normalization-save').onclick = async () => {
        if (!preview || !preview.hasOutput || busy) return;
        if (!confirm((scoped ? activeGroup.label + ' の全 ' + entries.length + '件に保存します。\n' +
          (activeGroup.reassignGroupId ? '所属情報の重複・混在を解消し、このフォルダーを独立した補正グループとして保存します。\n' : '') + '\n' : '') + '各分子の算出可能画素・係数・算出不可の理由を確認しましたか？\n\n生値は変更せず、プロファイルをこの PC に保存します。旧設定の Otsu は OFF に戻します。クラウドには次のボタンで別途保存します。')) return;
        setBusy(true, '変更競合を確認して、この PC に一括保存中…');
        try {
          if (scoped) {
            await checkScope(mergedGuard);
            const currentLocal = await readLocalGuard();
            if (!Scope.equalsSnapshot(localGuard, currentLocal)) throw new Error('プレビュー後にフォルダー構成が変更されました。設定を閉じて再読み込みしてください。');
          }
          const updates = [];
          for (const item of preview.profiles) {
            const entry = entries.find(e => e.project.id === item.projectId);
            const latest = await options.storage.getProject(item.projectId);
            if (!latest || latest.updatedAt !== entry.project.updatedAt) throw new Error('プレビュー後に更新されたデータがあります。設定を閉じて再読み込みしてください。');
            const currentRasters = await global.Normalization.loadRasters(latest, {storage:options.storage});
            if (global.Normalization.fingerprint(latest, currentRasters) !== item.normalization.rawFingerprint) throw new Error('生値が変更されています。プレビューからやり直してください。');
            const project = Object.assign({}, latest, {
              normalization:item.normalization,
              valueDisplay:{mode:'normalized',scale:'common'},
              otsu:Object.assign({}, latest.otsu || {}, {applied:false,sourceKeys:item.normalization.otsuSourceKeys,strength:0,manualThreshold:null})
            });
            if (scoped) project.normalizationBinding = {groupId:activeGroup.groupId, folderPath:activeGroup.path.slice(), memberId:Scope.memberId(entry.project)};
            updates.push({project,expectedUpdatedAt:latest.updatedAt});
          }
          // Catch a remote-only membership change during per-project verification;
          // the transaction guard independently covers concurrent local changes.
          if (scoped) await checkScope(mergedGuard);
          assertProfileRevision(preview.profiles[0].normalization.id, preview.profiles[0].normalization.revision);
          saved = await options.storage.putProjectsIfUnchanged(updates, scoped ? Object.assign({}, localGuard,
            {groupId:activeGroup.groupId}, activeGroup.reassignGroupId ? {reassignGroupId:true} : {}) : undefined);
          cloudPending = new Set(saved.map(p => p.id));
          saved.forEach(p => { const entry = entries.find(e=>e.project.id===p.id); entry.project = p; });
          setBusy(false, saved.length + ' 件をこの PC に保存しました。クラウドへの同期はまだ行っていません。');
          form.querySelector('#normalization-save').disabled = true;
          form.querySelector('#normalization-cloud').disabled = !options.saveCloud;
          if (options.onSaved) await options.onSaved(saved);
        } catch (e) { setBusy(false); error(e); }
      };
      form.querySelector('#normalization-cloud').onclick = async () => {
        if (!saved || busy || !options.saveCloud) return;
        setBusy(true, 'クラウドに保存中…');
        const failures = [];
        const pending = saved.filter(p => cloudPending.has(p.id));
        for (let i=0;i<pending.length;i++) {
          status.textContent = (i+1) + '/' + pending.length + ' ' + pending[i].displayName;
          try { await options.saveCloud(pending[i]); cloudPending.delete(pending[i].id); }
          catch (e) { failures.push(pending[i].displayName + ': ' + e.message); }
        }
        const successes = saved.length - cloudPending.size;
        setBusy(false, 'クラウド同期 ' + successes + '/' + saved.length + ' 件。' + (failures.length ? '\n同じプロファイルの同期が未完了です。異なる revision を混ぜて比較しないでください。\n' + failures.join('\n') : '\nすべて同じプロファイル・revision の保存を確認しました。'));
        form.querySelector('#normalization-cloud').disabled = !failures.length;
        if (options.onSaved) await options.onSaved(saved);
      };
    }

    function renderSimpleConfiguration(switched) {
      const N = global.Normalization;
      const existing = entries.map(e => e.project.normalization).filter(Boolean);
      // Per-section mappings, rasters and coefficients legitimately differ.
      // The shared scientific settings must agree before seeding a group form.
      const sharedSignature = p => N.stableStringify(Object.fromEntries([
        'schemaVersion','methodVersion','mode','id','revision','scope','batchId','prepId','quality','validationEvidence',
        'coordinateMatchConfirmed','comparabilityConfirmed','qc','reference','calibration','commonRanges','invalidated'
      ].map(key => [key,p[key]])));
      const same = existing.length === entries.length && existing.every(p => p.schemaVersion === 3 && p.id === existing[0].id &&
        p.revision === existing[0].revision && p.scope && p.scope.groupId === activeGroup.groupId && sharedSignature(p) === sharedSignature(existing[0]));
      const prior = same ? existing[0] : null, seed = prior || {};
      let replacementConfirmed = !!switched, advancedChanged = seed.mode === 'advanced';
      const mixed = existing.length > 0 && !same;
      const suggestions = entries.map(entry => N.suggestSimpleMapping(entry.project, entry.rasters));
      const input = (name, label, value, type) => '<label style="display:block;margin:8px 0;font-size:13px">' + label +
        '<input name="' + name + '" type="' + (type || 'text') + '" ' + (type === 'number' ? 'step="any" ' : '') +
        'value="' + esc(value == null ? '' : value) + '" style="border:1px solid #94a3b8;padding:5px;display:block;width:100%"></label>';
      const numeric = entry => (entry.project.molecules || []).filter(m => entry.rasters[m.key] && entry.rasters[m.key].values);
      const selectedKeys = entries.map((entry, i) => prior ? (entry.project.normalization.targets || []).map(t => t.key) : suggestions[i].targetKeys);
      function mapSelect(entry, name, selectedKey, emptyText, unresolved) {
        return '<select name="' + name + '" style="max-width:200px;border:1px solid #94a3b8;padding:5px">' +
          (unresolved ? '<option value="__unresolved__" selected>候補を確認して選択</option>' : '') +
          '<option value="" ' + (!unresolved && !selectedKey ? 'selected' : '') + '>' + esc(emptyText) + '</option>' + numeric(entry).map(m =>
            '<option value="' + esc(m.key) + '" ' + (selectedKey === m.key ? 'selected' : '') + '>' + esc(m.name || m.key) + '</option>').join('') + '</select>';
      }
      const hasAmbiguity = suggestions.some(s => (s.issues || []).length);
      body.innerHTML = '<div data-configuration-folder="' + esc(activeGroup.folderId) + '" style="padding:10px;background:#eff6ff;margin:12px 0"><strong>' + esc(activeGroup.label) + '</strong> ／ 対象 ' + entries.length +
        '件（子フォルダーを含む全件）<button class="btn" type="button" id="normalization-back" style="margin-left:12px">別のグループを選ぶ</button></div>' +
        '<p id="normalization-destination" style="font-size:13px">保存先：この PC' + (options.saveCloud ? ' ＋ クラウド（自動同期）' : '') + '</p>' +
        (mixed ? '<p id="normalization-replacement" style="background:#fffbeb;padding:8px;font-size:13px">従来形式・異なる設定・未設定のデータが含まれます。実行時に全 ' + entries.length + '件を同じ新しい設定へ置き換えます。</p>' : '') +
        '<form id="normalization-simple-form"><details id="normalization-mapping" ' + (hasAmbiguity && !prior ? 'open ' : '') + 'style="margin:12px 0"><summary>内部標準：d4-5-HT ／ 分子対応を確認</summary>' +
        '<table style="font-size:13px;width:100%;text-align:left"><thead><tr><th>データ</th><th>内部標準</th><th>画素比にする5-HT</th></tr></thead><tbody>' +
        entries.map((entry, i) => {
          const mapping = prior ? entry.project.normalization.mapping : {d4:suggestions[i].standardKey,ht:suggestions[i].htKey};
          const issues = prior ? [] : suggestions[i].issues || [];
          return '<tr data-simple-project="' + esc(entry.project.id) + '"><td style="padding:6px">' + esc(entry.project.displayName || entry.project.id) +
            '<small style="display:block">' + esc(projectPath(entry.project)) + '</small></td><td>' + mapSelect(entry, 'standard_' + i, mapping.d4, '内部標準を指定', issues.includes('D4_AMBIGUOUS')) +
            '</td><td>' + mapSelect(entry, 'ht_' + i, mapping.ht, '画素比の5-HTなし', issues.includes('HT_AMBIGUOUS')) + '</td></tr>';
        }).join('') + '</tbody></table></details>' +
        '<details id="normalization-targets" style="margin:12px 0"><summary>補正対象の分子を確認（合計 ' + selectedKeys.reduce((sum, keys) => sum + keys.length, 0) + ' レイヤー）</summary>' +
        entries.map((entry, i) => '<p style="font-size:13px"><strong>' + esc(entry.project.displayName || entry.project.id) + '</strong>：<span data-target-summary="' + i + '">' +
          numeric(entry).filter(m => selectedKeys[i].includes(m.key)).map(m => esc(m.name || m.key)).join('、') + '</span></p>').join('') + '</details>' +
        '<details id="normalization-simple-advanced" style="border:1px solid #cbd5e1;padding:10px;margin:12px 0"><summary>詳細設定（任意）</summary>' +
        '<p style="font-size:12px">既定では d4 の実測領域の中央値を使い、全切片を固定基準にします。実験条件の ID・版番号の手入力は不要です。</p>' +
        '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px">' +
        input('batchId','測定・散布バッチ ID（任意）',seed.batchId) + input('prepId','前処理・誘導体化条件 ID（任意）',seed.prepId) +
        input('minD4','d4 最小信号（以下を除外）',seed.qc ? seed.qc.minD4 : 0,'number') +
        input('saturationD4','d4 飽和境界（空欄：飽和未確認）',seed.qc && seed.qc.saturationD4,'number') +
        input('minCoverage','最低有効率 0–1',seed.qc ? seed.qc.minCoverage : 0.8,'number') + '</div>' +
        '<label style="display:block;font-size:13px;margin:8px 0"><input name="enforceCoverage" type="checkbox" ' + (seed.qc && seed.qc.enforceCoverage ? 'checked' : '') + '> 基準領域・ROI が最低有効率を下回る場合は算出しない</label>' +
        '<label style="display:block;font-size:13px;margin:8px 0"><input name="comparability" type="checkbox" ' + (seed.comparabilityConfirmed ? 'checked' : '') + '> 測定・散布・前処理条件の比較可能性を確認した</label>' +
        '<label style="display:block;font-size:13px;margin:8px 0"><input name="coordinateMatch" type="checkbox" ' + (seed.coordinateMatchConfirmed ? 'checked' : '') + '> 同一切片・同一測定の座標対応を確認した</label>' +
        '<label style="display:block;font-size:13px">係数の根拠 <select name="quality"><option value="provisional">暫定</option><option value="validated">妥当性を実験で検証済み</option></select></label>' +
        input('validationEvidence','測定差への適用を検証した資料・QC ID（検証済みの場合）',seed.validationEvidence) +
        '<label style="display:block;font-size:13px">基準領域 <select name="referenceKind"><option value="d4_measured">d4 実測領域（既定）</option><option value="qc">共通 QC</option><option value="roi">対応する解剖学的 ROI</option><option value="whole_tissue">全測定領域</option></select></label>' +
        '<label style="display:block;font-size:13px;margin:8px 0">固定基準 ROI 名（1行に1名）<textarea name="roiNames" rows="2" style="display:block;width:100%">' + esc((seed.reference && seed.reference.roiNames || []).join('\n')) + '</textarea></label>' +
        '<p style="font-size:13px;font-weight:700">固定基準と補正対象</p>' + entries.map((entry, i) => '<fieldset style="margin:10px 0;padding:8px;border:1px solid #cbd5e1"><legend>' + esc(entry.project.displayName || entry.project.id) + '</legend>' +
          '<label><input type="checkbox" name="simple_ref_' + i + '" ' + (!prior || (seed.reference.projectIds || []).includes(Scope.memberId(entry.project)) ? 'checked' : '') + '> 固定基準に含める</label><div style="margin-top:8px">' +
          numeric(entry).map((m, j) => '<label style="display:inline-block;margin:4px 12px 4px 0"><input name="target_' + i + '_' + j + '" type="checkbox" data-target-entry="' + i + '" data-target-key="' + esc(m.key) + '" ' +
            (selectedKeys[i].includes(m.key) ? 'checked ' : '') + '> ' + esc(m.name || m.key) + '</label>').join('') + '</div></fieldset>').join('') +
        '<details style="margin:12px 0"><summary>5-HT 絶対定量の検量線（任意）</summary><label style="display:block;margin:8px 0"><input name="calibrationEnabled" type="checkbox"> 検証済み検量線を登録する</label>' +
        '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px">' + input('calibrationId','検量線 ID','') + input('unit','出力単位','') +
        input('slope','傾き a','','number') + input('intercept','切片 b','','number') + input('lloq','定量下限 LLOQ','','number') + input('uloq','定量上限 ULOQ','','number') +
        input('responseMin','応答 R 下限','','number') + input('responseMax','応答 R 上限','','number') + '</div>' +
        '<label>応答集計 <select name="responseAggregation"><option value="mean_pixel_ratio">画素ごとの比の平均</option><option value="ratio_of_sums">信号総和の比</option></select></label>' +
        input('calibrationSource','検量線・検証結果の出典','') + '<label style="display:block"><input type="checkbox" name="calibrationConfirmed"> この単位・集計方式・測定条件での検量線の妥当性を確認した</label></details>' +
        '<button class="btn" type="button" id="normalization-simple-preview">保存前にプレビュー</button> ' +
        (!existing.some(p => p.schemaVersion === 3) ? '<button class="btn" type="button" id="normalization-use-detailed">従来の詳細設定で開く</button>' : '') + '</details>' +
        '<details style="margin:12px 0"><summary>表示設定：Otsu の入力分子</summary><p style="font-size:12px">補正・ROI集計には影響しません。未選択なら OFF。内部標準は使いません。</p>' +
        entries.map((entry,i) => '<fieldset style="margin:8px 0"><legend>' + esc(entry.project.displayName || entry.project.id) + '</legend>' + numeric(entry).map((m,j) =>
          '<label style="display:inline-block;margin:4px 12px 4px 0"><input type="checkbox" name="simple_otsu_' + i + '_' + j + '" data-otsu-entry="' + i + '" data-otsu-key="' + esc(m.key) + '" ' +
          (prior && (entry.project.normalization.otsuSourceKeys || []).includes(m.key) ? 'checked ' : '') + '> ' + esc(m.name || m.key) + '</label>').join('') + '</fieldset>').join('') + '</details>' +
        '<button class="btn btn-primary" type="submit" id="normalization-simple-apply">このフォルダーを補正</button> ' +
        '<button class="btn" type="button" id="normalization-simple-cloud" disabled>クラウドの未完了分を再試行</button>' +
        '<div id="normalization-simple-result" style="margin:16px 0;overflow:auto"></div></form>';
      const form = body.querySelector('#normalization-simple-form');
      const result = form.querySelector('#normalization-simple-result');
      form.elements.quality.value = seed.quality || 'provisional';
      form.elements.referenceKind.value = seed.reference && seed.reference.kind || 'd4_measured';
      if (seed.calibration) {
        form.elements.calibrationEnabled.checked = true;
        form.elements.calibrationConfirmed.checked = !!seed.calibration.validated;
        for (const [field,key] of Object.entries({calibrationId:'id',unit:'unit',slope:'slope',intercept:'intercept',lloq:'lloq',uloq:'uloq',responseMin:'responseMin',responseMax:'responseMax',responseAggregation:'responseAggregation',calibrationSource:'source'})) form.elements[field].value = seed.calibration[key] == null ? '' : seed.calibration[key];
      }
      function updateSelections() {
        let total = 0;
        entries.forEach((entry,i) => {
          const standard = form.elements['standard_' + i].value;
          const excluded = new Set(suggestions[i].excludedKeys || []);
          if (standard && standard !== '__unresolved__') excluded.add(standard);
          form.querySelectorAll('[data-target-entry="' + i + '"],[data-otsu-entry="' + i + '"]').forEach(el => {
            el.disabled = excluded.has(el.dataset.targetKey || el.dataset.otsuKey);
            if (el.disabled) el.checked = false;
          });
          const selected = [...form.querySelectorAll('[data-target-entry="' + i + '"]:checked')].map(el => el.dataset.targetKey);
          total += selected.length;
          form.querySelector('[data-target-summary="' + i + '"]').textContent = numeric(entry).filter(m => selected.includes(m.key)).map(m=>m.name || m.key).join('、') || '選択なし';
        });
        form.querySelector('#normalization-targets > summary').textContent = '補正対象の分子を確認（合計 ' + total + ' レイヤー）';
      }
      updateSelections();
      form.addEventListener('change', event => {
        if (event.target.closest('#normalization-simple-advanced')) advancedChanged = true;
        updateSelections(); preview = null;
        if (!saved) result.textContent = '';
        form.querySelector('#normalization-simple-apply').disabled = false;
      });
      form.addEventListener('input', () => { preview = null; form.querySelector('#normalization-simple-apply').disabled = false; });
      const legacy = body.querySelector('#normalization-use-detailed');
      if (legacy) legacy.onclick = () => { if (!busy) renderDetailedConfiguration(); };
      body.querySelector('#normalization-back').onclick = async () => {
        if (busy) return;
        setBusy(true, '補正グループを再確認中…');
        try {
          await refreshState(); entries = []; preview = null; saved = null; mergedGuard = null; localGuard = null;
          // Returning to the picker does not immediately reload the same folder.
          currentFolderId = null;
          setBusy(false, '補正グループを選択してください。'); renderGroupSelection();
        } catch (e) { setBusy(false); error(e); }
      };
      function configFromForm() {
        const currentProfile = saved && saved[0] && saved[0].normalization || prior;
        const matching = currentProfile && !activeGroup.reassignGroupId;
        const known = allProjects.flatMap(p => [p.normalization,p.__row && p.__row.state && p.__row.state.normalization]).concat(entries.map(e=>e.project.normalization)).filter(Boolean);
        const id = matching ? currentProfile.id : options.storage.uid('d4');
        const revision = 1 + Math.max(0, ...known.filter(p=>p.id === id).map(p=>Number(p.revision) || 0));
        const config = {id,revision,mode:advancedChanged ? 'advanced' : 'simple',
          batchId:form.elements.batchId.value.trim(),prepId:form.elements.prepId.value.trim(),quality:form.elements.quality.value,validationEvidence:form.elements.validationEvidence.value.trim(),
          coordinateMatchConfirmed:form.elements.coordinateMatch.checked,comparabilityConfirmed:form.elements.comparability.checked,
          qc:{minD4:numberField(form,'minD4'),saturationD4:numberField(form,'saturationD4',true),minCoverage:numberField(form,'minCoverage'),enforceCoverage:form.elements.enforceCoverage.checked},
          reference:{kind:form.elements.referenceKind.value,projectIds:[],roiNames:form.elements.roiNames.value.split('\n').map(v=>v.trim()).filter(Boolean)},
          scope:{type:'folder-depth',depth:2,includeDescendants:true,groupId:activeGroup.groupId,folderPath:activeGroup.path.slice(),memberIds:entries.map(e=>Scope.memberId(e.project)).sort()},
          otsuSourceKeys:{},calibration:null};
        if (config.qc.minD4 < 0 || config.qc.minCoverage <= 0 || config.qc.minCoverage > 1 || (config.qc.saturationD4 != null && config.qc.saturationD4 <= config.qc.minD4)) throw new Error('QC 境界が不正です。最小信号≥0、有効率>0かつ≤1、飽和境界>最小信号にしてください。');
        if (['d4_measured','whole_tissue'].includes(config.reference.kind)) config.reference.roiNames = [];
        entries.forEach((entry,i) => {
          const standardKey = form.elements['standard_' + i].value, htKey = form.elements['ht_' + i].value;
          if (!standardKey || standardKey === '__unresolved__') throw new Error((entry.project.displayName || entry.project.id) + '：内部標準の d4-5-HT を指定してください。');
          if (htKey === '__unresolved__') throw new Error((entry.project.displayName || entry.project.id) + '：5-HT の候補を確認して選択してください。');
          entry.simpleMapping = {standardKey,htKey:htKey || null,targetKeys:[...form.querySelectorAll('[data-target-entry="' + i + '"]:checked')].map(el=>el.dataset.targetKey)};
          if (form.elements['simple_ref_' + i].checked) config.reference.projectIds.push(entry.project.id);
          config.otsuSourceKeys[entry.project.id] = [...form.querySelectorAll('[data-otsu-entry="' + i + '"]:checked')].map(el=>el.dataset.otsuKey);
        });
        if (!config.reference.projectIds.length) throw new Error('固定基準データを少なくとも 1 件選択してください。');
        if (config.reference.kind === 'roi' && !config.reference.roiNames.length) throw new Error('固定基準 ROI 名を指定してください。');
        if (form.elements.calibrationEnabled.checked) {
          if (!config.batchId || !config.prepId || !config.comparabilityConfirmed || !config.coordinateMatchConfirmed || !form.elements.calibrationConfirmed.checked || config.qc.saturationD4 == null) throw new Error('絶対定量には測定・前処理 ID、条件・座標・検量線の確認、d4 飽和境界が必要です。');
          const c = {id:textField(form,'calibrationId'),model:'linear',slope:numberField(form,'slope'),intercept:numberField(form,'intercept'),unit:textField(form,'unit'),lloq:numberField(form,'lloq'),uloq:numberField(form,'uloq'),responseMin:numberField(form,'responseMin'),responseMax:numberField(form,'responseMax'),responseAggregation:form.elements.responseAggregation.value,validated:true,source:textField(form,'calibrationSource'),batchId:config.batchId,prepId:config.prepId};
          if (c.slope <= 0 || c.lloq < 0 || c.uloq <= c.lloq || c.responseMin >= c.responseMax) throw new Error('検量線の傾き・定量限界・応答範囲が不正です。');
          config.calibration = c;
        }
        assertProfileRevision(config.id,config.revision);
        return config;
      }
      async function checkLoadedState() {
        await checkScope(mergedGuard);
        if (!Scope.equalsSnapshot(localGuard,await readLocalGuard())) throw new Error('読み込み後にフォルダー構成が変更されました。設定を閉じて再読み込みしてください。');
        for (const entry of entries) {
          const latest = await options.storage.getProject(entry.project.id);
          if (!latest || latest.updatedAt !== entry.project.updatedAt) throw new Error('読み込み後に更新されたデータがあります。設定を閉じて再読み込みしてください。');
        }
      }
      async function calculate() {
        await checkLoadedState();
        const config = configFromForm();
        await new Promise(resolve => setTimeout(resolve,0));
        preview = N.createSimpleProfiles(entries,config);
        const reason = codes => (codes || []).map(N.reasonText).join(' / ');
        result.innerHTML = '<p>対象 ' + entries.length + '件 ／ 係数算出可能 ' + preview.preview.filter(row=>Number.isFinite(row.k)).length + '件</p>' +
          '<table style="width:100%;font-size:12px;text-align:left;border-collapse:collapse"><thead><tr><th>データ</th><th>d4 中央値</th><th>共通基準</th><th>係数</th><th>補正値・有効画素</th></tr></thead><tbody>' +
          preview.preview.map(row=>'<tr data-simple-output="' + esc(row.projectId) + '"><td style="padding:8px;border-top:1px solid #cbd5e1">' + esc(row.name || row.projectId) + '</td><td>' + fmt(row.Ds) + '</td><td>' + fmt(row.Dref) + '</td><td>' + fmt(row.k) +
            '</td><td>' + (row.correctedOutputs || []).map(ch=>'<div>' + esc(ch.name || ch.key) + '：' + ch.nValid + ' / ' + ch.nMeasured + '画素' + (ch.nValid < ch.nMeasured ? '（一部画素から算出）' : '') + (ch.nValid ? '' : ' ／ ' + esc(reason(ch.reasonCodes))) + '</div>').join('') +
            (!Number.isFinite(row.k) ? '<div style="color:#b91c1c">' + esc(reason(row.reasonCodes)) + '</div>' : '') + '</td></tr>').join('') + '</tbody></table>' +
          '<p style="font-size:12px">生値は保持します。' + (config.qc.enforceCoverage ? '基準領域・ROI の最低有効率を適用します。' : '有効画素がある ROI は、その画素から平均・SDを算出し、有効率を併記します。') + (config.qc.saturationD4 == null ? ' 飽和未確認の相対補正です。' : '') + '</p>' +
          (!preview.canSave ? '<p id="normalization-simple-blocked" style="color:#b91c1c">全件の係数と補正値を確認できないため保存できません。対象を自動で減らすことはありません。' + esc(reason(preview.reasonCodes)) + '</p>' : '');
        return preview;
      }
      async function syncSaved() {
        if (!saved || !options.saveCloud || !cloudPending.size) return;
        const failures = [];
        for (const project of saved.filter(p=>cloudPending.has(p.id))) {
          status.textContent = saved.length + ' 件をこの PC に保存済み。クラウド同期中：' + (project.displayName || project.id);
          try { await options.saveCloud(project); cloudPending.delete(project.id); }
          catch (e) { failures.push((project.displayName || project.id) + '：' + (e.message || String(e))); }
        }
        status.textContent = saved.length + ' 件をこの PC に保存しました。クラウド同期 ' + (saved.length - cloudPending.size) + '/' + saved.length + ' 件。' +
          (failures.length ? '\n未完了分は再試行できます。\n' + failures.join('\n') : '\nすべて同じプロファイル・revision の保存を確認しました。');
        status.style.color = failures.length ? '#92400e' : '#1e293b';
        if (options.onSaved) {
          try { await options.onSaved(saved); }
          catch (e) { status.textContent += '\n保存は完了しています。画面の更新に失敗しました：' + (e.message || String(e)); }
        }
      }
      form.querySelector('#normalization-simple-preview').onclick = async () => {
        if (busy) return;
        setBusy(true,'計算結果を確認中…');
        try { await calculate(); setBusy(false,'プレビューのみです。まだ保存されていません。'); }
        catch (e) { setBusy(false); error(e); }
      };
      form.onsubmit = async event => {
        event.preventDefault(); if (busy) return;
        if (mixed && !replacementConfirmed) {
          if (!confirm(activeGroup.label + ' の全 ' + entries.length + '件を新しい簡単設定で再計算します。既存の基準・対象分子・QC条件が変わります。生値は保持します。続けますか？')) return;
          replacementConfirmed = true;
        }
        setBusy(true,'全データの基準・係数・補正値を計算中…');
        try {
          await calculate();
          if (!preview.canSave) { setBusy(false,'補正できないデータがあります。各データの理由を確認してください。既存設定は保持しています。'); return; }
          await checkLoadedState();
          const updates = [];
          for (const item of preview.profiles) {
            const entry = entries.find(e=>e.project.id === item.projectId), latest = await options.storage.getProject(item.projectId);
            if (!latest || latest.updatedAt !== entry.project.updatedAt) throw new Error('計算中にデータが更新されました。設定を閉じて再読み込みしてください。');
            const currentRasters = await N.loadRasters(latest,{storage:options.storage});
            if (N.fingerprint(latest,currentRasters) !== item.normalization.rawFingerprint) throw new Error('生値が変更されています。読み込みからやり直してください。');
            updates.push({expectedUpdatedAt:latest.updatedAt,project:Object.assign({},latest,{normalization:item.normalization,
              normalizationBinding:{groupId:activeGroup.groupId,folderPath:activeGroup.path.slice(),memberId:Scope.memberId(entry.project)},
              valueDisplay:{mode:'normalized',scale:'common'},otsu:Object.assign({},latest.otsu || {},{applied:false,sourceKeys:item.normalization.otsuSourceKeys || [],strength:0,manualThreshold:null})})});
          }
          await checkScope(mergedGuard);
          assertProfileRevision(preview.profiles[0].normalization.id,preview.profiles[0].normalization.revision);
          saved = await options.storage.putProjectsIfUnchanged(updates,Object.assign({},localGuard,{groupId:activeGroup.groupId},activeGroup.reassignGroupId ? {reassignGroupId:true} : {}));
          cloudPending = new Set(options.saveCloud ? saved.map(p=>p.id) : []);
          saved.forEach(p=>{ entries.find(e=>e.project.id === p.id).project = p; });
          activeGroup.previousGroupId = activeGroup.groupId; activeGroup.reassignGroupId = false;
          // The transaction is already committed. A failed list refresh or UI
          // callback must not erase that success or prevent retrying cloud writes.
          status.textContent = saved.length + ' 件をこの PC に保存しました。';
          const refreshWarnings = [];
          try { await refreshState(); mergedGuard = Scope.snapshot(allProjects,folders,activeGroup.folderId); localGuard = await readLocalGuard(); }
          catch (e) { mergedGuard = null; localGuard = null; refreshWarnings.push('対象一覧を再確認できませんでした。再計算する場合は設定を開き直してください：' + (e.message || String(e))); }
          if (options.onSaved) {
            try { await options.onSaved(saved); }
            catch (e) { refreshWarnings.push('保存は完了しています。画面の更新に失敗しました：' + (e.message || String(e))); }
          }
          await syncSaved();
          if (refreshWarnings.length) status.textContent += '\n' + refreshWarnings.join('\n');
          setBusy(false);
          form.querySelector('#normalization-simple-apply').disabled = true;
          form.querySelector('#normalization-simple-cloud').disabled = !cloudPending.size;
        } catch (e) { setBusy(false); error(e); form.querySelector('#normalization-simple-cloud').disabled = !cloudPending.size; }
      };
      form.querySelector('#normalization-simple-cloud').onclick = async () => {
        if (busy || !saved || !cloudPending.size) return;
        setBusy(true,'クラウドの未完了分を再試行中…');
        try { await syncSaved(); } catch (e) { error(e); }
        finally { setBusy(false); form.querySelector('#normalization-simple-cloud').disabled = !cloudPending.size; }
      };
    }

    function assertProfileRevision(id, revision) {
      const knownProfiles = allProjects.flatMap(p => [p.normalization, p.__row && p.__row.state && p.__row.state.normalization, p.__row && p.__row.meta && p.__row.meta.normalization])
        .concat(entries.map(e=>e.project.normalization)).filter(Boolean);
      if (knownProfiles.some(p=>p.id === id && Number(p.revision)>=revision)) throw new Error('同じプロファイル ID には全登録データの前版より大きい revision を指定してください。');
      if (scoped && knownProfiles.some(p => p.id === id && (p.scope && p.scope.groupId || p.groupId || null) !== activeGroup.groupId)) throw new Error('別の補正グループ・従来形式で使われているプロファイル ID です。このフォルダー用の新しい ID を指定してください。');
    }

    function readConfiguration(form, prior) {
      if (!form.elements.comparability.checked) throw new Error('分子・座標・測定条件の確認チェックが必要です。');
      const config = {
        id:textField(form,'profileId'), revision:numberField(form,'revision'), batchId:textField(form,'batchId'),prepId:textField(form,'prepId'),
        quality:form.elements.quality.value, validationEvidence:form.elements.validationEvidence.value.trim(),
        coordinateMatchConfirmed:true, comparabilityConfirmed:true,
        qc:{minD4:numberField(form,'minD4'),saturationD4:numberField(form,'saturationD4',true),minCoverage:numberField(form,'minCoverage')},
        reference:{kind:form.elements.referenceKind.value,projectIds:[],roiNames:form.elements.roiNames.value.split('\n').map(v=>v.trim()).filter(Boolean)},
        otsuSourceRoles:['ht','da','ne'].filter(role=>form.elements['otsu_'+role].checked), calibration:null
      };
      if (config.reference.kind === 'whole_tissue') config.reference.roiNames = [];
      if (!Number.isInteger(config.revision) || config.revision<1) throw new Error('revision は正の整数です。');
      if (scoped) config.scope = {type:'folder-depth',depth:2,includeDescendants:true,groupId:activeGroup.groupId,
        folderPath:activeGroup.path.slice(), memberIds:entries.map(e => Scope.memberId(e.project)).sort()};
      assertProfileRevision(config.id, config.revision);
      if (config.quality==='validated' && !config.validationEvidence) throw new Error('検証済みには妥当性を確認した資料・QC ID が必要です。');
      if (config.qc.minD4<0 || config.qc.minCoverage<=0 || config.qc.minCoverage>1 || (config.qc.saturationD4!=null && config.qc.saturationD4<=config.qc.minD4)) throw new Error('QC 境界が不正です。最小信号≥0、有効率>0かつ≤1、飽和境界>最小信号にしてください。');
      entries.forEach((entry,index) => {
        entry.mapping = {};
        roles.forEach(([role]) => { entry.mapping[role] = form.elements['map_'+index+'_'+role].value || null; });
        if (form.elements['ref_'+index].checked) config.reference.projectIds.push(entry.project.id);
      });
      if (!config.reference.projectIds.length) throw new Error('固定基準データを少なくとも 1 件選択してください。');
      if (config.reference.kind==='roi' && !config.reference.roiNames.length) throw new Error('対応する固定基準 ROI 名を指定してください。');
      if (form.elements.calibrationEnabled.checked) {
        if (!form.elements.calibrationConfirmed.checked) throw new Error('検量線の条件と妥当性の確認チェックが必要です。');
        const c = {id:textField(form,'calibrationId'),model:'linear',slope:numberField(form,'slope'),intercept:numberField(form,'intercept'),unit:textField(form,'unit'),
          lloq:numberField(form,'lloq'),uloq:numberField(form,'uloq'),responseMin:numberField(form,'responseMin'),responseMax:numberField(form,'responseMax'),
          responseAggregation:form.elements.responseAggregation.value,validated:true,source:textField(form,'calibrationSource'),batchId:config.batchId,prepId:config.prepId};
        if (c.slope<=0 || c.lloq<0 || c.uloq<=c.lloq || c.responseMin>=c.responseMax) throw new Error('検量線の傾き／定量限界／応答範囲が不正です。');
        config.calibration = c;
      }
      return config;
    }
    dialog.showModal();
  }
  global.NormalizationUI = {open};
})(window);
