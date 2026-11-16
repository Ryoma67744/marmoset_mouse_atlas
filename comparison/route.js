/* Shared navigation for the static comparison page. No cloud writes. */
(() => {
  'use strict';
  const registry = window.MsiStPairs;
  const route = registry ? registry.resolveQuery(location.search) : {
    error: '切片の対応情報を読み込めませんでした。ページを再読み込みしてください。'
  };
  const root = document.getElementById('marmoset-st-mock');
  const notice = document.getElementById('comparison-route-notice');
  if (route.error) {
    root.hidden = true;
    notice.hidden = false;
    document.getElementById('comparison-route-error').textContent = route.error;
  }
  window.MSI_ST_ROUTE = Object.freeze({
    pair: route.pair || null,
    error: route.error || null,
    update(st) {
      const pair = registry.getPairForSt(st);
      if (!pair || route.error) return;
      const url = new URL(location.href);
      url.searchParams.set('project', pair.projectId);
      url.searchParams.set('section', pair.section);
      url.searchParams.set('st', pair.st);
      // replaceState keeps reload/copy URL faithful without polluting Back.
      try { history.replaceState(null, '', url); } catch (_) {}
      const viewer = new URL('../viewer/index.html', location.href);
      viewer.searchParams.set('project', pair.projectId);
      viewer.searchParams.set('from', 'msi-st');
      viewer.searchParams.set('newtab', '1');
      document.getElementById('mx-atlas-link').href = viewer.href;
      const stack = new URL('../stack3d/index.html', location.href);
      stack.searchParams.set('project', pair.projectId);
      stack.searchParams.set('series', 'legacy_marmoset');
      document.getElementById('comparison-stack3d').href = stack.href;
      document.getElementById('comparison-source').textContent = route.from === 'stack3d'
        ? '3Dから開いた比較' : route.from === 'viewer' ? '個別ページから開いた比較' : 'MSI–ST比較';
      document.title = pair.section + ' ↔ ' + pair.st + ' | Marmoset MSI–ST';
    }
  });
})();
