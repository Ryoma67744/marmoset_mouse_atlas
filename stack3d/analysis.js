/* Analysis UI uses loaded scientific rasters, independently of 3D visibility. */
(function (global) {
  'use strict';
  const KEY = 'atlas-stack3d-analysis-v1';
  const MODES = ['selected', 'by-section', 'pooled'];
  const CHANNELS = ['DA', 'NE', '5-HT'];
  const CHANNEL_NAMES = { DA: 'Dopamine', NE: 'Norepinephrine', '5-HT': 'Serotonin' };
  const MOUSE_STANDARD = 'Serotonin-d4-DPP';
  const MOUSE_DEFAULT = 'Serotonin-DPP';
  const ORDER_LABELS = { median: '中央値の高い順', mean: '平均値の高い順' };
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
  // Presentation order only: keep scientific results, stable keys and ties intact.
  function sortGroups(groups, order = 'median') {
    return global.IntensityOrder.sortByValue(groups, group => {
      const statistics = order === 'mean' ? group.statistics : group.distribution;
      return statistics?.n > 0 ? statistics[order === 'mean' ? 'mean' : 'median'] : null;
    });
  }
  function sortGroupsByMedian(groups) { return sortGroups(groups, 'median'); }
  function sortGroupsByMean(groups) { return sortGroups(groups, 'mean'); }
  function create(options) {
    const root = options.root, core = global.Stack3DAnalysis;
    if (!root || !core || !global.IntensityBoxPlot || !global.IntensityOrder) throw new Error('3D分析の描画機能を読み込めませんでした。');
    const state = { mode: 'selected', scope: 'all', sectionIds: [], roiNames: [], allRois: true, singleRoi: '',
      activeMolecule: 'DA', axisMode: 'auto', toolbarMinimized: false, loading: true, result: null };
    let sections = [], availableNames = [], initialized = false, disposed = false, generation = 0;
    let controller = null, frame = 0, resizeFrame = 0, drawCallbacks = [], lastSize = '', calculationPending = false, exporting = false;
    let selectionNotice = '', failure = '', stale = false, staleIds = new Set(), lastOptions = '';
    let series = readSeries(), channelNotice = '', channelIds = [], moleculeButtons = [];
    const listeners = [], worker = global.Stack3DAnalysisWorker?.create();
    function listen(target, event, handler) { target.addEventListener(event, handler); listeners.push([target, event, handler]); }
    function readSeries(source) {
      return options.getSeries?.() || global.Stack3D?.seriesOf?.((source || options.getSections?.() || [])[0]) ||
        { id: 'legacy_marmoset', species: 'marmoset' };
    }
    function isMouse() { return series.species === 'mouse'; }
    function restore() {
      Object.assign(state, { mode: 'selected', scope: 'all', sectionIds: [],
        roiNames: [], allRois: true, singleRoi: '', activeMolecule: isMouse() ? MOUSE_DEFAULT : 'DA',
        axisMode: 'auto', sortOrder: 'median', toolbarMinimized: false, seriesId: series.id, sampleScope: 'roi' });
      try {
        const saved = JSON.parse(sessionStorage.getItem(KEY + ':' + series.id) ||
          (series.id === 'legacy_marmoset' ? sessionStorage.getItem(KEY) : null));
        if (saved && MODES.includes(saved.mode)) {
          // Older mouse sessions describe the fixed whole-image comparison,
          // not a user-selected ROI mode. Keep their display preferences only.
          if (!isMouse() || saved.sampleScope === 'roi') {
            state.mode = saved.mode; state.scope = saved.scope === 'ids' ? 'ids' : 'all';
            state.sectionIds = Array.isArray(saved.sectionIds) ? [...new Set(saved.sectionIds.filter(id => typeof id === 'string'))] : [];
            state.roiNames = Array.isArray(saved.roiNames) ? [...new Set(saved.roiNames.filter(name => typeof name === 'string'))] : [];
            state.allRois = saved.allRois !== false; state.singleRoi = typeof saved.singleRoi === 'string' ? saved.singleRoi : '';
          }
          const choices = isMouse() ? global.Stack3D?.MOUSE_ANALYTES || [] : CHANNELS;
          if (choices.includes(saved.activeMolecule)) state.activeMolecule = saved.activeMolecule;
          state.axisMode = saved.axisMode === 'full' ? 'full' : 'auto'; state.toolbarMinimized = saved.toolbarMinimized === true;
          state.sortOrder = saved.sortOrder === 'mean' ? 'mean' : 'median';
        }
      } catch (_) {}
      channelNotice = ''; selectionNotice = '';
    }
    function syncSeries(source) {
      const next = readSeries(source);
      if (next.id === series.id && next.species === series.species) return;
      save(); series = next; restore(); cancel(); state.result = null; drawCallbacks = [];
    }
    restore();
    root.classList.add('analysis-panel');
    root.innerHTML = '<div id="analysis-resizer" role="separator" tabindex="0" aria-label="グラフ領域の高さ" aria-orientation="horizontal" aria-controls="analysis-panel" title="ドラッグまたは上下矢印キーで高さを変更。ダブルクリックで元に戻す"></div>' +
      '<div class="analysis-header"><strong id="analysis-title">INTENSITY BOX PLOT</strong><span id="analysis-value-badge"></span><button id="analysis-layout-toggle" type="button">上下配置へ</button><button id="analysis-focus" type="button" aria-pressed="false">解析を広く表示</button><button id="analysis-expand" type="button" aria-pressed="false">拡大</button><button id="analysis-collapse" type="button" aria-expanded="true" aria-controls="analysis-body">折りたたむ</button><button id="analysis-toolbar-toggle" type="button" aria-expanded="true" aria-controls="analysis-toolbar">操作部を最小化</button></div>' +
      '<div class="analysis-minibar" aria-label="最小化したグラフ操作部"><label class="analysis-mini-molecule"><span>分子</span><select id="analysis-molecule-select" aria-label="グラフに表示する分子"></select></label><label class="analysis-mini-sort"><span>並び順</span><select id="analysis-mini-sort-order" aria-label="グラフと統計表の並び順"><option value="median">中央値の高い順</option><option value="mean">平均値の高い順</option></select></label><span id="analysis-mini-summary"></span><span id="analysis-mini-axis"></span><button id="analysis-mini-export-excel" type="button" aria-describedby="analysis-export-status" disabled>表示中の分子をExcel出力</button><button id="analysis-mini-layout-toggle" type="button">上下配置へ</button><button id="analysis-mini-focus" type="button" aria-pressed="false">解析を広く表示</button><button id="analysis-toolbar-expand" type="button" aria-expanded="false" aria-controls="analysis-toolbar">操作部を表示</button></div>' +
      '<div id="analysis-body" class="analysis-body"><p id="analysis-sample-scope" hidden></p><p id="analysis-channel-note" role="status" hidden></p><div id="analysis-toolbar"><div class="analysis-molecule-tabs" role="group" aria-label="グラフに表示する分子"><span class="analysis-molecule-label">表示する分子</span></div><div class="analysis-mode-row"><div class="analysis-modes" role="group" aria-label="グラフのまとめ方"><button type="button" data-analysis-mode="selected">選択切片</button><button type="button" data-analysis-mode="by-section">切片ごとに比較</button><button type="button" data-analysis-mode="pooled">同名領域を統合</button></div><label class="analysis-axis-control">縦軸<select id="analysis-axis-mode"><option value="auto">自動（P99基準）</option><option value="full">全範囲</option></select></label><label class="analysis-sort-control">並び順<select id="analysis-sort-order" aria-label="グラフと統計表の並び順"><option value="median">中央値の高い順</option><option value="mean">平均値の高い順</option></select></label><button id="analysis-export-excel" type="button" aria-describedby="analysis-export-status" disabled>表示中の分子をExcel出力</button><span id="analysis-pooling-note"></span></div><details class="analysis-controls"><summary id="analysis-conditions-summary">集計条件を変更</summary>' +
      '<div class="analysis-target"><span id="analysis-target-detail"></span><details id="analysis-target-list"><summary>対象切片一覧</summary><ul></ul></details></div><div class="analysis-range-controls"><label for="analysis-range">集計する切片（一覧番号）</label><input id="analysis-range" type="text" placeholder="5-20,24,30-35" autocomplete="off" aria-describedby="analysis-range-error"><button id="analysis-apply-range" type="button">適用</button><button id="analysis-all-sections" type="button">全切片</button><button id="analysis-use-display" type="button">3D表示範囲を取り込む</button></div>' +
      '<p id="analysis-range-error" role="alert" hidden></p><p id="analysis-selection-note" hidden></p><div class="analysis-roi-controls"><span>グラフの領域</span><div id="analysis-roi-checks"></div><select id="analysis-single-roi" aria-label="切片ごとに比較する領域"></select></div></details>' +
      '<div class="analysis-legend"><span>箱 P25–P75・中央値 ｜ ひげ P0–P99</span><span><i class="analysis-blue-dot"></i>≤ P99</span><span><i class="analysis-red-dot"></i>&gt; P99（集計に含む）</span><span>↑ 表示上限を超える画素（統計に含む）</span></div></div><p id="analysis-stale" role="status" hidden></p><p id="analysis-status" role="status" aria-live="polite"></p><p id="analysis-export-status" role="status" aria-live="polite" hidden></p><div id="analysis-charts"></div>' +
      '<p class="analysis-footnote">n＝有限値の画素数。SD＝画素間の母標準偏差。統計量は元のROIの全有効画素から算出し、3Dの透過・表示範囲には依存しません。分子ごとに軸と単位が異なります。</p></div>';
    const $ = id => root.querySelector('#' + id);
    const modeButtons = [...root.querySelectorAll('[data-analysis-mode]')];
    function buildMolecules() {
      channelIds = isMouse() ? global.Stack3D.analytesFor(sections) : CHANNELS.slice();
      if (isMouse() && !channelIds.length) channelIds = Array.from(global.Stack3D.MOUSE_ANALYTES || []);
      const tabs = root.querySelector('.analysis-molecule-tabs');
      tabs.replaceChildren(element('span', 'analysis-molecule-label', '表示する分子')); $('analysis-molecule-select').replaceChildren();
      moleculeButtons = channelIds.map(channel => {
        const button = element('button', 'analysis-molecule-tab'); button.type = 'button'; button.dataset.analysisMolecule = channel;
        button.setAttribute('aria-controls', 'analysis-charts');
        const dot = element('i', 'analysis-molecule-dot'); dot.dataset.channel = channel; dot.setAttribute('aria-hidden', 'true');
        const color = global.Stack3D?.COLORS?.[channel]; if (color) dot.style.backgroundColor = `rgb(${color.join(',')})`;
        button.append(dot, element('strong', '', channel));
        if (CHANNEL_NAMES[channel]) button.append(element('span', 'analysis-molecule-name', CHANNEL_NAMES[channel]));
        if (channel === MOUSE_STANDARD) button.append(element('span', 'analysis-molecule-name', 'raw QC'));
        tabs.append(button); $('analysis-molecule-select').append(new Option(channel + (channel === MOUSE_STANDARD ? ' (raw QC)' : ''), channel));
        return button;
      });
      root.classList.toggle('analysis-mouse', isMouse());
    }
    buildMolecules();
    function save() {
      // A pending load may only know a series ID, before its species metadata.
      // Do not replace that series' saved preferences with provisional defaults.
      if (!initialized) return;
      try { sessionStorage.setItem(KEY + ':' + series.id, JSON.stringify({ mode: state.mode, scope: state.scope, sectionIds: state.sectionIds,
        roiNames: state.roiNames, allRois: state.allRois, singleRoi: state.singleRoi, activeMolecule: state.activeMolecule,
        axisMode: state.axisMode, sortOrder: state.sortOrder, toolbarMinimized: state.toolbarMinimized, sampleScope: state.sampleScope })); } catch (_) {}
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
      const valueMode = value.mode === 'normalized' ? 'normalized' : 'raw';
      return { channels: isMouse()
        ? channelIds.filter(channel => valueMode === 'raw' || channel !== MOUSE_STANDARD)
        : CHANNELS.filter(channel => (value.channels || CHANNELS).includes(channel)), valueMode, sampleScope: 'roi' };
    }
    function updateDisplay() {
      const available = currentOptions().channels;
      // During a series load the global value mode can still belong to the
      // previous series. Resolve availability only after that mode is restored.
      if (!state.loading && available.length && !available.includes(state.activeMolecule)) {
        const nextMolecule = isMouse() && available.includes(MOUSE_DEFAULT) ? MOUSE_DEFAULT : available[0];
        if (isMouse() && state.activeMolecule === MOUSE_STANDARD && currentOptions().valueMode === 'normalized') {
          channelNotice = `Serotonin-d4-DPP は原値で内部標準の分布を確認する分子です。補正表示では ${nextMolecule} に切り替えました。`;
        }
        state.activeMolecule = nextMolecule;
      }
      for (const button of moleculeButtons) {
        button.disabled = state.loading || !available.includes(button.dataset.analysisMolecule);
        button.hidden = isMouse() && !available.includes(button.dataset.analysisMolecule);
        button.setAttribute('aria-pressed', String(button.dataset.analysisMolecule === state.activeMolecule));
      }
      for (const option of $('analysis-molecule-select').options) {
        option.disabled = !available.includes(option.value); option.hidden = isMouse() && option.disabled;
      }
      $('analysis-molecule-select').disabled = state.loading || !available.length;
      $('analysis-molecule-select').value = state.activeMolecule;
      $('analysis-axis-mode').value = state.axisMode;
      $('analysis-sort-order').value = state.sortOrder;
      $('analysis-mini-sort-order').value = state.sortOrder;
      $('analysis-mini-axis').textContent = state.axisMode === 'auto' ? '自動軸' : '全範囲';
      root.classList.toggle('analysis-toolbar-minimized', state.toolbarMinimized);
      $('analysis-toolbar-toggle').setAttribute('aria-expanded', String(!state.toolbarMinimized));
      $('analysis-toolbar-expand').setAttribute('aria-expanded', String(!state.toolbarMinimized));
      $('analysis-channel-note').textContent = channelNotice; $('analysis-channel-note').hidden = !channelNotice || !isMouse();
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
      updateExportControls();
    }
    function exportChannel() {
      return state.result?.channels.find(channel => channel.key === state.activeMolecule);
    }
    function exportBlockReason() {
      if (disposed || !initialized || state.loading || calculationPending || controller || frame) return '読込・集計が完了してからExcel出力できます。';
      if (stale) return '登録データが更新されています。「再読込」後にExcel出力してください。';
      if (!exportChannel()?.groups.length) return '表示中の分子の集計結果がありません。';
      if (!global.ExcelIO?.buildGraphStatsXlsx || !global.XLSX?.utils) return 'Excel出力機能を読み込めませんでした。再読込してください。';
      if (exporting) return 'Excelを作成しています。';
      return '';
    }
    function updateExportControls() {
      const reason = exportBlockReason();
      for (const id of ['analysis-export-excel', 'analysis-mini-export-excel']) {
        $(id).disabled = !!reason; $(id).title = reason || '表示中の分子のグラフ統計と集計条件をExcelに保存します。';
      }
    }
    function exportGraphExcel() {
      if (exportBlockReason()) return false;
      const result = state.result, channel = exportChannel(), groups = displayGroups(channel.groups);
      const names = new Map(result.selection.sectionIds.map((id, index) => [id, result.selection.names[index] || id]));
      const finite = value => Number.isFinite(value) ? value : null;
      const groupReasons = group => [...(group.reasonCodes || []), ...(group.warnings || []), ...(group.compatibility?.reasonCodes || []),
        ...(group.exclusions || []).flatMap(item => [item.code, ...(item.reasonCodes || [])])].filter(Boolean);
      const rows = groups.map((group, index) => {
        const d = group.distribution, stats = group.statistics || {}, counts = group.counts || {};
        return { roiKey: group.roiName || group.key, roiName: group.roiName || group.name, channelKey: channel.key, moleculeName: channel.name || channel.key,
          sectionId: group.sectionId || '', sectionName: group.sectionId ? result.mode === 'by-section' ? group.name : names.get(group.sectionId) || group.sectionId : '',
          valueMode: result.valueMode, unit: group.unit || channel.unit || '',
          median: finite(d?.median), mean: d ? finite(stats.mean) : null, sd: d ? finite(stats.sd) : null,
          q1: finite(d?.q1), q3: finite(d?.q3), min: finite(d?.min), p99: finite(d?.whiskerHigh), max: finite(d?.max),
          n: finite(counts.nIncluded), nValid: finite(counts.nValid), nMeasured: finite(counts.nMeasured), nGeometry: finite(counts.nGeometry),
          targetSections: finite(counts.targetSections), roiSections: finite(counts.roiSections), includedSections: finite(counts.includedSections),
          mode: result.mode, order: index + 1, sortOrder: state.sortOrder, status: group.status || channel.status || '', reason: reasons(groupReasons(group)) };
      });
      const sectionRows = groups.flatMap(group => (group.sectionIds || result.selection.sectionIds).map(sectionId => {
        const excluded = (group.exclusions || []).filter(item => item.sectionId === sectionId);
        const included = !excluded.length && !!group.distribution;
        return { sectionId, sectionName: names.get(sectionId) || sectionId, roiKey: group.roiName || group.key, channelKey: channel.key,
          status: included ? 'INCLUDED' : 'EXCLUDED',
          reason: reasons(excluded.length ? excluded.flatMap(item => [item.code, ...(item.reasonCodes || [])]).filter(Boolean)
            : included ? [] : groupReasons(group)) };
      }));
      exporting = true; updateExportControls();
      const status = $('analysis-export-status'); status.hidden = false; status.textContent = 'Excelを作成しています…';
      try {
        const exported = global.ExcelIO.buildGraphStatsXlsx({ rows, sections: sectionRows, metadata: {
          surface: '3D', seriesId: series.id, species: series.species, moleculeName: channel.name || channel.key, channelKey: channel.key,
          mode: result.mode, valueMode: result.valueMode, sampleScope: result.sampleScope, sortOrder: state.sortOrder,
          sortOrderLabel: ORDER_LABELS[state.sortOrder], axisMode: state.axisMode, targetSectionCount: result.selection.count,
          targetSectionList: 'Sections シート参照', roiList: 'Statistics シート参照',
          roiKeyDefinition: '3Dでは同名ROIをまとめた名称を識別子として使用',
          pooling: result.mode === 'pooled' ? '全有効画素を統合（画素数による重み）' : '',
          statisticsSource: 'グラフの集計結果。表示用の間引き点群からは再計算しません。',
          sdConvention: '画素間の母標準偏差', stale: false
        } });
        const name = global.ExcelIO.sanitizeFileComponent(`${series.id}_${channel.name || channel.key}_${result.mode}`);
        const filename = `graph_${name}_${exported.exportedAt.replace(/\D/g, '').slice(0, 14)}.xlsx`;
        const url = URL.createObjectURL(new Blob([exported.bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        const link = document.createElement('a'); link.href = url; link.download = filename;
        document.body.append(link); link.click();
        setTimeout(() => { URL.revokeObjectURL(url); link.remove(); }, 1000);
        status.textContent = `${channel.name || channel.key} · ${exported.rowCount}行のグラフ統計をExcel出力しました。`;
        return true;
      } catch (error) {
        status.textContent = 'Excelを作成できませんでした：' + (error?.message || String(error));
        return false;
      } finally { exporting = false; updateExportControls(); }
    }
    function setActiveMolecule(channel) {
      if (!currentOptions().channels.includes(channel)) return false;
      channelNotice = '';
      state.activeMolecule = channel; updateDisplay(); save(); $('analysis-body').scrollTop = 0; requestRedraw(); return true;
    }
    function setToolbarMinimized(value) {
      state.toolbarMinimized = !!value; updateDisplay(); save(); $('analysis-body').scrollTop = 0; requestRedraw();
    }
    function setAxisMode(value) {
      state.axisMode = value === 'full' ? 'full' : 'auto'; updateDisplay(); save(); requestRedraw();
    }
    function setSortOrder(value) {
      const next = value === 'mean' ? 'mean' : 'median';
      if (next === state.sortOrder) return;
      state.sortOrder = next; updateDisplay(); save();
      // Reuse the completed statistics; sorting must never trigger analysis.
      if (state.result) renderResults();
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
      $('analysis-value-badge').textContent = opts.valueMode === 'normalized' ? (isMouse() ? '5-HT-d4補正（相対比）' : '補正値') : '原値';
      $('analysis-pooling-note').textContent = state.mode === 'pooled' ? '全有効画素を統合（画素数による重み）' : state.mode === 'by-section' ? '同じ領域を切片ごとに比較' : '選択中の切片にある領域を比較';
      $('analysis-sample-scope').hidden = !isMouse();
      $('analysis-sample-scope').textContent = `ROI内の有効画素を集計します。切片・領域は「集計条件を変更」で選択できます。3Dの領域表示・閾値・分子のチェックとは独立しています。${options.getOptions()?.outerEdgeWidth === 2 ? 'ROI内なら3Dで非表示にした外側2画素も集計に含みます。' : ''}`;
      root.querySelector('.analysis-footnote').textContent = isMouse()
        ? 'n＝ROI内の対象分子の有限値の画素数（ゼロを含む）。SD＝画素間の母標準偏差。補正値は同一画素の Serotonin-d4-DPP に対する相対比で、補正不能な画素は除外します。3Dの透過・領域表示は集計に影響しません。濃度・面積・体積への換算は行っていません。'
        : 'n＝有限値の画素数。SD＝画素間の母標準偏差。統計量は元のROIの全有効画素から算出し、3Dの透過・表示範囲には依存しません。分子ごとに軸と単位が異なります。';
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
      root.dataset.sampleScope = state.sampleScope; root.dataset.seriesId = series.id;
      updateDisplay();
    }
    function syncRangeInput() {
      const ids = state.scope === 'all' ? sections.map(section => section.id) : state.sectionIds;
      $('analysis-range').value = rangeText(sections.flatMap((section, index) => ids.includes(section.id) ? [index + 1] : []));
    }
    function setError(message) { $('analysis-range-error').textContent = message; $('analysis-range-error').hidden = !message; $('analysis-range').setAttribute('aria-invalid', String(!!message)); }
    function cancel() {
      generation++; controller?.abort(); controller = null; cancelAnimationFrame(frame); frame = 0; calculationPending = false;
    }
    function clearResults(message) {
      state.result = null; drawCallbacks = []; $('analysis-charts').replaceChildren(); $('analysis-status').textContent = message || '';
      root.setAttribute('aria-busy', 'false');
      updateDisplay();
    }
    function reasons(codes) {
      const local = { ROI_MISSING: '対象ROIなし', CHANNEL_MISSING: '分子データなし', NO_VALUES: '有効画素なし', NO_VALID_PIXELS: '有効画素なし', RAW_QC: '内部標準は原値のQC専用です',
        PIXEL_WEIGHTED: '全有効画素を統合（画素数による重み）', MIXED_PIXEL_SIZE: '画素サイズが異なる切片を含みます。面積・体積ではなく各画素を同じ重みで集計しています',
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
    function plotHeight(pages) {
      if (global.matchMedia('(max-width: 760px)').matches) return 280;
      const body = $('analysis-body');
      // Header/toolbar height can wrap with language, width, and open conditions.
      // Measure its actual space instead of subtracting a fixed toolbar height.
      const preceding = pages.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
      return Math.max(340, Math.min(640, Math.floor(body.clientHeight - preceding - 70)));
    }
    function displayGroups(groups) {
      if (!isMouse() || state.mode !== 'by-section') return sortGroups(groups, state.sortOrder);
      const sectionMap = new Map(sections.map(section => [section.id, section]));
      const number = group => Number(sectionMap.get(group.sectionId)?.project?.atlas?.sectionNumber) || Infinity;
      // Confirmed numbers resolve ties and absent values even after a reordered load.
      const ordered = groups.slice().sort((a, b) => number(a) === number(b) ? 0 : number(a) < number(b) ? -1 : 1);
      return sortGroups(ordered, state.sortOrder).map(group => {
        const atlas = sectionMap.get(group.sectionId)?.project?.atlas;
        const name = atlas?.sectionNumber ? `${atlas.sectionNumber} · ${atlas.sourceCandidateId || group.name}` : group.name;
        return { ...group, name };
      });
    }
    function renderResults() {
      const result = state.result; if (!result) return;
      const charts = $('analysis-charts'), scrollBody = $('analysis-body'), scrollTop = scrollBody.scrollTop;
      const openTables = new Map([...charts.querySelectorAll('.analysis-molecule')].map(card => [card.dataset.channel, card.querySelector('.analysis-table-details')?.open || false]));
      const plotScroll = new Map([...charts.querySelectorAll('.analysis-molecule')].map(card => [card.dataset.channel, card.querySelector('.analysis-plot')?.scrollLeft || 0]));
      charts.replaceChildren(); drawCallbacks = []; updateDisplay();
      for (const channel of result.channels) {
        const groups = displayGroups(channel.groups);
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
          const highlight = state.mode === 'by-section' ? groups.find(group => group.sectionId === selectedId)?.key : null;
          const availableWidth = Math.max(220, Math.floor(pages.clientWidth));
          const width = Math.max(availableWidth, groups.length * 100 + 104);
          const rois = groups.map(group => ({ key: group.key, name: group.name, distribution: group.distribution,
            aboveCount: state.axisMode === 'auto' ? group.distribution?.aboveAutoCount || 0 : 0 }));
          let plot = pages.querySelector('.analysis-plot');
          if (!plot) {
            const row = element('div', 'analysis-plot-row');
            row.append(element('p', 'analysis-row-label'));
            plot = element('div', 'analysis-plot'); plot.tabIndex = 0;
            plot.setAttribute('role', 'region'); plot.setAttribute('aria-label', (channel.name || channel.key) + ' 箱ひげ図。' + ORDER_LABELS[state.sortOrder] + '。左右にスクロールできます。');
            plot.append(document.createElement('canvas')); row.append(plot); pages.append(row);
          }
          pages.querySelector('.analysis-row-label').textContent = `${ORDER_LABELS[state.sortOrder]} · ${rois.length}${state.mode === 'by-section' ? '切片' : '領域'}${width > availableWidth ? ' · 横にスクロールして全体を表示' : ''}`;
          const scrollLeft = plotScroll.has(channel.key) ? plotScroll.get(channel.key) : plot.scrollLeft;
          plotScroll.delete(channel.key);
          const canvas = plot.querySelector('canvas');
          const geometry = global.IntensityBoxPlot.draw(canvas, { width, height: plotHeight(pages), fitWidth: true, compactTitle: true,
            fullLabels: true, showCounts: false, maxBitmapDimension: 16384, maxBitmapPixels: 16777216,
            domain: state.axisMode === 'auto' ? channel.plot?.autoDomain : undefined,
            title: channel.name || channel.key, unit: channel.unit, highlightRoiKey: highlight, rois,
            onSelect: state.mode === 'by-section' && typeof options.onSelect === 'function' ? key => {
              const group = groups.find(item => item.key === key); if (group?.sectionId) options.onSelect(group.sectionId);
            } : undefined });
          canvas.dataset.groupKeys = JSON.stringify(rois.map(group => group.key));
          if (geometry) canvas.dataset.axisDomain = JSON.stringify(geometry.domain);
          plot.scrollLeft = scrollLeft;
        };
        drawCallbacks.push(draw); draw();
        const tableDetails = element('details', 'analysis-table-details'); tableDetails.open = openTables.get(channel.key) || false;
        tableDetails.append(element('summary', '', `統計表を表示（${groups.length}${state.mode === 'by-section' ? '切片' : '領域'}）`), tableFor(groups)); card.append(tableDetails);
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
        calculationPending = false;
        clearResults(!ids.length ? '集計対象の切片がありません。範囲を指定してください。'
          : !names.length ? (availableNames.length ? 'グラフに表示する領域を選択してください。' : '対象切片にROIが登録されていません。ROIのある切片を選択するか、個別ビューでROIを登録してください。')
          : isMouse() ? '集計できる分子データがありません。' : '左側で表示する分子を選択してください。'); return;
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
      } finally { if (token === generation && !disposed) { root.setAttribute('aria-busy', 'false'); controller = null; calculationPending = false; updateExportControls(); } }
    }
    function schedule() {
      if (disposed) return; cancel(); calculationPending = true; $('analysis-export-status').hidden = true; updateControls(); save();
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
    listen(root.querySelector('.analysis-molecule-tabs'), 'click', event => {
      const button = event.target.closest('button[data-analysis-molecule]');
      if (button && !button.disabled) setActiveMolecule(button.dataset.analysisMolecule);
    });
    listen($('analysis-molecule-select'), 'change', event => setActiveMolecule(event.target.value));
    listen($('analysis-axis-mode'), 'change', event => setAxisMode(event.target.value));
    listen($('analysis-sort-order'), 'change', event => setSortOrder(event.target.value));
    listen($('analysis-mini-sort-order'), 'change', event => setSortOrder(event.target.value));
    listen($('analysis-export-excel'), 'click', exportGraphExcel);
    listen($('analysis-mini-export-excel'), 'click', exportGraphExcel);
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
      beginLoad() { cancel(); syncSeries(); initialized = false; state.loading = true; sections = []; buildMolecules(); core.clearCache(); failure = ''; stale = false; staleIds.clear(); clearResults('切片を読み込んでいます…'); root.setAttribute('aria-busy', 'true'); updateControls(); },
      setSections() {
        cancel();
        syncSeries(options.getSections() || []);
        // Placement saves can replace the live project object with a newer ROI.
        // Keep the loaded geometry/profile metadata paired with its loaded rasters.
        sections = (options.getSections() || []).map(section => ({ ...section,
          project: typeof global.structuredClone === 'function' ? global.structuredClone(section.project) : JSON.parse(JSON.stringify(section.project)),
          channels: { ...section.channels } }));
        buildMolecules();
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
        if (currentOptions().valueMode === 'raw') channelNotice = '';
        if (next === lastOptions) return; lastOptions = next; schedule();
      },
      markStale(ids) {
        if (Array.isArray(ids)) for (const id of ids) staleIds.add(id);
        else for (const section of sections) staleIds.add(section.id);
        stale = staleIds.size > 0; updateControls();
        if (state.result) $('analysis-status').textContent += $('analysis-status').textContent.includes('更新前') ? '' : ' · 更新前の読込データ';
      },
      getState() { return { ...state, sectionIds: state.sectionIds.slice(), roiNames: state.roiNames.slice(), targetIds: targetIds(), stale, failure, generation, layout: layout?.getState() }; },
      setActiveMolecule, setToolbarMinimized, setAxisMode, setSortOrder, exportGraphExcel,
      dispose() { cancel(); disposed = true; save(); observer?.disconnect(); layout?.dispose(); worker?.dispose(); core.clearCache(); sections = []; cancelAnimationFrame(resizeFrame); for (const [target, event, handler] of listeners) target.removeEventListener(event, handler); drawCallbacks = []; state.result = null; }
    };
  }
  global.Stack3DAnalysisUI = { create, sortGroupsByMedian, sortGroupsByMean };
})(window);
