/* Per-tab analysis layout; resizing never edits projects or changes the camera. */
(function (global) {
  'use strict';
  const KEY = 'atlas-stack3d-analysis-layout-v1';
  function create(options) {
    const panel = options.panel, scenePanel = options.scenePanel, scene = options.scene;
    const handle = panel.querySelector('#analysis-resizer'), body = panel.querySelector('.analysis-body');
    const button = panel.querySelector('#analysis-collapse'), expand = panel.querySelector('#analysis-expand');
    const focus = panel.querySelector('#analysis-focus'), miniFocus = panel.querySelector('#analysis-mini-focus'), workspace = scenePanel.closest('.workspace');
    const focusButtons = [focus, miniFocus].filter(Boolean);
    const viewport = scene.closest('.scene-viewport') || scene;
    const desktop = global.matchMedia('(min-width: 761px)');
    let state = { height: 560, collapsed: false, expanded: false }, focused = false, drag = null, disposed = false;
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY));
      if (saved && Number.isFinite(saved.height) && saved.height >= 200 && saved.height <= 3000)
        state = { height: saved.height, collapsed: saved.collapsed === true, expanded: saved.expanded === true };
    } catch (_) {}
    const listeners = [];
    function listen(target, event, handler) { target.addEventListener(event, handler); listeners.push([target, event, handler]); }
    function bounds() {
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
      panel.classList.toggle('analysis-collapsed', state.collapsed);
      body.hidden = state.collapsed;
      button.textContent = state.collapsed ? '展開' : '折りたたむ';
      button.setAttribute('aria-expanded', String(!state.collapsed));
      const toolbarToggle = panel.querySelector('#analysis-toolbar-toggle');
      if (toolbarToggle) toolbarToggle.disabled = state.collapsed;
      const bound = bounds();
      const height = focused ? scenePanel.clientHeight : state.collapsed ? 52 : state.expanded ? bound.max : Math.max(bound.min, Math.min(bound.max, state.height));
      expand.textContent = state.expanded ? '高さを戻す' : '拡大'; expand.setAttribute('aria-pressed', String(state.expanded));
      expand.hidden = !desktop.matches || focused; expand.disabled = state.collapsed;
      for (const control of focusButtons) {
        control.hidden = !desktop.matches;
        control.textContent = focused ? '3D表示に戻る' : '解析を広く表示';
        control.setAttribute('aria-pressed', String(focused));
        control.setAttribute('title', focused ? '3Dモデルとサイドパネルを表示（Escでも戻れます）' : '画面の幅と高さを使ってグラフを表示');
      }
      if (desktop.matches) {
        panel.style.height = height + 'px'; panel.style.flexBasis = height + 'px';
      } else { panel.style.removeProperty('height'); panel.style.removeProperty('flex-basis'); }
      handle.hidden = !desktop.matches || state.collapsed || focused;
      handle.setAttribute('aria-valuemin', String(bound.min));
      handle.setAttribute('aria-valuemax', String(bound.max));
      handle.setAttribute('aria-valuenow', String(Math.round(height)));
      if (typeof options.onResize === 'function') options.onResize();
    }
    function end(event) {
      if (!drag || event && drag.id !== event.pointerId) return;
      const id = drag.id; drag = null; document.body.classList.remove('resizing-analysis-panel');
      if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
      save();
    }
    function resize(height) {
      if (focused) return;
      const bound = bounds(); state.expanded = false; state.height = Math.max(bound.min, Math.min(bound.max, height)); apply(); save();
    }
    listen(handle, 'pointerdown', event => {
      if (!desktop.matches || state.collapsed || focused || event.button !== 0) return;
      event.preventDefault(); handle.focus();
      drag = { id: event.pointerId, y: event.clientY, height: panel.getBoundingClientRect().height };
      handle.setPointerCapture(event.pointerId); document.body.classList.add('resizing-analysis-panel');
    });
    listen(handle, 'pointermove', event => {
      if (drag && event.pointerId === drag.id) resize(drag.height + drag.y - event.clientY);
    });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(handle, event, end);
    listen(handle, 'keydown', event => {
      if (!desktop.matches || state.collapsed || focused) return;
      const delta = event.shiftKey ? 50 : 10, height = panel.getBoundingClientRect().height;
      const next = { ArrowUp: height + delta, ArrowDown: height - delta, Home: bounds().min, End: bounds().max }[event.key];
      if (next !== undefined) { event.preventDefault(); resize(next); }
    });
    listen(handle, 'dblclick', () => { if (focused) return; end(); state.height = 560; state.expanded = false; apply(); save(); });
    listen(button, 'click', () => { end(); state.collapsed = !state.collapsed; apply(); save(); });
    listen(expand, 'click', () => { if (focused) return; end(); state.expanded = !state.expanded; apply(); save(); });
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
    // Parent height can change without a window resize (e.g. an embedded view).
    const observer = global.ResizeObserver ? new ResizeObserver(() => apply()) : null;
    observer?.observe(scenePanel);
    apply();
    return {
      getState: () => ({ ...state, focused }),
      setCollapsed(value) { state.collapsed = !!value; apply(); save(); },
      dispose() { end(); save(); disposed = true; focused = false; workspace?.classList.remove('analysis-focused'); observer?.disconnect(); for (const [target, event, handler] of listeners) target.removeEventListener(event, handler); }
    };
  }
  global.Stack3DAnalysisResize = { create };
})(window);
