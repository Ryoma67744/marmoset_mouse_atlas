/* Per-tab layout only. Image viewports retain their size while the panel moves. */
(function (global) {
  'use strict';
  const workspace = document.querySelector('.workspace'), panel = document.getElementById('section-panel');
  const handle = document.getElementById('section-resizer'), preview = document.getElementById('section-preview');
  const key = 'atlas-stack3d-layout-v1', desktop = global.matchMedia('(min-width: 761px)');
  let state = null, drag = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key));
    if (saved && ['panelWidth', 'previewWidth', 'previewHeight'].every(k => Number.isFinite(saved[k]) && saved[k] > 0 && saved[k] < 3000)) state = saved;
  } catch (_) {}
  function limits() {
    const width = workspace.getBoundingClientRect().width;
    const left = document.querySelector('.controls').getBoundingClientRect().width;
    const center = global.innerWidth >= 1750 ? 450 : global.innerWidth > 1100 ? 330 : 280;
    return { min: 190, max: Math.max(190, Math.min(800, width - left - center)) };
  }
  function save() {
    try { if (state) sessionStorage.setItem(key, JSON.stringify(state)); else sessionStorage.removeItem(key); } catch (_) {}
  }
  function apply() {
    const active = desktop.matches && state;
    workspace.classList.toggle('panel-custom-width', !!active);
    if (active) {
      const bound = limits(), width = Math.max(bound.min, Math.min(bound.max, state.panelWidth));
      workspace.style.setProperty('--section-panel-width', width + 'px');
      workspace.style.setProperty('--section-preview-width', state.previewWidth + 'px');
      workspace.style.setProperty('--section-preview-height', state.previewHeight + 'px');
    } else {
      for (const name of ['--section-panel-width', '--section-preview-width', '--section-preview-height']) workspace.style.removeProperty(name);
    }
    if (desktop.matches) {
      const bound = limits();
      handle.setAttribute('aria-valuemin', String(Math.round(bound.min)));
      handle.setAttribute('aria-valuemax', String(Math.round(bound.max)));
      handle.setAttribute('aria-valuenow', String(Math.round(panel.getBoundingClientRect().width)));
    }
  }
  function resize(width) {
    if (!desktop.matches) return;
    if (!state) {
      const rect = preview.getBoundingClientRect();
      state = { panelWidth: panel.getBoundingClientRect().width, previewWidth: rect.width, previewHeight: rect.height };
    }
    const bound = limits(); state.panelWidth = Math.max(bound.min, Math.min(bound.max, width));
    apply(); save();
  }
  function endDrag(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    const id = drag.id; drag = null; document.body.classList.remove('resizing-section-panel');
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    save();
  }
  handle.addEventListener('pointerdown', event => {
    if (!desktop.matches || event.button !== 0) return;
    event.preventDefault(); handle.focus();
    drag = { id: event.pointerId, x: event.clientX, width: panel.getBoundingClientRect().width };
    handle.setPointerCapture(event.pointerId); document.body.classList.add('resizing-section-panel');
  });
  handle.addEventListener('pointermove', event => {
    if (drag && event.pointerId === drag.id) resize(drag.width + drag.x - event.clientX);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(name, endDrag);
  handle.addEventListener('dblclick', () => { endDrag(); state = null; apply(); save(); });
  handle.addEventListener('keydown', event => {
    if (!desktop.matches) return;
    const delta = event.shiftKey ? 50 : 10, width = panel.getBoundingClientRect().width;
    const next = { ArrowLeft: width + delta, ArrowRight: width - delta, Home: limits().min, End: limits().max }[event.key];
    if (next !== undefined) { event.preventDefault(); resize(next); }
  });
  global.addEventListener('resize', () => { endDrag(); apply(); });
  global.addEventListener('pagehide', () => { endDrag(); save(); });
  global.Atlas3DPanelResize = { getState: () => state && { ...state } };
  apply();
})(window);
