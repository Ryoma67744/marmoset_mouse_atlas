/* Same-tab section navigation. The Viewer owns its editable state and save
 * policy; this controller only asks it to flush and verifies the destination. */
(function (global) {
  'use strict';
  const VIEW_KEY = 'atlas-viewer-navigation-view';

  function create(options) {
    const o = options || {}, document = global.document;
    const nav = document.getElementById('section-navigation');
    const previous = document.getElementById('section-previous');
    const next = document.getElementById('section-next');
    const position = document.getElementById('section-position');
    if (!nav || !previous || !next || !position) throw new Error('切片移動の表示欄がありません');
    const ordering = global.SectionNavigation, sync = global.ProjectSync;
    if (!ordering || !sync || typeof sync.ensureLocal !== 'function') throw new Error('切片移動の処理を読み込めません');
    const storage = o.storage || global.ProjectStorage, cloud = o.cloud || global.Cloud, zip = o.zip || global.ZipIO;
    let status = document.getElementById('section-navigation-status');
    if (!status) {
      status = document.createElement('span');
      status.id = 'section-navigation-status';
      nav.appendChild(status);
    }
    status.classList.add('section-navigation-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    nav.setAttribute('aria-describedby', status.id);
    previous.type = next.type = 'button';
    let disposed = false, pending = false, committed = false, catalog = null;
    let refreshTask = null, refreshGeneration = 0, refreshRequested = false, notice = '';
    const unsubscribers = [];
    const project = () => typeof o.getProject === 'function' ? o.getProject() : null;
    const ready = () => typeof o.getReady !== 'function' || !!o.getReady();
    const blocked = () => typeof o.getBlockingReason === 'function' ? String(o.getBlockingReason() || '') : '';
    const revision = () => typeof o.getRevision === 'function' ? o.getRevision() : null;
    const unsaved = () => typeof o.hasUnsavedChanges === 'function' && !!o.hasUnsavedChanges();

    function identity(value) {
      if (!value) return '';
      const series = ordering.seriesOf(value), order = ordering.naturalCor(value);
      return JSON.stringify([value.id, series.id, series.species, series.coordinateMode, order && order.canonical]);
    }
    function setPending(value) {
      pending = !!value;
      if (!disposed && typeof o.onPendingChange === 'function') o.onPendingChange(pending);
      update();
    }
    function inform(message) {
      notice = message;
      if (typeof o.onMessage === 'function') o.onMessage(message);
      update();
    }
    function update() {
      if (disposed) return;
      const reason = !ready() || !project() ? '切片を読み込んでいます。' : blocked();
      const valid = catalog && catalog.status === 'ready';
      nav.setAttribute('aria-busy', String(pending || !!refreshTask));
      position.textContent = valid ? `${catalog.index + 1} / ${catalog.items.length}` : '— / —';
      position.title = 'この系列の登録一覧内の位置';
      for (const [button, target, edge] of [[previous, valid && catalog.previous, 'この一覧の最初の切片です。'],
        [next, valid && catalog.next, 'この一覧の最後の切片です。']]) {
        button.disabled = !!(pending || reason || !valid || !target);
        button.title = pending ? '移動先を確認しています。' : reason || (!valid ? catalog && catalog.reason || '切片一覧を確認しています。' :
          target ? target.displayName || target.id : edge);
      }
      status.textContent = pending ? '保存と移動先を確認中…' : notice || reason ||
        (catalog && catalog.status !== 'ready' ? catalog.reason : !catalog ? '切片一覧を確認中…' :
          catalog.complete ? '' : '手元の登録切片のみ（一覧の一部）');
      status.hidden = !status.textContent;
    }
    async function readCatalog(current) {
      const localsTask = storage.listProjects();
      const remoteTask = (async () => {
        try {
          if (!cloud || !cloud.configured() || !cloud.signedIn() || typeof cloud.listProjects !== 'function') return null;
          const rows = await cloud.listProjects();
          return Array.isArray(rows) ? rows : null;
        } catch (_) { return null; }
      })();
      const [locals, rows] = await Promise.all([localsTask, remoteTask]);
      if (!Array.isArray(locals)) throw new Error('手元の切片一覧を読み込めませんでした。');
      return ordering.buildCatalog(current, locals, rows);
    }
    function refresh() {
      if (disposed) return Promise.resolve(null);
      if (pending) { refreshRequested = true; update(); return Promise.resolve(catalog); }
      if (refreshTask) { refreshRequested = true; update(); return refreshTask; }
      if (!ready() || !project()) { update(); return Promise.resolve(null); }
      const current = project(), currentIdentity = identity(current);
      const generation = ++refreshGeneration;
      refreshRequested = false;
      refreshTask = readCatalog(current).then(result => {
        if (!disposed && generation === refreshGeneration && currentIdentity === identity(project())) {
          catalog = result; notice = '';
        }
        return result;
      }).catch(error => {
        if (!disposed && generation === refreshGeneration) {
          catalog = null; notice = error && error.message || '切片一覧を確認できませんでした。';
        }
        return null;
      }).finally(() => {
        refreshTask = null; update();
        if (!disposed && refreshRequested && !pending) { refreshRequested = false; refresh(); }
      });
      update(); return refreshTask;
    }
    function pendingFolderChanges(id) {
      const pendingFolders = {};
      try {
        if (global.localStorage.getItem('marmoset:pendingFolderChange:' + encodeURIComponent(id))) pendingFolders[id] = true;
      } catch (_) { /* A blocked localStorage does not grant permission to replace a local edit. */ }
      return pendingFolders;
    }
    async function navigate(direction) {
      if (disposed || pending) return;
      const reason = !ready() || !project() ? '切片の読み込みが完了するまでお待ちください。' : blocked();
      if (reason) { inform(reason); return; }
      const intended = catalog && catalog.status === 'ready' && catalog[direction];
      if (!intended) { update(); return; }
      const original = project(), originalIdentity = identity(original), originalRevision = revision();
      const destinationIdentity = identity(intended), destinationId = intended.id;
      let carry = null;
      committed = false; notice = ''; ++refreshGeneration; setPending(true);
      function assertCurrent(checkEdits = false) {
        if (disposed || identity(project()) !== originalIdentity || revision() !== originalRevision) {
          throw new Error('表示中の切片が変わったため、移動を中止しました。');
        }
        const currentReason = blocked();
        if (currentReason) throw new Error(currentReason);
        if (checkEdits && unsaved()) throw new Error('確認中に編集が始まりました。編集を保存してから、もう一度移動してください。');
      }
      function assertNeighbor(result) {
        // Install the new list even when it cannot satisfy the old click. The
        // next explicit click then uses the newly confirmed adjacent section.
        if (result) catalog = result;
        if (!result || result.status !== 'ready') throw new Error(result && result.reason || '切片の順番を確認できませんでした。');
        const neighbor = result[direction];
        if (!neighbor || identity(neighbor) !== destinationIdentity) {
          throw new Error('確認中に切片一覧または順番が変わりました。新しい一覧を確認して、もう一度移動してください。');
        }
      }
      try {
        if (typeof o.flush !== 'function') throw new Error('編集を安全に保存できません。再読込してから移動してください。');
        await o.flush(); assertCurrent(true);
        const before = await readCatalog(project()); assertCurrent(true); assertNeighbor(before);
        catalog = before;
        const target = await sync.ensureLocal(destinationId, {
          storage, cloud, zip,
          pendingFolderChanges: () => pendingFolderChanges(destinationId),
          canApplyRemote: () => {
            try { assertCurrent(true); return true; } catch (_) { return false; }
          }
        });
        assertCurrent();
        if (!target || identity(target) !== destinationIdentity) throw new Error('移動先の切片の系列または番号が変わりました。移動を中止しました。');
        const syncStatus = typeof sync.statusOf === 'function' ? sync.statusOf(target) : null;
        if (syncStatus && ['conflict', 'pending', 'missing-remote'].includes(syncStatus.status)) {
          throw new Error('移動先を安全に確認できませんでした。' + (syncStatus.reason || 'Masterで対象の切片を確認してください。'));
        }
        const after = await readCatalog(project()); assertCurrent(); assertNeighbor(after);
        catalog = after;
        // Flush once more after the network work. A newer edit is retained by
        // the Viewer's save implementation; any remaining edit blocks leaving.
        await o.flush(); assertCurrent(true);
        const localTarget = await storage.getProject(destinationId); assertCurrent(true);
        if (!localTarget || identity(localTarget) !== destinationIdentity) throw new Error('移動先が更新または削除されました。もう一度一覧を確認してください。');
        // Check local ordering again after the final save, without downloading
        // any other bundle. Reuse cloud metadata from the completed catalogue.
        const finalLocals = await storage.listProjects(); assertCurrent(true);
        const finalCatalog = ordering.buildCatalog(project(), finalLocals,
          after.complete ? after.items.filter(item => item.cloudAvailable).map(item => ({
            id: item.id, display_name: item.displayName, meta: { atlas: item.atlas, plane: item.plane }
          })) : null);
        assertNeighbor(finalCatalog); catalog = finalCatalog;
        const url = new URL(global.location.href); url.searchParams.set('project', destinationId);
        try {
          carry = JSON.stringify({ targetId: destinationId, sourceSeries: ordering.seriesOf(original).id,
            view: typeof o.getViewState === 'function' ? o.getViewState() : null, createdAt: Date.now() });
          global.sessionStorage.setItem(VIEW_KEY, carry);
        } catch (_) { carry = null; }
        assertCurrent(true);
        if (typeof o.onCommit === 'function') o.onCommit(true);
        committed = true;
        global.location.assign(url.href);
      } catch (error) {
        committed = false;
        if (typeof o.onCommit === 'function') o.onCommit(false);
        if (carry) {
          try { if (global.sessionStorage.getItem(VIEW_KEY) === carry) global.sessionStorage.removeItem(VIEW_KEY); } catch (_) { /* unavailable */ }
        }
        if (!disposed) inform('切片を移動しませんでした。' + (error && error.message || '保存または移動先の確認に失敗しました。'));
      } finally {
        if (!committed) {
          setPending(false);
          // Keep the error message visible until a user action or external
          // catalogue change asks for a fresh check.
          refreshRequested = false;
        }
      }
    }
    const onPrevious = () => { navigate('previous'); }, onNext = () => { navigate('next'); };
    const onPageShow = () => {
      if (disposed) return;
      committed = false;
      if (typeof o.onCommit === 'function') o.onCommit(false);
      setPending(false);
      refresh();
    };
    const onFocus = () => { refresh(); };
    const onVisibility = () => { if (!document.hidden) refresh(); };
    let updateQueued = false;
    const onGesture = () => {
      if (updateQueued || disposed) return;
      updateQueued = true;
      // Run after the Viewer's own event handlers have set drawing, IME and
      // modal state. This never reads the catalogue from storage or network.
      Promise.resolve().then(() => { updateQueued = false; update(); });
    };
    const gestureEvents = ['click', 'input', 'change', 'compositionstart', 'compositionend', 'keyup'];
    const modalObserver = typeof global.MutationObserver === 'function' ? new global.MutationObserver(records => {
      // Alignment may close only after its asynchronous save. Observe modal
      // insertion/removal, not every redraw of plots or image controls.
      const isModal = node => node.nodeType === 1 && (node.matches('.modal-backdrop') || node.querySelector('.modal-backdrop'));
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(isModal))) onGesture();
    }) : null;
    previous.addEventListener('click', onPrevious); next.addEventListener('click', onNext);
    global.addEventListener('pageshow', onPageShow); global.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    for (const event of gestureEvents) document.addEventListener(event, onGesture);
    if (modalObserver && document.body) modalObserver.observe(document.body, { childList: true, subtree: true });
    if (typeof storage.subscribeChanges === 'function') unsubscribers.push(storage.subscribeChanges(() => { refresh(); }));
    if (cloud && typeof cloud.subscribeSessionChanges === 'function') unsubscribers.push(cloud.subscribeSessionChanges(() => { refresh(); }));
    update();
    return {
      refresh, update, get pending() { return pending; },
      dispose() {
        if (disposed) return;
        disposed = true; ++refreshGeneration;
        previous.removeEventListener('click', onPrevious); next.removeEventListener('click', onNext);
        global.removeEventListener('pageshow', onPageShow); global.removeEventListener('focus', onFocus);
        document.removeEventListener('visibilitychange', onVisibility);
        for (const event of gestureEvents) document.removeEventListener(event, onGesture);
        if (modalObserver) modalObserver.disconnect();
        for (const unsubscribe of unsubscribers) if (typeof unsubscribe === 'function') unsubscribe();
      }
    };
  }
  global.ViewerSectionNavigation = Object.freeze({ create });
})(window);
