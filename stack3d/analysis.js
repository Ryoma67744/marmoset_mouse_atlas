/* Analysis UI uses loaded scientific rasters, independently of 3D visibility. */
(function (global) {
  'use strict';
  const KEY = 'atlas-stack3d-analysis-v1';
  const MODES = ['selected', 'by-section', 'pooled'];
  const CHANNELS = ['DA', 'NE', '5-HT'];
  const CHANNEL_NAMES = { DA: 'Dopamine', NE: 'Norepinephrine', '5-HT': 'Serotonin' };
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
    const state = { mode: 'selected', scope: 'all', sectionIds: [], roiNames: [], allRois: true, singleRoi: '',
      activeMolecule: 'DA', axisMode: 'auto', toolbarMinimized: false, loading: true, result: null };
    let sections = [], availableNames = [], initialized = false, disposed = false, generation = 0;
    let controller = null, frame = 0, resizeFrame = 0, drawCallbacks = [], lastSize = '';
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
        state.activeMolecule = CHANNELS.includes(saved.activeMolecule) ? saved.activeMolecule : 'DA';
        state.axisMode = saved.axisMode === 'full' ? 'full' : 'auto'; state.toolbarMinimized = saved.toolbarMinimized === true;
      }
    } catch (_) {}
    root.classList.add('analysis-panel');
    root.innerHTML = '<div id="analysis-resizer" role="separator" tabindex="0" aria-label="グラフ領域の高さ" aria-orientation="horizontal" aria-controls="analysis-panel" title="ドラッグまたは上下矢印キーで高さを変更。ダブルクリックで元に戻す"></div>' +
      '<div class="analysis-header"><strong id="analysis-title">INTENSITY BOX PLOT</strong><span id="analysis-value-badge"></span><button id="analysis-focus" type="button" aria-pressed="false">解析を広く表示</button><button id="analysis-expand" type="button" aria-pressed="false">拡大</button><button id="analysis-collapse" type="button" aria-expanded="true" aria-controls="analysis-body">折りたたむ</button><button id="analysis-toolbar-toggle" type="button" aria-expanded="true" aria-controls="analysis-toolbar">操作部を最小化</button></div>' +
      '<div class="analysis-minibar" aria-label="最小化したグラフ操作部"><label class="analysis-mini-molecule"><span>分子</span><select id="analysis-molecule-select" aria-label="グラフに表示する分子"></select></label><span id="analysis-mini-summary"></span><span id="analysis-mini-axis"></span><button id="analysis-mini-focus" type="button" aria-pressed="false">解析を広く表示</button><button id="analysis-toolbar-expand" type="button" aria-expanded="false" aria-controls="analysis-toolbar">操作部を表示</button></div>' +
      '<div id="analysis-body" class="analysis-body"><div id="analysis-toolbar"><div class="analysis-molecule-tabs" role="group" aria-label="グラフに表示する分子"><span class="analysis-molecule-label">表示する分子</span></div><div class="analysis-mode-row"><div class="analysis-modes" role="group" aria-label="グラフのまとめ方"><button type="button" data-analysis-mode="selected">選択切片</button><button type="button" data-analysis-mode="by-section">切片ごとに比較</button><button type="button" data-analysis-mode="pooled">同名領域を統合</button></div><label class="analysis-axis-control">縦軸<select id="analysis-axis-mode"><option value="auto">自動（P99基準）</option><option value="full">全範囲</option></select></label><span id="analysis-pooling-note"></span></div><details class="analysis-controls"><summary id="analysis-conditions-summary">集計条件を変更</summary>' +
      '<div class="analysis-target"><span id="analysis-target-detail"></span><details id="analysis-target-list"><summary>対象切片一覧</summary><ul></ul></details></div><div class="analysis-range-controls"><label for="analysis-range">集計する切片（一覧番号）</label><input id="analysis-range" type="text" placeholder="5-20,24,30-35" autocomplete="off" aria-describedby="analysis-range-error"><button id="analysis-apply-range" type="button">適用</button><button id="analysis-all-sections" type="button">全切片</button><button id="analysis-use-display" type="button">3D表示範囲を取り込む</button></div>' +
      '<p id="analysis-range-error" role="alert" hidden></p><p id="analysis-selection-note" hidden></p><div class="analysis-roi-controls"><span>グラフの領域</span><div id="analysis-roi-checks"></div><select id="analysis-single-roi" aria-label="切片ごとに比較する領域"></select></div></details>' +
      '<div class="analysis-legend"><span>箱 P25–P75・中央値 ｜ ひげ P0–P99</span><span><i class="analysis-blue-dot"></i>≤ P99</span><span><i class="analysis-red-dot"></i>&gt; P99（集計に含む）</span><span>↑ 表示上限を超える画素（統計に含む）</span></div></div><p id="analysis-stale" role="status" hidden></p><p id="analysis-status" role="status" aria-live="polite"></p><div id="analysis-charts"></div>' +
      '<p class="analysis-footnote">n＝有限値の画素数。SD＝画素間の母標準偏差。統計量は元のROIの全有効画素から算出し、3Dの透過・表示範囲には依存しません。分子ごとに軸と単位が異なります。</p></div>';
    const $ = id => root.querySelector('#' + id);
    const modeButtons = [...root.querySelectorAll('[data-analysis-mode]')];
    const moleculeButtons = CHANNELS.map(channel => {
      const button = element('button', 'analysis-molecule-tab'); button.type = 'button'; button.dataset.analysisMolecule = channel;
      button.setAttribute('aria-controls', 'analysis-charts');
      const dot = element('i', 'analysis-molecule-dot'); dot.dataset.channel = channel; dot.setAttribute('aria-hidden', 'true');
      button.append(dot, element('strong', '', channel), element('span', 'analysis-molecule-name', CHANNEL_NAMES[channel]));
      root.querySelector('.analysis-molecule-tabs').append(button); $('analysis-molecule-select').append(new Option(channel, channel));
      return button;
    });
    function save() {
      try { sessionStorage.setItem(KEY, JSON.stringify({ mode: state.mode, scope: state.scope, sectionIds: state.sectionIds,
        roiNames: state.roiNames, allRois: state.allRois, singleRoi: state.singleRoi, activeMolecule: state.activeMolecule,
        axisMode: state.axisMode, toolbarMinimized: state.toolbarMinimized })); } catch (_) {}
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
    function updateDisplay() {
      const available = currentOptions().channels;
      if (available.length && !available.includes(state.activeMolecule)) state.activeMolecule = available[0];
      for (const button of moleculeButtons) {
        button.disabled = state.loading || !available.includes(button.dataset.analysisMolecule);
        button.setAttribute('aria-pressed', String(button.dataset.analysisMolecule === state.activeMolecule));
      }
      for (const option of $('analysis-molecule-select').options) option.disabled = !available.includes(option.value);
      $('analysis-molecule-select').disabled = state.loading || !available.length;
      $('analysis-molecule-select').value = state.activeMolecule;
      $('analysis-axis-mode').value = state.axisMode;
      $('analysis-mini-axis').textContent = state.axisMode === 'auto' ? '自動軸' : '全範囲';
      root.classList.toggle('analysis-toolbar-minimized', state.toolbarMinimized);
      $('analysis-toolbar-toggle').setAttribute('aria-expanded', String(!state.toolbarMinimized));
      $('analysis-toolbar-expand').setAttribute('aria-expanded', String(!state.toolbarMinimized));
      for (const card of $('analysis-charts').children) {
        card.hidden = card.dataset.channel !== state.activeMolecule;
        if (card.hidden) card.querySelector('.analysis-plot-pages')?.replaceChildren();
      }
      const ids = new Set(targetIds()), numbers = sections.flatMap((section, index) => ids.has(section.id) ? [index + 1] : []);
      const mode = { selected: '選択切片', 'by-section': '切片ごとに比較', pooled: '同名領域を統合' }[state.mode];
      // Use committed selection IDs, never the editable (possibly unapplied) input.
      const target = state.mode === 'selected' ? selectedSection()?.name || '対象なし' : numbers.length ? `一覧 ${rangeText(numbers)} · ${numbers.length}切片` : '対象なし';
      const summary = `${mode} · ${target} · ${currentOptions().valueMode === 'normalized' ? '補正値' : '原値'}`;
      $('analysis-mini-summary').textContent = summary; $('analysis-mini-summary').title = summary;
    }
    function setActiveMolecule(channel) {
      if (!currentOptions().channels.includes(channel)) return false;
      state.activeMolecule = channel; updateDisplay(); save(); $('analysis-body').scrollTop = 0; requestRedraw(); return true;
    }
    function setToolbarMinimized(value) {
      state.toolbarMinimized = !!value; updateDisplay(); save(); $('analysis-body').scrollTop = 0; requestRedraw();
    }
    function setAxisMode(value) {
      state.axisMode = value === 'full' ? 'full' : 'auto'; updateDisplay(); save(); requestRedraw();
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
      const roiLabel = state.mode === 'by-section' ? state.singleRoi || '領域未選択' : `${state.roiNames.filter(name => availableNames.includes(name)).length}領域`;
      $('analysis-conditions-summary').textContent = `集計条件を変更 · ${$('analysis-target-detail').textContent} · ${roiLabel}`;
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
      updateDisplay();
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
      updateDisplay();
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
      const labels = [state.mode === 'by-section' ? '切片' : '領域', '中央値 [P25–P75]', '平均 ± SD', '画素 n', '対象 / 存在 / 採用切片'];
      for (const label of labels) header.append(element('th', '', label));
      head.append(header); table.append(head); const body = document.createElement('tbody');
      for (const group of groups) {
        const row = document.createElement('tr'); row.dataset.groupKey = group.key; row.dataset.roiName = group.roiName || '';
        if (group.sectionId) row.dataset.sectionId = group.sectionId;
        const label = document.createElement('td'); label.dataset.label = labels[0];
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
        for (const [index, [key, value]] of values.entries()) { const cell = element('td', '', value); cell.dataset.stat = key; cell.dataset.label = labels[index + 1]; row.append(cell); }
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
    function plotHeight(pages, multipleRows) {
      if (global.matchMedia('(max-width: 760px)').matches) return 280;
      const body = $('analysis-body');
      // Header/toolbar height can wrap with language, width, and open conditions.
      // Measure its actual space instead of subtracting a fixed toolbar height.
      const preceding = pages.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
      return Math.max(340, Math.min(640, Math.floor(body.clientHeight - preceding - 46 - (multipleRows ? 24 : 0))));
    }
    function renderResults() {
      const result = state.result; if (!result) return;
      const charts = $('analysis-charts'), scrollBody = $('analysis-body'), scrollTop = scrollBody.scrollTop;
      const openTables = new Map([...charts.querySelectorAll('.analysis-molecule')].map(card => [card.dataset.channel, card.querySelector('.analysis-table-details')?.open || false]));
      charts.replaceChildren(); drawCallbacks = []; updateDisplay();
      for (const channel of result.channels) {
        const card = element('section', 'analysis-molecule'); card.dataset.channel = channel.key; card.hidden = channel.key !== state.activeMolecule;
        const heading = element('div', 'analysis-molecule-heading'); heading.append(element('strong', '', channel.name || channel.key), element('span', '', channel.unit || ''));
        card.append(heading);
        if (channel.status === 'BLOCKED') card.append(element('p', 'analysis-unavailable', '補正値の集計を停止しました：' + reasons(channel.compatibility?.reasonCodes)));
        const warnings = new Set(channel.groups.flatMap(group => group.warnings || []));
        if (warnings.has('MIXED_PIXEL_SIZE')) card.append(element('p', 'analysis-warning', '画素サイズが異なる切片を含みます。各画素を同じ重みで集計し、面積・体積による重み付けはしていません。'));
        const pages = element('div', 'analysis-plot-pages'); card.append(pages); charts.append(card);
        const draw = () => {
          if (!pages.isConnected || card.hidden || root.classList.contains('analysis-collapsed')) return;
          const selectedId = selectedSection()?.id;
          const highlight = state.mode === 'by-section' ? channel.groups.find(group => group.sectionId === selectedId)?.key : null;
          const width = Math.max(220, Math.floor(pages.clientWidth)), perRow = Math.max(1, Math.floor((width - 104) / 90));
          const rois = channel.groups.map(group => ({ key: group.key, name: group.name, distribution: group.distribution,
            aboveCount: state.axisMode === 'auto' ? group.distribution?.aboveAutoCount || 0 : 0 }));
          const height = plotHeight(pages, rois.length > perRow);
          pages.replaceChildren();
          for (let start = 0; start < rois.length; start += perRow) {
            const rowRois = rois.slice(start, start + perRow), row = element('div', 'analysis-plot-row');
            if (rois.length > perRow) row.append(element('p', 'analysis-row-label', `${state.mode === 'by-section' ? '切片' : '領域'} ${start + 1}–${start + rowRois.length} / ${rois.length} · 縦軸は全行で共通`));
            const plot = element('div', 'analysis-plot'), canvas = document.createElement('canvas'); plot.append(canvas); row.append(plot); pages.append(row);
            const geometry = global.IntensityBoxPlot.draw(canvas, { width, height, fitWidth: true, axisRois: rois, compactTitle: true,
              domain: state.axisMode === 'auto' ? channel.plot?.autoDomain : undefined,
              title: channel.name || channel.key, unit: channel.unit, highlightRoiKey: highlight, rois: rowRois,
              onSelect: state.mode === 'by-section' && typeof options.onSelect === 'function' ? key => {
                const group = channel.groups.find(item => item.key === key); if (group?.sectionId) options.onSelect(group.sectionId);
              } : undefined });
            canvas.dataset.groupKeys = JSON.stringify(rowRois.map(group => group.key));
            if (geometry) canvas.dataset.axisDomain = JSON.stringify(geometry.domain);
          }
        };
        drawCallbacks.push(draw); draw();
        const tableDetails = element('details', 'analysis-table-details'); tableDetails.open = openTables.get(channel.key) || false;
        tableDetails.append(element('summary', '', `統計表を表示（${channel.groups.length}${state.mode === 'by-section' ? '切片' : '領域'}）`), tableFor(channel.groups)); card.append(tableDetails);
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
      scrollBody.scrollTop = scrollTop;
      $('analysis-status').textContent = result.channels.length ? `${result.selection.count}切片を集計 · ${result.channels.length}分子${stale ? ' · 更新前の読込データ' : ''}` : '左側で表示する分子を選択してください。';
      updateDisplay(); requestRedraw();
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
    for (const button of moleculeButtons) listen(button, 'click', () => setActiveMolecule(button.dataset.analysisMolecule));
    listen($('analysis-molecule-select'), 'change', event => setActiveMolecule(event.target.value));
    listen($('analysis-axis-mode'), 'change', event => setAxisMode(event.target.value));
    listen($('analysis-toolbar-toggle'), 'click', () => { setToolbarMinimized(true); $('analysis-toolbar-expand').focus({ preventScroll: true }); });
    listen($('analysis-toolbar-expand'), 'click', () => { setToolbarMinimized(false); $('analysis-toolbar-toggle').focus({ preventScroll: true }); });
    listen(root.querySelector('.analysis-controls'), 'toggle', requestRedraw);
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
      const size = `${$('analysis-charts').clientWidth}:${$('analysis-body').clientHeight}:${$('analysis-toolbar').getBoundingClientRect().height}`;
      if (size !== lastSize) { lastSize = size; requestRedraw(); }
    }) : null;
    observer?.observe(root); observer?.observe($('analysis-toolbar'));
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
      setActiveMolecule, setToolbarMinimized, setAxisMode,
      dispose() { cancel(); disposed = true; save(); observer?.disconnect(); layout?.dispose(); worker?.dispose(); core.clearCache(); sections = []; cancelAnimationFrame(resizeFrame); for (const [target, event, handler] of listeners) target.removeEventListener(event, handler); drawCallbacks = []; state.result = null; }
    };
  }
  global.Stack3DAnalysisUI = { create };
})(window);
