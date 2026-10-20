/* Per-tab presentation preferences, shared across species; no project writes. */
(function (global) {
  'use strict';
  const key = 'atlas-stack3d-sidebars-v1', workspace = document.querySelector('.workspace');
  const panels = [
    { name: 'controls', label: '分子分布', panel: 'controls-panel', body: 'controls-body', button: 'controls-toggle', close: '‹', open: '›' },
    { name: 'section', label: '選択切片', panel: 'section-panel', body: 'section-body', button: 'section-toggle', close: '›', open: '‹' }
  ];
  let state = { controls: false, section: false };
  try {
    const saved = JSON.parse(sessionStorage.getItem(key));
    if (saved) state = { controls: saved.controls === true, section: saved.section === true };
  } catch (_) {}
  function save() { try { sessionStorage.setItem(key, JSON.stringify(state)); } catch (_) {} }
  function apply(item) {
    const collapsed = state[item.name], body = document.getElementById(item.body), button = document.getElementById(item.button);
    if (collapsed && body.contains(document.activeElement)) button.focus();
    body.hidden = collapsed; body.inert = collapsed;
    document.getElementById(item.panel).classList.toggle('sidebar-collapsed', collapsed);
    workspace.classList.toggle(item.name + '-collapsed', collapsed);
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', item.label + (collapsed ? 'を表示' : 'を最小化'));
    button.title = item.label + (collapsed ? 'を表示' : 'を最小化');
    button.querySelector('.sidebar-toggle-icon').textContent = collapsed ? item.open : item.close;
    button.querySelector('.sidebar-toggle-text').textContent = collapsed ? '表示' : '最小化';
  }
  for (const item of panels) {
    document.getElementById(item.button).addEventListener('click', () => {
      state[item.name] = !state[item.name]; apply(item); save();
    });
    apply(item);
  }
  global.Atlas3DSidebars = { getState: () => ({ ...state }) };
})(window);
