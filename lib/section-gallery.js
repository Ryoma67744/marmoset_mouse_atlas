/* Shared, read-only section browser. Opening a card never navigates or saves
 * the source page: the individual Viewer opens in another tab. */
(function (global) {
  'use strict';

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function create(options = {}) {
    if (document.getElementById('section-gallery-launcher')) return null;
    if (!global.SectionGalleryData) return null;
    const getContext = () => options.getContext && options.getContext() || {};
    const data = options.data || global.SectionGalleryData.create({
      storage: global.ProjectStorage, cloud: global.Cloud, zip: global.ZipIO,
      getCurrentProject: () => getContext().currentProject
    });
    let controller = null, generation = 0, catalog = null, sourceKey = '', selectedSeries = '';
    let returnFocus = null, destroyed = false;
    const cards = new Map();

    const launcher = element('button', 'section-gallery-launcher');
    launcher.id = 'section-gallery-launcher';
    launcher.type = 'button';
    launcher.setAttribute('aria-haspopup', 'dialog');
    launcher.setAttribute('aria-controls', 'section-gallery-dialog');
    launcher.setAttribute('aria-expanded', 'false');
    const icon = element('span', 'section-gallery-icon', '▦');
    icon.setAttribute('aria-hidden', 'true');
    launcher.append(icon, element('span', '', '切片一覧'));

    const dialog = element('dialog', 'section-gallery-dialog');
    dialog.id = 'section-gallery-dialog';
    dialog.setAttribute('aria-labelledby', 'section-gallery-title');
    dialog.setAttribute('aria-describedby', 'section-gallery-description');
    const header = element('header', 'section-gallery-header');
    const heading = element('div');
    const eyebrow = element('div', 'section-gallery-eyebrow', 'SECTION GALLERY');
    const title = element('h2', '', '切片一覧');
    title.id = 'section-gallery-title';
    const description = element('p', 'section-gallery-description', '画像をクリックすると、その切片の個別ページを別タブで開きます。');
    description.id = 'section-gallery-description';
    heading.append(eyebrow, title, description);
    const closeButton = element('button', 'section-gallery-close', '×');
    closeButton.id = 'section-gallery-close';
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', '切片一覧を閉じる');
    header.append(heading, closeButton);

    const controls = element('div', 'section-gallery-controls');
    const seriesLabel = element('label', 'section-gallery-field');
    seriesLabel.append(element('span', '', '表示する系列'));
    const seriesSelect = element('select');
    seriesSelect.id = 'section-gallery-series';
    seriesLabel.append(seriesSelect);
    const sourceLabel = element('label', 'section-gallery-field');
    sourceLabel.append(element('span', '', '一覧に表示する画像'));
    const sourceSelect = element('select');
    sourceSelect.id = 'section-gallery-source';
    sourceLabel.append(sourceSelect);
    const reloadButton = element('button', 'section-gallery-reload', '一覧を更新');
    reloadButton.type = 'button';
    controls.append(seriesLabel, sourceLabel, reloadButton);

    const summary = element('div', 'section-gallery-summary');
    const count = element('strong', '', '登録切片を確認中…');
    const imageHint = element('span');
    summary.append(count, imageHint);
    const notice = element('p', 'section-gallery-notice');
    notice.hidden = true;
    const status = element('p', 'section-gallery-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const grid = element('div', 'section-gallery-grid');
    grid.id = 'section-gallery-grid';
    const body = element('div', 'section-gallery-body');
    body.append(summary, notice, status, grid);
    const footer = element('footer', 'section-gallery-footer');
    footer.append(element('span', '', '切片番号順で表示 · 元の画面はそのまま保持'), element('span', '', 'Esc で閉じる'));
    dialog.append(header, controls, body, footer);
    document.body.append(launcher, dialog);

    function contextProject() { return getContext().currentProject || null; }
    function setNotice(text) { notice.textContent = text || ''; notice.hidden = !text; }
    function setSources(sources, preferred) {
      const unique = new Map();
      for (const source of sources || []) if (source && source.key) unique.set(source.key, source);
      sourceSelect.replaceChildren();
      const groups = new Map();
      for (const source of unique.values()) {
        const label = source.key.startsWith('msi:') ? '分子画像' : '染色・参照画像';
        let group = groups.get(label);
        if (!group) { group = document.createElement('optgroup'); group.label = label; groups.set(label, group); sourceSelect.append(group); }
        const option = element('option', '', source.label || source.key);
        option.value = source.key;
        group.append(option);
      }
      sourceKey = unique.has(preferred) ? preferred : (unique.keys().next().value || '');
      sourceSelect.value = sourceKey;
      sourceSelect.disabled = !sourceKey;
    }
    function updateImageHint() {
      imageHint.textContent = sourceKey.startsWith('msi:')
        ? '分子ごとに系列共通の色範囲で表示'
        : '登録された画像を表示 · 未登録は「画像なし」';
    }
    function makeCards() {
      const fragment = document.createDocumentFragment();
      const current = contextProject();
      cards.clear();
      for (const [index, item] of catalog.items.entries()) {
        const card = element('a', 'section-gallery-card');
        const url = new URL(options.viewerPath || 'viewer/index.html', document.baseURI);
        url.searchParams.set('project', item.id);
        url.searchParams.set('from', 'section-gallery');
        url.searchParams.set('newtab', '1');
        card.href = url.href;
        card.target = '_blank';
        card.rel = 'noopener noreferrer';
        card.dataset.projectId = item.id;
        card.dataset.status = 'loading';
        const isCurrent = !!current && current.id === item.id;
        if (isCurrent) card.dataset.current = 'true';
        const visual = element('div', 'section-gallery-thumbnail');
        visual.append(element('span', 'section-gallery-placeholder', '読込中…'));
        const label = element('div', 'section-gallery-card-label');
        const number = item.sectionNumber || item.atlas && item.atlas.sectionNumber;
        const name = item.displayName || item.name || item.id;
        const numberLabel = element('span', 'section-gallery-number', number ? String(number).padStart(2, '0') : String(index + 1).padStart(2, '0'));
        const text = element('span', 'section-gallery-card-title', item.atlas && item.atlas.sourceCandidateId || name);
        label.append(numberLabel, text);
        card.append(visual, label);
        if (isCurrent) card.append(element('span', 'section-gallery-current', '表示中'));
        card.setAttribute('aria-label', name + (isCurrent ? '、表示中' : '') + 'を別タブで開く');
        cards.set(item.id, { card, visual });
        fragment.append(card);
      }
      grid.replaceChildren(fragment);
      count.textContent = catalog.items.length + ' 切片';
    }
    function newRequest() {
      if (controller) controller.abort();
      controller = new AbortController();
      return { signal: controller.signal, token: ++generation };
    }
    function isActive(token) { return !destroyed && dialog.open && token === generation; }
    async function render(request) {
      const { signal, token } = request || newRequest();
      if (!catalog || !sourceKey || !isActive(token)) return;
      const renderingKey = sourceKey;
      updateImageHint();
      let completed = 0;
      for (const { card, visual } of cards.values()) {
        card.dataset.status = 'loading';
        card.removeAttribute('title');
        visual.replaceChildren(element('span', 'section-gallery-placeholder', '読込中…'));
      }
      status.textContent = catalog.items.length ? '画像を読み込んでいます…' : 'この系列に登録された切片はありません。';
      grid.setAttribute('aria-busy', 'true');
      try {
        const result = await data.renderThumbnails(catalog, renderingKey, {
          signal,
          onProgress(progress) {
            if (isActive(token) && !completed && progress && Number.isFinite(progress.completed)) {
              status.textContent = progress.completed + ' / ' + progress.total + ' 切片を読込中…';
            }
          },
          onThumbnail(result) {
            if (!isActive(token) || result.sourceKey && result.sourceKey !== renderingKey) return;
            const target = cards.get(result.id);
            if (!target) return;
            const ready = !!result.canvas;
            const failed = ['error', 'unavailable'].includes(result.status);
            target.card.dataset.status = ready ? 'ready' : failed ? 'error' : 'missing';
            target.visual.replaceChildren();
            if (ready) {
              result.canvas.setAttribute('aria-hidden', 'true');
              target.visual.append(result.canvas);
            } else {
              target.visual.append(element('span', 'section-gallery-placeholder', failed ? '表示できませんでした' : '画像なし'));
            }
            if (result.notice) target.card.title = result.notice;
            completed++;
            status.textContent = completed + ' / ' + catalog.items.length + ' 切片の画像を確認';
          }
        });
        if (!isActive(token)) return;
        if (result && result.sources) {
          catalog.sources = result.sources;
          setSources(result.sources, renderingKey);
        }
        const notices = [catalog.notice, result && result.notice].filter(Boolean);
        setNotice([...new Set(notices)].join(' '));
        const available = [...cards.values()].filter(({ card }) => card.dataset.status === 'ready').length;
        status.textContent = available + ' / ' + catalog.items.length + ' 切片に画像あり';
      } catch (error) {
        if (!isActive(token) || error && error.name === 'AbortError') return;
        status.textContent = '画像を読み込めませんでした。「一覧を更新」で再試行できます。';
        for (const { card, visual } of cards.values()) if (card.dataset.status === 'loading') {
          card.dataset.status = 'error';
          visual.replaceChildren(element('span', 'section-gallery-placeholder', '読込できませんでした'));
        }
      } finally { if (isActive(token)) grid.setAttribute('aria-busy', 'false'); }
    }
    async function load(seriesId) {
      const request = newRequest();
      seriesSelect.disabled = true;
      sourceSelect.disabled = true;
      reloadButton.disabled = true;
      setNotice('');
      status.textContent = '登録切片を確認しています…';
      grid.setAttribute('aria-busy', 'true');
      grid.replaceChildren();
      cards.clear();
      try {
        const result = await data.loadCatalog({ seriesId, currentProject: contextProject(), signal: request.signal });
        if (!isActive(request.token)) return;
        catalog = result;
        catalog.items = catalog.items || [];
        selectedSeries = catalog.seriesId || '';
        seriesSelect.replaceChildren();
        for (const series of catalog.series || []) {
          const option = element('option', '', series.name || series.id);
          option.value = series.id;
          seriesSelect.append(option);
        }
        seriesSelect.value = selectedSeries;
        setSources(catalog.sources, sourceKey);
        makeCards();
        setNotice(catalog.notice);
        // Images can take longer than metadata. Keep the controls usable so a
        // different source/series can cancel that work immediately.
        reloadButton.disabled = false;
        seriesSelect.disabled = seriesSelect.options.length < 2;
        sourceSelect.disabled = !sourceSelect.options.length;
        await render(request);
      } catch (error) {
        if (!isActive(request.token) || error && error.name === 'AbortError') return;
        catalog = null;
        count.textContent = '一覧を取得できませんでした';
        status.textContent = '接続状態を確認して「一覧を更新」を押してください。';
      } finally {
        if (isActive(request.token)) {
          reloadButton.disabled = false;
          seriesSelect.disabled = seriesSelect.options.length < 2;
          sourceSelect.disabled = !sourceSelect.options.length;
          grid.setAttribute('aria-busy', 'false');
        }
      }
    }
    function open() {
      if (destroyed || dialog.open) return;
      returnFocus = document.activeElement;
      dialog.showModal();
      launcher.setAttribute('aria-expanded', 'true');
      closeButton.focus();
      const context = getContext();
      const current = context.currentProject;
      const contextualSeries = context.seriesId || current && global.SectionNavigation && global.SectionNavigation.seriesOf(current).id;
      load(contextualSeries || selectedSeries || undefined);
    }
    function close() { if (dialog.open) dialog.close(); }
    function didClose() {
      generation++;
      if (controller) controller.abort();
      launcher.setAttribute('aria-expanded', 'false');
      // Free canvas backing stores when the modal is not visible.
      grid.replaceChildren();
      cards.clear();
      const target = returnFocus && returnFocus.isConnected ? returnFocus : launcher;
      target.focus({ preventScroll: true });
    }
    launcher.addEventListener('click', open);
    closeButton.addEventListener('click', close);
    dialog.addEventListener('close', didClose);
    // Escape belongs to this top-level dialog, not to Viewer drawing tools.
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    });
    seriesSelect.addEventListener('change', () => load(seriesSelect.value));
    sourceSelect.addEventListener('change', () => {
      sourceKey = sourceSelect.value;
      render();
    });
    reloadButton.addEventListener('click', () => load(selectedSeries));
    return { open, close, refresh: () => dialog.open && load(selectedSeries), destroy() {
      destroyed = true;
      if (controller) controller.abort();
      dialog.removeEventListener('close', didClose);
      dialog.remove(); launcher.remove(); cards.clear();
      if (data.dispose) data.dispose();
    } };
  }
  global.SectionGallery = Object.freeze({ create });
})(window);
