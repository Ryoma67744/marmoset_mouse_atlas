/*
 * HE/MSI alignment editor. A draft owns its exact raw-pixel matrix until a
 * parameter or candidate is explicitly applied. Viewer persistence is injected
 * so cancel, failed saves and comparisons never mutate the stored transform.
 */
(function (global) {
  'use strict';
  const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = value => structuredClone(value);
  const fmt = (n, digits = 2) => Number.isFinite(n) ? n.toFixed(digits) : '—';
  const svgNS = 'http://www.w3.org/2000/svg';

  function open(options) {
    const { heKey, heImg, heSrc, rasters, project, saved, worldCoords, save, formatName } = options;
    const A = global.Align, R = global.AlignmentReference;
    const keys = Object.keys(rasters);
    const hasCanonical = Object.prototype.hasOwnProperty.call(worldCoords || {}, 'T_he_to_msi');
    const hasSavedMatrix = Object.prototype.hasOwnProperty.call(saved || {}, 'T_he_to_msi');
    const initial = hasCanonical ? worldCoords.T_he_to_msi : saved?.T_he_to_msi;
    if ((hasCanonical || hasSavedMatrix) && !A.validateAffine(initial)) throw new Error('保存された変換行列が無効です。古いパラメータへの置き換えは行いません。元データを確認してください。');
    let T = hasCanonical || hasSavedMatrix ? clone(initial) : A.buildHeToMsiAffine({ ...A.defaultAlignState(), ...(saved || {}) });
    let state = A.decomposeAffine(T);
    let currentModel = saved?.model === 'affine' ? 'affine' : state.model;
    let editModel = currentModel;
    const landmarks = {
      he: clone(saved?.landmarks?.he || []),
      msi: clone(saved?.landmarks?.msi || []),
      excluded: clone(saved?.landmarks?.excluded || []),
    };
    const endogenous = R.sourceKeys(project, rasters);
    const storedReference = saved?.reference;
    let referenceMode = ['single', 'rawsum', 'balanced'].includes(storedReference?.mode) ? storedReference.mode : 'single';
    let singleKey = storedReference?.mode === 'single' && storedReference.sourceKeys?.[0]
      ? storedReference.sourceKeys[0] : (keys.includes(options.msiKey0) ? options.msiKey0 : keys[0]);
    let selectedSources = storedReference?.mode !== 'single' && Array.isArray(storedReference?.sourceKeys)
      ? storedReference.sourceKeys.slice() : endogenous.slice();
    // Keep saved unavailable sources visible: never silently change a recipe.
    const sourceChoices = Array.from(new Set([...endogenous, ...selectedSources]));
    let reference = null, msiBase = null, msiMask = null, heMask, landmarkGrid = null;
    let heMaskLoaded = false, heMaskTint = null, msiMaskCanvas = null;
    let autoMeta = null, previousAutoMeta = saved?.previousAutoAligned ? clone(saved.previousAutoAligned) : null;
    let candidates = [], selectedPoint = -1, pickMode = null;
    let inputValid = true, closed = false, saving = false, revision = 0, raf = 0;
    let status = '保存済みの変換を表示しています。候補の計算だけでは変換は変わりません。';
    let fitMethod = saved?.fit?.method || 'saved';
    const activeBefore = document.activeElement;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop alignment-modal';
    backdrop.innerHTML = `
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="alignment-title">
        <div class="align-header">
          <h3 id="alignment-title">重ね合わせ — ${escapeHtml(formatName(heKey))} → MSI</h3>
          <button data-act="close" aria-label="閉じる">×</button>
        </div>
        <div class="align-reference">
          <div class="align-reference-line">
            <label>位置合わせの参照
              <select data-sel="reference" aria-label="位置合わせの参照">
                <option value="single">単一分子（原値）</option>
                <option value="rawsum">登録分子の合算（原値）</option>
                <option value="balanced">強度差補正合成（分子ごと P99）</option>
              </select>
            </label>
            <select data-sel="msi" aria-label="参照する単一分子"></select>
            <label><input type="checkbox" data-show-masks> 自動推定に使う組織マスクを表示</label>
          </div>
          <details data-source-options>
            <summary>合成に使う分子を選択（表示中の分子とは独立）</summary>
            <div class="align-sources" data-el="sources"></div>
          </details>
          <div class="align-note" data-el="reference-info"></div>
          <div class="align-error" data-el="reference-error" role="status"></div>
        </div>
        <div class="align-panels">
          <div>
            <div class="align-pane-title"><span>HE（生の向き）</span><button data-pick="he">対応点を打つ</button></div>
            <div class="pick-pane" data-pane="he"><img data-img="he" alt="HE 原画像"></div>
          </div>
          <div>
            <div class="align-pane-title"><span data-el="msi-title">MSI 参照画像</span><button data-pick="msi">対応点を打つ</button></div>
            <div class="pick-pane" data-pane="msi"><img data-img="msi" alt="位置合わせ用 MSI 参照"></div>
          </div>
          <div>
            <div class="align-pane-title"><span>重ね合わせ・対応点のずれ</span></div>
            <div class="pick-pane" data-pane="preview"><img data-img="preview" alt="変換後 HE と MSI の重ね合わせ"><svg class="align-residual-svg" data-el="vectors"></svg></div>
            <div class="align-legend"><span>緑：HE 組織</span><span>□ 紫：変換後 HE 点</span><span>○ 橙：MSI 点</span><span>線：ずれ</span></div>
          </div>
        </div>
        <div data-el="status" role="status"></div>
        <div class="align-controls">
          <div class="align-parameters">
            <h4>変換パラメータ（入力を即時反映）</h4>
            <label><span>変換モデル</span><select data-sel="model"><option value="similarity">相似変換</option><option value="affine">アフィン変換</option></select></label>
            <label><input type="checkbox" data-p="flip_lr"> 左右反転</label>
            <label><input type="checkbox" data-p="flip_ud"> 上下反転</label>
            <label data-only-model="similarity"><span>スケール</span><input type="number" step="any" data-p="scale_pct"> %</label>
            <label data-only-model="affine"><span>X スケール</span><input type="number" step="any" data-p="scale_x_pct"> %</label>
            <label data-only-model="affine"><span>Y スケール</span><input type="number" step="any" data-p="scale_y_pct"> %</label>
            <label data-only-model="affine"><span>せん断</span><input type="number" step="any" data-p="shear"></label>
            <label><span>回転</span><input type="number" step="any" data-p="rotate_deg"> °</label>
            <label><span>X 移動</span><input type="number" step="any" data-p="offx"> px</label>
            <label><span>Y 移動</span><input type="number" step="any" data-p="offy"> px</label>
            <div class="align-error" data-el="input-error" role="status"></div>
            <div class="align-note">モデルの選択だけでは変換を変更しません。空欄や無効な値では直前の有効なプレビューを保持します。</div>
            <button data-act="auto" style="margin-top:8px">自動推定の候補を計算（シルエット）</button>
          </div>
          <div>
            <div class="align-pane-title"><h4>対応点とずれ（MSI px）</h4><span><button data-act="undo">1 点戻す</button> <button data-act="clear">全消去</button></span></div>
            <div data-el="qc"></div>
            <div data-el="table"></div>
            <div class="align-note">チェックを外した点は計算から除外します。行を選ぶと 3 画面で同じ点を強調します。Δ = 変換後 HE − MSI。</div>
            <button data-act="solve" style="margin-top:6px">対応点から候補を計算（Solve）</button>
          </div>
          <div class="align-evaluation">
            <h4>現在の変換と候補の比較</h4>
            <div data-el="report"></div>
            <label class="align-tolerance">許容ずれ <input type="number" step="any" min="0" data-tolerance placeholder="未設定"> px</label>
            <div class="align-note">許容値未設定時は適否を自動判定しません。3 点だけのアフィンは残差が 0 でも精度の検証にはなりません。</div>
            <div class="align-error" data-el="solve-error" role="status"></div>
            <div data-el="candidates"></div>
          </div>
        </div>
        <div class="align-error" data-el="save-error" role="alert"></div>
        <div class="align-footer"><button data-act="close">キャンセル</button><button data-act="apply">適用して保存</button></div>
      </div>`;
    document.body.appendChild(backdrop);
    const q = s => backdrop.querySelector(s);
    const all = s => [...backdrop.querySelectorAll(s)];
    const heImage = q('[data-img=he]'), msiImage = q('[data-img=msi]'), previewImage = q('[data-img=preview]');
    const msiSelect = q('[data-sel=msi]');
    keys.forEach(k => msiSelect.add(new Option(formatName(k), k)));
    if (!keys.includes(singleKey)) msiSelect.add(new Option(`${formatName(singleKey)}（データがありません）`, singleKey));
    msiSelect.value = singleKey;
    q('[data-sel=reference]').value = referenceMode;
    q('[data-sel=model]').value = editModel;
    if (Number.isFinite(saved?.fit?.tolerancePx)) q('[data-tolerance]').value = saved.fit.tolerancePx;
    sourceChoices.forEach(key => {
      const label = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.dataset.sourceKey = key;
      input.checked = selectedSources.includes(key);
      label.append(input, document.createTextNode(formatName(key)));
      q('[data-el=sources]').appendChild(label);
    });
    heImage.src = heSrc;
    sizePane('he', heImg.naturalWidth, heImg.naturalHeight);

    function sizePane(which, width, height) {
      const pane = q(`[data-pane=${which}]`), ratio = width / height;
      // Constrain the image itself, with no letterboxing: percentage landmarks
      // and the residual SVG retain the same exact image bounds.
      pane.style.setProperty('--align-pane-vh', `${36 * ratio}vh`);
      pane.style.setProperty('--align-pane-px', `${380 * ratio}px`);
    }
    function getHeMask() {
      if (!heMaskLoaded) { heMask = A.heTissueMask(heImg); heMaskLoaded = true; }
      return heMask;
    }
    function maskCanvas(mask, color) {
      if (!mask) return null;
      const canvas = document.createElement('canvas'); canvas.width = mask.w; canvas.height = mask.h;
      const ctx = canvas.getContext('2d'), data = ctx.createImageData(mask.w, mask.h);
      for (let i = 0; i < mask.mask.length; i++) if (mask.mask[i]) {
        data.data[i * 4] = color[0]; data.data[i * 4 + 1] = color[1]; data.data[i * 4 + 2] = color[2]; data.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(data, 0, 0); return canvas;
    }
    function sourceRecipe() {
      return { mode: referenceMode, sourceKeys: referenceMode === 'single' ? [singleKey] : selectedSources.slice() };
    }
    function invalidateCandidates(message) {
      revision++; candidates = [];
      if (autoMeta) previousAutoMeta = { ...clone(autoMeta), stale: true };
      autoMeta = null;
      q('[data-el=candidates]').replaceChildren(); q('[data-el=solve-error]').textContent = '';
      if (message) status = message;
    }
    function refreshReference() {
      invalidateCandidates('参照画像を変更しました。自動評価は未計算です。現在の変換と対応点は保持しています。');
      reference = null; msiBase = null; msiMask = null; msiMaskCanvas = null;
      q('[data-el=reference-error]').textContent = '';
      q('[data-source-options]').hidden = referenceMode === 'single';
      msiSelect.hidden = referenceMode !== 'single';
      try {
        reference = R.build(project, rasters, sourceRecipe());
        if (landmarkGrid && (landmarkGrid.W !== reference.W || landmarkGrid.H !== reference.H) && (landmarks.he.length || landmarks.msi.length)) {
          throw new Error('参照のグリッドが変わるため対応点を引き継げません。元の参照に戻すか、対応点を全消去してから選び直してください。');
        }
        landmarkGrid = { W: reference.W, H: reference.H };
        sizePane('msi', reference.W, reference.H); sizePane('preview', reference.W, reference.H);
        msiBase = global.MSIRaster.paintRasterToCanvas(reference.values, reference.W, reference.H, {
          color: null, win: reference.range, gamma: 0.5,
        });
        msiMask = A.msiTissueMaskFromValues(reference.values, reference.W, reference.H);
        msiMaskCanvas = maskCanvas(msiMask, [220, 220, 220]);
        q('[data-el=msi-title]').textContent = referenceMode === 'single' ? formatName(singleKey) : referenceMode === 'balanced' ? '強度差補正合成' : '登録分子の合算';
        q('[data-el=reference-info]').textContent = referenceMode === 'balanced'
          ? '各分子の P99 で除算し、1 で上限を揃えて合算。全分子に共通する有効画素を使用します。内部標準は除外。全質量域の TIC ではありません。'
          : referenceMode === 'rawsum' ? '選択した登録分子の原値を合算します。全質量域の TIC ではありません。'
            : '原値の参照画像です。Viewer の d4 補正や色範囲の設定とは独立しています。';
      } catch (error) {
        reference = null;
        q('[data-el=reference-error]').textContent = error.message;
        q('[data-el=reference-info]').textContent = '';
      }
      renderReferenceImages(); scheduleRefresh();
    }
    function renderReferenceImages() {
      if (!reference || !msiBase) { msiImage.removeAttribute('src'); previewImage.removeAttribute('src'); return; }
      const showMask = q('[data-show-masks]').checked;
      const hm = getHeMask();
      if (showMask && hm) {
        const h = maskCanvas(hm, [220, 220, 220]);
        // Preserve the raw HE coordinate system while using the processed mask.
        const c = document.createElement('canvas'); c.width = heImg.naturalWidth; c.height = heImg.naturalHeight;
        c.getContext('2d').drawImage(h, 0, 0, c.width, c.height); heImage.src = c.toDataURL();
      } else heImage.src = heSrc;
      if (showMask && msiMaskCanvas) {
        const c = document.createElement('canvas'); c.width = reference.W; c.height = reference.H;
        c.getContext('2d').drawImage(msiMaskCanvas, 0, 0, c.width, c.height); msiImage.src = c.toDataURL();
      } else msiImage.src = msiBase.toDataURL();
      if (showMask && (!hm || !msiMask)) q('[data-el=reference-error]').textContent = '組織マスクを抽出できない画像があります。該当画像は原画像を表示しています。';
      else q('[data-el=reference-error]').textContent = '';
    }
    function syncParameters() {
      all('[data-only-model]').forEach(el => { el.hidden = el.dataset.onlyModel !== editModel; });
      all('[data-p]').forEach(el => {
        const key = el.dataset.p;
        if (el.type === 'checkbox') el.checked = !!state[key];
        else el.value = Number.isFinite(state[key]) ? String(Number(state[key].toPrecision(12))) : '';
      });
      q('[data-sel=model]').value = editModel;
    }
    function updateEnabled() {
      q('[data-act=apply]').disabled = saving || !inputValid || !reference || !A.validateAffine(T);
      q('[data-act=auto]').disabled = saving || !reference;
      q('[data-act=solve]').disabled = saving;
    }
    function scheduleRefresh() {
      if (!raf && !closed) raf = requestAnimationFrame(() => { raf = 0; if (!closed) refresh(); });
    }
    function residuals() { return A.computeLandmarkResiduals(landmarks, T, options.msiPitch || worldCoords?.msi_um_per_px); }
    function tolerance() {
      const value = q('[data-tolerance]').value.trim();
      return value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
    }
    function renderPreview() {
      if (!reference || !msiBase) { q('[data-el=vectors]').replaceChildren(); return; }
      const c = document.createElement('canvas'); c.width = reference.W; c.height = reference.H;
      const ctx = c.getContext('2d');
      if (q('[data-show-masks]').checked && msiMaskCanvas) ctx.drawImage(msiMaskCanvas, 0, 0, c.width, c.height);
      else ctx.drawImage(msiBase, 0, 0);
      const hm = getHeMask();
      if (hm) {
        heMaskTint ||= maskCanvas(hm, [0, 220, 0]);
        ctx.save(); ctx.globalAlpha = .5; ctx.globalCompositeOperation = 'lighter';
        ctx.transform(T[0][0], T[1][0], T[0][1], T[1][1], T[0][2], T[1][2]);
        ctx.scale(hm.sx, hm.sy); ctx.drawImage(heMaskTint, 0, 0); ctx.restore();
      }
      previewImage.src = c.toDataURL();
    }
    function svgElement(name, attrs, parent) {
      const e = document.createElementNS(svgNS, name);
      Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v)); parent.appendChild(e); return e;
    }
    function highlightPoint(index) {
      selectedPoint = index;
      all('[data-point]').forEach(el => el.classList.toggle('align-selected', Number(el.dataset.point) === index));
    }
    function renderPoints(resid) {
      for (const which of ['he', 'msi']) {
        const pane = q(`[data-pane=${which}]`);
        pane.querySelectorAll('.pick-dot').forEach(dot => dot.remove());
        const W = which === 'he' ? heImg.naturalWidth : reference?.W;
        const H = which === 'he' ? heImg.naturalHeight : reference?.H;
        if (!W || !H) continue;
        landmarks[which].forEach((point, i) => {
          const dot = document.createElement('div'); dot.className = 'pick-dot'; dot.dataset.point = i;
          dot.classList.toggle('align-excluded', landmarks.excluded.includes(i));
          dot.style.left = `${point[0] / W * 100}%`; dot.style.top = `${point[1] / H * 100}%`;
          dot.style.background = which === 'he' ? '#16a34a' : '#f97316'; dot.textContent = i + 1; pane.appendChild(dot);
        });
      }
      const svg = q('[data-el=vectors]'); svg.replaceChildren();
      if (!reference) return;
      svg.setAttribute('viewBox', `0 0 ${reference.W} ${reference.H}`);
      const radius = Math.max(reference.W, reference.H) * .009;
      (resid?.perPoint || []).forEach(p => {
        const xy = p.transformed || A.applyAffinePoint(T, ...landmarks.he[p.i]);
        const target = landmarks.msi[p.i], included = !landmarks.excluded.includes(p.i);
        const g = svgElement('g', { 'data-point': p.i, class: included ? '' : 'align-excluded' }, svg);
        svgElement('line', { x1: xy[0], y1: xy[1], x2: target[0], y2: target[1], stroke: '#38bdf8', 'stroke-width': radius * .3 }, g);
        svgElement('rect', { x: xy[0] - radius, y: xy[1] - radius, width: radius * 2, height: radius * 2, fill: 'none', stroke: '#e879f9', 'stroke-width': radius * .35 }, g);
        svgElement('circle', { cx: target[0], cy: target[1], r: radius, fill: 'none', stroke: '#fb923c', 'stroke-width': radius * .35 }, g);
        const label = svgElement('text', { x: target[0] + radius * 1.5, y: target[1] - radius, fill: 'white', 'font-size': radius * 2.7, stroke: '#111827', 'stroke-width': radius * .13, 'paint-order': 'stroke' }, g);
        label.textContent = p.i + 1;
      });
      highlightPoint(selectedPoint);
    }
    function renderResiduals(resid) {
      const nHe = landmarks.he.length, nMsi = landmarks.msi.length;
      const includedPoints = landmarks.msi.filter((_, i) => i < nHe && !landmarks.excluded.includes(i));
      const geo = A.assessLandmarkGeometry(includedPoints, reference?.W || 1, reference?.H || 1);
      q('[data-el=qc]').textContent = nHe !== nMsi
        ? `HE ${nHe} 点 / MSI ${nMsi} 点：点数を揃えてから Solve してください。`
        : `${nHe} 組・計算対象 ${includedPoints.length} 組 / 点の広がり ${fmt(geo.spread)}（位置合わせの正確さとは別の指標）`;
      const largest = resid?.perPoint.filter(p => p.included !== false).reduce((a, b) => !a || b.d > a.d ? b : a, null);
      const table = document.createElement('table');
      table.innerHTML = '<thead><tr><th>使用 / #</th><th>ΔX</th><th>ΔY</th><th>距離 px</th><th>µm</th></tr></thead>';
      const body = document.createElement('tbody'); table.appendChild(body);
      for (let i = 0; i < Math.max(nHe, nMsi); i++) {
        const p = resid?.perPoint.find(p => p.i === i), included = !landmarks.excluded.includes(i);
        const tr = document.createElement('tr'); tr.dataset.point = i;
        tr.classList.toggle('align-excluded', !included); tr.classList.toggle('align-largest', largest?.i === i);
        tr.innerHTML = `<td><input type="checkbox" data-exclude="${i}" aria-label="対応点 ${i + 1} を計算に使用" ${included ? 'checked' : ''} ${saving || !p ? 'disabled' : ''}> ${i + 1}${largest?.i === i ? ' 最大' : ''}</td>` +
          `<td>${fmt(p?.dx)}</td><td>${fmt(p?.dy)}</td><td>${fmt(p?.d)}</td><td>${fmt(p?.dUm, 1)}</td>`;
        tr.addEventListener('click', () => highlightPoint(i));
        tr.querySelector('input').addEventListener('change', ev => {
          if (saving) { ev.target.checked = included; return; }
          landmarks.excluded = ev.target.checked ? landmarks.excluded.filter(k => k !== i) : [...new Set([...landmarks.excluded, i])];
          pointsChanged(); highlightPoint(i);
        }); body.appendChild(tr);
      }
      q('[data-el=table]').replaceChildren(table);
      const tol = tolerance(), warnings = [];
      if (nHe === nMsi && includedPoints.length > 0 && includedPoints.length < (editModel === 'affine' ? 4 : 3)) warnings.push('独立した確認点を追加して精度を確認してください。');
      if (includedPoints.length >= 3 && geo.spread < .33) warnings.push('点が狭い範囲に集まっています。外周にも対応点を置いてください。');
      if (tol !== null && largest && largest.d > tol) warnings.push(`最大のずれが許容値 ${tol} px を超えています。`);
      const transformState = A.decomposeAffine(T);
      let report = `<div>現在：<b>${currentModel === 'affine' ? 'アフィン' : '相似'}</b> / ${transformState.flip_lr || transformState.flip_ud ? '鏡映あり' : '鏡映なし'}</div>` +
        `<div>RMSE <b>${fmt(resid?.rmse_px)} px</b> / 最大 <b>${fmt(resid?.max_px)} px</b></div>`;
      if (Number.isFinite(resid?.rmse_um)) report += `<div>RMSE ${fmt(resid.rmse_um, 1)} µm / 最大 ${fmt(resid.max_um, 1)} µm</div>`;
      if (autoMeta) report += `<div>適用した自動候補：Dice ${fmt(autoMeta.dice, 4)}</div>`;
      report += warnings.map(w => `<div class="align-warning">${escapeHtml(w)}</div>`).join('');
      q('[data-el=report]').innerHTML = report;
    }
    function refresh() {
      const resid = residuals();
      q('[data-el=status]').textContent = status;
      renderResiduals(resid); renderPreview(); renderPoints(resid); updateEnabled();
    }
    function pointsChanged() {
      if (saving) return;
      landmarks.excluded = landmarks.excluded.filter(i => i < Math.min(landmarks.he.length, landmarks.msi.length));
      fitMethod = 'manual';
      invalidateCandidates('対応点を変更しました。再 Solve 待ちです。現在の変換は保持しています。'); scheduleRefresh();
    }
    function applyCandidate(candidate) {
      if (saving) return;
      T = clone(candidate.T); state = A.decomposeAffine(T); currentModel = candidate.model || state.model; editModel = currentModel;
      inputValid = true; fitMethod = candidate.method; autoMeta = candidate.autoMeta || null;
      q('[data-el=input-error]').textContent = ''; syncParameters();
      status = `「${candidate.label}」をプレビューに適用しました。保存するまで元データは変更されません。`;
      scheduleRefresh();
    }
    function renderCandidates() {
      const container = q('[data-el=candidates]'); container.replaceChildren();
      candidates.forEach((candidate, index) => {
        const state = A.decomposeAffine(candidate.T);
        const resid = A.computeLandmarkResiduals(landmarks, candidate.T, options.msiPitch || worldCoords?.msi_um_per_px);
        const item = document.createElement('div'); item.className = 'align-candidate';
        item.innerHTML = `<strong>${escapeHtml(candidate.label)}</strong>` +
          `<div>RMSE ${fmt(resid?.rmse_px)} px / 最大 ${fmt(resid?.max_px)} px</div>` +
          `<div>${state.flip_lr || state.flip_ud ? '鏡映あり' : '鏡映なし'}</div>` +
          `<div>回転 ${fmt(state.rotate_deg)}° / X ${fmt(state.scale_x_pct)}% / Y ${fmt(state.scale_y_pct)}% / せん断 ${fmt(state.shear, 3)}</div>`;
        if (candidate.autoMeta) item.innerHTML += `<div>Dice ${fmt(candidate.autoMeta.dice, 4)} / 現在の変換との差 ${fmt(candidate.disagreement)} px</div>`;
        if (candidate.warning) {
          const warning = document.createElement('div'); warning.className = 'align-warning'; warning.textContent = candidate.warning; item.appendChild(warning);
        }
        const button = document.createElement('button'); button.dataset.candidateApply = index;
        button.textContent = `${candidate.model === 'affine' ? 'アフィン' : '相似'}候補を適用`;
        button.setAttribute('aria-label', candidate.label + 'を適用');
        button.addEventListener('click', () => applyCandidate(candidate)); item.appendChild(button); container.appendChild(item);
      });
    }
    function close() {
      if (saving || closed) return;
      closed = true; revision++; if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('keydown', keyboard); backdrop.remove(); activeBefore?.focus();
    }
    function keyboard(event) {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const focusables = all('button:not(:disabled),select:not(:disabled),input:not(:disabled),summary').filter(el => el.getClientRects().length);
        const first = focusables[0], last = focusables.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }
    all('[data-p]').forEach(el => {
      const update = () => {
        if (saving) return;
        const key = el.dataset.p;
        state[key] = el.type === 'checkbox' ? el.checked : el.value.trim() === '' ? NaN : Number(el.value);
        try {
          for (const input of all('[data-p]')) {
            if (input.type !== 'checkbox' && !input.closest('[hidden]') && (input.value.trim() === '' || !Number.isFinite(Number(input.value)))) throw new Error('数値を入力してください。直前の有効な変換を表示しています。');
          }
          const candidateState = { ...state, model: editModel };
          const candidateT = A.buildHeToMsiAffine(candidateState);
          if (!A.validateAffine(candidateT)) throw new Error('変換が無効です。スケールは 0 より大きい値にしてください。');
          T = candidateT; currentModel = editModel; inputValid = true; fitMethod = 'manual';
          q('[data-el=input-error]').textContent = '';
          invalidateCandidates('手動調整済み。変換と対応点のずれを即時表示しています。Solve は自動では実行しません。');
        } catch (error) {
          inputValid = false; q('[data-el=input-error]').textContent = error.message;
        }
        updateEnabled(); scheduleRefresh();
      };
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', update);
    });
    q('[data-sel=model]').addEventListener('change', ev => {
      if (saving) return;
      editModel = ev.target.value; state = A.decomposeAffine(T); inputValid = true;
      q('[data-el=input-error]').textContent = ''; syncParameters();
      status = `${editModel === 'affine' ? 'アフィン' : '相似'}モードを選択しました。現在の変換は保持しています。パラメータの編集または候補の適用で変更します。`;
      scheduleRefresh();
    });
    q('[data-sel=reference]').addEventListener('change', ev => { if (saving) return; referenceMode = ev.target.value; refreshReference(); });
    msiSelect.addEventListener('change', () => { if (saving) return; singleKey = msiSelect.value; refreshReference(); });
    all('[data-source-key]').forEach(el => el.addEventListener('change', () => {
      if (saving) return;
      selectedSources = all('[data-source-key]:checked').map(input => input.dataset.sourceKey); refreshReference();
    }));
    q('[data-show-masks]').addEventListener('change', () => { renderReferenceImages(); scheduleRefresh(); });
    q('[data-tolerance]').addEventListener('input', scheduleRefresh);
    all('[data-pick]').forEach(button => button.addEventListener('click', () => {
      if (saving) return;
      pickMode = pickMode === button.dataset.pick ? null : button.dataset.pick;
      all('[data-pane]').forEach(pane => pane.classList.toggle('active', pane.dataset.pane === pickMode));
      all('[data-pick]').forEach(b => b.setAttribute('aria-pressed', b.dataset.pick === pickMode));
    }));
    for (const which of ['he', 'msi']) q(`[data-pane=${which}]`).addEventListener('click', event => {
      if (saving || pickMode !== which || !reference) return;
      const image = which === 'he' ? heImage : msiImage;
      const rect = image.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      landmarks[which].push([x * (which === 'he' ? heImg.naturalWidth : reference.W), y * (which === 'he' ? heImg.naturalHeight : reference.H)]);
      pointsChanged();
    });
    q('[data-act=undo]').addEventListener('click', () => {
      if (saving) return;
      if (landmarks.he.length > landmarks.msi.length) landmarks.he.pop();
      else if (landmarks.msi.length > landmarks.he.length) landmarks.msi.pop();
      else { landmarks.he.pop(); landmarks.msi.pop(); } pointsChanged();
    });
    q('[data-act=clear]').addEventListener('click', () => {
      if (saving) return;
      landmarks.he = []; landmarks.msi = []; landmarks.excluded = []; selectedPoint = -1; pointsChanged();
    });
    q('[data-act=solve]').addEventListener('click', () => {
      if (saving) return;
      invalidateCandidates();
      const errors = [];
      try {
        const fits = A.solveSimilarityCandidates(landmarks);
        fits.forEach((fit, index) => candidates.push({
          ...fit, model: 'similarity', method: 'landmarks-similarity',
          label: `相似・${fit.reflected ? '鏡映あり' : '鏡映なし'}${index === 0 ? '（相似候補の最小残差）' : ''}`,
        }));
      } catch (error) { errors.push('相似: ' + error.message); }
      try {
        const fit = A.solveAffineFromLandmarks(landmarks);
        candidates.push({ ...fit, model: 'affine', method: 'landmarks-affine', label: 'アフィン',
          warning: fit.n === 3 ? '3 点だけでは残差が 0 でも精度を検証できません。独立した確認点を追加してください。' : null });
      } catch (error) { errors.push('アフィン: ' + error.message); }
      q('[data-el=solve-error]').textContent = errors.join(' / ');
      status = candidates.length ? '候補を計算しました。現在の変換と比較し、「この候補を適用」で選択してください。' : '候補を計算できませんでした。対応点を確認してください。';
      renderCandidates(); scheduleRefresh();
    });
    q('[data-act=auto]').addEventListener('click', async () => {
      if (saving || !reference) return;
      invalidateCandidates();
      const requestRevision = revision, referenceAtStart = reference, button = q('[data-act=auto]');
      button.disabled = true; button.textContent = '組織シルエットから計算中…';
      await new Promise(resolve => requestAnimationFrame(resolve));
      try {
        if (closed || requestRevision !== revision) return;
        const hm = getHeMask();
        if (!hm || !msiMask) throw new Error('組織マスクを抽出できません。マスク表示と参照画像を確認してください。');
        const hePitch = worldCoords?.he_um_per_px, msiPitch = options.msiPitch || worldCoords?.msi_um_per_px;
        const mean = p => p?.x > 0 && p?.y > 0 ? (Number(p.x) + Number(p.y)) / 2 : 0;
        const lockScale = mean(hePitch) && mean(msiPitch) ? mean(hePitch) / mean(msiPitch) : 0;
        const auto = A.autoAlignSilhouette(hm, msiMask, lockScale ? { lockScale } : null);
        if (!auto) throw new Error('シルエットからの推定に失敗しました。');
        if (closed || requestRevision !== revision || reference !== referenceAtStart) return;
        const candidateT = A.buildHeToMsiAffine(auto.state);
        const warnings = [];
        if (!auto.reliableRotation) warnings.push('組織がほぼ回転対称のため、角度や鏡映を対応点で確認してください。');
        if (auto.scaleLocked && Math.abs(auto.areaScaleRatio - 1) > .05) warnings.push('組織面積から推定したスケールと µm/px 設定が異なります。');
        candidates = [{
          T: candidateT, model: 'similarity', method: 'silhouette-v2', label: 'シルエット自動推定（相似変換）',
          disagreement: A.transformDisagreementPx(hm, T, candidateT), warning: warnings.join(' '),
          autoMeta: { method: 'silhouette-v2', dice: auto.dice, aniso: auto.aniso, reliableRotation: auto.reliableRotation,
            scaleLocked: auto.scaleLocked, sigmaPx: auto.sigmaPx, referenceFingerprint: reference.sourceFingerprint, ts: Date.now() },
        }];
        status = 'シルエットの相似変換候補を計算しました。現在の変換は保持しています。対応点のずれも確認してください。';
        renderCandidates(); scheduleRefresh();
      } catch (error) {
        if (!closed && requestRevision === revision) q('[data-el=solve-error]').textContent = error.message;
      } finally {
        if (!closed) { button.textContent = '自動推定の候補を計算（シルエット）'; updateEnabled(); }
      }
    });
    all('[data-act=close]').forEach(button => button.addEventListener('click', close));
    backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
    q('[data-act=apply]').addEventListener('click', async () => {
      if (saving || !inputValid || !reference || !A.validateAffine(T)) return;
      saving = true; const disabledStates = all('input,select,button').map(el => [el, el.disabled]);
      disabledStates.forEach(([el]) => { el.disabled = true; }); q('[data-el=save-error]').textContent = '';
      try {
        const parameters = A.decomposeAffine(T), resid = residuals();
        const alignment = {
          schemaVersion: 2, T_he_to_msi: clone(T), ...parameters,
          // The explicit selected model survives an affine fit that happens to be a similarity.
          model: currentModel,
          landmarks: clone(landmarks), reference: clone(reference.metadata),
          // Unknown physical pitch / no included points are represented as null
          // consistently in IndexedDB, exported ZIP and cloud JSON.
          fit: { method: fitMethod, tolerancePx: tolerance(), residuals: resid ? JSON.parse(JSON.stringify(resid)) : null, timestamp: Date.now() },
          ...(autoMeta ? { autoAligned: clone(autoMeta) } : {}),
          ...(previousAutoMeta ? { previousAutoAligned: clone(previousAutoMeta) } : {}),
        };
        await save(clone(T), alignment);
        saving = false; close();
      } catch (error) {
        q('[data-el=save-error]').textContent = `保存できませんでした。編集内容をこの画面に保持しています。${error.message}`;
        saving = false; disabledStates.forEach(([el, disabled]) => { el.disabled = disabled; }); updateEnabled(); scheduleRefresh();
      }
    });
    document.addEventListener('keydown', keyboard);
    heImage.addEventListener('load', scheduleRefresh); msiImage.addEventListener('load', scheduleRefresh);
    syncParameters(); refreshReference();
    if (saved?.autoAligned) {
      const matchingReference = reference && ['mode', 'sourceKeys', 'quantile', 'quantileMethod', 'recipe', 'sourceFingerprint']
        .every(key => JSON.stringify(saved.reference?.[key]) === JSON.stringify(reference.metadata?.[key]));
      if (matchingReference && saved.autoAligned.referenceFingerprint === reference.sourceFingerprint) autoMeta = clone(saved.autoAligned);
      else previousAutoMeta = { ...clone(saved.autoAligned), stale: true };
    }
    status = '保存済みの変換を表示しています。候補の計算だけでは変換は変わりません。';
    q('[data-sel=reference]').focus();
    return { close, element: backdrop };
  }
  global.AlignmentModal = { open };
})(typeof window !== 'undefined' ? window : globalThis);
