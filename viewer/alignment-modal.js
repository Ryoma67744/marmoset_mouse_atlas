/*
 * Two-step HE/MSI alignment. Raw pixels remain the storage coordinate system.
 * The manual orientation frame is immutable during every automatic fit.
 * All edits are modal drafts; persistence is injected by the Viewer.
 */
(function (global) {
  'use strict';
  const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = value => structuredClone(value);
  const fmt = (n, digits = 2) => Number.isFinite(n) ? n.toFixed(digits) : '—';
  const svgNS = 'http://www.w3.org/2000/svg';
  const MAX_ROTATION = 15;
  function fingerprint(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return `${value.length}:${(hash >>> 0).toString(16)}`;
  }

  function open(options) {
    const { heKey, heImg, heSrc, rasters, project, saved, worldCoords, save, formatName } = options;
    const A = global.Align, R = global.AlignmentReference, O = global.AlignmentOrientation;
    if (!O) throw new Error('向きを固定する位置合わせ処理を読み込めませんでした。再読み込みしてください。');
    const keys = Object.keys(rasters);
    const hasCanonical = Object.prototype.hasOwnProperty.call(worldCoords || {}, 'T_he_to_msi');
    const hasSavedMatrix = Object.prototype.hasOwnProperty.call(saved || {}, 'T_he_to_msi');
    const initial = hasCanonical ? worldCoords.T_he_to_msi : saved?.T_he_to_msi;
    if ((hasCanonical || hasSavedMatrix) && !A.validateAffine(initial)) throw new Error('保存された変換行列が無効です。古いパラメータへの置き換えは行いません。元データを確認してください。');
    let T = hasCanonical || hasSavedMatrix ? clone(initial) : A.buildHeToMsiAffine({ ...A.defaultAlignState(), ...(saved || {}) });
    let currentModel = ['affine', 'similarity'].includes(saved?.model) ? saved.model : A.decomposeAffine(T).model, editModel = currentModel;
    let parameterState = null, orientation = null, stage = 1;
    const landmarks = { he: clone(saved?.landmarks?.he || []), msi: clone(saved?.landmarks?.msi || []), excluded: clone(saved?.landmarks?.excluded || []) };
    const originalDraft = { T: clone(T), landmarks: clone(landmarks), model: currentModel };
    const endogenous = R.sourceKeys(project, rasters), storedReference = saved?.reference;
    let referenceMode = ['single', 'rawsum', 'balanced'].includes(storedReference?.mode) ? storedReference.mode : 'single';
    let singleKey = storedReference?.mode === 'single' && storedReference.sourceKeys?.[0]
      ? storedReference.sourceKeys[0] : (keys.includes(options.msiKey0) ? options.msiKey0 : keys[0]);
    let selectedSources = storedReference?.mode !== 'single' && Array.isArray(storedReference?.sourceKeys)
      ? storedReference.sourceKeys.slice() : endogenous.slice();
    const sourceChoices = Array.from(new Set([...endogenous, ...selectedSources]));
    let reference = null, msiBase = null, msiMask = null, heMask = null;
    let heMaskLoaded = false, heMaskTint = null, msiMaskCanvas = null;
    let autoMeta = null, previousAutoMeta = saved?.previousAutoAligned ? clone(saved.previousAutoAligned) : null;
    let selectedPoint = -1, editPair = null, fitStale = false, geometryChanged = false, sourceChanged = false, draftTouched = false;
    let inputValid = true, closed = false, saving = false, busy = false, revision = 0, raf = 0;
    let status = '① HE と MSI の向きを揃えてください。保存済みの位置合わせは、そのまま保持しています。';
    let fitMethod = saved?.fit?.method || 'saved';
    const activeBefore = document.activeElement;
    const view = { he: { zoom: 1, x: 0, y: 0 }, msi: { zoom: 1, x: 0, y: 0 } };
    const source = { heKey, heFingerprint: fingerprint(heSrc), heWidth: heImg.naturalWidth, heHeight: heImg.naturalHeight };
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop alignment-modal';
    backdrop.innerHTML = `
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="alignment-title">
        <div class="align-header"><h3 id="alignment-title">重ね合わせ — ${escapeHtml(formatName(heKey))} → MSI</h3><button data-act="close" aria-label="閉じる">×</button></div>
        <div class="align-stepper" aria-label="位置合わせの手順"><span data-step="1">① 向きを揃える</span><span aria-hidden="true">→</span><span data-step="2">② 対応点をクリックする</span></div>
        <div class="align-reference">
          <div class="align-reference-line"><label>位置合わせの参照 <select data-sel="reference" aria-label="位置合わせの参照"><option value="single">単一分子（原値）</option><option value="rawsum">登録分子の合算（原値）</option><option value="balanced">強度差補正合成（分子ごと P99）</option></select></label><select data-sel="msi" aria-label="参照する単一分子"></select><label><input type="checkbox" data-show-masks> 組織マスクを表示</label></div>
          <details data-source-options><summary>合成に使う分子</summary><div class="align-sources" data-el="sources"></div></details>
          <div class="align-note" data-el="reference-info"></div><div class="align-error" data-el="reference-error" role="status"></div>
        </div>
        <div data-stage-only="1" class="align-orient-toolbar">
          <span>HE の向き：</span><button data-act="orient-flip-lr">左右反転</button><button data-act="orient-flip-ud">上下反転</button><button data-act="orient-left">左へ90°</button><button data-act="orient-right">右へ90°</button>
          <details><summary>傾きの微調整</summary><label>回転 <input type="number" step="1" min="-45" max="45" value="0" data-orient-angle aria-label="HE の傾きの微調整"> °</label> <button data-act="orient-fine">この角度を加える</button></details>
          <div class="align-note">MSI を基準に、HE の上下左右と大まかな傾きを揃えます。画像の中心を保って反転・回転します。位置と大きさは次の段階で合わせます。</div>
        </div>
        <div data-stage-only="2" class="align-pick-guide"><button data-act="orient-back">← 向きを直す</button><strong data-el="pick-guide"></strong><button data-act="edit-cancel" hidden>点の修正を取り消す</button></div>
        <div class="align-panels">
          <div><div class="align-pane-title"><span>HE（確認する向き）</span><span class="align-zoom"><button data-act="zoom-out" data-zoom-pane="he" aria-label="HE 縮小">−</button><button data-act="zoom-reset" data-zoom-pane="he">全体</button><button data-act="zoom-in" data-zoom-pane="he" aria-label="HE 拡大">＋</button></span></div><div class="pick-pane align-viewport" data-pane="he"><div class="align-image-layer" data-layer="he"><img data-img="he" alt="向きを揃える HE 画像" draggable="false"></div></div></div>
          <div><div class="align-pane-title"><span data-el="msi-title">MSI 参照画像</span><span class="align-zoom"><button data-act="zoom-out" data-zoom-pane="msi" aria-label="MSI 縮小">−</button><button data-act="zoom-reset" data-zoom-pane="msi">全体</button><button data-act="zoom-in" data-zoom-pane="msi" aria-label="MSI 拡大">＋</button></span></div><div class="pick-pane align-viewport" data-pane="msi"><div class="align-image-layer" data-layer="msi"><img data-img="msi" alt="基準となる MSI 参照画像" draggable="false"></div></div></div>
          <div data-stage-only="2"><div class="align-pane-title"><span>重ね合わせ・点のずれ</span></div><div class="pick-pane" data-pane="preview"><img data-img="preview" alt="変換後 HE と MSI の重ね合わせ"><svg class="align-residual-svg" data-el="vectors"></svg></div><div class="align-legend">緑：HE 組織　□：HE の点　○：MSI の点　線：ずれ</div></div>
        </div>
        <div class="align-note align-gesture-note">＋ / − またはホイールで拡大・縮小。画像をドラッグすると移動します。対応点はドラッグせずにクリックします。</div>
        <div data-el="status" role="status" aria-live="polite"></div><div class="align-error" data-el="solve-error" role="status"></div>
        <div data-stage-only="1" class="align-next"><button data-act="orient-next">この向きで次へ →</button></div>
        <div data-stage-only="2" class="align-controls">
          <div class="align-point-controls"><div class="align-pane-title"><h4>対応点</h4><span><button data-act="undo">1 組戻す</button> <button data-act="clear">全消去</button></span></div><div data-el="qc"></div><div data-el="report"></div><div class="align-actions"><button data-act="solve">対応点から再計算</button><button data-act="auto">輪郭で位置と大きさを合わせる</button><button data-act="restore">編集開始時に戻す</button></div><div class="align-note">3 組から自動で位置合わせします。組織全体に分散した 4～6 組を目安にしてください。対応点の誤差だけでなく、内部構造も確認してください。</div></div>
          <details class="align-details"><summary>対応点の詳細・点を修正</summary><div data-el="table"></div><div class="align-note">「修正」で、その番号の HE → MSI を選び直します。チェックを外した点は計算に使いません。Δ = 変換後 HE − MSI。</div></details>
          <details class="align-details align-advanced"><summary>詳細設定</summary><div class="align-parameters"><label><span>変換モデル</span><select data-sel="model"><option value="similarity">相似変換（標準）</option><option value="affine">アフィン（縦横差・せん断）</option></select></label><div class="align-note">アフィンは 4 組以上で計算します。自動の反転・180°回転は行いません。向き確定後の角度補正は ±15°までです。</div><label><input type="checkbox" data-allow-rotation> 輪郭合わせで小さな角度補正も許可（±15°）</label><label class="align-tolerance">許容ずれ <input type="number" step="any" min="0" data-tolerance placeholder="未設定"> MSI px</label><details><summary>変換の数値を手動調整</summary><div class="align-note">確定した向きからの補正値です。位置の単位は作業座標です。反転は「向きを直す」で変更します。</div><label data-only-model="similarity"><span>倍率</span><input type="number" step="any" data-p="scale_pct"> %</label><label data-only-model="affine"><span>X 倍率</span><input type="number" step="any" data-p="scale_x_pct"> %</label><label data-only-model="affine"><span>Y 倍率</span><input type="number" step="any" data-p="scale_y_pct"> %</label><label data-only-model="affine"><span>せん断</span><input type="number" step="any" data-p="shear"></label><label><span>角度補正</span><input type="number" step="any" data-p="rotate_deg"> °</label><label><span>X 移動</span><input type="number" step="any" data-p="offx"></label><label><span>Y 移動</span><input type="number" step="any" data-p="offy"></label><div class="align-error" data-el="input-error" role="status"></div></details></div></details>
        </div>
        <div class="align-error" data-el="save-error" role="alert"></div><div class="align-footer"><span class="align-note" data-el="save-hint"></span><button data-act="close">キャンセル</button><button data-act="apply">適用して保存</button></div>
      </div>`;
    document.body.appendChild(backdrop);
    const q = s => backdrop.querySelector(s), all = s => [...backdrop.querySelectorAll(s)];
    const heImage = q('[data-img=he]'), msiImage = q('[data-img=msi]'), previewImage = q('[data-img=preview]');
    const msiSelect = q('[data-sel=msi]');
    keys.forEach(k => msiSelect.add(new Option(formatName(k), k)));
    if (!keys.includes(singleKey)) msiSelect.add(new Option(`${formatName(singleKey)}（データがありません）`, singleKey));
    msiSelect.value = singleKey; q('[data-sel=reference]').value = referenceMode; q('[data-sel=model]').value = editModel;
    if (Number.isFinite(saved?.fit?.tolerancePx)) q('[data-tolerance]').value = saved.fit.tolerancePx;
    q('[data-allow-rotation]').checked = !!(saved?.orientationConstraint?.allowSilhouetteRotation ?? saved?.autoAligned?.allowRotation);
    sourceChoices.forEach(key => {
      const label = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.dataset.sourceKey = key; input.checked = selectedSources.includes(key);
      label.append(input, document.createTextNode(formatName(key))); q('[data-el=sources]').appendChild(label);
    });

    function frameOptions() { return { heWidth: source.heWidth, heHeight: source.heHeight, msiWidth: reference.W, msiHeight: reference.H, hePitch: worldCoords?.he_um_per_px, msiPitch: options.msiPitch || worldCoords?.msi_um_per_px }; }
    function currentSource() { return { ...source, msiWidth: reference.W, msiHeight: reference.H }; }
    function initOrientation() {
      const frames = O.createFrame(frameOptions());
      orientation = { ...frames, confirmed: false, revision: 0, source: currentSource() };
      if (saved?.schemaVersion >= 3 && saved.orientation) {
        try {
          const oldSource = saved.orientation.source || {};
          if (Object.keys(currentSource()).some(key => oldSource[key] !== currentSource()[key])) { sourceChanged = true; throw new Error('画像またはグリッドが変更されています。向きと対応点を確認してください。'); }
          const restored = O.restore(saved.orientation, frames);
          orientation = { ...restored, source: currentSource(), confirmed: !!saved.orientation.confirmed, revision: Number(saved.orientation.revision) || 0 };
          stage = orientation.confirmed ? 2 : 1;
          if (orientation.confirmed && !O.check(T, constraints()).valid) {
            fitStale = true; status = '保存した変換と方向の制約が一致しません。向きと対応点を確認してください。';
          }
          if (orientation.confirmed && saved.fit?.orientationRevision !== orientation.revision) {
            fitStale = true; geometryChanged = true; status = '保存した向きと計算結果の更新番号が一致しません。位置合わせを計算し直してください。';
          }
        } catch (error) {
          fitStale = true; geometryChanged = true;
          status = `向きの再確認が必要です。${error.message}`;
        }
      }
      originalDraft.orientation = clone(orientation); originalDraft.stage = stage; originalDraft.stale = fitStale; originalDraft.sourceChanged = sourceChanged;
    }
    function constraints() { return { he: orientation.he, msi: orientation.msi, model: editModel, maxRotationDeg: MAX_ROTATION }; }
    function includedCount() { return Math.min(landmarks.he.length, landmarks.msi.length) - landmarks.excluded.filter(i => i < Math.min(landmarks.he.length, landmarks.msi.length)).length; }
    function pendingPair() { return !!editPair || landmarks.he.length !== landmarks.msi.length; }
    function expectedPane() { return editPair ? editPair.next : landmarks.he.length > landmarks.msi.length ? 'msi' : 'he'; }
    function canSave() {
      return !saving && !busy && inputValid && !!reference && A.validateAffine(T) && !sourceChanged && !fitStale && !pendingPair()
        && (!draftTouched || (orientation?.confirmed && stage === 2));
    }
    function clearAuto() {
      revision++;
      if (autoMeta) previousAutoMeta = { ...clone(autoMeta), stale: true };
      autoMeta = null;
    }
    function sizePane(which, width, height) {
      const pane = q(`[data-pane=${which}]`), ratio = width / height;
      pane.style.aspectRatio = String(ratio); pane.style.setProperty('--align-pane-vh', `${40 * ratio}vh`); pane.style.setProperty('--align-pane-px', `${440 * ratio}px`);
    }
    function getHeMask() { if (!heMaskLoaded) { heMask = A.heTissueMask(heImg); heMaskLoaded = true; } return heMask; }
    function maskCanvas(mask, color) {
      if (!mask) return null;
      const canvas = document.createElement('canvas'); canvas.width = mask.w; canvas.height = mask.h;
      const ctx = canvas.getContext('2d'), data = ctx.createImageData(mask.w, mask.h);
      for (let i = 0; i < mask.mask.length; i++) if (mask.mask[i]) { data.data[i * 4] = color[0]; data.data[i * 4 + 1] = color[1]; data.data[i * 4 + 2] = color[2]; data.data[i * 4 + 3] = 255; }
      ctx.putImageData(data, 0, 0); return canvas;
    }
    function rawMaskCanvas(mask, W, H) {
      const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      canvas.getContext('2d').drawImage(maskCanvas(mask, [220, 220, 220]), 0, 0, W, H); return canvas;
    }
    function drawFrame(image, frame) {
      // Working coordinates may be measured in physical units. Retain native
      // HE detail independently of those units for accurate zoomed landmarks.
      const canvas = document.createElement('canvas'), edge = Math.min(1800, Math.max(frame.rawWidth, frame.rawHeight)), scale = edge / Math.max(frame.width, frame.height);
      canvas.width = Math.max(1, Math.ceil(frame.width * scale)); canvas.height = Math.max(1, Math.ceil(frame.height * scale));
      const ctx = canvas.getContext('2d'); ctx.scale(canvas.width / frame.width, canvas.height / frame.height);
      const M = frame.matrix; ctx.transform(M[0][0], M[1][0], M[0][1], M[1][1], M[0][2], M[1][2]); ctx.drawImage(image, 0, 0);
      return canvas.toDataURL();
    }
    function sourceRecipe() { return { mode: referenceMode, sourceKeys: referenceMode === 'single' ? [singleKey] : selectedSources.slice() }; }
    function refreshReference(initialLoad = false) {
      clearAuto(); reference = null; msiBase = null; msiMask = null; msiMaskCanvas = null;
      q('[data-el=reference-error]').textContent = ''; q('[data-source-options]').hidden = referenceMode === 'single'; msiSelect.hidden = referenceMode !== 'single';
      try {
        const next = R.build(project, rasters, sourceRecipe());
        if (orientation && (orientation.msi.rawWidth !== next.W || orientation.msi.rawHeight !== next.H)) {
          throw new Error('参照のグリッドが変わっています。対応点の座標を保持するため、元の参照に戻してください。別グリッドは別の位置合わせとして開き直してください。');
        }
        reference = next;
        if (!orientation) initOrientation();
        msiBase = global.MSIRaster.paintRasterToCanvas(reference.values, reference.W, reference.H, { color: null, win: reference.range, gamma: .5 });
        msiMask = A.msiTissueMaskFromValues(reference.values, reference.W, reference.H); msiMaskCanvas = maskCanvas(msiMask, [220, 220, 220]);
        q('[data-el=msi-title]').textContent = referenceMode === 'single' ? formatName(singleKey) : referenceMode === 'balanced' ? '強度差補正合成' : '登録分子の合算';
        q('[data-el=reference-info]').textContent = referenceMode === 'balanced' ? '各分子を P99 で除算し、1 を上限に合算。全分子に共通する有効画素を使用し、内部標準は除外します。全質量域の TIC ではありません。' : referenceMode === 'rawsum' ? '登録分子の原値を合算します。全質量域の TIC ではありません。' : '原値を使用します。Viewer の d4 補正や色範囲とは独立しています。';
        if (!initialLoad) status = '参照画像を変更しました。向きと対応点は保持し、輪郭の評価をリセットしました。';
      } catch (error) { reference = null; q('[data-el=reference-error]').textContent = error.message; }
      renderReferenceImages(); syncParameters(); updateStage(); scheduleRefresh();
    }
    function renderReferenceImages() {
      if (!reference || !msiBase || !orientation) { msiImage.removeAttribute('src'); previewImage.removeAttribute('src'); return; }
      const showMask = q('[data-show-masks]').checked, hm = getHeMask();
      heImage.src = drawFrame(showMask && hm ? rawMaskCanvas(hm, source.heWidth, source.heHeight) : heImg, orientation.he);
      msiImage.src = drawFrame(showMask && msiMask ? rawMaskCanvas(msiMask, reference.W, reference.H) : msiBase, orientation.msi);
      sizePane('he', orientation.he.width, orientation.he.height); sizePane('msi', orientation.msi.width, orientation.msi.height); sizePane('preview', orientation.msi.width, orientation.msi.height);
      updateView('he'); updateView('msi');
      if (showMask && (!hm || !msiMask)) q('[data-el=reference-error]').textContent = '一部の組織マスクを抽出できないため、該当画像は原画像を表示しています。';
      else q('[data-el=reference-error]').textContent = '';
    }
    function updateView(which) {
      const v = view[which]; q(`[data-layer=${which}]`).style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
      q(`[data-layer=${which}]`).querySelectorAll('.pick-dot').forEach(dot => { dot.style.transform = `translate(-50%, -50%) scale(${1 / v.zoom})`; });
      q(`[data-act=zoom-reset][data-zoom-pane=${which}]`).textContent = v.zoom === 1 ? '全体' : `${Math.round(v.zoom * 100)}%`;
    }
    function zoomAt(which, next, x, y) {
      const pane = q(`[data-pane=${which}]`), v = view[which], factor = Math.min(8, Math.max(1, next)) / v.zoom;
      x ??= pane.clientWidth / 2; y ??= pane.clientHeight / 2;
      v.x = x - (x - v.x) * factor; v.y = y - (y - v.y) * factor; v.zoom *= factor;
      if (v.zoom === 1) { v.x = 0; v.y = 0; } updateView(which);
    }
    function updateStage() {
      backdrop.dataset.stage = String(stage);
      all('[data-stage-only]').forEach(el => { el.hidden = Number(el.dataset.stageOnly) !== stage; });
      all('[data-step]').forEach(el => el.classList.toggle('active', Number(el.dataset.step) === stage));
      q('[data-act=edit-cancel]').hidden = !editPair;
      updateGuide(); updateEnabled();
    }
    function updateGuide() {
      const next = expectedPane(), number = editPair ? editPair.i + 1 : Math.min(landmarks.he.length, landmarks.msi.length) + 1;
      q('[data-el=pick-guide]').textContent = `${editPair ? '修正：' : ''}${next === 'he' ? 'HE' : 'MSI'} の点 ${number} をクリックしてください`;
      for (const which of ['he', 'msi']) q(`[data-pane=${which}]`).classList.toggle('active', stage === 2 && next === which);
    }
    function syncParameters() {
      if (!orientation) return;
      const checked = O.check(T, constraints());
      parameterState = A.decomposeAffine(checked.F || O.multiply(orientation.msi.matrix, O.multiply(T, O.invert(orientation.he.matrix))));
      all('[data-only-model]').forEach(el => { el.hidden = el.dataset.onlyModel !== editModel; });
      all('[data-p]').forEach(el => { el.value = Number.isFinite(parameterState[el.dataset.p]) ? String(Number(parameterState[el.dataset.p].toPrecision(12))) : ''; });
      q('[data-sel=model]').value = editModel;
    }
    function updateEnabled() {
      q('[data-act=apply]').disabled = !canSave();
      q('[data-el=save-hint]').textContent = saving ? '保存中…' : busy ? '輪郭を確認中…'
        : !reference ? '参照画像を確認してください。'
          : sourceChanged ? '元画像が変更されています。対応点を全消去して指定し直してください。'
            : pendingPair() ? 'HE と MSI の点の組を完成してください。'
              : !inputValid ? '入力値を確認してください。'
                : fitStale ? '向きと対応点を確認し、位置合わせを計算してください。'
                  : draftTouched && stage !== 2 ? '「この向きで次へ」で確認してください。' : '';
      q('[data-act=orient-next]').disabled = saving || busy || !reference || !inputValid;
      q('[data-act=auto]').disabled = saving || busy || !reference || !orientation?.confirmed || pendingPair() || (includedCount() > 0 && includedCount() < 3);
      q('[data-act=auto]').textContent = busy ? '輪郭を確認中…' : includedCount() >= 3 ? '輪郭の一致を確認する' : '輪郭で位置と大きさを合わせる';
      q('[data-act=solve]').disabled = saving || busy || !orientation?.confirmed || pendingPair();
      q('[data-act=undo]').disabled = saving || (!landmarks.he.length && !landmarks.msi.length);
    }
    function scheduleRefresh() { if (!raf && !closed) raf = requestAnimationFrame(() => { raf = 0; if (!closed) refresh(); }); }
    function residuals() { return A.computeLandmarkResiduals(landmarks, T, options.msiPitch || worldCoords?.msi_um_per_px); }
    function tolerance() { const value = q('[data-tolerance]').value.trim(); return value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null; }
    function renderPreview() {
      if (!reference || !msiBase) { q('[data-el=vectors]').replaceChildren(); return; }
      const canvas = document.createElement('canvas'); canvas.width = reference.W; canvas.height = reference.H;
      const ctx = canvas.getContext('2d');
      if (q('[data-show-masks]').checked && msiMaskCanvas) ctx.drawImage(msiMaskCanvas, 0, 0, canvas.width, canvas.height); else ctx.drawImage(msiBase, 0, 0);
      const hm = getHeMask();
      if (hm) { heMaskTint ||= maskCanvas(hm, [0, 220, 0]); ctx.save(); ctx.globalAlpha = .5; ctx.globalCompositeOperation = 'lighter'; ctx.transform(T[0][0], T[1][0], T[0][1], T[1][1], T[0][2], T[1][2]); ctx.scale(hm.sx, hm.sy); ctx.drawImage(heMaskTint, 0, 0); ctx.restore(); }
      previewImage.src = drawFrame(canvas, orientation.msi);
    }
    function svgElement(name, attrs, parent) { const e = document.createElementNS(svgNS, name); Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v)); parent.appendChild(e); return e; }
    function highlightPoint(index) { selectedPoint = index; all('[data-point]').forEach(el => el.classList.toggle('align-selected', Number(el.dataset.point) === index)); }
    function renderPoints(resid) {
      if (!orientation) return;
      for (const which of ['he', 'msi']) {
        const layer = q(`[data-layer=${which}]`), frame = orientation[which]; layer.querySelectorAll('.pick-dot').forEach(dot => dot.remove());
        landmarks[which].forEach((point, i) => {
          const xy = O.fromRaw(frame, point), dot = document.createElement('button');
          dot.type = 'button'; dot.className = 'pick-dot'; dot.dataset.point = i; dot.disabled = saving;
          dot.setAttribute('aria-label', `${which.toUpperCase()} 対応点 ${i + 1}`);
          dot.classList.toggle('align-excluded', landmarks.excluded.includes(i)); dot.style.left = `${xy[0] / frame.width * 100}%`; dot.style.top = `${xy[1] / frame.height * 100}%`; dot.style.background = which === 'he' ? '#16a34a' : '#f97316'; dot.textContent = i + 1;
          dot.style.transform = `translate(-50%, -50%) scale(${1 / view[which].zoom})`;
          dot.addEventListener('click', event => { event.stopPropagation(); highlightPoint(i); if (editPair && expectedPane() === which) clickPoint(which, event); }); layer.appendChild(dot);
        });
      }
      const svg = q('[data-el=vectors]'); svg.replaceChildren(); if (!reference) return;
      svg.setAttribute('viewBox', `0 0 ${orientation.msi.width} ${orientation.msi.height}`); const radius = Math.max(orientation.msi.width, orientation.msi.height) * .009;
      (resid?.perPoint || []).forEach(p => {
        const xy = O.fromRaw(orientation.msi, p.transformed || A.applyAffinePoint(T, ...landmarks.he[p.i])), target = O.fromRaw(orientation.msi, landmarks.msi[p.i]);
        const g = svgElement('g', { 'data-point': p.i, class: landmarks.excluded.includes(p.i) ? 'align-excluded' : '' }, svg);
        if (p.d > .1) svgElement('line', { x1: xy[0], y1: xy[1], x2: target[0], y2: target[1], stroke: '#38bdf8', 'stroke-width': radius * .3 }, g);
        svgElement('rect', { x: xy[0] - radius, y: xy[1] - radius, width: radius * 2, height: radius * 2, fill: 'none', stroke: '#e879f9', 'stroke-width': radius * .35 }, g);
        svgElement('circle', { cx: target[0], cy: target[1], r: radius, fill: 'none', stroke: '#fb923c', 'stroke-width': radius * .35 }, g);
        const label = svgElement('text', { x: target[0] + radius * 1.5, y: target[1] - radius, fill: 'white', 'font-size': radius * 2.7, stroke: '#111827', 'stroke-width': radius * .13, 'paint-order': 'stroke' }, g); label.textContent = p.i + 1;
      }); highlightPoint(selectedPoint);
    }
    function startPairEdit(i) {
      if (saving || stage !== 2 || pendingPair()) return;
      editPair = { i, next: 'he', originalHe: clone(landmarks.he[i]), originalMsi: clone(landmarks.msi[i]), previousStale: fitStale };
      clearAuto(); fitStale = true; status = `対応点 ${i + 1} を修正します。まず HE、次に MSI をクリックしてください。`; updateStage(); scheduleRefresh();
    }
    function cancelPairEdit() {
      if (!editPair || saving) return;
      const item = editPair; landmarks.he[item.i] = item.originalHe; landmarks.msi[item.i] = item.originalMsi; editPair = null;
      fitStale = item.previousStale; status = '点の修正を取り消しました。位置合わせは保持しています。'; updateStage(); scheduleRefresh();
    }
    function renderResiduals(resid) {
      const n = includedCount(), geo = A.assessLandmarkGeometry(landmarks.msi.filter((_, i) => i < landmarks.he.length && !landmarks.excluded.includes(i)), reference?.W || 1, reference?.H || 1);
      q('[data-el=qc]').textContent = `${Math.min(landmarks.he.length, landmarks.msi.length)} 組（計算に使用 ${n} 組）${pendingPair() ? '・対応点を入力中' : ''}`;
      const largest = resid?.perPoint.filter(p => p.included !== false).reduce((a, b) => !a || b.d > a.d ? b : a, null);
      const mean = resid?.perPoint.filter(p => p.included !== false).reduce((sum, p) => sum + p.d / n, 0);
      const table = document.createElement('table'); table.innerHTML = '<thead><tr><th>使用 / #</th><th>ΔX</th><th>ΔY</th><th>距離 px</th><th>µm</th><th></th></tr></thead>';
      const body = document.createElement('tbody'); table.appendChild(body);
      for (let i = 0; i < Math.max(landmarks.he.length, landmarks.msi.length); i++) {
        const p = resid?.perPoint.find(p => p.i === i), included = !landmarks.excluded.includes(i), tr = document.createElement('tr'); tr.dataset.point = i;
        tr.classList.toggle('align-excluded', !included); tr.classList.toggle('align-largest', largest?.i === i);
        tr.innerHTML = `<td><input type="checkbox" data-exclude="${i}" aria-label="対応点 ${i + 1} を計算に使用" ${included ? 'checked' : ''} ${saving || pendingPair() || !p ? 'disabled' : ''}> ${i + 1}</td><td>${fmt(p?.dx)}</td><td>${fmt(p?.dy)}</td><td>${fmt(p?.d)}</td><td>${fmt(p?.dUm, 1)}</td><td><button data-edit-pair="${i}" ${saving || pendingPair() || !p ? 'disabled' : ''}>修正</button></td>`;
        tr.addEventListener('click', () => highlightPoint(i)); tr.querySelector('button').addEventListener('click', () => startPairEdit(i));
        tr.querySelector('input').addEventListener('change', ev => { if (saving) { ev.target.checked = included; return; } landmarks.excluded = ev.target.checked ? landmarks.excluded.filter(k => k !== i) : [...new Set([...landmarks.excluded, i])]; pointsChanged(); }); body.appendChild(tr);
      }
      q('[data-el=table]').replaceChildren(table);
      const warnings = [], tol = tolerance();
      if (n >= 3 && geo.spread < .33) warnings.push('点が狭い範囲に集まっています。外周にも対応点を置いてください。');
      if (tol !== null && largest && largest.d > tol) warnings.push(`最大のずれが許容値 ${tol} px を超えています。`);
      let report = `<div>平均ずれ <b>${n ? fmt(mean) : '—'} px</b> / 最大ずれ <b>${fmt(resid?.max_px)} px</b></div>`;
      if (n) report += `<div class="align-note">RMSE ${fmt(resid?.rmse_px)} px ・ ${currentModel === 'affine' ? 'アフィン' : '相似変換'}</div>`;
      if (autoMeta) report += `<div>輪郭の一致 Dice ${fmt(autoMeta.dice, 4)}${autoMeta.evaluationOnly ? '（確認のみ・変換は維持）' : ''}</div>`;
      report += warnings.map(w => `<div class="align-warning">${escapeHtml(w)}</div>`).join(''); q('[data-el=report]').innerHTML = report;
    }
    function refresh() { const resid = residuals(); q('[data-el=status]').textContent = status; renderResiduals(resid); renderPreview(); renderPoints(resid); updateGuide(); updateEnabled(); }
    function adoptFit(fit, method) {
      T = clone(fit.T); currentModel = editModel; fitMethod = method; fitStale = false; inputValid = true; geometryChanged = false;
      q('[data-el=input-error]').textContent = ''; q('[data-el=solve-error]').textContent = ''; syncParameters();
    }
    function fitPoints() {
      if (!orientation?.confirmed || stage !== 2) { fitStale = true; return; }
      if (sourceChanged) { fitStale = true; status = '元画像が変更されています。対応点を全消去し、新しい画像で指定し直してください。'; return; }
      if (pendingPair()) { fitStale = true; status = '対応する点の指定を完了してください。直前のプレビューを保持しています。'; return; }
      const minimum = editModel === 'affine' ? 4 : 3;
      if (includedCount() < minimum) { fitStale = true; status = `位置合わせには ${minimum} 組以上の対応点が必要です。直前のプレビューを保持しています。`; return; }
      try { adoptFit(O.solve(landmarks, constraints()), `landmarks-${editModel}-oriented`); status = '対応点から位置合わせしました。向きは固定されています。点のずれと組織の内部構造を確認してください。'; }
      catch (error) { fitStale = true; q('[data-el=solve-error]').textContent = `${error.message} 向き、点の番号、点の位置を確認してください。直前の変換を保持しています。`; status = '対応点からの計算結果を採用できませんでした。'; }
    }
    function pointsChanged() {
      if (saving) return;
      landmarks.excluded = landmarks.excluded.filter(i => i < Math.min(landmarks.he.length, landmarks.msi.length)); draftTouched = true; clearAuto(); q('[data-el=solve-error]').textContent = ''; fitPoints(); updateEnabled(); scheduleRefresh();
    }
    function changeOrientation(operation) {
      if (saving || !orientation || stage !== 1) return;
      try { orientation.he = O.orient(orientation.he, operation); orientation.revision++; orientation.confirmed = false; geometryChanged = true; draftTouched = true; fitStale = true; inputValid = true; clearAuto(); q('[data-el=solve-error]').textContent = ''; q('[data-el=input-error]').textContent = ''; view.he = { zoom: 1, x: 0, y: 0 }; renderReferenceImages(); syncParameters(); status = 'HE の向きを変更しました。向きを確定してから位置合わせを計算してください。'; }
      catch (error) { inputValid = false; q('[data-el=solve-error]').textContent = error.message; }
      updateEnabled(); scheduleRefresh();
    }
    function clickPoint(which, event) {
      if (saving || stage !== 2 || !reference || expectedPane() !== which) return;
      const image = which === 'he' ? heImage : msiImage, rect = image.getBoundingClientRect(), frame = orientation[which];
      if (!rect.width || !rect.height) return;
      const x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      const raw = O.toRaw(frame, [x * frame.width, y * frame.height]);
      if (raw[0] < 0 || raw[1] < 0 || raw[0] > frame.rawWidth || raw[1] > frame.rawHeight) { status = '画像の外側です。組織上の点をクリックしてください。'; scheduleRefresh(); return; }
      if (editPair) { landmarks[which][editPair.i] = raw; selectedPoint = editPair.i; if (which === 'he') editPair.next = 'msi'; else editPair = null; }
      else { landmarks[which].push(raw); selectedPoint = landmarks[which].length - 1; }
      pointsChanged(); updateStage();
    }
    function close() { if (saving || closed) return; closed = true; revision++; if (raf) cancelAnimationFrame(raf); document.removeEventListener('keydown', keyboard); backdrop.remove(); activeBefore?.focus(); }
    function keyboard(event) {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') { const focusable = all('button:not(:disabled),select:not(:disabled),input:not(:disabled),summary').filter(el => el.getClientRects().length); const first = focusable[0], last = focusable.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
    }
    for (const [action, op] of [['orient-flip-lr', 'mirror-x'], ['orient-flip-ud', 'mirror-y'], ['orient-left', 'rotate-left'], ['orient-right', 'rotate-right']]) q(`[data-act=${action}]`).addEventListener('click', () => changeOrientation(op));
    q('[data-act=orient-fine]').addEventListener('click', () => { const input = q('[data-orient-angle]'), degrees = Number(input.value); if (input.value.trim() === '' || !Number.isFinite(degrees) || Math.abs(degrees) > 45) { q('[data-el=solve-error]').textContent = '微調整の角度は −45°～45°で入力してください。'; return; } changeOrientation({ type: 'rotate', degrees }); input.value = '0'; });
    q('[data-act=orient-next]').addEventListener('click', () => {
      if (saving || !orientation || !reference || !inputValid) return;
      const firstConfirmation = !orientation.confirmed;
      orientation.confirmed = true; stage = 2; clearAuto();
      status = '② HE と MSI の同じ場所を順にクリックしてください。3 組から自動で位置合わせします。';
      if (firstConfirmation || geometryChanged) {
        draftTouched = true;
        if (landmarks.he.length || landmarks.msi.length) fitPoints();
        else if (!O.check(T, constraints()).valid) { fitStale = true; status = '向きを固定しました。対応点または輪郭で位置合わせしてください。'; }
      }
      updateStage(); syncParameters(); scheduleRefresh();
    });
    q('[data-act=orient-back]').addEventListener('click', () => { if (saving) return; if (editPair) cancelPairEdit(); stage = 1; clearAuto(); status = 'HE の向きを確認してください。変更した場合は位置合わせを計算し直します。'; updateStage(); scheduleRefresh(); });
    q('[data-act=edit-cancel]').addEventListener('click', cancelPairEdit);
    all('[data-zoom-pane]').forEach(button => button.addEventListener('click', () => { if (saving) return; const which = button.dataset.zoomPane; if (button.dataset.act === 'zoom-reset') { view[which] = { zoom: 1, x: 0, y: 0 }; updateView(which); } else zoomAt(which, view[which].zoom * (button.dataset.act === 'zoom-in' ? 1.35 : 1 / 1.35)); }));
    for (const which of ['he', 'msi']) {
      const pane = q(`[data-pane=${which}]`); let gesture = null, suppressClick = false;
      pane.addEventListener('wheel', event => { if (saving) return; event.preventDefault(); const rect = pane.getBoundingClientRect(); zoomAt(which, view[which].zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX - rect.left, event.clientY - rect.top); }, { passive: false });
      pane.addEventListener('pointerdown', event => { if (saving || event.button !== 0 || event.target.closest('.pick-dot')) return; gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, vx: view[which].x, vy: view[which].y, moved: false }; pane.setPointerCapture(event.pointerId); });
      pane.addEventListener('pointermove', event => { if (!gesture || gesture.id !== event.pointerId || saving) return; const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y; if (Math.hypot(dx, dy) > 4) gesture.moved = true; if (gesture.moved) { view[which].x = gesture.vx + dx; view[which].y = gesture.vy + dy; updateView(which); } });
      pane.addEventListener('pointerup', event => { if (!gesture || gesture.id !== event.pointerId) return; suppressClick = gesture.moved; gesture = null; if (pane.hasPointerCapture(event.pointerId)) pane.releasePointerCapture(event.pointerId); });
      pane.addEventListener('pointercancel', () => { gesture = null; suppressClick = true; });
      pane.addEventListener('click', event => { if (suppressClick) { suppressClick = false; return; } if (!event.target.closest('.pick-dot')) clickPoint(which, event); });
    }
    all('[data-p]').forEach(input => input.addEventListener('input', () => {
      if (saving || stage !== 2 || !orientation?.confirmed) return;
      clearAuto(); draftTouched = true;
      try {
        for (const field of all('[data-p]')) { if (field.closest('[data-only-model]')?.hidden) continue; if (field.value.trim() === '' || !Number.isFinite(Number(field.value))) throw new Error('数値を入力してください。直前の変換を表示しています。'); parameterState[field.dataset.p] = Number(field.value); }
        const F = A.buildHeToMsiAffine({ ...parameterState, model: editModel, flip_lr: false, flip_ud: false });
        const candidate = O.multiply(O.invert(orientation.msi.matrix), O.multiply(F, orientation.he.matrix)), check = O.check(candidate, constraints());
        if (!check.valid) throw new Error(check.reason || '確定した向きからの角度補正は ±15°以内にしてください。');
        if (sourceChanged) throw new Error('元画像が変更されています。対応点を全消去し、新しい画像で指定し直してください。');
        if (pendingPair() || (includedCount() > 0 && includedCount() < (editModel === 'affine' ? 4 : 3))) throw new Error('対応点の指定を完了してから手動調整してください。');
        T = candidate; currentModel = editModel; inputValid = true; fitStale = false; geometryChanged = false; fitMethod = 'manual-oriented'; q('[data-el=input-error]').textContent = ''; q('[data-el=solve-error]').textContent = ''; status = '手動調整を即時反映しました。人が確定した向きは維持しています。';
      } catch (error) { inputValid = false; q('[data-el=input-error]').textContent = error.message; }
      updateEnabled(); scheduleRefresh();
    }));
    q('[data-sel=model]').addEventListener('change', event => { if (saving) return; editModel = event.target.value; clearAuto(); draftTouched = true; syncParameters(); fitPoints(); scheduleRefresh(); });
    q('[data-sel=reference]').addEventListener('change', event => { if (saving) return; referenceMode = event.target.value; refreshReference(); });
    msiSelect.addEventListener('change', () => { if (saving) return; singleKey = msiSelect.value; refreshReference(); });
    all('[data-source-key]').forEach(input => input.addEventListener('change', () => { if (saving) return; selectedSources = all('[data-source-key]:checked').map(el => el.dataset.sourceKey); refreshReference(); }));
    q('[data-show-masks]').addEventListener('change', () => { if (saving) return; renderReferenceImages(); scheduleRefresh(); });
    q('[data-allow-rotation]').addEventListener('change', () => { if (saving) return; clearAuto(); scheduleRefresh(); });
    q('[data-tolerance]').addEventListener('input', () => { if (!saving) scheduleRefresh(); });
    q('[data-act=undo]').addEventListener('click', () => { if (saving) return; if (editPair) { cancelPairEdit(); return; } if (landmarks.he.length > landmarks.msi.length) landmarks.he.pop(); else if (landmarks.msi.length > landmarks.he.length) landmarks.msi.pop(); else { landmarks.he.pop(); landmarks.msi.pop(); } pointsChanged(); });
    q('[data-act=clear]').addEventListener('click', () => { if (saving) return; landmarks.he = []; landmarks.msi = []; landmarks.excluded = []; editPair = null; selectedPoint = -1; sourceChanged = false; pointsChanged(); updateStage(); });
    q('[data-act=solve]').addEventListener('click', () => { if (saving) return; clearAuto(); draftTouched = true; fitPoints(); scheduleRefresh(); });
    q('[data-act=restore]').addEventListener('click', () => {
      if (saving) return;
      T = clone(originalDraft.T); landmarks.he = clone(originalDraft.landmarks.he); landmarks.msi = clone(originalDraft.landmarks.msi); landmarks.excluded = clone(originalDraft.landmarks.excluded);
      orientation = clone(originalDraft.orientation); stage = originalDraft.stage; currentModel = editModel = originalDraft.model; fitStale = originalDraft.stale; geometryChanged = fitStale; sourceChanged = originalDraft.sourceChanged; draftTouched = false; inputValid = true; editPair = null; clearAuto(); q('[data-el=input-error]').textContent = ''; q('[data-el=solve-error]').textContent = ''; fitMethod = saved?.fit?.method || 'saved'; status = '編集開始時の向き・対応点・変換に戻しました。'; renderReferenceImages(); syncParameters(); updateStage(); scheduleRefresh();
    });
    q('[data-act=auto]').addEventListener('click', async () => {
      if (saving || busy || !reference || !orientation?.confirmed || pendingPair() || (includedCount() > 0 && includedCount() < 3)) return;
      clearAuto(); const requestRevision = revision, referenceAtStart = reference; busy = true; updateEnabled();
      await new Promise(resolve => requestAnimationFrame(resolve));
      try {
        if (closed || requestRevision !== revision) return;
        const hm = getHeMask(); if (!hm || !msiMask) throw new Error('組織マスクを抽出できません。参照画像とマスク表示を確認してください。');
        if (includedCount() >= 3) {
          autoMeta = { method: 'silhouette-oriented', dice: A.maskDiceUnderAffine(hm, msiMask, T), evaluationOnly: true, improved: false, allowRotation: false, orientationRevision: orientation.revision, referenceFingerprint: reference.sourceFingerprint, ts: Date.now() };
          status = '現在の位置合わせの輪郭一致を確認しました。対応点から求めた変換は変更していません。';
          return;
        }
        const currentValid = O.check(T, constraints()).valid && !geometryChanged;
        const auto = O.silhouette(hm, msiMask, { ...constraints(), allowRotation: q('[data-allow-rotation]').checked, maxEvaluations: 400, ...(currentValid ? { initialT: T } : {}) });
        if (closed || requestRevision !== revision || reference !== referenceAtStart) return;
        autoMeta = { method: 'silhouette-oriented', dice: auto.improved ? auto.dice : auto.initialDice, evaluationOnly: false, improved: auto.improved, allowRotation: q('[data-allow-rotation]').checked, orientationRevision: orientation.revision, referenceFingerprint: reference.sourceFingerprint, ts: Date.now() };
        if (auto.improved) { editModel = 'similarity'; adoptFit(auto, 'silhouette-oriented'); draftTouched = true; status = '向きを固定して輪郭を合わせました。共通する点をクリックすると、対応点で仕上げられます。'; }
        else status = '輪郭の一致が改善しなかったため、現在の変換を保持しました。対応点で位置合わせしてください。';
      } catch (error) { if (!closed && requestRevision === revision) q('[data-el=solve-error]').textContent = error.message; }
      finally { if (!closed) { busy = false; updateEnabled(); scheduleRefresh(); } }
    });
    all('[data-act=close]').forEach(button => button.addEventListener('click', close)); backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
    q('[data-act=apply]').addEventListener('click', async () => {
      if (!canSave()) return;
      saving = true; const disabledStates = all('input,select,button').map(el => [el, el.disabled]); disabledStates.forEach(([el]) => { el.disabled = true; }); q('[data-el=save-error]').textContent = '';
      try {
        const parameters = A.decomposeAffine(T), resid = residuals();
        const alignment = { schemaVersion: 3, T_he_to_msi: clone(T), ...parameters, model: currentModel, landmarks: clone(landmarks), reference: clone(reference.metadata), orientation: clone(orientation), orientationConstraint: { maxRotationDeg: MAX_ROTATION, allowSilhouetteRotation: q('[data-allow-rotation]').checked }, fit: { method: fitMethod, tolerancePx: tolerance(), orientationRevision: orientation.revision, residuals: resid ? JSON.parse(JSON.stringify(resid)) : null, timestamp: Date.now() }, ...(autoMeta ? { autoAligned: clone(autoMeta) } : {}), ...(previousAutoMeta ? { previousAutoAligned: clone(previousAutoMeta) } : {}) };
        // Legacy no-op saves remain unconfirmed unless the existing matrix also
        // satisfies the new explicit orientation frame. Never rebuild exact T.
        if (!draftTouched && !O.check(T, constraints()).valid) alignment.orientation.confirmed = false;
        await save(clone(T), alignment); saving = false; close();
      } catch (error) { q('[data-el=save-error]').textContent = `保存できませんでした。編集内容はこの画面に保持しています。${error.message}`; saving = false; disabledStates.forEach(([el, disabled]) => { el.disabled = disabled; }); updateEnabled(); scheduleRefresh(); }
    });
    document.addEventListener('keydown', keyboard); heImage.addEventListener('load', scheduleRefresh); msiImage.addEventListener('load', scheduleRefresh);
    refreshReference(true);
    if (saved?.autoAligned) {
      const matchingRecipe = reference && ['mode', 'sourceKeys', 'quantile', 'quantileMethod', 'recipe', 'sourceFingerprint']
        .every(key => JSON.stringify(saved.reference?.[key]) === JSON.stringify(reference.metadata?.[key]));
      const matching = matchingRecipe && saved.autoAligned.referenceFingerprint === reference.sourceFingerprint && saved.autoAligned.orientationRevision === orientation?.revision && orientation?.confirmed && !fitStale;
      if (matching) autoMeta = clone(saved.autoAligned); else previousAutoMeta = { ...clone(saved.autoAligned), stale: true };
    }
    if (stage === 2 && !fitStale) status = '保存済みの向き・対応点・位置合わせを表示しています。点を追加または修正すると再計算します。';
    updateStage(); scheduleRefresh(); q('[data-sel=reference]').focus();
    return { close, element: backdrop };
  }
  global.AlignmentModal = { open };
})(typeof window !== 'undefined' ? window : globalThis);
