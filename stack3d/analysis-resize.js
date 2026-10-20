/* Per-tab analysis layout; resizing never edits projects or changes the camera. */
(function (global) {
  'use strict';
  const KEY = 'atlas-stack3d-analysis-layout-v1';
  const SIDE_MIN_WIDTH = 1000, DEFAULT_RATIO = .6;
  function create(options) {
    const panel = options.panel, scenePanel = options.scenePanel, scene = options.scene;
    const handle = panel.querySelector('#analysis-resizer'), body = panel.querySelector('.analysis-body');
    const button = panel.querySelector('#analysis-collapse'), expand = panel.querySelector('#analysis-expand');
    const focus = panel.querySelector('#analysis-focus'), miniFocus = panel.querySelector('#analysis-mini-focus'), workspace = scenePanel.closest('.workspace');
    const focusButtons = [focus, miniFocus].filter(Boolean);
    const layoutButtons = ['#analysis-layout-toggle', '#analysis-mini-layout-toggle'].map(selector => panel.querySelector(selector)).filter(Boolean);
    const viewport = scene.closest('.scene-viewport') || scene;
    const desktop = global.matchMedia('(min-width: 761px)');
    let state = { height: 560, collapsed: false, expanded: false, layout: 'side', ratio: DEFAULT_RATIO, sideExpanded: false };
    let focused = false, orientation = 'stacked', drag = null, disposed = false, observedSize = '';
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY));
      if (saved && typeof saved === 'object') {
        if (Number.isFinite(saved.height) && saved.height >= 200 && saved.height <= 3000) state.height = saved.height;
        state.collapsed = saved.collapsed === true; state.expanded = saved.expanded === true;
        state.layout = saved.layout === 'stacked' ? 'stacked' : 'side';
        if (Number.isFinite(saved.ratio) && saved.ratio > 0 && saved.ratio < 1) state.ratio = saved.ratio;
        state.sideExpanded = saved.sideExpanded === true;
      }
    } catch (_) {}
    const listeners = [];
    function listen(target, event, handler) { target.addEventListener(event, handler); listeners.push([target, event, handler]); }
    function bounds() {
      if (orientation === 'side') return { min: 420, max: Math.floor(scenePanel.clientWidth - 320) };
      const available = scenePanel.clientHeight;
      // Other siblings are the operation hint and existing section scrubber.
      const occupied = [...scenePanel.children].filter(element => element !== panel && element !== viewport &&
        global.getComputedStyle(element).position !== 'absolute').reduce((sum, element) => sum + element.getBoundingClientRect().height, 0);
      const maximum = Math.max(52, Math.floor(available - occupied - 260));
      return { min: Math.min(260, maximum), max: maximum };
    }
    function save() { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
    function apply() {
      if (disposed) return;
      if (!desktop.matches || state.collapsed) focused = false;
      workspace?.classList.toggle('analysis-focused', focused);
      const nextOrientation = desktop.matches && !state.collapsed && !focused && state.layout === 'side' && scenePanel.clientWidth >= SIDE_MIN_WIDTH ? 'side' : 'stacked';
      if (nextOrientation !== orientation) end();
      orientation = nextOrientation;
      const side = orientation === 'side';
      scenePanel.classList.toggle('analysis-side-layout', side);
      scenePanel.dataset.analysisOrientation = orientation;
      panel.classList.toggle('analysis-collapsed', state.collapsed);
      body.hidden = state.collapsed;
      button.textContent = state.collapsed ? '展開' : '折りたたむ';
      button.setAttribute('aria-expanded', String(!state.collapsed));
      const toolbarToggle = panel.querySelector('#analysis-toolbar-toggle');
      if (toolbarToggle) toolbarToggle.disabled = state.collapsed;
      const bound = bounds();
      const expanded = side ? state.sideExpanded : state.expanded;
      const size = side ? expanded ? bound.max : Math.max(bound.min, Math.min(bound.max, scenePanel.clientWidth * state.ratio)) :
        focused ? scenePanel.clientHeight : state.collapsed ? 52 : expanded ? bound.max : Math.max(bound.min, Math.min(bound.max, state.height));
      expand.textContent = expanded ? side ? '幅を戻す' : '高さを戻す' : side ? '幅を広げる' : '拡大';
      expand.setAttribute('aria-pressed', String(expanded));
      expand.hidden = !desktop.matches || focused; expand.disabled = state.collapsed;
      for (const control of layoutButtons) {
        const fallback = state.layout === 'side' && !side;
        control.hidden = !desktop.matches || state.collapsed || focused;
        control.textContent = state.layout === 'side' ? fallback ? '上下配置を固定' : '上下配置へ' : '左右配置へ';
        const actual = side ? '左右配置' : '上下配置';
        const action = state.layout === 'side' ? '上下配置に固定します' : '左右配置を優先します';
        const explanation = `現在は${actual}。${fallback ? '中央領域の幅が狭いため、上下配置で表示しています。' : ''}${action}。`;
        control.setAttribute('aria-label', control.textContent + '。' + explanation);
        control.setAttribute('title', explanation);
        control.setAttribute('aria-pressed', String(state.layout === 'side'));
      }
      for (const control of focusButtons) {
        control.hidden = !desktop.matches;
        control.textContent = focused ? '3D表示に戻る' : '解析を広く表示';
        control.setAttribute('aria-pressed', String(focused));
        control.setAttribute('title', focused ? '3Dモデルとサイドパネルを表示（Escでも戻れます）' : '画面の幅と高さを使ってグラフを表示');
      }
      if (side) {
        scenePanel.style.setProperty('--analysis-side-width', size + 'px');
        panel.style.removeProperty('height'); panel.style.removeProperty('flex-basis');
      } else if (desktop.matches) {
        scenePanel.style.removeProperty('--analysis-side-width');
        panel.style.height = size + 'px'; panel.style.flexBasis = size + 'px';
      } else { panel.style.removeProperty('height'); panel.style.removeProperty('flex-basis'); }
      handle.hidden = !desktop.matches || state.collapsed || focused;
      handle.tabIndex = handle.hidden ? -1 : 0;
      handle.setAttribute('aria-orientation', side ? 'vertical' : 'horizontal');
      handle.setAttribute('aria-label', side ? 'グラフ領域の幅' : 'グラフ領域の高さ');
      handle.setAttribute('title', side ? 'ドラッグまたは左右矢印キーで幅を変更。ダブルクリックで元に戻す' : 'ドラッグまたは上下矢印キーで高さを変更。ダブルクリックで元に戻す');
      handle.setAttribute('aria-valuemin', String(bound.min));
      handle.setAttribute('aria-valuemax', String(bound.max));
      handle.setAttribute('aria-valuenow', String(Math.round(size)));
      if (typeof options.onResize === 'function') options.onResize();
    }
    function end(event) {
      if (!drag || event && drag.id !== event.pointerId) return;
      const id = drag.id; drag = null; document.body.classList.remove('resizing-analysis-panel', 'resizing-analysis-side');
      if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
      save();
    }
    function resize(size) {
      if (focused) return;
      const bound = bounds(), value = Math.max(bound.min, Math.min(bound.max, size));
      if (orientation === 'side') { state.sideExpanded = false; state.ratio = value / scenePanel.clientWidth; }
      else { state.expanded = false; state.height = value; }
      apply(); save();
    }
    listen(handle, 'pointerdown', event => {
      if (!desktop.matches || state.collapsed || focused || event.button !== 0) return;
      event.preventDefault(); handle.focus();
      const side = orientation === 'side', rect = panel.getBoundingClientRect();
      drag = { id: event.pointerId, position: side ? event.clientX : event.clientY, size: side ? rect.width : rect.height, orientation };
      handle.setPointerCapture(event.pointerId); document.body.classList.add('resizing-analysis-panel');
      document.body.classList.toggle('resizing-analysis-side', side);
    });
    listen(handle, 'pointermove', event => {
      if (drag && event.pointerId === drag.id) resize(drag.size + drag.position - (drag.orientation === 'side' ? event.clientX : event.clientY));
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(handle, event, end);
    listen(handle, 'keydown', event => {
      if (!desktop.matches || state.collapsed || focused) return;
      const delta = event.shiftKey ? 50 : 10, side = orientation === 'side', rect = panel.getBoundingClientRect(), size = side ? rect.width : rect.height;
      const next = { ...(side ? { ArrowLeft: size + delta, ArrowRight: size - delta } : { ArrowUp: size + delta, ArrowDown: size - delta }), Home: bounds().min, End: bounds().max }[event.key];
      if (next !== undefined) { event.preventDefault(); resize(next); }
    });
    listen(handle, 'dblclick', () => {
      if (focused) return;
      end();
      if (orientation === 'side') { state.ratio = DEFAULT_RATIO; state.sideExpanded = false; }
      else { state.height = 560; state.expanded = false; }
      apply(); save();
    });
    listen(button, 'click', () => { end(); state.collapsed = !state.collapsed; apply(); save(); });
    listen(expand, 'click', () => {
      if (focused) return;
      end();
      if (orientation === 'side') state.sideExpanded = !state.sideExpanded;
      else state.expanded = !state.expanded;
      apply(); save();
    });
    for (const control of layoutButtons) listen(control, 'click', () => {
      end(); state.layout = state.layout === 'side' ? 'stacked' : 'side'; apply(); save();
    });
    for (const control of focusButtons) listen(control, 'click', () => {
      if (!desktop.matches || !workspace) return;
      end(); focused = !focused; state.collapsed = false; apply(); save();
    });
    listen(global, 'keydown', event => {
      if (event.key !== 'Escape' || !focused) return;
      event.preventDefault(); end(); focused = false; apply();
      const focusTarget = panel.classList.contains('analysis-toolbar-minimized') ? miniFocus : focus;
      focusTarget?.focus();
    });
    listen(global, 'resize', () => { end(); apply(); });
    listen(global, 'pagehide', () => { end(); save(); });
    // Sidebar resizing also changes the usable center width without a window event.
    // Ignore unchanged dimensions so our own layout styles cannot cause a redraw loop.
    const observer = global.ResizeObserver ? new ResizeObserver(() => {
      const size = `${scenePanel.clientWidth}:${scenePanel.clientHeight}`;
      if (size !== observedSize) { observedSize = size; apply(); }
    }) : null;
    observer?.observe(scenePanel);
    apply();
    return {
      getState: () => ({ ...state, focused, orientation }),
      setCollapsed(value) { end(); state.collapsed = !!value; apply(); save(); },
      dispose() {
        end(); save(); disposed = true; focused = false;
        workspace?.classList.remove('analysis-focused'); scenePanel.classList.remove('analysis-side-layout');
        scenePanel.style.removeProperty('--analysis-side-width'); delete scenePanel.dataset.analysisOrientation;
        observer?.disconnect(); for (const [target, event, handler] of listeners) target.removeEventListener(event, handler);
      }
    };
  }
  global.Stack3DAnalysisResize = { create };
})(window);
