/* Native Atlas 3D entry point. Projects are read through the same storage,
 * normalization and cloud synchronization modules as the existing Viewer. */
(function (global) {
  'use strict';
  const $ = id => document.getElementById(id);
  const SELECTION_KEY = 'atlas-stack3d-selection', VIEW_KEY = 'atlas-stack3d-view-v1';
  const DEFAULT_SPACING = 0.595, SPACING_DEFAULTS_VERSION = 1;
  const SOURCE_FIELDS = ['displayName', 'atlas', 'grid', 'molecules', 'images', 'rotation', 'world_coords', 'roi', 'stack3d', 'folderId',
    'normalization', 'normalizationBinding', 'layerDisplay', 'valueDisplay'];
  const sourceFingerprint = project => JSON.stringify(SOURCE_FIELDS.map(key => project?.[key] ?? null));
  const STALE_PLACEMENT_MESSAGE = '元のデータが更新されています。「再読込」で最新の内容を確認してから配置を保存してください。';
  const UNKNOWN_LOCAL_MESSAGE = 'クラウドには保存されました。手元の保存状態を確認できなかったため、「再読込」で確認してから保存を再試行してください。';
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));
  const session = {
    get(key) { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (_) { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (_) {} }
  };
  const query = new URLSearchParams(location.search);
  let activeSeries = query.get('series') || session.get('atlas-stack3d-active-series') || 'legacy_marmoset';
  let availableSeries = [];
  const seriesKey = key => `${key}:${activeSeries}`;
  // Retain the legacy slot for its single legacy series; every named series
  // has its own slot, so older Master/viewer links remain compatible.
  const viewKey = () => activeSeries === 'legacy_marmoset' ? VIEW_KEY : seriesKey(VIEW_KEY);
  const activeSeriesInfo = () => availableSeries.find(item => item.id === activeSeries) || { id: activeSeries, name: 'Marmoset', species: 'marmoset', coordinateMode: 'physical' };
  const pixelSeries = () => activeSeriesInfo().coordinateMode === 'pixel';
  const MOUSE_STANDARD = 'Serotonin-d4-DPP', MOUSE_RATIO_DISPLAY_VERSION = 1;
  const mouseRatioSeries = () => activeSeriesInfo().species === 'mouse' && sections.length > 0 &&
    sections.every(section => section.project?.normalization?.mode === 'pixel_ratio');
  const mouseRatioMode = () => mouseRatioSeries() && $('value-mode').value === 'normalized';
  const valueModeLabel = () => $('value-mode').value === 'raw' ? '原値' : mouseRatioSeries() ? '5-HT-d4補正・相対比' : '補正値';
  const defaultSpacing = () => pixelSeries() ? finite(sections[0]?.project?.atlas?.displaySpacing, 2) : DEFAULT_SPACING;
  const viewState = () => session.get(viewKey());
  let sections = [], rendered = [], renderer = null, selected = 0, previewKind = 'MSI';
  // null means unrestricted MSI; an empty list deliberately hides every region.
  let roiRegions = null;
  let renderGeneration = 0, loadGeneration = 0, previewGeneration = 0, heGeneration = 0, detailGeneration = 0;
  let busy = false, saving = false, noticeTimer, unsubscribe = null, sourceChanged = false, restoredCamera = null, repaintPending = false;
  let pendingPreview = null, previewWorker = null;
  let alignmentProposal = null, alignmentWorking = false, alignmentGeneration = 0;
  const alignmentSaveGuards = new Map();
  let batchAlignmentUI = null, analysisUI = null;
  const dirtyPlacements = new Set(), commonRanges = new Map(), hePlanes = new Map(), hiddenSectionIds = new Set();
  const staleSections = new Map(), pendingSourceIds = new Set();
  let pendingFolderChange = false, sourceChangeWorker = null, syncWarningGeneration = 0, loadedFolderFingerprint = '[]';

  function syncWarning(messages) {
    const button = $('sync-warning'), text = messages.join('\n');
    button.hidden = !messages.length; button.title = text;
    button.setAttribute('aria-label', messages.length ? `未同期の編集があります（${messages.length}切片）。詳細を表示` : '未同期の編集はありません');
    button.setAttribute('aria-expanded', 'false'); $('sync-details').hidden = true; $('sync-details').textContent = text;
  }

  async function refreshSyncWarnings() {
    const token = ++syncWarningGeneration, generation = loadGeneration;
    if (!global.Cloud?.configured?.()) { syncWarning([]); return; }
    // Inspect acknowledged local baselines only. Refreshing a badge must never
    // import a cloud project, reload the scene, or discard a placement draft.
    const projects = new Map((await ProjectStorage.listProjects()).map(project => [project.id, project]));
    if (token !== syncWarningGeneration || generation !== loadGeneration) return;
    const pending = {};
    for (const section of sections) {
      try { if (localStorage.getItem('marmoset:pendingFolderChange:' + encodeURIComponent(section.id))) pending[section.id] = true; } catch (_) {}
    }
    const messages = [];
    for (const section of sections) {
      const project = projects.get(section.id); if (!project) continue;
      const status = ProjectSync.localStatus(project, { pendingFolderChanges: pending });
      if (status.remainingLocalEdits || status.status === 'pending') messages.push(`${project.displayName || section.name}: ${status.reason}`);
    }
    syncWarning(messages);
  }
  function placementStatus(section) {
    return staleSections.get(section.id) || (pixelSeries() ? '保存済みの剛体配置を表示中です。単位は画像pixelです。' : batchAlignmentUI?.active
      ? '一括操作中です。上の一括操作で採用・保存してください。' : dirtyPlacements.has(section.id)
        ? '配置に未保存の変更があります。' : '保存済みの向きに、3D用の配置を加えます。');
  }
  function markStale(section, message = STALE_PLACEMENT_MESSAGE) {
    staleSections.set(section.id, message); sourceChanged = true;
    analysisUI?.markStale([section.id]);
    if (sections[selected]?.id === section.id) $('placement-status').textContent = message;
  }
  function acknowledgeCloudSave(section, project, status) {
    if (status?.localStateKnown === false) { markStale(section, UNKNOWN_LOCAL_MESSAGE); return false; }
    if (sourceFingerprint(project) !== sourceFingerprint(section.project)) {
      // Keep the source actually used by the renderer as the conflict baseline.
      // Rebasing it onto unseen data would allow the next local save to replace
      // a concurrent edit with this screen's older placement.
      markStale(section); return false;
    }
    section.project = project; section.sourceRevision = project.updatedAt; return true;
  }
  async function flushSourceChanges({ preserveNotice = false } = {}) {
    if (saving || busy || batchAlignmentUI?.saving) return;
    if (sourceChangeWorker) return sourceChangeWorker;
    sourceChangeWorker = (async () => {
      while (pendingSourceIds.size || pendingFolderChange) {
        if (saving || busy || batchAlignmentUI?.saving) return;
        const generation = loadGeneration, folderChanged = pendingFolderChange;
        const ids = folderChanged ? sections.map(section => section.id) : [...pendingSourceIds];
        pendingSourceIds.clear(); pendingFolderChange = false;
        const latest = new Map((await ProjectStorage.listProjects()).map(project => [project.id, project]));
        const foldersDiffer = folderChanged && JSON.stringify(await ProjectStorage.listFolders()) !== loadedFolderFingerprint;
        if (generation !== loadGeneration) continue;
        if (saving || busy || batchAlignmentUI?.saving) {
          ids.forEach(id => pendingSourceIds.add(id)); pendingFolderChange ||= folderChanged; return;
        }
        const changed = [], newlyStale = [];
        for (const id of ids) {
          const section = sections.find(item => item.id === id); if (!section) continue;
          const project = latest.get(id);
          if (foldersDiffer || !project || sourceFingerprint(project) !== sourceFingerprint(section.project)) {
            changed.push(id); if (!staleSections.has(id)) newlyStale.push(id); sourceChanged = true;
            // Keep the original source for the existing per-field/CAS save
            // guards. A manual placement may still safely preserve a newer
            // unrelated ROI; only an unseen cloud-save return locks the pose.
          } else {
            section.project = project; section.sourceRevision = project.updatedAt;
          }
        }
        if (changed.length) {
          analysisUI?.markStale(changed);
          batchAlignmentUI?.sourceChanged(changed, { preserveMessage: preserveNotice });
          if (alignmentWorking || alignmentProposal?.references.some(reference => changed.includes(reference.id))) {
            cancelAlignment('参照したデータが更新されたため、候補を取り消しました。再読込して計算し直してください。');
          }
          if (newlyStale.length) {
            const previous = preserveNotice && !$('notice').hidden ? $('notice').textContent + '\n' : '';
            notice(previous + '登録データが更新されました。「再読込」で最新の内容を反映できます。', true);
          }
        }
      }
      await refreshSyncWarnings();
    })().catch(error => notice(`同期状態を確認できませんでした：${error.message}`, true)).finally(() => {
      sourceChangeWorker = null; syncAlignmentControls();
      if ((pendingSourceIds.size || pendingFolderChange) && !saving && !busy && !batchAlignmentUI?.saving) flushSourceChanges();
    });
    return sourceChangeWorker;
  }

  function notice(message, persistent = false) {
    clearTimeout(noticeTimer); $('notice').textContent = message; $('notice').hidden = false;
    if (!persistent) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6500);
  }
  function options() {
    return { mode: $('value-mode').value, rangeMode: 'common', roiRegions: roiRegions === null ? null : [...roiRegions],
      channels: Array.from(document.querySelectorAll('input[name=channel]:checked'), input => input.value)
        .filter(name => !mouseRatioMode() || name !== MOUSE_STANDARD), threshold: finite($('threshold').value, 0) };
  }
  function saveView() {
    // A queued repaint may finish after a series switch has started. Never
    // store its old sections/default controls in the incoming series' slot.
    if (busy || !sections.length || sections.some(section => Stack3D.seriesOf(section).id !== activeSeries)) return;
    session.set(viewKey(), { ids: sections.map(section => section.id), selectedId: sections[selected]?.id, options: options(),
      opacity: finite($('opacity').value, 0.55), spacing: finite($('spacing').value, DEFAULT_SPACING), spacingDefaultsVersion: SPACING_DEFAULTS_VERSION,
      roi: roiOptions(), brain: brainOptions(),
      range: [finite($('range-start').value, 1), finite($('range-end').value, sections.length)],
      hiddenSectionIds: [...hiddenSectionIds], camera: renderer?.getView(), previewKind,
      ...(mouseRatioSeries() ? { mouseRatioDisplayVersion: MOUSE_RATIO_DISPLAY_VERSION } : {}) });
  }
  function restoreView() {
    const view = viewState();
    hiddenSectionIds.clear();
    // Preserve each known section's toggle even when sections are added or
    // removed. New sections start ON; never carry an unknown project ID.
    if (Array.isArray(view?.hiddenSectionIds)) {
      const loadedIds = new Set(sections.map(section => section.id));
      for (const id of view.hiddenSectionIds) if (loadedIds.has(id)) hiddenSectionIds.add(id);
    }
    if (!view || !Array.isArray(view.ids) || view.ids.join('\n') !== sections.map(section => section.id).join('\n')) return;
    const saved = view.options || {};
    $('value-mode').value = mouseRatioSeries() && view.mouseRatioDisplayVersion !== MOUSE_RATIO_DISPLAY_VERSION
      ? 'normalized' : saved.mode === 'normalized' ? 'normalized' : 'raw';
    if (Array.isArray(saved.channels)) for (const input of document.querySelectorAll('input[name=channel]')) input.checked = saved.channels.includes(input.value);
    $('threshold').value = Math.max(0, Math.min(0.95, finite(saved.threshold, 0)));
    $('opacity').value = Math.max(0.05, Math.min(1, finite(view.opacity, 0.55)));
    const savedSpacing = finite(view.spacing, defaultSpacing());
    // Adopt the new initial interval for sessions still at the former default.
    // Once migrated, a user's deliberate 1.0× setting remains 1.0×.
    $('spacing').value = Math.max(Number($('spacing').min), Math.min(Number($('spacing').max),
      !pixelSeries() && view.spacingDefaultsVersion !== SPACING_DEFAULTS_VERSION && Math.abs(savedSpacing - 0.35) < 1e-9 ? DEFAULT_SPACING : savedSpacing));
    $('roi-visible').checked = view.roi?.visible !== false;
    $('roi-labels').checked = view.roi?.labelsVisible !== false;
    const savedRegions = view.roi?.regions !== undefined ? view.roi.regions : saved.roiRegions;
    const legacyRegion = view.roi?.region || saved.roiRegion;
    setRoiSelection(Array.isArray(savedRegions) ? savedRegions : savedRegions === null ? null : legacyRegion ? [legacyRegion] : null);
    $('brain-visible').checked = view.brain?.visible === true;
    $('brain-opacity').value = Math.max(0.02, Math.min(0.35, finite(view.brain?.opacity, 0.12)));
    if (Array.isArray(view.range)) { $('range-start').value = view.range[0]; $('range-end').value = view.range[1]; }
    selected = Math.max(0, sections.findIndex(section => section.id === view.selectedId));
    previewKind = ['MSI', 'HE_Stain', 'ATLAS'].includes(view.previewKind) ? view.previewKind : 'MSI';
    restoredCamera = view.camera;
  }
  function setBusy(value) {
    busy = value;
    for (const id of ['reload', 'save-image', 'open-section', 'enlarge-preview', 'save-placement', 'reset-placement', 'save-cloud']) $(id).disabled = value || (id !== 'reload' && !sections.length);
    for (const input of document.querySelectorAll('.controls input,.controls select,.controls button,.slice-scrubber input,.slice-scrubber button,.placement input,[data-preview],.section-visible,.section-select,#enable-all-sections')) input.disabled = value || !sections.length;
    $('series-select').disabled = value || saving;
    syncSeriesRestrictions(); syncAlignmentControls();
  }
  function renderError(error) {
    $('render-error').hidden = false; $('render-error-text').textContent = error?.message || String(error);
    $('scene-message').hidden = true; $('save-image').disabled = true;
  }
  function emptyState(message) {
    $('scene-message').hidden = false; $('scene-message').querySelector('strong').textContent = message;
    $('load-progress').textContent = global.Cloud?.configured?.() && !global.Cloud?.signedIn?.()
      ? '左上のMarmoset AtlasからMasterへ戻り、クラウドにログインしてください。'
      : 'Masterで対象系列の切片を登録して「3D表示」から開いてください。';
    $('dataset-count').textContent = '0 sections'; $('render-state').textContent = ''; setBusy(false); updateVisibilityStatus();
  }
  function updateSeriesInventory(projects) {
    const inventory = new Map();
    for (const project of projects) {
      const info = Stack3D.seriesOf(project);
      if (info && !inventory.has(info.id)) inventory.set(info.id, info);
    }
    availableSeries = [...inventory.values()];
    const queryProject = query.get('project');
    if (!query.get('series') && queryProject && !sections.length) {
      const project = projects.find(item => item.id === queryProject);
      if (project) activeSeries = Stack3D.seriesOf(project).id;
    }
    if (!inventory.has(activeSeries) && availableSeries.length) activeSeries = availableSeries[0].id;
    const select = $('series-select'); select.replaceChildren();
    for (const info of availableSeries) {
      const option = document.createElement('option');
      option.value = info.id;
      option.textContent = `${info.species === 'mouse' ? 'Mouse' : 'Marmoset'} · ${info.name}`;
      select.append(option);
    }
    select.value = activeSeries;
    session.set('atlas-stack3d-active-series', activeSeries);
  }
  function buildChannels() {
    const group = $('channel-group'); group.replaceChildren();
    const legend = document.createElement('legend'); legend.textContent = '表示する分子'; group.append(legend);
    for (const name of Stack3D.analytesFor(sections)) {
      const label = document.createElement('label'), input = document.createElement('input');
      const swatch = document.createElement('span'), text = document.createElement('strong');
      label.className = 'channel'; input.type = 'checkbox'; input.name = 'channel'; input.value = name; input.checked = true;
      swatch.className = 'swatch'; text.textContent = Stack3D.analyteLabel(name) + (mouseRatioSeries() && name === MOUSE_STANDARD ? ' · raw QC' : '');
      const color = Stack3D.COLORS[name]; if (color) swatch.style.backgroundColor = `rgb(${color.join(',')})`;
      label.append(input, swatch, text); group.append(label);
    }
  }
  function configureSeriesView() {
    const pixel = pixelSeries(), info = activeSeriesInfo();
    $('master-link').href = '../index.html?series=' + encodeURIComponent(activeSeries);
    $('dataset-title').textContent = `${info.species === 'mouse' ? 'Mouse' : 'Marmoset'} · ${info.name}`;
    $('series-note').textContent = pixel
      ? '確定した切片番号順。輪郭による剛体位置合わせ済み。画素サイズ・切片間隔の実寸は不明です。'
      : '選択した系列内の切片を表示します。';
    $('spacing').min = pixel ? '0.5' : '0.08'; $('spacing').max = pixel ? '8' : '2'; $('spacing').step = pixel ? '0.1' : '0.005';
    $('spacing').value = defaultSpacing();
    $('opacity').value = '0.55'; $('threshold').value = '0'; $('value-mode').value = mouseRatioSeries() ? 'normalized' : 'raw';
    $('value-mode').querySelector('[value="raw"]').textContent = mouseRatioSeries() ? '原値 (a.u.)' : '原値';
    $('value-mode').querySelector('[value="normalized"]').textContent = mouseRatioSeries() ? '5-HT-d4補正 (相対比)' : '補正値';
    $('roi-visible').checked = true; $('roi-labels').checked = true; $('brain-visible').checked = false;
    $('brain-opacity').value = '0.12'; previewKind = 'MSI'; restoredCamera = null;
    $('section-search').value = ''; $('section-search').placeholder = pixel ? '切片番号・C025…' : 'Cor_…';
    $('direction-label').textContent = pixel ? `切片番号 1 → ${sections.length}（解剖学的方向は未指定）` : '小脳側 → 嗅球側（初期視点）';
    $('scrubber-hint').textContent = pixel ? '表示：1番 ～ 選択した切片番号' : '表示：小脳側 ～ 選択断面';
    $('section-slider').title = pixel ? '選択番号より後の切片を隠します' : '選択した断面より後（嗅球側）の切片を隠します';
    $('spacing-help').textContent = pixel ? '画像pixelを基準にした等間隔の表示です。実際の切片間隔ではありません。' : '前後方向は切片順です。間隔は表示上の距離です。';
    $('coordinate-note').textContent = pixel ? 'XY：画像pixel · Z：確定番号順。実寸は不明。' : 'XY：保存された画素サイズ · 前後：欠番を詰めた切片順';
    $('brain-help').textContent = pixel ? 'この模式図はマーモセット用のため、マウス系列では利用できません。' : 'マーモセット脳の模式図です。実際の脳への位置合わせは行っていません。';
    buildChannels(); syncSeriesRestrictions(); syncRatioControls();
  }
  function syncRatioControls() {
    const ratioSeries = mouseRatioSeries(), ratio = mouseRatioMode();
    const standard = [...document.querySelectorAll('input[name=channel]')].find(input => input.value === MOUSE_STANDARD);
    if (standard) {
      if (ratio) standard.checked = false;
      standard.disabled = busy || !sections.length || ratio;
      standard.closest('label').title = ratio ? '内部標準のQC画像は「原値」に切り替えて表示できます。' : '';
    }
    const help = $('value-mode-help'); help.hidden = !ratioSeries;
    help.textContent = ratio
      ? '5分子を同じ画素の5-HT-d4信号で割った相対比です。濃度ではありません。d4 > 0で計算し、0・欠損は算出不可。P10による低値除外はしていません。内部標準自体のQCは「原値」で表示できます。'
      : '保存された原値を表示しています。Serotonin-d4-DPPは噴霧した内部標準のQC信号です。';
  }
  function syncSeriesRestrictions() {
    const pixel = pixelSeries();
    $('analysis-panel').hidden = pixel; $('analysis-unavailable').hidden = !pixel;
    $('batch-alignment-details').hidden = pixel; $('placement-details').hidden = pixel; $('pixel-placement-note').hidden = !pixel;
    $('brain-visible').disabled = busy || !sections.length || pixel;
    if (pixel) $('brain-visible').checked = false;
    $('brain-opacity').disabled = busy || !sections.length || pixel || !$('brain-visible').checked;
    syncRatioControls();
  }
  async function sourceProjects(progress) {
    let locals = await ProjectStorage.listProjects();
    const notices = [], unsynced = [], rows = new Map(locals.map(project => [project.id, project]));
    const cloudReady = global.Cloud?.configured?.() && global.Cloud?.signedIn?.();
    if (cloudReady) {
      try {
        for (const row of await Cloud.listProjects()) rows.set(row.id, { ...(rows.get(row.id) || {}), id: row.id, displayName: row.display_name,
          ...(row.meta?.atlas ? { atlas: row.meta.atlas } : {}) });
      } catch (error) { notices.push('クラウド一覧を取得できません。取得済みデータを使用します。' + error.message); }
    } else if (global.Cloud?.configured?.()) notices.push('クラウド未接続です。取得済みデータを使用します。最新データはMasterでログインして確認してください。');
    updateSeriesInventory([...rows.values()]);
    const seriesRows = [...rows.values()].filter(project => Stack3D.seriesOf(project).id === activeSeries);
    const stored = session.get(seriesKey(SELECTION_KEY)) || session.get(SELECTION_KEY);
    const matchingStored = Array.isArray(stored) ? stored.filter(id => seriesRows.some(project => project.id === id)) : [];
    const requested = matchingStored.length ? new Set(matchingStored) : null;
    const queryId = new URLSearchParams(location.search).get('project');
    if (requested && queryId) requested.add(queryId);
    const candidates = Stack3D.sortCoronal(seriesRows.filter(project => !requested || requested.has(project.id)));
    const canonicalNames = new Set(), duplicates = new Set();
    for (const project of candidates) {
      const name = project.atlas?.sectionNumber ?? Stack3D.naturalCor(project)?.canonical;
      if (name == null) continue;
      if (canonicalNames.has(name)) duplicates.add(name); canonicalNames.add(name);
    }
    if (duplicates.size) {
      notices.push('同じ切片番号が複数あります。Masterで各切片番号が1つになるよう対象データを選択してください: ' + [...duplicates].join(', '));
      return { projects: [], allProjects: locals, folders: await ProjectStorage.listFolders(), notices, unsynced, blocked: '切片番号が重複しています' };
    }
    if (requested) for (const id of requested) if (!rows.has(id)) notices.push('選択データが見つかりません: ' + id);
    const projects = [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]; progress(`${i + 1} / ${candidates.length} · ${candidate.displayName || candidate.id}`);
      try {
        const project = cloudReady ? await ProjectSync.ensureLocal(candidate.id, {
          pendingFolderChanges: () => {
            const pending = {};
            try { if (localStorage.getItem('marmoset:pendingFolderChange:' + encodeURIComponent(candidate.id))) pending[candidate.id] = true; } catch (_) {}
            return pending;
          }
        }) : await ProjectStorage.getProject(candidate.id);
        if (!project) throw new Error('データ本体を取得できません');
        projects.push(project);
        if (cloudReady) {
          const status = ProjectSync.statusOf(project);
          if (status.status === 'local-edits') unsynced.push(`${project.displayName}: ${status.reason}`);
          else if (status.reason && !['current', 'updated', 'local-only'].includes(status.status)) notices.push(`${project.displayName}: ${status.reason}`);
        }
      } catch (error) { notices.push(`${candidate.displayName || candidate.id}: ${error.message}`); }
      await yieldUI();
    }
    // Cloud imports may update group membership; resolve normalization using
    // the completed, current project/folder inventory rather than the old list.
    locals = await ProjectStorage.listProjects();
    return { projects, allProjects: locals, folders: await ProjectStorage.listFolders(), notices, unsynced };
  }
  async function load() {
    analysisUI?.beginLoad();
    batchAlignmentUI?.reset();
    cancelAlignment();
    setBusy(true); renderGeneration++; previewGeneration++; heGeneration++; detailGeneration++;
    $('preview-dialog').close(); syncWarning([]); clearTimeout(noticeTimer); $('notice').hidden = true;
    const generation = ++loadGeneration; global.__stack3dReady = false;
    $('render-error').hidden = true;
    try {
      const source = await sourceProjects(text => { if (generation === loadGeneration) $('load-progress').textContent = text; });
      if (generation !== loadGeneration) return;
      syncWarning(source.unsynced);
      const loaded = await Stack3D.loadSections(source.projects, { allProjects: source.allProjects, folders: source.folders,
        onProgress: ({ completed, total, project }) => { if (generation === loadGeneration) $('load-progress').textContent = `${completed} / ${total} · ${project.displayName || project.id}`; } });
      if (generation !== loadGeneration) { loaded.forEach(Stack3D.releaseSection); return; }
      // Detach old canvases from GPU textures before releasing their pixels.
      renderer?.updateTextures(new Map(sections.map(section => [section.id, null])));
      renderer?.updateHeTextures(new Map(sections.map(section => [section.id, null])));
      hePlanes.forEach(canvas => { if (canvas) { canvas.width = 0; canvas.height = 0; } }); hePlanes.clear();
      sections.forEach(Stack3D.releaseSection); rendered.forEach(releaseRender);
      sections = loaded; rendered = []; commonRanges.clear(); hiddenSectionIds.clear(); dirtyPlacements.clear(); alignmentSaveGuards.clear(); staleSections.clear(); sourceChanged = false; selected = 0;
      configureSeriesView();
      loadedFolderFingerprint = JSON.stringify(source.folders);
      if (!sections.length) {
        if (!pixelSeries()) analysisUI?.setSections();
        renderer?.setSections([]); $('section-list').replaceChildren(); replacePreview($('section-preview'), null, '切片を選択してください');
        $('section-name').textContent = '—'; $('section-metadata').textContent = ''; $('section-status').textContent = '';
        emptyState(source.blocked || (source.projects.length ? '切片を読み込めませんでした' : 'この系列に表示する切片がありません'));
        const issues = [...source.notices, ...loaded.errors.map(error => `${error.name}: ${error.message}`)];
        if (issues.length) notice(issues.join(' / '), true); return;
      }
      $('range-start').value = 1; $('range-end').value = sections.length;
      for (const id of ['range-start', 'range-end']) $(id).max = sections.length;
      $('section-slider').max = sections.length - 1; buildRoiList(); restoreView();
      const queryId = new URLSearchParams(location.search).get('project'), queryIndex = sections.findIndex(section => section.id === queryId);
      if (queryIndex >= 0) selected = queryIndex;
      $('dataset-count').textContent = `${sections.length} sections`;
      if (!renderer) { try { renderer = Stack3DRenderer.createRenderer($('scene'), { onSelect: selectSection, onError: renderError }); } catch (error) { renderError(error); } }
      renderer?.setSections(sections); renderer?.setHiddenSections(hiddenSectionIds);
      renderer?.setSpacing(finite($('spacing').value, defaultSpacing())); renderer?.setOpacity(finite($('opacity').value, 0.55));
      renderer?.setHeOverlay({ visible: false }); renderer?.setRoiOverlay(roiOptions()); renderer?.setBrainContext(brainOptions());
      if (restoredCamera) { renderer?.setView(restoredCamera); restoredCamera = null; }
      updateLabels(); setRange(); buildList(); await repaint();
      if (generation !== loadGeneration) return;
      $('scene-message').hidden = true; setBusy(false); if (!renderer) $('save-image').disabled = true; selectSection(selected);
      if (!pixelSeries()) analysisUI?.setSections();
      const issues = [...source.notices, ...loaded.errors.map(error => `${error.name}: ${error.message}`)];
      if (issues.length) notice(issues.join(' / '), true);
      if (!unsubscribe && ProjectStorage.subscribeChanges) unsubscribe = ProjectStorage.subscribeChanges(onSourceChange);
      await flushSourceChanges();
      global.__stack3dReady = true;

    } catch (error) { analysisUI?.loadFailed(error.message); setBusy(false); emptyState('読み込みを完了できませんでした'); notice(error.message, true); }
  }
  function releaseRender(result) { if (result) for (const canvas of [result.canvas, result.previewCanvas]) if (canvas) { canvas.width = 0; canvas.height = 0; } }
  function updateLabels() {
    syncRatioControls();
    $('opacity-value').textContent = Math.round(finite($('opacity').value, 0.55) * 100) + '%';
    $('threshold-value').textContent = Math.round(finite($('threshold').value, 0) * 100) + '%';
    $('spacing-value').textContent = pixelSeries() ? `${finite($('spacing').value, 2).toFixed(1)} px` : (finite($('spacing').value, DEFAULT_SPACING) / 0.35).toFixed(1) + '×';
    $('brain-opacity-value').textContent = Math.round(finite($('brain-opacity').value, 0.12) * 100) + '%';
    $('brain-opacity').disabled = busy || !sections.length || pixelSeries() || !$('brain-visible').checked;
    $('brain-context-note').hidden = !$('brain-visible').checked || !sections.length || !renderer;
    for (const button of document.querySelectorAll('[data-preview]')) button.setAttribute('aria-pressed', String(button.dataset.preview === previewKind));
  }
  function brainOptions() { return { visible: !pixelSeries() && $('brain-visible').checked, opacity: finite($('brain-opacity').value, 0.12) }; }
  function roiOptions() { return { visible: $('roi-visible').checked, labelsVisible: $('roi-labels').checked, regions: roiRegions === null ? null : [...roiRegions] }; }
  function roiInputs() { return Array.from($('roi-region-list').querySelectorAll('input[name=roi-region]')); }
  function setRoiSelection(regions) {
    const inputs = roiInputs(), known = new Set(inputs.map(input => input.value));
    roiRegions = regions === null ? null : [...new Set(regions)].filter(name => known.has(name));
    $('roi-unrestricted').checked = roiRegions === null;
    for (const input of inputs) input.checked = roiRegions === null || roiRegions.includes(input.value);
    $('roi-selection-status').textContent = roiRegions === null ? '領域制限なし · ROI外も表示'
      : roiRegions.length ? `${roiRegions.length} / ${inputs.length}領域を表示` : '全消し · MSIとROIは非表示';
  }
  function roiSelectionChanged(regions) {
    if (busy) return;
    setRoiSelection(regions); renderer?.setRoiOverlay(roiOptions()); requestRepaint(); saveView();
  }
  function buildRoiList() {
    const list = $('roi-region-list'); list.replaceChildren();
    const names = new Set(sections.flatMap(section => Stack3D.roiPolygons(section).filter(p => p.visible).map(p => p.name)));
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
      const label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span');
      label.className = 'roi-region-row'; input.type = 'checkbox'; input.name = 'roi-region'; input.value = name;
      input.disabled = busy; text.textContent = name; label.append(input, text); list.append(label);
    }
    if (!names.size) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = '表示できるROIがありません。'; list.append(empty); }
    setRoiSelection(null);
  }
  async function repaint() {
    const generation = ++renderGeneration, loadToken = loadGeneration, seriesId = activeSeries, current = options(); updateLabels();
    const enabled = sections.filter(section => !hiddenSectionIds.has(section.id));
    $('mode-label').textContent = current.channels.length ? current.channels.map(Stack3D.analyteLabel).join(' + ') : '分子を選択'; $('render-state').textContent = '表示を更新中…';
    $('save-image').disabled = true;
    if (current.rangeMode === 'common') {
      if (!commonRanges.has(current.mode)) commonRanges.set(current.mode, Stack3D.computeCommonRanges(enabled, current.mode));
      current.commonRanges = commonRanges.get(current.mode);
    }
    let unavailable = 0;
    for (let i = 0; i < sections.length; i++) {
      if (generation !== renderGeneration) return;
      const result = Stack3D.renderSection(sections[i], enabled.length ? current : { ...current, channels: [] }), old = rendered[i]; rendered[i] = result;
      renderer?.updateTextures(new Map([[sections[i].id, result.canvas]])); releaseRender(old);
      if (!hiddenSectionIds.has(sections[i].id) && result.status.code === 'UNAVAILABLE') unavailable++;
      if (i % 4 === 3) await yieldUI();
    }
    if (generation !== renderGeneration) return;
    $('render-state').textContent = `${valueModeLabel()} · ON ${enabled.length} / ${sections.length}切片${unavailable ? ` / ${unavailable}切片は表示不可` : ''}`;
    $('save-image').disabled = busy || !renderer || !$('render-error').hidden;
    updateList(); await refreshPreview();
    if (generation !== renderGeneration || loadToken !== loadGeneration || seriesId !== activeSeries) return;
    saveView();
  }
  function requestRepaint() {
    if (busy) return; renderGeneration++;
    if (repaintPending) return; repaintPending = true;
    const loadToken = loadGeneration, seriesId = activeSeries;
    requestAnimationFrame(() => {
      repaintPending = false;
      if (busy || loadToken !== loadGeneration || seriesId !== activeSeries) return;
      repaint().catch(error => notice(error.message, true));
    });
  }
  function buildList() {
    $('section-list').replaceChildren();
    sections.forEach((section, index) => {
      const row = document.createElement('div'); row.className = 'section-row'; row.dataset.index = index; row.setAttribute('role', 'listitem');
      const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.className = 'section-visible'; toggle.dataset.sectionId = section.id;
      toggle.setAttribute('aria-label', `${section.name}を3D表示`); toggle.setAttribute('aria-describedby', 'visibility-help');
      toggle.addEventListener('change', () => setSectionVisible(section.id, toggle.checked));
      const button = document.createElement('button'); button.className = 'section-select'; button.setAttribute('aria-label', `${index + 1} ${section.name}`);
      const rank = document.createElement('span'), name = document.createElement('span'); rank.className = 'rank'; rank.textContent = String(index + 1).padStart(2, '0'); name.textContent = section.name;
      button.append(rank, name); button.addEventListener('click', () => selectSection(index)); row.append(toggle, button); $('section-list').append(row);
    });
    filterList(); updateList();
  }
  function updateList() {
    for (const row of $('section-list').children) {
      const index = Number(row.dataset.index), section = sections[index]; row.setAttribute('aria-current', String(index === selected)); row.querySelector('.status-dot,.dirty-dot')?.remove();
      const visible = !hiddenSectionIds.has(section.id);
      row.querySelector('.section-visible').checked = visible; row.querySelector('.section-visible').disabled = busy;
      row.querySelector('.section-select').setAttribute('aria-current', String(index === selected)); row.querySelector('.section-select').disabled = busy;
      row.classList.toggle('section-off', !visible);
      if (dirtyPlacements.has(section.id) || (visible && rendered[index]?.status.code === 'UNAVAILABLE')) {
        const dot = document.createElement('span'); dot.className = dirtyPlacements.has(section.id) ? 'dirty-dot' : 'status-dot'; dot.textContent = dirtyPlacements.has(section.id) ? '•' : '';
        dot.title = dirtyPlacements.has(section.id) ? '配置の未保存変更' : '現在の表示値を表示できません'; row.append(dot);
      }
    }
    updateVisibilityStatus();
  }
  function updateVisibilityStatus() {
    const count = sections.length - hiddenSectionIds.size;
    $('visibility-status').textContent = count ? `ON ${count} / ${sections.length}切片 · OFF ${hiddenSectionIds.size}` : 'ON 0切片 · 全切片がOFFです。チェックを入れると再表示できます。';
    $('enable-all-sections').disabled = busy || !hiddenSectionIds.size;
  }
  function visibilityChanged() {
    // Invalidate BOTH raw and corrected display windows. Stored normalization
    // references and scientific arrays remain untouched.
    commonRanges.clear(); previewGeneration++; detailGeneration++;
    $('preview-dialog').close();
    renderer?.setHiddenSections(hiddenSectionIds); updateList(); saveView();
    requestRepaint();
  }
  function setSectionVisible(id, visible) {
    if (busy || !sections.some(section => section.id === id)) return;
    if (visible) hiddenSectionIds.delete(id); else hiddenSectionIds.add(id);
    visibilityChanged();
  }
  function filterList() {
    const text = $('section-search').value.trim().toLowerCase();
    for (const row of $('section-list').children) {
      const section = sections[Number(row.dataset.index)], atlas = section.project.atlas;
      row.hidden = !`${section.name} ${atlas?.sourceCandidateId || ''} ${atlas?.sectionNumber || ''}`.toLowerCase().includes(text);
    }
  }
  function selectSection(index, cutAfter = false) {
    if (!sections.length) return;
    const nextSelected = Math.max(0, Math.min(sections.length - 1, Math.round(Number(index) || 0)));
    if (nextSelected !== selected) cancelAlignment();
    selected = nextSelected; const section = sections[selected];
    if (cutAfter) $('range-end').value = selected + 1;
    if (selected + 1 < Number($('range-start').value)) $('range-start').value = selected + 1;
    if (selected + 1 > Number($('range-end').value)) $('range-end').value = selected + 1;
    setRange(); renderer?.select(selected); $('section-slider').value = selected; $('section-position').textContent = `${selected + 1} / ${sections.length}`;
    $('section-name').textContent = section.name; $('section-metadata').textContent = pixelSeries()
      ? `${section.W} × ${section.H} px · ${section.project.atlas?.sourceCandidateId || ''} · 回転 ${finite(section.rotationDeg, 0).toFixed(1)}° / 移動 ${finite(section.offsetXPx, 0).toFixed(2)}, ${finite(section.offsetYPx, 0).toFixed(2)} px · 実寸不明`
      : `${section.umPerPxX} × ${section.umPerPxY} µm / pixel · ${section.W} × ${section.H}`;
    $('offset-x').value = section.offsetXUm; $('offset-y').value = section.offsetYUm; $('rotation').value = section.rotationDeg;
    $('placement-status').textContent = placementStatus(section);
    $('previous-section').disabled = selected === 0; $('next-section').disabled = selected === sections.length - 1;
    $('save-cloud').hidden = !(global.Cloud?.configured?.() && global.Cloud?.signedIn?.());
    syncAlignmentControls(); updateList(); refreshPreview().catch(error => notice(error.message)); saveView();
    if (!pixelSeries()) analysisUI?.selectionChanged();
  }
  function setRange() {
    if (!sections.length) return;
    const start = Math.max(1, Math.min(sections.length, Math.round(finite($('range-start').value, 1))));
    const end = Math.max(start, Math.min(sections.length, Math.round(finite($('range-end').value, sections.length))));
    $('range-start').value = start; $('range-end').value = end; renderer?.setRange(start - 1, end - 1); saveView();
  }
  function previewScale(section, maxSize) {
    const pitchX = section.previewPitchX ?? section.umPerPxX, pitchY = section.previewPitchY ?? section.umPerPxY;
    const pitch = Math.min(pitchX, pitchY);
    const width = section.W * pitchX / pitch, height = section.H * pitchY / pitch;
    const angle = section.angleDeg * Math.PI / 180;
    return maxSize / Math.max(Math.abs(width * Math.cos(angle)) + Math.abs(height * Math.sin(angle)), Math.abs(width * Math.sin(angle)) + Math.abs(height * Math.cos(angle)));
  }
  function msiPreviewMessage() {
    if (hiddenSectionIds.size === sections.length) return '切片一覧から表示をONにしてください。';
    const current = options(), ranges = commonRanges.get(current.mode);
    if (!ranges) return '表示を更新中…';
    if (!current.channels.length) return '表示する分子を選択してください。';
    if (!current.channels.some(name => ranges[name]?.nFinite > 0)) return 'ONの切片に表示できる値がありません。分子・表示値を確認してください。';
    return '';
  }
  async function preview(index, kind, maxSize = 1024) {
    const section = sections[index], image = rendered[index]; if (!image) return null;
    if (kind === 'MSI') {
      if (msiPreviewMessage()) return null;
      const current = options(); current.commonRanges = commonRanges.get(current.mode);
      current.channels = current.channels.filter(name => current.commonRanges[name]?.nFinite > 0);
      const result = Stack3D.renderSection(section, { ...current, previewPixelScale: previewScale(section, maxSize), roi: true });
      result.canvas.width = 0; result.canvas.height = 0; return result.previewCanvas;
    }
    if (kind === 'HE_Stain') return Stack3D.renderHePreview(section, { maxSize: 2048, roi: true, roiRegions });
    if (kind === 'ATLAS') { const source = await Stack3D.loadReferenceImage(section, 'ATLAS'); if (!source) return null; const image = source.cloneNode(); image.alt = `${section.name} 参照アトラス`; return image; }
    return null;
  }
  function previewStatus(index) {
    const section = sections[index], status = rendered[index]?.status; if (!section || !status) return '';
    const roi = Stack3D.roiSummary(section);
    const visiblePolygons = Stack3D.roiPolygons(section).filter(polygon => polygon.visible && (roiRegions === null || roiRegions.includes(polygon.name))).length;
    const roiText = roi.totalPolygons ? `ROI輪郭 ${visiblePolygons} / ${roi.totalPolygons}` : 'ROI未登録';
    const off = hiddenSectionIds.has(section.id) ? '3D表示OFF・共通色範囲の計算対象外 · ' : '';
    if (previewKind === 'ATLAS') return off + '参照用の2Dアトラス画像';
    if (previewKind === 'HE_Stain') return off + `保存された位置合わせのHE画像 · ${roiText}`;
    if (hiddenSectionIds.size === sections.length) return '全切片がOFFです。切片一覧から表示をONにしてください。';
    if (msiPreviewMessage()) return off + msiPreviewMessage();
    const text = [valueModeLabel() + 'を表示'];
    if (status.code === 'UNAVAILABLE') text[0] = status.message || '表示できる値がありません。分子・表示値を確認してください。'; else if (status.message) text.push(status.message);
    if (status.unavailableChannels?.length && status.code !== 'UNAVAILABLE') text.push(`表示不可：${status.unavailableChannels.join('・')}`);
    if (options().mode === 'normalized' && status.code === 'PROVISIONAL') text.push('保存された暫定補正を使用');
    text.push(roiText);
    return off + text.join(' · ');
  }
  async function refreshPreview() {
    const generation = ++previewGeneration, index = selected, kind = previewKind; if (!sections[index]) return; updateLabels();
    delete $('section-preview').dataset.previewKind;
    const status = rendered[index]?.status;
    $('section-status').textContent = previewStatus(index); $('section-status').classList.toggle('warning', kind === 'MSI' && (status?.code === 'UNAVAILABLE' || status?.code === 'PARTIAL')); renderLegend(index);
    // A rapid scrub should decode the last requested HE/Atlas image next,
    // instead of queueing every obsolete intermediate section.
    pendingPreview = { generation, index, kind };
    if (!previewWorker) previewWorker = drainPreviews().finally(() => { previewWorker = null; });
    return previewWorker;
  }
  async function drainPreviews() {
    while (pendingPreview) {
      const { generation, index, kind } = pendingPreview; pendingPreview = null;
      if (generation !== previewGeneration) continue;
      try {
        const element = await preview(index, kind);
        if (generation !== previewGeneration) { releasePreview(element); continue; }
        replacePreview($('section-preview'), element, kind === 'MSI' ? msiPreviewMessage() : undefined); $('section-preview').dataset.previewKind = kind;
      } catch (error) {
        if (generation === previewGeneration) { replacePreview($('section-preview'), null, error.message); $('section-preview').dataset.previewKind = kind; }
      }
    }
  }
  function releasePreview(element) { if (element?.tagName === 'CANVAS') { element.width = 0; element.height = 0; } }
  function replacePreview(container, element, message = 'この参照画像は登録されていません。') {
    for (const child of container.children) releasePreview(child);
    if (element) container.replaceChildren(element);
    else { const text = document.createElement('p'); text.textContent = message; container.replaceChildren(text); }
  }
  async function enlargePreview() {
    const generation = ++detailGeneration, index = selected, kind = previewKind;
    if (!sections[index] || busy) return;
    const name = { MSI: 'MSI＋ROI', HE_Stain: 'HE＋ROI', ATLAS: 'Atlas' }[kind];
    $('detail-title').textContent = `${sections[index].name} · ${name}`;
    $('detail-status').textContent = previewStatus(index);
    delete $('detail-preview').dataset.previewKind;
    replacePreview($('detail-preview'), null, '画像を準備中…'); $('preview-dialog').showModal();
    try {
      const element = await preview(index, kind, 2048);
      if (generation !== detailGeneration || !$('preview-dialog').open) { releasePreview(element); return; }
      replacePreview($('detail-preview'), element, kind === 'MSI' ? msiPreviewMessage() : undefined); $('detail-preview').dataset.previewKind = kind;
    } catch (error) { if (generation === detailGeneration && $('preview-dialog').open) replacePreview($('detail-preview'), null, error.message); }
  }
  function renderLegend(index) {
    $('range-legend').replaceChildren(); const format = n => Number.isFinite(n) ? Number(n).toLocaleString('en-US', { maximumSignificantDigits: 4 }) : '—';
    for (const [name, range] of Object.entries(commonRanges.get(options().mode) || {})) {
      if (!range.memberIds?.length || !options().channels.includes(name)) continue;
      const row = document.createElement('div'), label = document.createElement('span'), value = document.createElement('span'); row.className = 'range-row'; label.textContent = Stack3D.analyteLabel(name);
      value.textContent = `${format(range.min)} – ${format(range.max)}${mouseRatioMode() ? ' (signal / d4)' : ''}`; row.append(label, value); $('range-legend').append(row);
    }
    if (options().mode === 'normalized' && options().rangeMode === 'common' && new Set(Object.values(commonRanges.get('normalized') || {}).flatMap(range => range.normalizationGroups || [])).size > 1) {
      const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = '複数の補正グループを含みます。補正基準の違いを考慮して比較してください。'; $('range-legend').append(hint);
    }
  }
  const placementOf = section => ({ offsetXUm: section.offsetXUm, offsetYUm: section.offsetYUm, rotationDeg: section.rotationDeg });
  function alignmentSource(project) {
    // Fingerprint only the source fields that determine the ROI coordinates.
    // Keep these snapshots after adoption so an external ROI edit cannot be
    // silently combined with a candidate derived from older coordinates.
    return JSON.stringify(['atlas', 'grid', 'rotation', 'world_coords', 'roi', 'stack3d'].map(key => project[key] ?? null));
  }
  function syncAlignmentControls() {
    const batchLocked = batchAlignmentUI?.active || batchAlignmentUI?.working;
    const unavailable = pixelSeries() || busy || saving || alignmentWorking || batchLocked || !sections.length || staleSections.has(sections[selected]?.id);
    const proposal = alignmentProposal;
    $('alignment-calculate').disabled = unavailable;
    $('alignment-preview').disabled = unavailable || !proposal?.fit;
    $('alignment-preview').setAttribute('aria-pressed', String(!!proposal?.previewing));
    $('alignment-preview').textContent = proposal?.previewing ? '元の配置と比較' : '候補を仮表示';
    $('alignment-adopt').disabled = unavailable || !proposal?.fit || !proposal.previewing;
    $('alignment-cancel').disabled = busy || saving || batchLocked || !proposal;
    for (const input of $('alignment-rois').querySelectorAll('input')) input.disabled = unavailable;
    for (const id of ['offset-x', 'offset-y', 'rotation', 'reset-placement']) $(id).disabled = unavailable || (!!proposal && !proposal.previewing);
    for (const id of ['save-placement', 'save-cloud']) $(id).disabled = unavailable || !!proposal;
    $('reload').disabled = busy || saving || !!batchAlignmentUI?.saving;
    $('open-section').disabled = busy || saving || !!batchAlignmentUI?.saving || !sections.length;
    batchAlignmentUI?.sync();
  }
  function applyPlacement(section, placement) {
    Object.assign(section, placement); renderer?.setPlacement(section.id, placement);
    if (sections[selected]?.id === section.id) {
      $('offset-x').value = section.offsetXUm; $('offset-y').value = section.offsetYUm; $('rotation').value = section.rotationDeg;
    }
  }
  function clearAlignmentUI(message = '') {
    $('alignment-result').hidden = true; $('alignment-rois').replaceChildren();
    $('alignment-summary').textContent = ''; $('alignment-message').textContent = message;
    syncAlignmentControls();
  }
  function cancelAlignment(message = '') {
    alignmentGeneration++; alignmentWorking = false;
    const proposal = alignmentProposal; alignmentProposal = null;
    if (proposal) {
      const section = sections.find(item => item.id === proposal.sectionId);
      if (section) {
        if (proposal.previewing) applyPlacement(section, proposal.basePlacement);
        if (proposal.baseDirty) dirtyPlacements.add(section.id); else dirtyPlacements.delete(section.id);
        if (sections[selected]?.id === section.id) $('placement-status').textContent = placementStatus(section);
        updateList();
      }
    }
    clearAlignmentUI(message);
  }
  async function checkAlignmentReferences(guard) {
    const projects = await Promise.all(guard.references.map(reference => ProjectStorage.getProject(reference.id)));
    const latest = new Map();
    guard.references.forEach((reference, index) => {
      const project = projects[index], loaded = sections.find(section => section.id === reference.id);
      if (!project || !loaded || alignmentSource(project) !== reference.source ||
          (reference.id !== guard.sectionId && !samePlacement(placementOf(loaded), reference.placement))) {
        throw new Error(`${reference.name} のROI・向き・寸法・配置が変更されました。再読込して候補を計算し直してください。`);
      }
      latest.set(reference.id, project);
    });
    return latest;
  }
  function alignmentSummary() {
    const proposal = alignmentProposal; if (!proposal?.fit) return;
    const base = proposal.basePlacement, draft = proposal.draftPlacement, rows = proposal.fit.rows;
    const angle = -(draft.rotationDeg - base.rotationDeg) * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    let squared = 0;
    for (const row of rows) {
      const x = row.current[0] - base.offsetXUm / 1000, y = row.current[1] + base.offsetYUm / 1000;
      const dx = c * x - s * y + draft.offsetXUm / 1000 - row.target[0];
      const dy = s * x + c * y - draft.offsetYUm / 1000 - row.target[1];
      squared += dx * dx + dy * dy;
    }
    $('alignment-summary').textContent = `${rows.length}領域 · ROI重心の差（RMS）\n${proposal.fit.rmsBeforeMm.toFixed(3)} → ${Math.sqrt(squared / rows.length).toFixed(3)} mm\n配置の変更量：X ${(draft.offsetXUm - base.offsetXUm).toFixed(1)} µm / Y ${(draft.offsetYUm - base.offsetYUm).toFixed(1)} µm / 回転 ${(draft.rotationDeg - base.rotationDeg).toFixed(2)}°`;
  }
  function refitAlignment() {
    const proposal = alignmentProposal; if (!proposal) return;
    const names = Array.from($('alignment-rois').querySelectorAll('input:checked'), input => input.value);
    try {
      // Always fit the frozen pre-proposal placement, including after a preview
      // or manual adjustment. Re-fitting an already transformed plane compounds
      // the candidate and would invalidate the original-vs-candidate comparison.
      proposal.fit = Stack3DAlignment.fit(proposal.baseSection, proposal.rows, names);
      proposal.draftPlacement = { ...proposal.fit.placement };
      if (proposal.previewing) applyPlacement(sections[selected], proposal.draftPlacement);
      $('alignment-message').textContent = proposal.description;
      alignmentSummary();
    } catch (error) {
      if (proposal.previewing) applyPlacement(sections[selected], proposal.basePlacement);
      proposal.previewing = false; proposal.fit = null; proposal.draftPlacement = null;
      $('alignment-message').textContent = error.message; $('alignment-summary').textContent = '';
    }
    syncAlignmentControls();
  }
  async function calculateAlignment() {
    if (pixelSeries() || busy || saving || alignmentWorking || batchAlignmentUI?.active || batchAlignmentUI?.working || !sections[selected] || staleSections.has(sections[selected].id)) return;
    cancelAlignment();
    const section = sections[selected], neighbors = [sections[selected - 1], section, sections[selected + 1]];
    if (neighbors.some(item => !item)) { $('alignment-message').textContent = '前後両方の切片が必要です。端の切片は計算しません。'; return; }
    if (neighbors.some(item => item.id !== section.id && dirtyPlacements.has(item.id))) {
      $('alignment-message').textContent = '前後の切片に未保存の配置があります。先に保存してから候補を計算してください。'; return;
    }
    const generation = ++alignmentGeneration;
    const guard = { sectionId: section.id, references: neighbors.map(item => ({ id: item.id, name: item.name,
      source: alignmentSource(item.project), placement: placementOf(item) })) };
    alignmentWorking = true; syncAlignmentControls(); $('alignment-message').textContent = '前後のROIを確認しています…';
    try {
      await checkAlignmentReferences(guard); await yieldUI();
      if (generation !== alignmentGeneration || sections[selected]?.id !== section.id) return;
      const result = Stack3DAlignment.describe(...neighbors);
      if (!result.available) throw new Error(result.reason);
      const description = `${neighbors[0].name} ← ${section.name} → ${neighbors[2].name}\n前後の同名ROIの重心の中点を比較先にします。` + (result.warnings.length ? '\n' + result.warnings.join('\n') : '');
      alignmentProposal = { ...guard, basePlacement: placementOf(section), baseSection: { ...section }, baseDirty: dirtyPlacements.has(section.id),
        rows: result.rows, description, fit: null, draftPlacement: null, previewing: false };
      for (const row of result.rows) {
        const label = document.createElement('label'), input = document.createElement('input'), name = document.createElement('span'), detail = document.createElement('small');
        label.className = 'alignment-roi-row'; input.type = 'checkbox'; input.className = 'alignment-roi-input'; input.value = row.name; input.checked = row.defaultSelected;
        name.textContent = row.name; detail.textContent = `面積比 ${row.areaRatio.toFixed(2)}倍` + (row.edge ? ' · 画像端に接触' : '');
        input.addEventListener('change', refitAlignment); name.append(detail); label.append(input, name); $('alignment-rois').append(label);
      }
      $('alignment-result').hidden = false; refitAlignment();
    } catch (error) {
      if (generation === alignmentGeneration) $('alignment-message').textContent = error.message;
    } finally {
      if (generation === alignmentGeneration) { alignmentWorking = false; syncAlignmentControls(); }
    }
  }
  async function previewAlignment() {
    const proposal = alignmentProposal; if (!proposal?.fit || busy || saving || alignmentWorking) return;
    if (proposal.previewing) {
      applyPlacement(sections[selected], proposal.basePlacement); proposal.previewing = false;
      $('placement-status').textContent = '元の配置を比較表示中です。候補はまだ採用していません。'; syncAlignmentControls(); return;
    }
    alignmentWorking = true; syncAlignmentControls();
    try {
      await checkAlignmentReferences(proposal);
      if (alignmentProposal !== proposal) return;
      applyPlacement(sections[selected], proposal.draftPlacement); proposal.previewing = true;
      $('placement-status').textContent = '候補を仮表示中です。下の数値で微調整できます。まだ保存されていません。';
    } catch (error) { if (alignmentProposal === proposal) cancelAlignment(error.message); }
    finally { if (alignmentProposal === proposal) { alignmentWorking = false; syncAlignmentControls(); } }
  }
  async function adoptAlignment() {
    const proposal = alignmentProposal; if (!proposal?.fit || !proposal.previewing || busy || saving || alignmentWorking) return;
    alignmentWorking = true; syncAlignmentControls();
    try {
      await checkAlignmentReferences(proposal);
      if (alignmentProposal !== proposal) return;
      dirtyPlacements.add(proposal.sectionId);
      alignmentSaveGuards.set(proposal.sectionId, { sectionId: proposal.sectionId, references: proposal.references });
      alignmentProposal = null; alignmentWorking = false; alignmentGeneration++;
      clearAlignmentUI('候補を採用しました。「配置を保存」でこのブラウザーに保存します。');
      $('placement-status').textContent = '配置に未保存の変更があります。'; updateList();
    } catch (error) { if (alignmentProposal === proposal) cancelAlignment(error.message); }
    finally { if (alignmentProposal === proposal) { alignmentWorking = false; syncAlignmentControls(); } }
  }
  function updatePlacement() {
    const section = sections[selected]; if (!section || pixelSeries() || busy || saving) return;
    if (staleSections.has(section.id)) { notice(staleSections.get(section.id), true); return; }
    if (alignmentWorking || batchAlignmentUI?.active || batchAlignmentUI?.working || (alignmentProposal && !alignmentProposal.previewing)) return;
    const fields = [$('offset-x').value, $('offset-y').value, $('rotation').value];
    const values = fields.map(value => value.trim() === '' ? NaN : Number(value));
    if (!values.every(Number.isFinite)) { notice('位置・回転には有限の数値を入力してください。'); return; }
    [section.offsetXUm, section.offsetYUm, section.rotationDeg] = values; renderer?.setPlacement(section.id, section);
    if (alignmentProposal) {
      alignmentProposal.draftPlacement = placementOf(section); alignmentSummary();
      $('placement-status').textContent = '候補を微調整して仮表示中です。採用後に保存してください。';
    } else {
      dirtyPlacements.add(section.id); $('placement-status').textContent = '配置に未保存の変更があります。'; updateList();
    }
  }
  function samePlacement(a, b) { return JSON.stringify(a || null) === JSON.stringify(b || null); }
  async function savePlacement() {
    const section = sections[selected]; if (!section || pixelSeries() || saving || busy || alignmentWorking || alignmentProposal || batchAlignmentUI?.active || batchAlignmentUI?.working) return;
    if (staleSections.has(section.id)) { notice(staleSections.get(section.id), true); return; }
    saving = true; syncAlignmentControls();
    try {
      const guard = alignmentSaveGuards.get(section.id);
      const referenceProjects = guard ? await checkAlignmentReferences(guard) : null;
      const latest = referenceProjects ? referenceProjects.get(section.id) : await ProjectStorage.getProject(section.id);
      if (!latest || !samePlacement(latest.stack3d, section.project.stack3d)) throw new Error('別の画面でこの切片の3D配置が変更されました。再読込して確認してください。');
      if (['atlas', 'grid', 'molecules', 'images', 'rotation', 'world_coords', 'folderId', 'normalization', 'normalizationBinding', 'layerDisplay', 'valueDisplay'].some(key => JSON.stringify(latest[key] || null) !== JSON.stringify(section.project[key] || null))) {
        throw new Error('切片のデータ・向き・位置合わせ・表示条件が変更されました。再読込してから3D配置を確認してください。');
      }
      const changedSinceLoad = latest.updatedAt !== section.project.updatedAt;
      const stack3d = { schemaVersion: 1, offsetXUm: section.offsetXUm, offsetYUm: section.offsetYUm, rotationDeg: section.rotationDeg };
      const saveOptions = { expectedUpdatedAt: latest.updatedAt };
      if (referenceProjects) saveOptions.expectedProjectRevisions = Array.from(referenceProjects.values(), project => ({ id: project.id, updatedAt: project.updatedAt }));
      const saved = await ProjectStorage.patchProjectFields(section.id, { stack3d }, saveOptions);
      section.project = saved; section.sourceRevision = saved.updatedAt; dirtyPlacements.delete(section.id); alignmentSaveGuards.delete(section.id);
      if (changedSinceLoad) { sourceChanged = true; analysisUI?.markStale([section.id]); }
      if (sections[selected]?.id === section.id) $('placement-status').textContent = 'このブラウザーに配置を保存しました。ZIP出力にも含まれます。';
      updateList(); notice(`${section.name} の配置を保存しました。` + (sourceChanged ? ' 他の更新内容は「再読込」で表示に反映できます。' : ''), sourceChanged);
    } catch (error) { notice(`配置を保存できませんでした：${error.message}`, true); }
    finally { saving = false; await flushSourceChanges({ preserveNotice: true }); syncAlignmentControls(); }
  }
  async function saveCloud() {
    const section = sections[selected]; if (!section || saving || busy || alignmentWorking || alignmentProposal || batchAlignmentUI?.active || batchAlignmentUI?.working) return;
    if (staleSections.has(section.id)) { notice(staleSections.get(section.id), true); return; }
    if (dirtyPlacements.has(section.id)) { notice('先に「配置を保存」を押してください。'); return; }
    saving = true; syncAlignmentControls();
    try {
      const project = await ProjectSync.saveState(section.project), status = ProjectSync.statusOf(project);
      const unchanged = acknowledgeCloudSave(section, project, status);
      if (status.status === 'saved-local-deleted') markStale(section);
      if (status.localStateKnown === false) notice(UNKNOWN_LOCAL_MESSAGE, true);
      else if (!unchanged) notice('クラウドには保存されました。保存中に手元のデータが更新されたため、「再読込」で最新の内容を確認してください。', true);
      else if (status.status !== 'saved' || status.remainingLocalEdits) notice(status.reason || 'クラウドには保存されました。手元の未同期の編集を確認してください。', true);
      else notice('クラウドに保存しました。');
    }
    catch (error) { notice(`クラウド保存を完了できませんでした：${error.message}`, true); }
    finally { saving = false; await flushSourceChanges({ preserveNotice: true }); syncAlignmentControls(); }
  }
  function onSourceChange(change) {
    const ids = change?.projectIds || [];
    for (const id of ids) if (sections.some(section => section.id === id)) pendingSourceIds.add(id);
    if (!ids.length || change?.folderIds?.length) pendingFolderChange = true;
    flushSourceChanges();
  }
  function openSection() {
    if (!sections[selected] || busy || saving || batchAlignmentUI?.saving) return;
    // Keep this 3D scene and its unsaved placement drafts alive in the original tab.
    saveView();
    global.open('../viewer/index.html?project=' + encodeURIComponent(sections[selected].id) + '&from=stack3d&newtab=1', '_blank', 'noopener');
  }
  $('channel-group').addEventListener('change', event => {
    if (!event.target.matches('input[name=channel]')) return;
    requestRepaint(); if (!pixelSeries()) analysisUI?.valueModeChanged();
  });
  $('value-mode').addEventListener('change', () => { requestRepaint(); if (!pixelSeries()) analysisUI?.valueModeChanged(); });
  $('series-select').addEventListener('change', () => {
    if (busy || saving || $('series-select').value === activeSeries) return;
    if (dirtyPlacements.size && !global.confirm('未保存の3D配置を破棄して系列を切り替えますか？')) { $('series-select').value = activeSeries; return; }
    saveView(); activeSeries = $('series-select').value;
    session.set('atlas-stack3d-active-series', activeSeries);
    query.set('series', activeSeries); query.delete('project');
    history.replaceState(null, '', `${location.pathname}?${query}`);
    $('scene-message').hidden = false; $('scene-message').querySelector('strong').textContent = '切片を読み込んでいます'; load();
  });
  $('threshold').addEventListener('input', requestRepaint);
  $('opacity').addEventListener('input', () => { renderer?.setOpacity(Number($('opacity').value)); updateLabels(); saveView(); });
  for (const id of ['roi-visible', 'roi-labels']) $(id).addEventListener('change', () => {
    renderer?.setRoiOverlay(roiOptions()); saveView();
  });
  $('roi-region-list').addEventListener('change', event => {
    if (event.target.matches('input[name=roi-region]')) roiSelectionChanged(roiInputs().filter(input => input.checked).map(input => input.value));
  });
  $('roi-unrestricted').addEventListener('change', () => roiSelectionChanged($('roi-unrestricted').checked ? null : roiInputs().filter(input => input.checked).map(input => input.value)));
  $('roi-select-all').addEventListener('click', () => roiSelectionChanged(roiInputs().map(input => input.value)));
  $('roi-clear-all').addEventListener('click', () => roiSelectionChanged([]));
  for (const [id, event] of [['brain-visible', 'change'], ['brain-opacity', 'input']]) $(id).addEventListener(event, () => { renderer?.setBrainContext(brainOptions()); updateLabels(); saveView(); });
  $('spacing').addEventListener('input', () => { renderer?.setSpacing(Number($('spacing').value)); updateLabels(); saveView(); });
  for (const id of ['range-start', 'range-end']) $(id).addEventListener('change', setRange);
  $('show-all').addEventListener('click', () => { $('range-start').value = 1; $('range-end').value = sections.length; setRange(); });
  $('enable-all-sections').addEventListener('click', () => { if (busy) return; hiddenSectionIds.clear(); visibilityChanged(); });
  $('section-slider').addEventListener('input', () => selectSection($('section-slider').value, true));
  $('previous-section').addEventListener('click', () => selectSection(selected - 1, true)); $('next-section').addEventListener('click', () => selectSection(selected + 1, true));
  $('section-search').addEventListener('input', filterList);
  for (const button of document.querySelectorAll('[data-preview]')) button.addEventListener('click', () => { previewKind = button.dataset.preview; refreshPreview(); saveView(); });
  $('enlarge-preview').addEventListener('click', enlargePreview);
  $('close-preview').addEventListener('click', () => $('preview-dialog').close());
  $('preview-dialog').addEventListener('close', () => { detailGeneration++; replacePreview($('detail-preview'), null, ''); });
  $('sync-warning').addEventListener('click', () => { const open = $('sync-details').hidden; $('sync-details').hidden = !open; $('sync-warning').setAttribute('aria-expanded', String(open)); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('sync-details').hidden = true; $('sync-warning').setAttribute('aria-expanded', 'false'); } });
  $('reset-view').addEventListener('click', () => { renderer?.resetView(); saveView(); });
  for (const id of ['offset-x', 'offset-y', 'rotation']) $(id).addEventListener('change', updatePlacement);
  $('reset-placement').addEventListener('click', () => { for (const id of ['offset-x', 'offset-y', 'rotation']) $(id).value = 0; updatePlacement(); });
  $('alignment-calculate').addEventListener('click', calculateAlignment);
  $('alignment-preview').addEventListener('click', previewAlignment);
  $('alignment-adopt').addEventListener('click', adoptAlignment);
  $('alignment-cancel').addEventListener('click', () => cancelAlignment('候補を取り消し、計算前の配置に戻しました。'));
  $('save-placement').addEventListener('click', savePlacement); $('save-cloud').addEventListener('click', saveCloud); $('open-section').addEventListener('click', openSection);
  $('master-link').addEventListener('click', saveView);
  $('reload').addEventListener('click', () => {
    if (dirtyPlacements.size && !global.confirm('未保存の3D配置を破棄して、最新データを再読込しますか？')) return;
    saveView(); $('scene-message').hidden = false; $('scene-message').querySelector('strong').textContent = '切片を読み込んでいます'; load();
  });
  $('save-image').addEventListener('click', async () => {
    if (!renderer) return;
    try { const image = await renderer.capturePNG(), link = document.createElement('a'); link.href = image; link.download = `${activeSeries}_3d_${options().channels.join('_') || 'empty'}.png`; link.click(); }
    catch (error) { notice(`画像を保存できませんでした：${error.message}`); }
  });
  global.addEventListener('beforeunload', event => { saveView(); if (dirtyPlacements.size) { event.preventDefault(); event.returnValue = ''; } });
  global.addEventListener('pagehide', event => {
    batchAlignmentUI?.cancel(); cancelAlignment(); saveView(); if (event.persisted) return; renderGeneration++; loadGeneration++; previewGeneration++; heGeneration++; detailGeneration++;
    analysisUI?.dispose();
    unsubscribe?.(); renderer?.dispose(); rendered.forEach(releaseRender); sections.forEach(Stack3D.releaseSection);
    hePlanes.forEach(releasePreview); hePlanes.clear();
  });
  for (const [name, color] of Object.entries(Stack3D.COLORS)) {
    const input = Array.from(document.querySelectorAll('input[name=channel]')).find(input => input.value === name);
    if (input) input.closest('label').querySelector('.swatch').style.backgroundColor = `rgb(${color.join(',')})`;
  }
  global.AppVersion?.paint?.();
  analysisUI = Stack3DAnalysisUI.create({
    root: $('analysis-panel'), getSections: () => pixelSeries() ? [] : sections, getSelected: () => selected, getOptions: options,
    getDisplayedSectionIds: () => sections.filter((section, index) => index >= Number($('range-start').value) - 1 &&
      index <= Number($('range-end').value) - 1 && !hiddenSectionIds.has(section.id)).map(section => section.id),
    onSelect: id => { const index = sections.findIndex(section => section.id === id); if (index >= 0) selectSection(index); }, session
  });
  batchAlignmentUI = Stack3DBatchUI.create({
    getSections: () => sections, getSelected: () => selected,
    isLocked: () => pixelSeries() || busy || saving || alignmentWorking,
    hasStaleSources: () => staleSections.size > 0, isSourceStale: id => staleSections.has(id),
    placementOf, applyPlacement, getDirtyIds: () => new Set(dirtyPlacements),
    setDirty: (id, value) => { if (value) dirtyPlacements.add(id); else dirtyPlacements.delete(id); },
    selectSection, onBeforeCalculate: cancelAlignment,
    onChange: () => {
      syncAlignmentControls(); updateList();
      const current = sections[selected];
      if (current) $('placement-status').textContent = placementStatus(current);
    },
    onSaved: projects => {
      for (const project of projects) {
        const section = sections.find(item => item.id === project.id); if (!section) continue;
        section.project = project; section.sourceRevision = project.updatedAt;
        dirtyPlacements.delete(project.id); alignmentSaveGuards.delete(project.id);
      }
      $('placement-status').textContent = '一括配置をこのブラウザーに保存しました。ZIP出力にも含まれます。';
    },
    onCloudSaved: (project, status) => {
      const section = sections.find(item => item.id === project.id);
      if (!section) return;
      if (!acknowledgeCloudSave(section, project, status)) notice(status?.localStateKnown === false ? UNKNOWN_LOCAL_MESSAGE : 'クラウド保存中に手元のデータが更新されました。「再読込」で最新の内容を確認してください。', true);
    },
    onPersistenceFinished: () => flushSourceChanges({ preserveNotice: true })
  });
  global.Atlas3D = { get sections() { return sections; }, get selected() { return selected; }, get rendered() { return rendered; },
    get seriesId() { return activeSeries; }, get availableSeries() { return availableSeries.slice(); },
    get hiddenSectionIds() { return [...hiddenSectionIds]; },
    get analysis() { return analysisUI; },
    get renderer() { return renderer; }, get sourceChanged() { return sourceChanged; }, options, selectSection };
  load();
})(window);
