/* Master-only setup workflow. No scientific defaults are inferred from filenames or a cohort.
 * Raw rasters are read for preview; only confirmed immutable profiles are written.
 */
(function (global) {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = v => Number.isFinite(v) ? Number(v).toPrecision(6) : '—';
  const roles = [['ht','5-HT'], ['d4','d4-5-HT'], ['da','DA'], ['ne','NE']];
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
    dialog.innerHTML = '<h2 id="normalization-title" style="font-size:20px;font-weight:700">補正・正規化の設定</h2>' +
      '<p style="font-size:13px;margin:10px 0">生値は変更しません。5-HT は d4-5-HT との画素比、DA・NE は同じ切片係数で正規化します。' +
      '検量線がない場合、5-HT の絶対定量は利用できません。</p>' +
      '<p style="background:#fffbeb;padding:10px;font-size:13px">設定前に対象データの Viewer を閉じてください。' +
      '全データを自動で同一測定バッチにはしません。異なるバッチ間は直接比較できません。' +
      'd4 の散布量だけの差や分子固有のイオン化差は、この係数だけでは補正できません。</p>' +
      '<div id="normalization-body"></div><p id="normalization-status" style="white-space:pre-wrap;font-size:13px;margin:12px 0" role="status"></p>' +
      '<button type="button" class="btn" id="normalization-close">閉じる</button>';
    document.body.appendChild(dialog);
    const body = dialog.querySelector('#normalization-body');
    const status = dialog.querySelector('#normalization-status');
    let busy = false, entries = [], preview = null, saved = null;
    const close = () => { if (!busy) { dialog.close(); dialog.remove(); if (options.onClose) options.onClose(); } };
    dialog.querySelector('#normalization-close').onclick = close;
    dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
    dialog.addEventListener('click', e => { if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
    }});
    function setBusy(on, message) {
      if (message != null) status.textContent = message;
      if (busy === on) return;
      busy = on;
      dialog.querySelectorAll('button,input,select,textarea').forEach(el => {
        if (on) { el.dataset.prevDisabled = el.disabled ? '1' : '0'; el.disabled = true; }
        else { el.disabled = el.dataset.prevDisabled === '1'; delete el.dataset.prevDisabled; }
      });
    }
    function error(e) { status.textContent = e && e.message ? e.message : String(e); status.style.color = '#b91c1c'; }
    const selected = new Set(options.selectedIds || []);
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
        entries = [];
        for (let i = 0; i < rows.length; i++) {
          status.textContent = (i + 1) + '/' + rows.length + ' ' + (rows[i].displayName || rows[i].id);
          const project = await options.loadProject(rows[i]);
          const rasters = await global.Normalization.loadRasters(project, {storage:options.storage});
          entries.push({project, rasters, mapping:global.Normalization.suggestMapping(project.molecules || [])});
        }
        setBusy(false, '分子の自動候補を確認し、基準データと条件を指定してください。');
        renderConfiguration();
      } catch (e) { setBusy(false); error(e); }
    };

    function renderConfiguration() {
      const existing = entries.map(e => e.project.normalization).filter(Boolean);
      const same = existing.length === entries.length && existing.every(p => p.id === existing[0].id && p.revision === existing[0].revision);
      const prior = same ? existing[0] : null;
      const seed = prior || {};
      entries.forEach(e => { if (prior) e.mapping = Object.assign({}, e.project.normalization.mapping); });
      function input(name, label, value, type) {
        return '<label style="display:block;margin:8px 0;font-size:13px">' + label +
          '<input name="' + name + '" type="' + (type || 'text') + '" ' + (type === 'number' ? 'step="any" ' : '') +
          'value="' + esc(value == null ? '' : value) + '" style="border:1px solid #94a3b8;padding:5px;display:block;width:100%"></label>';
      }
      const mapRows = entries.map((entry, index) => '<tr><td style="padding:6px">' + esc(entry.project.displayName) + '</td>' +
        '<td style="text-align:center"><input type="checkbox" name="ref_' + index + '" ' +
          (prior && prior.reference && (prior.reference.projectIds || []).includes(entry.project.id) ? 'checked' : '') + '></td>' +
        roles.map(([role]) => '<td><select name="map_' + index + '_' + role + '" style="max-width:160px;border:1px solid #94a3b8;padding:4px">' +
          '<option value="">未指定／存在しない</option>' + (entry.project.molecules || []).map(m => '<option value="' + esc(m.key) + '" ' +
            (entry.mapping[role] === m.key ? 'selected' : '') + '>' + esc(m.name || m.key) + '</option>').join('') + '</select></td>').join('') + '</tr>').join('');
      body.innerHTML = '<form id="normalization-form"><h3 style="font-weight:700;margin:16px 0 8px">2. 条件・固定基準・分子対応</h3>' +
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
        preview = null; saved = null;
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
          const config = readConfiguration(form, prior);
          setBusy(true, '固定基準・係数・共通表示レンジを計算中…');
          await new Promise(resolve => setTimeout(resolve, 0));
          preview = global.Normalization.createProfiles(entries, config);
          setBusy(false, 'プレビューのみです。まだ保存されていません。算出不可・暫定の理由を確認してください。');
          status.style.color = '#1e293b';
          form.querySelector('#normalization-preview-result').innerHTML = '<table style="font-size:12px;width:100%;border-collapse:collapse"><thead><tr>' +
            ['データ','D_s','D_ref','係数 k','有効率','状態／理由'].map(h => '<th style="text-align:left;padding:6px">'+h+'</th>').join('') + '</tr></thead><tbody>' +
            preview.preview.map(p => '<tr>' + [p.name || p.projectId,fmt(p.Ds),fmt(p.Dref),fmt(p.k),Number.isFinite(p.coverage)?(p.coverage*100).toFixed(1)+'%':'—',p.status + ' / ' + (p.reasonCodes || []).map(global.Normalization.reasonText).join(' / ')].map(v=>'<td style="border-top:1px solid #cbd5e1;padding:6px">'+esc(v)+'</td>').join('') + '</tr>').join('') + '</tbody></table>' +
            '<p style="font-size:12px;margin-top:8px">5-HT 絶対値: ' + (config.calibration ?
              config.qc.saturationD4 == null ? 'D4_SATURATION_UNKNOWN：検量線は登録されていますが、d4 の飽和境界が未設定のため算出不可です。信号比は暫定表示できます。' :
              'ROI ごとに有効率・検量線範囲を検証して算出します。' : 'CALIBRATION_MISSING：検量線未登録のため算出不可。信号比の表示は独立して利用できます。') + '</p>' +
            '<p style="font-size:12px">固定共通レンジ: ' + esc(JSON.stringify(preview.profiles[0] && preview.profiles[0].normalization.commonRanges || {})) + '</p>';
          form.querySelector('#normalization-save').disabled = false;
        } catch (e2) { if (busy) setBusy(false); invalidatePreview(); error(e2); }
      };
      form.querySelector('#normalization-save').onclick = async () => {
        if (!preview || busy) return;
        if (!confirm('対象の Viewer を閉じ、プレビューの係数・算出不可の理由を確認しましたか？\n\n生値は変更せず、プロファイルをこの PC に保存します。旧設定の Otsu は OFF に戻します。クラウドには次のボタンで別途保存します。')) return;
        setBusy(true, '変更競合を確認して、この PC に一括保存中…');
        try {
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
            updates.push({project,expectedUpdatedAt:latest.updatedAt});
          }
          saved = await options.storage.putProjectsIfUnchanged(updates);
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
        let successes = 0;
        for (let i=0;i<saved.length;i++) {
          status.textContent = (i+1) + '/' + saved.length + ' ' + saved[i].displayName;
          try { await options.saveCloud(saved[i]); successes++; }
          catch (e) { failures.push(saved[i].displayName + ': ' + e.message); }
        }
        setBusy(false, 'クラウド同期 ' + successes + '/' + saved.length + ' 件。' + (failures.length ? '\n同じプロファイルの同期が未完了です。異なる revision を混ぜて比較しないでください。\n' + failures.join('\n') : '\nすべて同じプロファイル・revision の保存を確認しました。'));
        form.querySelector('#normalization-cloud').disabled = !failures.length;
        if (options.onSaved) await options.onSaved(saved);
      };
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
      const knownProfiles = (options.projects || []).flatMap(p => [p.normalization, p.__row && p.__row.state && p.__row.state.normalization, p.__row && p.__row.meta && p.__row.meta.normalization])
        .concat(entries.map(e=>e.project.normalization)).filter(Boolean);
      if (knownProfiles.some(p=>p.id === config.id && Number(p.revision)>=config.revision)) throw new Error('同じプロファイル ID には全登録データの前版より大きい revision を指定してください。');
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
