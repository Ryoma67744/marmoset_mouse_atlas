/* Analysis UI uses loaded scientific rasters, independently of 3D visibility. */
(function (global) {
  'use strict';
  const KEY = 'atlas-stack3d-analysis-v1';
  const MODES = ['selected', 'by-section', 'pooled'];
  const CHANNELS = ['DA', 'NE', '5-HT'];
  const fmt = value => Number.isFinite(value) ? Number(value.toPrecision(5)).toLocaleString('en-US', { maximumSignificantDigits: 5 }) : '—';
  const count = value => Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
  function element(tag, className, text) {
    const node = document.createElement(tag); if (className) node.className = className;
    if (text !== undefined) node.textContent = text; return node;
  }
  function rangeText(numbers) {
    const result = []; let start, end;
    for (const number of [...numbers, NaN]) {
      if (start === undefined) { start = end = number; continue; }
      if (number === end + 1) { end = number; continue; }
      result.push(start === end ? String(start) : start + '-' + end); start = end = number;
    }
    return result.join(', ');
  }
  function create(options) {
    const root = options.root, core = global.Stack3DAnalysis;
    if (!root || !core || !global.IntensityBoxPlot) throw new Error('3D分析の描画機能を読み込めませんでした。');
    const state = { mode: 'selected', scope: 'all', sectionIds: [], roiNames: [], allRois: true, singleRoi: '', loading: true, result: null };
    let sections = [], availableNames = [], initialized = false, disposed = false, generation = 0;
    let controller = null, frame = 0, resizeFrame = 0, drawCallbacks = [], lastWidth = 0;
    let selectionNotice = '', failure = '', stale = false, staleIds = new Set(), lastOptions = '';
    const listeners = [], worker = global.Stack3DAnalysisWorker?.create();
    function listen(target, event, handler) { target.addEventListener(event, handler); listeners.push([target, event, handler]); }
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY));
      if (saved && MODES.includes(saved.mode)) {
        state.mode = saved.mode; state.scope = saved.scope === 'ids' ? 'ids' : 'all';
        state.sectionIds = Array.isArray(saved.sectionIds) ? [...new Set(saved.sectionIds.filter(id => typeof id === 'string'))] : [];
        state.roiNames = Array.isArray(saved.roiNames) ? [...new Set(saved.roiNames.filter(name => typeof name === 'string'))] : [];
        state.allRois = saved.allRois !== false; state.singleRoi = typeof saved.singleRoi === 'string' ? saved.singleRoi : '';
      }
    } catch (_) {}
    root.classList.add('analysis-panel');
    root.innerHTML = '<div id="analysis-resizer" role="separator" tabindex="0" aria-label="グラフ領域の高さ" aria-orientation="horizontal" aria-controls="analysis-panel" title="ドラッグまたは上下矢印キーで高さを変更。ダブルクリックで元に戻す"></div>' +
      '<div class="analysis-header"><strong id="analysis-title">INTENSITY BOX PLOT</strong><span id="analysis-value-badge"></span><button id="analysis-expand" type="button" aria-pressed="false">拡大</button><button id="analysis-collapse" type="button" aria-expanded="true" aria-controls="analysis-body">折りたたむ</button></div>' +
      '<div id="analysis-body" class="analysis-body"><div class="analysis-controls"><div class="analysis-mode-row"><div class="analysis-modes" role="group" aria-label="グラフのまとめ方"><button type="button" data-analysis-mode="selected">選択切片</button><button type="button" data-analysis-mode="by-section">切片ごとに比較</button><button type="button" data-analysis-mode="pooled">同名領域を統合</button></div><span id="analysis-pooling-note"></span></div>' +
      '<div class="analysis-target"><span id="analysis-target-detail"></span><details id="analysis-target-list"><summary>対象切片一覧</summary><ul></ul></details></div><div class="analysis-range-controls"><label for="analysis-range">集計する切片（一覧番号）</label><input id="analysis-range" type="text" placeholder="5-20,24,30-35" autocomplete="off" aria-describedby="analysis-range-error"><button id="analysis-apply-range" type="button">適用</button><button id="analysis-all-sections" type="button">全切片</button><button id="analysis-use-display" type="button">3D表示範囲を取り込む</button></div>' +
      '<p id="analysis-range-error" role="alert" hidden></p><p id="analysis-selection-note" hidden></p><div class="analysis-roi-controls"><span>グラフの領域</span><div id="analysis-roi-checks"></div><select id="analysis-single-roi" aria-label="切片ごとに比較する領域"></select></div></div>' +
      '<p id="analysis-stale" role="status" hidden></p><p id="analysis-status" role="status" aria-live="polite"></p><div class="analysis-legend"><span>箱 P25–P75・中央値 ｜ ひげ P0–P99</span><span><i class="analysis-blue-dot"></i>≤ P99</span><span><i class="analysis-red-dot"></i>&gt; P99（集計に含む）</span></div><div id="analysis-charts"></div>' +
      '<p class="analysis-footnote">n＝有限値の画素数。SD＝画素間の母標準偏差。統計量は元のROIの全有効画素から算出し、3Dの透過・表示範囲には依存しません。分子ごとに軸と単位が異なります。</p></div>';
    const $ = id => root.querySelector('#' + id);
    const modeButtons = [...root.querySelectorAll('[data-analysis-mode]')];
    function save() {
      try { sessionStorage.setItem(KEY, JSON.stringify({ mode: state.mode, scope: state.scope, sectionIds: state.sectionIds,
        roiNames: state.roiNames, allRois: state.allRois, singleRoi: state.singleRoi })); } catch (_) {}
    }
    function selectedSection() {
      const selected = options.getSelected();
      return typeof selected === 'number' ? sections[selected] : sections.find(section => section.id === (selected?.id || selected));
    }
    function targetIds() {
      if (state.mode === 'selected') return selectedSection() ? [selectedSection().id] : [];
      return state.scope === 'all' ? sections.map(section => section.id) : sections.filter(section => state.sectionIds.includes(section.id)).map(section => section.id);
    }
    function currentOptions() {
      const value = options.getOptions() || {};
      return { channels: CHANNELS.filter(channel => (value.channels || CHANNELS).includes(channel)), valueMode: value.mode === 'normalized' ? 'normalized' : 'raw' };
    }
    function updateRois() {
      const wanted = new Set(targetIds());
      // In comparison/pooled modes a known ROI may be absent from this subset.
      // Keep it selectable so absence is reported, rather than silently dropped.
      availableNames = core.regionCatalog(state.mode === 'selected' ? sections.filter(section => wanted.has(section.id)) : sections).map(row => row.name);
      if (state.allRois) state.roiNames = availableNames.slice();
      // Retain unchecked/temporarily absent names so switching sections does not erase choices.
      if (!availableNames.includes(state.singleRoi)) state.singleRoi = availableNames[0] || '';
      $('analysis-roi-checks').replaceChildren();
      const allLabel = element('label', 'analysis-roi-option'), allInput = document.createElement('input');
      allInput.type = 'checkbox'; allInput.id = 'analysis-all-rois'; allInput.checked = state.allRois;
      allInput.addEventListener('change', () => { state.allRois = allInput.checked; state.roiNames = allInput.checked ? availableNames.slice() : []; updateRois(); schedule(); });
      allLabel.append(allInput, '全領域'); $('analysis-roi-checks').append(allLabel);
      for (const name of availableNames) {
        const label = element('label', 'analysis-roi-option'), input = document.createElement('input');
        input.type = 'checkbox'; input.dataset.roiName = name; input.checked = state.roiNames.includes(name);
        input.addEventListener('change', () => {
          state.allRois = false; $('analysis-all-rois').checked = false;
          const names = new Set(state.roiNames); if (input.checked) names.add(name); else names.delete(name);
          state.roiNames = [...names]; schedule();
        });
        label.append(input, name); $('analysis-roi-checks').append(label);
      }
      $('analysis-single-roi').replaceChildren(...availableNames.map(name => new Option(name, name)));
      $('analysis-single-roi').value = state.singleRoi;
    }
    function updateControls() {
      const selectedMode = state.mode === 'selected', ids = targetIds(), opts = currentOptions();
      for (const button of modeButtons) { button.setAttribute('aria-pressed', String(button.dataset.analysisMode === state.mode)); button.disabled = state.loading || !sections.length; }
      for (const id of ['analysis-range', 'analysis-apply-range', 'analysis-all-sections', 'analysis-use-display']) $(id).disabled = selectedMode || state.loading || !sections.length;
      $('analysis-roi-checks').hidden = state.mode === 'by-section'; $('analysis-single-roi').hidden = state.mode !== 'by-section';
      for (const input of root.querySelectorAll('.analysis-roi-controls input,.analysis-roi-controls select')) input.disabled = state.loading || !sections.length;
      $('analysis-value-badge').textContent = opts.valueMode === 'normalized' ? '補正値' : '原値';
      $('analysis-pooling-note').textContent = state.mode === 'pooled' ? '全有効画素を統合（画素数による重み）' : state.mode === 'by-section' ? '同じ領域を切片ごとに比較' : '選択中の切片にある領域を比較';
      const numbers = sections.flatMap((section, index) => ids.includes(section.id) ? [index + 1] : []);
      const names = sections.filter(section => ids.includes(section.id)).map(section => section.name);
      $('analysis-target-detail').textContent = ids.length ? (selectedMode ? `${numbers[0]} / ${sections.length} · ${names[0]}` : `${state.scope === 'all' ? '全' : '一覧番号 ' + rangeText(numbers) + ' · '}${ids.length}切片 / 読込 ${sections.length}切片`) : '集計対象の切片がありません';
      const targetList = $('analysis-target-list'); targetList.hidden = !ids.length || selectedMode;
      targetList.querySelector('summary').textContent = `対象切片一覧 (${ids.length})`;
      targetList.querySelector('ul').replaceChildren(...sections.flatMap((section, index) => {
        if (!ids.includes(section.id)) return [];
        const row = element('li', '', `${index + 1}. ${section.name}`); row.dataset.sectionId = section.id; return [row];
      }));
      $('analysis-selection-note').textContent = selectionNotice; $('analysis-selection-note').hidden = !selectionNotice;
      $('analysis-stale').hidden = !stale;
      $('analysis-stale').textContent = '登録データが更新されています。グラフは更新前の読込データです。「再読込」で最新の内容を反映してください。';
      root.dataset.analysisMode = state.mode; root.dataset.mode = state.mode;
    }
    function syncRangeInput() {
      const ids = state.scope === 'all' ? sections.map(section => section.id) : state.sectionIds;
      $('analysis-range').value = rangeText(sections.flatMap((section, index) => ids.includes(section.id) ? [index + 1] : []));
    }
    function setError(message) { $('analysis-range-error').textContent = message; $('analysis-range-error').hidden = !message; $('analysis-range').setAttribute('aria-invalid', String(!!message)); }
    function cancel() {
      generation++; controller?.abort(); controller = null; cancelAnimationFrame(frame); frame = 0;
    }
    function clearResults(message) {
      state.result = null; drawCallbacks = []; $('analysis-charts').replaceChildren(); $('analysis-status').textContent = message || '';
      root.setAttribute('aria-busy', 'false');
    }
    function reasons(codes) {
      const local = { ROI_MISSING: '対象ROIなし', CHANNEL_MISSING: '分子データなし', NO_VALUES: '有効画素なし', NO_VALID_PIXELS: '有効画素なし',
        UNIT_MISMATCH: '補正値の単位が一致しません', NORMALIZATION_GROUP_MISMATCH: '補正グループが一致しません', NORMALIZATION_REFERENCE_MISMATCH: '補正基準が一致しません',
        NORMALIZATION_UNAVAILABLE: '補正値を算出できません', NORMALIZATION_SCOPE_UNVERIFIED: '補正基準グループが未確認です',
        NORMALIZATION_SCOPE_INCOMPATIBLE: '補正グループの状態が一致しません',
        NORMALIZATION_INCOMPATIBLE: '補正方法・単位・保存基準が異なります' };
      return [...new Set(codes || [])].map(code => local[code] || global.Normalization?.reasonText?.(code) || code).join('・');
    }
    function tableFor(groups) {
      const wrap = element('div', 'analysis-table-wrap'), table = element('table', 'analysis-table');
      table.setAttribute('aria-label', 'ROIと切片の集計統計');
      const head = document.createElement('thead'), header = document.createElement('tr');
      for (const label of [state.mode === 'by-section' ? '切片' : '領域', '中央値 [P25–P75]', '平均 ± SD', '画素 n', '対象 / 存在 / 採用切片']) header.append(element('th', '', label));
      head.append(header); table.append(head); const body = document.createElement('tbody');
      for (const group of groups) {
        const row = document.createElement('tr'); row.dataset.groupKey = group.key; row.dataset.roiName = group.roiName || '';
        if (group.sectionId) row.dataset.sectionId = group.sectionId;
        const label = document.createElement('td');
        if (state.mode === 'by-section' && group.sectionId && typeof options.onSelect === 'function') {
          const button = element('button', 'analysis-section-link', group.name);
          button.type = 'button'; button.addEventListener('click', () => options.onSelect(group.sectionId)); label.append(button);
        } else label.textContent = group.name;
        if (group.roiName && state.mode === 'by-section') label.append(element('small', '', group.roiName));
        row.append(label);
        const d = group.distribution, stats = group.statistics || {}, counts = group.counts || {};
        const values = [
          ['median', d ? `${fmt(d.median)} [${fmt(d.q1)}–${fmt(d.q3)}]` : '算出不可'],
          ['mean', d ? `${fmt(stats.mean)} ± ${fmt(stats.sd)}` : '—'],
          ['count', count(counts.nIncluded)],
          ['sections', `${count(counts.targetSections)} / ${count(counts.roiSections)} / ${count(counts.includedSections)}`]
        ];
        for (const [key, value] of values) { const cell = element('td', '', value); cell.dataset.stat = key; row.append(cell); }
        const detail = element('small', 'analysis-count-detail', `有効 ${count(counts.nValid)} / 測定 ${count(counts.nMeasured)} / ROI ${count(counts.nGeometry)}`);
        row.querySelector('[data-stat=count]').append(detail);
        const selected = state.mode === 'by-section' && group.sectionId === selectedSection()?.id;
        row.setAttribute('aria-selected', String(selected));
        if (selected) row.classList.add('analysis-selected');
        body.append(row);
      }
      table.append(body); wrap.append(table); return wrap;
    }
    function redraw() {
      if (disposed || root.classList.contains('analysis-collapsed')) return;
      for (const draw of drawCallbacks) draw();
    }
    function requestRedraw() {
      cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(redraw);
    }
    function renderResults() {
      const result = state.result; if (!result) return;
      const charts = $('analysis-charts'), scrollTop = charts.scrollTop;
      const scrolls = new Map([...charts.querySelectorAll('.analysis-molecule')].map(card => [card.dataset.channel, card.querySelector('.analysis-plot')?.scrollLeft || 0]));
      charts.replaceChildren(); drawCallbacks = [];
      for (const channel of result.channels) {
        const card = element('section', 'analysis-molecule'); card.dataset.channel = channel.key;
        const heading = element('div', 'analysis-molecule-heading'); heading.append(element('strong', '', channel.name || channel.key), element('span', '', channel.unit || ''));
        card.append(heading);
        if (channel.status === 'BLOCKED') card.append(element('p', 'analysis-unavailable', '補正値の集計を停止しました：' + reasons(channel.compatibility?.reasonCodes)));
        const warnings = new Set(channel.groups.flatMap(group => group.warnings || []));
        if (warnings.has('MIXED_PIXEL_SIZE')) card.append(element('p', 'analysis-warning', '画素サイズが異なる切片を含みます。各画素を同じ重みで集計し、面積・体積による重み付けはしていません。'));
        const plot = element('div', 'analysis-plot'), canvas = document.createElement('canvas'); plot.append(canvas); card.append(plot); charts.append(card);
        const draw = () => {
          if (!plot.isConnected || root.classList.contains('analysis-collapsed')) return;
          const selectedId = selectedSection()?.id;
          const highlight = state.mode === 'by-section' ? channel.groups.find(group => group.sectionId === selectedId)?.key : null;
          global.IntensityBoxPlot.draw(canvas, { width: Math.max(300, plot.clientWidth), height: 228,
            title: channel.name || channel.key, unit: channel.unit, highlightRoiKey: highlight,
            rois: channel.groups.map(group => ({ key: group.key, name: group.name, distribution: group.distribution })),
            onSelect: state.mode === 'by-section' && typeof options.onSelect === 'function' ? key => {
              const group = channel.groups.find(item => item.key === key); if (group?.sectionId) options.onSelect(group.sectionId);
            } : undefined });
        };
        drawCallbacks.push(draw); draw(); plot.scrollLeft = scrolls.get(channel.key) || 0;
        card.append(tableFor(channel.groups));
        const acceptedWarnings = [...new Set(channel.groups.flatMap(group => group.reasonCodes || []))];
        if (acceptedWarnings.length) card.append(element('p', 'analysis-warning', reasons(acceptedWarnings)));
        const exclusions = channel.groups.flatMap(group => (group.exclusions || []).map(item => ({ ...item, roiName: group.roiName })));
        if (exclusions.length) {
          const details = element('details', 'analysis-exclusions'); details.append(element('summary', '', `除外・算出不可の内訳 (${exclusions.length})`));
          const list = document.createElement('ul');
          for (const item of exclusions) list.append(element('li', '', `${item.sectionName || item.sectionId} · ${item.roiName}: ${reasons([item.code, ...(item.reasonCodes || [])].filter(Boolean))}`));
          details.append(list); card.append(details);
        }
        const sampled = channel.groups.filter(group => group.distribution?.sampled);
        if (sampled.length) card.append(element('p', 'analysis-sampling-note', '点群のみ間引き表示。通常域とP99超の範囲から抽出し、箱・統計は全有効画素で計算。' + sampled.map(group => `${group.name}: 表示 ${count(group.distribution.points.length)} / 統計 ${count(group.distribution.n)}`).join('、')));
      }
      charts.scrollTop = scrollTop;
      $('analysis-status').textContent = result.channels.length ? `${result.selection.count}切片を集計 · ${result.channels.length}分子${stale ? ' · 更新前の読込データ' : ''}` : '左側で表示する分子を選択してください。';
    }
    async function calculate(token) {
      frame = 0; if (disposed || state.loading || token !== generation) return;
      updateControls(); const ids = targetIds(), opts = currentOptions();
      const names = state.mode === 'by-section' ? [state.singleRoi].filter(Boolean) : state.roiNames.filter(name => availableNames.includes(name));
      if (!ids.length || !names.length || !opts.channels.length) {
        clearResults(!ids.length ? '集計対象の切片がありません。範囲を指定してください。' : !names.length ? 'グラフに表示する領域を選択してください。' : '左側で表示する分子を選択してください。'); return;
      }
      controller = new AbortController();
      clearResults('集計中…'); root.setAttribute('aria-busy', 'true');
      try {
        const result = await core.analyze(sections, { mode: state.mode, sectionIds: ids, roiNames: names, ...opts }, {
          signal: controller.signal, summarize: options.summarize || worker?.summarize,
          onProgress(progress) { if (token === generation && !disposed) $('analysis-status').textContent = `集計中… ${progress.completed} / ${progress.total}`; }
        });
        if (token !== generation || disposed) return;
        state.result = result; renderResults();
      } catch (error) {
        if (token !== generation || disposed || error?.name === 'AbortError') return;
        clearResults('集計できませんでした：' + error.message);
      } finally { if (token === generation && !disposed) { root.setAttribute('aria-busy', 'false'); controller = null; } }
    }
    function schedule() {
      if (disposed) return; cancel(); updateControls(); save();
      if (!state.loading) { const token = generation; frame = requestAnimationFrame(() => calculate(token)); }
    }
    function applyRange() {
      try {
        const parsed = core.parseSelection($('analysis-range').value, sections);
        state.scope = 'ids'; state.sectionIds = parsed.sectionIds; selectionNotice = '';
        setError(''); syncRangeInput(); updateRois(); schedule(); return true;
      } catch (error) { setError(error.message); return false; }
    }
    for (const button of modeButtons) listen(button, 'click', () => { state.mode = button.dataset.analysisMode; updateRois(); schedule(); });
    listen($('analysis-apply-range'), 'click', applyRange);
    listen($('analysis-range'), 'keydown', event => { if (event.key === 'Enter') { event.preventDefault(); applyRange(); } });
    listen($('analysis-all-sections'), 'click', () => { state.scope = 'all'; state.sectionIds = sections.map(section => section.id); selectionNotice = ''; setError(''); syncRangeInput(); updateRois(); schedule(); });
    listen($('analysis-use-display'), 'click', () => {
      const displayed = new Set(options.getDisplayedSectionIds ? options.getDisplayedSectionIds() : []);
      const ids = sections.filter(section => displayed.has(section.id)).map(section => section.id);
      if (!ids.length) { setError('現在3Dに表示されている切片がありません。集計対象は変更していません。'); return; }
      state.scope = 'ids'; state.sectionIds = ids; selectionNotice = '現在の3D表示範囲を取り込みました。その後の3D操作で集計対象は変わりません。';
      setError(''); syncRangeInput(); updateRois(); schedule();
    });
    listen($('analysis-single-roi'), 'change', event => { state.singleRoi = event.target.value; schedule(); });
    const observer = global.ResizeObserver ? new ResizeObserver(() => {
      const width = $('analysis-charts').clientWidth;
      if (width !== lastWidth) { lastWidth = width; requestRedraw(); }
    }) : null;
    observer?.observe($('analysis-charts'));
    const layout = global.Stack3DAnalysisResize?.create({ panel: root, scenePanel: root.closest('.scene-panel'), scene: document.getElementById('scene'), onResize: requestRedraw });
    updateControls();
    return {
      beginLoad() { cancel(); state.loading = true; sections = []; core.clearCache(); failure = ''; stale = false; staleIds.clear(); clearResults('切片を読み込んでいます…'); root.setAttribute('aria-busy', 'true'); updateControls(); },
      setSections() {
        cancel();
        // Placement saves can replace the live project object with a newer ROI.
        // Keep the loaded geometry/profile metadata paired with its loaded rasters.
        sections = (options.getSections() || []).map(section => ({ ...section,
          project: typeof global.structuredClone === 'function' ? global.structuredClone(section.project) : JSON.parse(JSON.stringify(section.project)),
          channels: { ...section.channels } }));
        state.loading = false; stale = false; staleIds.clear(); failure = '';
        const ids = new Set(sections.map(section => section.id));
        if (state.scope === 'all') state.sectionIds = sections.map(section => section.id);
        else {
          const removed = state.sectionIds.filter(id => !ids.has(id));
          if (removed.length) selectionNotice = `${removed.length}切片が今回の読込集合にないため、対象から外しました。対象の切片名を確認してください。`;
          state.sectionIds = state.sectionIds.filter(id => ids.has(id));
        }
        initialized = true; updateRois(); syncRangeInput(); setError(''); lastOptions = JSON.stringify(currentOptions()); schedule();
      },
      loadFailed(message) { cancel(); state.loading = false; sections = []; core.clearCache(); failure = message?.message || String(message || '切片を読み込めませんでした。'); clearResults(failure); root.setAttribute('aria-busy', 'false'); updateControls(); },
      selectionChanged() {
        if (!initialized || disposed || state.loading) return;
        if (state.mode === 'selected') { updateRois(); schedule(); }
        else { updateControls(); if (state.result) renderResults(); }
      },
      valueModeChanged() {
        const next = JSON.stringify(currentOptions());
        if (next === lastOptions) return; lastOptions = next; schedule();
      },
      markStale(ids) {
        if (Array.isArray(ids)) for (const id of ids) staleIds.add(id);
        else for (const section of sections) staleIds.add(section.id);
        stale = staleIds.size > 0; updateControls();
        if (state.result) $('analysis-status').textContent += $('analysis-status').textContent.includes('更新前') ? '' : ' · 更新前の読込データ';
      },
      getState() { return { ...state, sectionIds: state.sectionIds.slice(), roiNames: state.roiNames.slice(), targetIds: targetIds(), stale, failure, generation, layout: layout?.getState() }; },
      dispose() { cancel(); disposed = true; save(); observer?.disconnect(); layout?.dispose(); worker?.dispose(); core.clearCache(); sections = []; cancelAnimationFrame(resizeFrame); for (const [target, event, handler] of listeners) target.removeEventListener(event, handler); drawCallbacks = []; state.result = null; }
    };
  }
  global.Stack3DAnalysisUI = { create };
})(window);
