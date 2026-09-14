/* Native Atlas 3D entry point. Projects are read through the same storage,
 * normalization and cloud synchronization modules as the existing Viewer. */
(function (global) {
  'use strict';
  const $ = id => document.getElementById(id);
  const SELECTION_KEY = 'atlas-stack3d-selection', VIEW_KEY = 'atlas-stack3d-view-v1';
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));
  const session = {
    get(key) { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (_) { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (_) {} }
  };
  let sections = [], rendered = [], renderer = null, selected = 0, previewKind = 'MSI';
  let renderGeneration = 0, loadGeneration = 0, previewGeneration = 0, heGeneration = 0, detailGeneration = 0;
  let busy = false, saving = false, noticeTimer, unsubscribe = null, sourceChanged = false, restoredCamera = null, repaintPending = false;
  let pendingPreview = null, previewWorker = null;
  const dirtyPlacements = new Set(), commonRanges = new Map(), hePlanes = new Map();

  function syncWarning(messages) {
    const button = $('sync-warning'), text = messages.join('\n');
    button.hidden = !messages.length; button.title = text;
    button.setAttribute('aria-label', messages.length ? `未同期の編集があります（${messages.length}切片）。詳細を表示` : '未同期の編集はありません');
    button.setAttribute('aria-expanded', 'false'); $('sync-details').hidden = true; $('sync-details').textContent = text;
  }

  function notice(message, persistent = false) {
    clearTimeout(noticeTimer); $('notice').textContent = message; $('notice').hidden = false;
    if (!persistent) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6500);
  }
  function options() {
    return { mode: $('value-mode').value, rangeMode: 'common',
      channels: Array.from(document.querySelectorAll('input[name=channel]:checked'), input => input.value), threshold: finite($('threshold').value, 0) };
  }
  function saveView() {
    if (!sections.length) return;
    session.set(VIEW_KEY, { ids: sections.map(section => section.id), selectedId: sections[selected]?.id, options: options(),
      opacity: finite($('opacity').value, 0.55), spacing: finite($('spacing').value, 0.35), he: heOptions(), brain: brainOptions(),
      range: [finite($('range-start').value, 1), finite($('range-end').value, sections.length)], camera: renderer?.getView(), previewKind });
  }
  function restoreView() {
    const view = session.get(VIEW_KEY);
    if (!view || !Array.isArray(view.ids) || view.ids.join('\n') !== sections.map(section => section.id).join('\n')) return;
    const saved = view.options || {};
    $('value-mode').value = saved.mode === 'normalized' ? 'normalized' : 'raw';
    if (Array.isArray(saved.channels)) for (const input of document.querySelectorAll('input[name=channel]')) input.checked = saved.channels.includes(input.value);
    $('threshold').value = Math.max(0, Math.min(0.95, finite(saved.threshold, 0)));
    $('opacity').value = Math.max(0.05, Math.min(1, finite(view.opacity, 0.55)));
    $('spacing').value = Math.max(0.08, Math.min(2, finite(view.spacing, 0.35)));
    $('he-visible').checked = view.he?.visible !== false;
    $('he-opacity').value = Math.max(0.01, Math.min(0.4, finite(view.he?.opacity, 0.12)));
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
    for (const input of document.querySelectorAll('.controls input,.controls select,.controls button,.slice-scrubber input,.slice-scrubber button,.placement input,[data-preview]')) input.disabled = value || !sections.length;
  }
  function renderError(error) {
    $('render-error').hidden = false; $('render-error-text').textContent = error?.message || String(error);
    $('scene-message').hidden = true; $('save-image').disabled = true;
  }
  function emptyState(message) {
    $('scene-message').hidden = false; $('scene-message').querySelector('strong').textContent = message;
    $('load-progress').textContent = global.Cloud?.configured?.() && !global.Cloud?.signedIn?.()
      ? '左上のMarmoset AtlasからMasterへ戻り、クラウドにログインしてください。'
      : '左上のMarmoset AtlasからMasterへ戻り、Cor切片を登録して「3D表示」から開いてください。';
    $('dataset-count').textContent = '0 sections'; $('render-state').textContent = ''; setBusy(false);
  }
  async function sourceProjects(progress) {
    let locals = await ProjectStorage.listProjects();
    const notices = [], unsynced = [], rows = new Map(locals.map(project => [project.id, project]));
    const cloudReady = global.Cloud?.configured?.() && global.Cloud?.signedIn?.();
    if (cloudReady) {
      try {
        for (const row of await Cloud.listProjects()) rows.set(row.id, { ...(rows.get(row.id) || {}), id: row.id, displayName: row.display_name });
      } catch (error) { notices.push('クラウド一覧を取得できません。取得済みデータを使用します。' + error.message); }
    } else if (global.Cloud?.configured?.()) notices.push('クラウド未接続です。取得済みデータを使用します。最新データはMasterでログインして確認してください。');
    const stored = session.get(SELECTION_KEY), requested = Array.isArray(stored) && stored.length ? new Set(stored) : null;
    const queryId = new URLSearchParams(location.search).get('project');
    if (requested && queryId) requested.add(queryId);
    const candidates = Stack3D.sortCoronal(Array.from(rows.values()).filter(project => !requested || requested.has(project.id)));
    const canonicalNames = new Set(), duplicates = new Set();
    for (const project of candidates) {
      const name = Stack3D.naturalCor(project).canonical;
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
      sections = loaded; rendered = []; commonRanges.clear(); dirtyPlacements.clear(); sourceChanged = false; selected = 0;
      if (!sections.length) {
        renderer?.setSections([]); $('section-list').replaceChildren(); replacePreview($('section-preview'), null, '切片を選択してください');
        $('section-name').textContent = '—'; $('section-metadata').textContent = ''; $('section-status').textContent = '';
        emptyState(source.blocked || (source.projects.length ? '切片を読み込めませんでした' : '表示するCor切片がありません'));
        const issues = [...source.notices, ...loaded.errors.map(error => `${error.name}: ${error.message}`)];
        if (issues.length) notice(issues.join(' / '), true); return;
      }
      $('range-start').value = 1; $('range-end').value = sections.length;
      for (const id of ['range-start', 'range-end']) $(id).max = sections.length;
      $('section-slider').max = sections.length - 1; restoreView();
      const queryId = new URLSearchParams(location.search).get('project'), queryIndex = sections.findIndex(section => section.id === queryId);
      if (queryIndex >= 0) selected = queryIndex;
      $('dataset-count').textContent = `${sections.length} sections`; $('dataset-title').textContent = 'Coronal sections';
      if (!renderer) { try { renderer = Stack3DRenderer.createRenderer($('scene'), { onSelect: selectSection, onError: renderError }); } catch (error) { renderError(error); } }
      renderer?.setSections(sections); renderer?.setSpacing(finite($('spacing').value, 0.35)); renderer?.setOpacity(finite($('opacity').value, 0.55));
      renderer?.setHeOverlay(heOptions()); renderer?.setBrainContext(brainOptions());
      if (restoredCamera) { renderer?.setView(restoredCamera); restoredCamera = null; }
      updateLabels(); setRange(); buildList(); await repaint();
      if (generation !== loadGeneration) return;
      $('scene-message').hidden = true; setBusy(false); if (!renderer) $('save-image').disabled = true; selectSection(selected);
      const issues = [...source.notices, ...loaded.errors.map(error => `${error.name}: ${error.message}`)];
      if (issues.length) notice(issues.join(' / '), true);
      if (!unsubscribe && ProjectStorage.subscribeChanges) unsubscribe = ProjectStorage.subscribeChanges(onSourceChange);
      global.__stack3dReady = true;
      updateHeOverlay().catch(error => notice(error.message));
    } catch (error) { setBusy(false); emptyState('読み込みを完了できませんでした'); notice(error.message, true); }
  }
  function releaseRender(result) { if (result) for (const canvas of [result.canvas, result.previewCanvas]) if (canvas) { canvas.width = 0; canvas.height = 0; } }
  function updateLabels() {
    $('opacity-value').textContent = Math.round(finite($('opacity').value, 0.55) * 100) + '%';
    $('threshold-value').textContent = Math.round(finite($('threshold').value, 0) * 100) + '%';
    $('spacing-value').textContent = (finite($('spacing').value, 0.35) / 0.35).toFixed(1) + '×';
    $('he-opacity-value').textContent = Math.round(finite($('he-opacity').value, 0.12) * 100) + '%';
    $('he-opacity').disabled = busy || !sections.length || !$('he-visible').checked;
    $('brain-opacity-value').textContent = Math.round(finite($('brain-opacity').value, 0.12) * 100) + '%';
    $('brain-opacity').disabled = busy || !sections.length || !$('brain-visible').checked;
    $('brain-context-note').hidden = !$('brain-visible').checked || !sections.length || !renderer;
    for (const button of document.querySelectorAll('[data-preview]')) button.setAttribute('aria-pressed', String(button.dataset.preview === previewKind));
  }
  function heOptions() { return { visible: $('he-visible').checked, opacity: finite($('he-opacity').value, 0.12) }; }
  function brainOptions() { return { visible: $('brain-visible').checked, opacity: finite($('brain-opacity').value, 0.12) }; }
  async function updateHeOverlay() {
    const generation = ++heGeneration, currentSections = sections;
    renderer?.setHeOverlay(heOptions()); updateLabels(); saveView();
    if (!$('he-visible').checked) { $('he-status').textContent = 'HEの重ね合わせはOFFです。'; return; }
    let available = 0, missing = 0, failed = 0;
    const errors = [];
    for (let i = 0; i < currentSections.length; i++) {
      if (generation !== heGeneration) return;
      const section = currentSections[i];
      $('he-status').textContent = `HEを準備中… ${i + 1} / ${currentSections.length}`;
      try {
        let canvas = hePlanes.get(section.id);
        if (!hePlanes.has(section.id)) {
          canvas = await Stack3D.renderHePlane(section, { maxSize: 768 });
          if (generation !== heGeneration) { if (canvas) { canvas.width = 0; canvas.height = 0; } return; }
          hePlanes.set(section.id, canvas);
        }
        if (canvas) { renderer?.updateHeTextures(new Map([[section.id, canvas]])); available++; } else missing++;
      } catch (error) { if (generation !== heGeneration) return; failed++; errors.push(`${section.name}: ${error.message}`); }
      await yieldUI();
    }
    if (generation !== heGeneration) return;
    $('he-status').textContent = `HE ${available} / ${currentSections.length}切片${missing ? ` · 未登録 ${missing}` : ''}${failed ? ` · 表示不可 ${failed}` : ''}`;
    $('he-status').title = errors.join('\n');
  }
  async function repaint() {
    const generation = ++renderGeneration, current = options(); updateLabels();
    $('mode-label').textContent = current.channels.length ? current.channels.join(' + ') : '分子を選択'; $('render-state').textContent = '表示を更新中…';
    if (current.rangeMode === 'common') {
      if (!commonRanges.has(current.mode)) commonRanges.set(current.mode, Stack3D.computeCommonRanges(sections, current.mode));
      current.commonRanges = commonRanges.get(current.mode);
    }
    let unavailable = 0;
    for (let i = 0; i < sections.length; i++) {
      if (generation !== renderGeneration) return;
      const result = Stack3D.renderSection(sections[i], current), old = rendered[i]; rendered[i] = result;
      renderer?.updateTextures(new Map([[sections[i].id, result.canvas]])); releaseRender(old);
      if (result.status.code === 'UNAVAILABLE') unavailable++;
      if (i % 4 === 3) await yieldUI();
    }
    if (generation !== renderGeneration) return;
    $('render-state').textContent = `${current.mode === 'raw' ? '原値' : '補正値'} · ${sections.length}切片${unavailable ? ` / ${unavailable}切片は表示不可` : ''}`;
    updateList(); await refreshPreview(); saveView();
  }
  function requestRepaint() {
    if (busy) return; renderGeneration++;
    if (repaintPending) return; repaintPending = true;
    requestAnimationFrame(() => { repaintPending = false; repaint().catch(error => notice(error.message, true)); });
  }
  function buildList() {
    $('section-list').replaceChildren();
    sections.forEach((section, index) => {
      const button = document.createElement('button'); button.className = 'section-row'; button.dataset.index = index;
      button.setAttribute('role', 'listitem'); button.setAttribute('aria-label', `${index + 1} ${section.name}`);
      const rank = document.createElement('span'), name = document.createElement('span'); rank.className = 'rank'; rank.textContent = String(index + 1).padStart(2, '0'); name.textContent = section.name;
      button.append(rank, name); button.addEventListener('click', () => selectSection(index)); $('section-list').append(button);
    });
    filterList(); updateList();
  }
  function updateList() {
    for (const row of $('section-list').children) {
      const index = Number(row.dataset.index), section = sections[index]; row.setAttribute('aria-current', String(index === selected)); row.querySelector('.status-dot,.dirty-dot')?.remove();
      if (dirtyPlacements.has(section.id) || rendered[index]?.status.code === 'UNAVAILABLE') {
        const dot = document.createElement('span'); dot.className = dirtyPlacements.has(section.id) ? 'dirty-dot' : 'status-dot'; dot.textContent = dirtyPlacements.has(section.id) ? '•' : '';
        dot.title = dirtyPlacements.has(section.id) ? '配置の未保存変更' : '現在の表示値を表示できません'; row.append(dot);
      }
    }
  }
  function filterList() { const query = $('section-search').value.trim().toLowerCase(); for (const row of $('section-list').children) row.hidden = !sections[Number(row.dataset.index)].name.toLowerCase().includes(query); }
  function selectSection(index, cutBefore = false) {
    if (!sections.length) return;
    selected = Math.max(0, Math.min(sections.length - 1, Math.round(Number(index) || 0))); const section = sections[selected];
    if (cutBefore) $('range-start').value = selected + 1;
    if (selected + 1 < Number($('range-start').value)) $('range-start').value = selected + 1;
    if (selected + 1 > Number($('range-end').value)) $('range-end').value = selected + 1;
    setRange(); renderer?.select(selected); $('section-slider').value = selected; $('section-position').textContent = `${selected + 1} / ${sections.length}`;
    $('section-name').textContent = section.name; $('section-metadata').textContent = `${section.umPerPxX} × ${section.umPerPxY} µm / pixel · ${section.W} × ${section.H}`;
    $('offset-x').value = section.offsetXUm; $('offset-y').value = section.offsetYUm; $('rotation').value = section.rotationDeg;
    $('placement-status').textContent = dirtyPlacements.has(section.id) ? '配置に未保存の変更があります。' : '保存済みの向きに、3D用の配置を加えます。';
    $('previous-section').disabled = selected === 0; $('next-section').disabled = selected === sections.length - 1;
    $('save-cloud').hidden = !(global.Cloud?.configured?.() && global.Cloud?.signedIn?.());
    updateList(); refreshPreview().catch(error => notice(error.message)); saveView();
  }
  function setRange() {
    if (!sections.length) return;
    const start = Math.max(1, Math.min(sections.length, Math.round(finite($('range-start').value, 1))));
    const end = Math.max(start, Math.min(sections.length, Math.round(finite($('range-end').value, sections.length))));
    $('range-start').value = start; $('range-end').value = end; renderer?.setRange(start - 1, end - 1); saveView();
  }
  function previewScale(section, maxSize) {
    const pitch = Math.min(section.umPerPxX, section.umPerPxY);
    const width = section.W * section.umPerPxX / pitch, height = section.H * section.umPerPxY / pitch;
    const angle = section.angleDeg * Math.PI / 180;
    return maxSize / Math.max(Math.abs(width * Math.cos(angle)) + Math.abs(height * Math.sin(angle)), Math.abs(width * Math.sin(angle)) + Math.abs(height * Math.cos(angle)));
  }
  async function preview(index, kind, maxSize = 1024) {
    const section = sections[index], image = rendered[index]; if (!image) return null;
    if (kind === 'MSI') {
      const current = options(); current.commonRanges = commonRanges.get(current.mode);
      const result = Stack3D.renderSection(section, { ...current, previewPixelScale: previewScale(section, maxSize), roi: true });
      result.canvas.width = 0; result.canvas.height = 0; return result.previewCanvas;
    }
    if (kind === 'HE_Stain') return Stack3D.renderHePreview(section, { maxSize: 2048, roi: true });
    if (kind === 'ATLAS') { const source = await Stack3D.loadReferenceImage(section, 'ATLAS'); if (!source) return null; const image = source.cloneNode(); image.alt = `${section.name} 参照アトラス`; return image; }
    return null;
  }
  function previewStatus(index) {
    const section = sections[index], status = rendered[index]?.status; if (!section || !status) return '';
    const roi = Stack3D.roiSummary(section);
    const roiText = roi.totalPolygons ? `ROI輪郭 ${roi.visiblePolygons} / ${roi.totalPolygons}` : 'ROI未登録';
    if (previewKind === 'ATLAS') return '参照用の2Dアトラス画像';
    if (previewKind === 'HE_Stain') return `保存された位置合わせのHE画像 · ${roiText}`;
    const text = [options().mode === 'raw' ? '原値を表示' : '補正値を表示'];
    if (status.code === 'UNAVAILABLE') text[0] = status.message || '表示できる値がありません。分子・表示値を確認してください。'; else if (status.message) text.push(status.message);
    if (status.unavailableChannels?.length && status.code !== 'UNAVAILABLE') text.push(`表示不可：${status.unavailableChannels.join('・')}`);
    if (options().mode === 'normalized' && status.code === 'PROVISIONAL') text.push('保存された暫定補正を使用');
    text.push(roiText);
    return text.join(' · ');
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
        replacePreview($('section-preview'), element); $('section-preview').dataset.previewKind = kind;
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
    $('detail-status').textContent = kind === 'MSI' ? 'MSIは元の測定画素を表示しています。' : '登録された元画像の解像度を活かして表示しています。';
    delete $('detail-preview').dataset.previewKind;
    replacePreview($('detail-preview'), null, '画像を準備中…'); $('preview-dialog').showModal();
    try {
      const element = await preview(index, kind, 2048);
      if (generation !== detailGeneration || !$('preview-dialog').open) { releasePreview(element); return; }
      replacePreview($('detail-preview'), element); $('detail-preview').dataset.previewKind = kind;
    } catch (error) { if (generation === detailGeneration && $('preview-dialog').open) replacePreview($('detail-preview'), null, error.message); }
  }
  function renderLegend(index) {
    $('range-legend').replaceChildren(); const format = n => Number.isFinite(n) ? Number(n).toLocaleString('en-US', { maximumSignificantDigits: 4 }) : '—';
    for (const [name, range] of Object.entries(rendered[index]?.ranges || {})) {
      const row = document.createElement('div'), label = document.createElement('span'), value = document.createElement('span'); row.className = 'range-row'; label.textContent = name;
      value.textContent = `${format(range.min)} – ${format(range.max)}`; row.append(label, value); $('range-legend').append(row);
    }
    if (options().mode === 'normalized' && options().rangeMode === 'common' && new Set(Object.values(commonRanges.get('normalized') || {}).flatMap(range => range.normalizationGroups || [])).size > 1) {
      const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = '複数の補正グループを含みます。補正基準の違いを考慮して比較してください。'; $('range-legend').append(hint);
    }
  }
  function updatePlacement() {
    const section = sections[selected]; if (!section || busy || saving) return;
    const fields = [$('offset-x').value, $('offset-y').value, $('rotation').value];
    const values = fields.map(value => value.trim() === '' ? NaN : Number(value));
    if (!values.every(Number.isFinite)) { notice('位置・回転には有限の数値を入力してください。'); return; }
    [section.offsetXUm, section.offsetYUm, section.rotationDeg] = values; dirtyPlacements.add(section.id); renderer?.setPlacement(section.id, section);
    $('placement-status').textContent = '配置に未保存の変更があります。'; updateList();
  }
  function samePlacement(a, b) { return JSON.stringify(a || null) === JSON.stringify(b || null); }
  async function savePlacement() {
    const section = sections[selected]; if (!section || saving || busy) return;
    saving = true; $('save-placement').disabled = true;
    try {
      const latest = await ProjectStorage.getProject(section.id);
      if (!latest || !samePlacement(latest.stack3d, section.project.stack3d)) throw new Error('別の画面でこの切片の3D配置が変更されました。再読込して確認してください。');
      if (['grid', 'molecules', 'images', 'rotation', 'world_coords', 'folderId', 'normalization', 'normalizationBinding', 'layerDisplay', 'valueDisplay'].some(key => JSON.stringify(latest[key] || null) !== JSON.stringify(section.project[key] || null))) {
        throw new Error('切片のデータ・向き・位置合わせ・表示条件が変更されました。再読込してから3D配置を確認してください。');
      }
      const changedSinceLoad = latest.updatedAt !== section.project.updatedAt;
      const stack3d = { schemaVersion: 1, offsetXUm: section.offsetXUm, offsetYUm: section.offsetYUm, rotationDeg: section.rotationDeg };
      const saved = await ProjectStorage.patchProjectFields(section.id, { stack3d }, { expectedUpdatedAt: latest.updatedAt });
      section.project = saved; section.sourceRevision = saved.updatedAt; dirtyPlacements.delete(section.id);
      if (changedSinceLoad) sourceChanged = true;
      if (sections[selected]?.id === section.id) $('placement-status').textContent = 'このブラウザーに配置を保存しました。ZIP出力にも含まれます。';
      updateList(); notice(`${section.name} の配置を保存しました。` + (sourceChanged ? ' 他の更新内容は「再読込」で表示に反映できます。' : ''), sourceChanged);
    } catch (error) { notice(`配置を保存できませんでした：${error.message}`, true); }
    finally { saving = false; $('save-placement').disabled = false; }
  }
  async function saveCloud() {
    const section = sections[selected]; if (!section || saving || busy) return;
    if (dirtyPlacements.has(section.id)) { notice('先に「配置を保存」を押してください。'); return; }
    saving = true; $('save-cloud').disabled = true;
    try { section.project = await ProjectSync.saveState(section.project); section.sourceRevision = section.project.updatedAt; notice('クラウドに保存しました。'); }
    catch (error) { notice(`クラウド保存を完了できませんでした：${error.message}`, true); }
    finally { saving = false; $('save-cloud').disabled = false; }
  }
  function onSourceChange(change) {
    if (saving || busy) return;
    const ids = change?.projectIds || []; if (ids.length && !ids.some(id => sections.some(section => section.id === id))) return;
    sourceChanged = true; notice('登録データが更新されました。「再読込」で最新の内容を反映できます。', true);
  }
  function openSection() {
    if (!sections[selected] || busy || saving) return; saveView();
    location.href = '../viewer/index.html?project=' + encodeURIComponent(sections[selected].id) + '&from=stack3d';
  }
  for (const input of document.querySelectorAll('input[name=channel]')) input.addEventListener('change', requestRepaint);
  $('value-mode').addEventListener('change', requestRepaint);
  $('threshold').addEventListener('input', requestRepaint);
  $('opacity').addEventListener('input', () => { renderer?.setOpacity(Number($('opacity').value)); updateLabels(); saveView(); });
  $('he-visible').addEventListener('change', () => { updateHeOverlay().catch(error => notice(error.message)); });
  $('he-opacity').addEventListener('input', () => { renderer?.setHeOverlay(heOptions()); updateLabels(); saveView(); });
  for (const [id, event] of [['brain-visible', 'change'], ['brain-opacity', 'input']]) $(id).addEventListener(event, () => { renderer?.setBrainContext(brainOptions()); updateLabels(); saveView(); });
  $('spacing').addEventListener('input', () => { renderer?.setSpacing(Number($('spacing').value)); updateLabels(); saveView(); });
  for (const id of ['range-start', 'range-end']) $(id).addEventListener('change', setRange);
  $('show-all').addEventListener('click', () => { $('range-start').value = 1; $('range-end').value = sections.length; setRange(); });
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
  $('save-placement').addEventListener('click', savePlacement); $('save-cloud').addEventListener('click', saveCloud); $('open-section').addEventListener('click', openSection);
  $('master-link').addEventListener('click', saveView);
  $('reload').addEventListener('click', () => {
    if (dirtyPlacements.size && !global.confirm('未保存の3D配置を破棄して、最新データを再読込しますか？')) return;
    saveView(); $('scene-message').hidden = false; $('scene-message').querySelector('strong').textContent = '切片を読み込んでいます'; load();
  });
  $('save-image').addEventListener('click', async () => {
    if (!renderer) return;
    try { const image = await renderer.capturePNG(), link = document.createElement('a'); link.href = image; link.download = `marmoset_3d_${options().channels.join('_') || 'empty'}.png`; link.click(); }
    catch (error) { notice(`画像を保存できませんでした：${error.message}`); }
  });
  global.addEventListener('beforeunload', event => { saveView(); if (dirtyPlacements.size) { event.preventDefault(); event.returnValue = ''; } });
  global.addEventListener('pagehide', event => {
    saveView(); if (event.persisted) return; renderGeneration++; loadGeneration++; previewGeneration++; heGeneration++; detailGeneration++;
    unsubscribe?.(); renderer?.dispose(); rendered.forEach(releaseRender); sections.forEach(Stack3D.releaseSection);
    hePlanes.forEach(releasePreview); hePlanes.clear();
  });
  for (const [name, color] of Object.entries(Stack3D.COLORS)) {
    const input = Array.from(document.querySelectorAll('input[name=channel]')).find(input => input.value === name);
    if (input) input.closest('label').querySelector('.swatch').style.backgroundColor = `rgb(${color.join(',')})`;
  }
  global.AppVersion?.paint?.();
  global.Atlas3D = { get sections() { return sections; }, get selected() { return selected; }, get rendered() { return rendered; },
    get renderer() { return renderer; }, get sourceChanged() { return sourceChanged; }, options, selectSection };
  load();
})(window);
