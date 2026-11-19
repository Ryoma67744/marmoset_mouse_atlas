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
    reference: route.reference || null,
    update(st, msiProjectId) {
      const pair = registry.getPairForSt(st);
      if (!pair || route.error) return;
      const reference = registry.getReferenceForSt(st);
      const source = reference && msiProjectId === reference.projectId ? reference : pair;
      const url = new URL(location.href);
      if (source === pair) url.searchParams.delete('msiReference');
      else url.searchParams.set('msiReference', source.section);
      url.searchParams.set('project', pair.projectId);
      url.searchParams.set('section', pair.section);
      url.searchParams.set('st', pair.st);
      // replaceState keeps reload/copy URL faithful without polluting Back.
      try { history.replaceState(null, '', url); } catch (_) {}
      const viewer = new URL('../viewer/index.html', location.href);
      viewer.searchParams.set('project', source.projectId);
      viewer.searchParams.set('from', 'msi-st');
      viewer.searchParams.set('newtab', '1');
      document.getElementById('mx-atlas-link').href = viewer.href;
      const stack = new URL('../stack3d/index.html', location.href);
      stack.searchParams.set('project', source.projectId);
      stack.searchParams.set('series', 'legacy_marmoset');
      document.getElementById('comparison-stack3d').href = stack.href;
      document.getElementById('comparison-source').textContent = route.from === 'stack3d'
        ? '3Dから開いた比較' : route.from === 'viewer' ? '個別ページから開いた比較' : 'MSI–ST比較';
      document.title = (source === pair ? pair.section + ' ↔ ' : source.section + '（参照）× ') + st + ' | Marmoset MSI–ST';
    }
  });
})();
