/* Pure section ordering and catalogue construction. No storage, network or
 * Viewer/3D display state is read or changed by this module. */
(function (global) {
  'use strict';
  const own = (value, key) => value != null && Object.prototype.hasOwnProperty.call(value, key);
  const number = (value, fallback) => Number.isFinite(Number(value)) && value != null && value !== '' ? Number(value) : fallback;
  const nameOf = project => typeof project === 'string' ? project : String(project && (project.displayName || project.name) || '');

  // Keep these three functions compatible with the established Stack3D order.
  // Catalogue input validation below is deliberately separate from that API.
  function seriesOf(value) {
    const project = value && (value.project || value), atlas = project && project.atlas;
    if (!atlas || !atlas.seriesId) return { id: 'legacy_marmoset', name: 'Marmoset', species: 'marmoset', coordinateMode: 'physical' };
    return { id: String(atlas.seriesId), name: String(atlas.seriesName || atlas.seriesId),
      species: String(atlas.species || ''), coordinateMode: atlas.coordinateMode === 'pixel' ? 'pixel' : 'physical' };
  }
  function naturalCor(project) {
    if (project && typeof project === 'object' && project.atlas) {
      const atlas = project.atlas, section = number(atlas.sectionNumber, NaN);
      if (!atlas.seriesId || !Number.isSafeInteger(section) || section < 1 ||
          (project.plane && project.plane !== 'coronal')) return null;
      return { group: 0, section, canonical: String(atlas.seriesId) + ':' + section };
    }
    const match = nameOf(project).trim().match(/^Cor[_-](\d+)[_-](\d+)(?=$|[\s_.(\-])/i);
    return match ? { group: Number(match[1]), section: Number(match[2]), canonical: 'Cor_' + Number(match[1]) + '_' + Number(match[2]) } : null;
  }
  function sortCoronal(projects) {
    return (projects || []).filter(p => naturalCor(p)).slice().sort((a, b) => {
      const x = naturalCor(a), y = naturalCor(b);
      return seriesOf(a).id.localeCompare(seriesOf(b).id) || x.group - y.group || x.section - y.section ||
        nameOf(a).localeCompare(nameOf(b)) || String(a.id || '').localeCompare(String(b.id || ''));
    });
  }

  function descriptor(record, remote = false) {
    if (!record || typeof record !== 'object' || !own(record, 'id') ||
        typeof record.id !== 'string' || !record.id.trim()) return null;
    const meta = remote && own(record, 'meta') && record.meta && typeof record.meta === 'object' ? record.meta : {};
    const state = remote && own(record, 'state') && record.state && typeof record.state === 'object' ? record.state : {};
    const atlas = remote ? (own(meta, 'atlas') && meta.atlas || own(state, 'atlas') && state.atlas || null)
      : own(record, 'atlas') ? record.atlas : null;
    const displayName = remote ? (own(record, 'display_name') ? record.display_name : '')
      : own(record, 'displayName') ? record.displayName : own(record, 'name') ? record.name : '';
    return { id: record.id, displayName: typeof displayName === 'string' ? displayName : '',
      atlas: atlas && typeof atlas === 'object' && !Array.isArray(atlas) ? { ...atlas } : atlas ? {} : null,
      plane: remote ? (own(meta, 'plane') ? meta.plane : '') : own(record, 'plane') ? record.plane : '',
      localAvailable: !remote, cloudAvailable: remote,
      cloudUpdatedAt: !remote && own(record, 'cloudUpdatedAt') ? record.cloudUpdatedAt : null,
      cloudPending: !remote && own(record, 'cloudPending') && record.cloudPending === true };
  }
  function catalogueOrder(item) {
    if (!item) return null;
    if (item.atlas) {
      const atlas = item.atlas, value = atlas.sectionNumber;
      if (!own(atlas, 'seriesId') || typeof atlas.seriesId !== 'string' || !atlas.seriesId.trim() ||
          !own(atlas, 'sectionNumber') || !['number', 'string'].includes(typeof value) ||
          typeof value === 'string' && !value.trim()) return null;
    }
    const order = naturalCor(item);
    return order && Number.isSafeInteger(order.group) && Number.isSafeInteger(order.section) ? order : null;
  }
  function sameSeries(a, b) {
    const x = seriesOf(a), y = seriesOf(b);
    return x.id === y.id && x.species === y.species && x.coordinateMode === y.coordinateMode;
  }

  // remoteRows is an authoritative, successfully fetched complete list when it
  // is an array (including []). Pass null if the cloud list was unavailable.
  // complete describes the catalogue source, not contiguous section numbers.
  function buildCatalog(currentProject, locals, remoteRows = null) {
    const complete = Array.isArray(remoteRows), source = complete ? 'cloud-and-local' : 'local';
    const current = descriptor(currentProject), currentOrder = catalogueOrder(current);
    const base = { items: [], index: -1, previous: null, next: null, status: 'unavailable', reason: '', source, complete };
    if (!currentOrder) return { ...base, reason: '表示中の切片の番号・系列を確認できないため、前後へ移動できません。' };

    const remote = new Map(), merged = new Map();
    if (complete) for (const row of remoteRows) {
      const item = descriptor(row, true);
      if (item) { remote.set(item.id, item); merged.set(item.id, item); }
    }
    for (const project of Array.isArray(locals) ? locals : []) {
      const item = descriptor(project);
      if (!item) continue;
      // Preserve local-only and pending work, but do not resurrect a clean
      // downloaded cache that an authoritative cloud catalogue no longer has.
      if (complete && !remote.has(item.id) && item.cloudUpdatedAt && !item.cloudPending) continue;
      item.cloudAvailable = remote.has(item.id);
      merged.set(item.id, item);
    }
    const items = sortCoronal([...merged.values()].filter(item => sameSeries(current, item) && catalogueOrder(item)));
    const index = items.findIndex(item => item.id === current.id);
    const result = { ...base, items, index };
    if (index < 0) return { ...result, reason: '表示中の切片が現在の登録一覧にありません。再読込して一覧を確認してください。' };
    if (catalogueOrder(items[index]).canonical !== currentOrder.canonical) {
      return { ...result, reason: '表示中の切片の番号が登録一覧と異なります。再読込してから移動してください。' };
    }
    const seen = new Set(), duplicates = new Set();
    for (const item of items) {
      const key = catalogueOrder(item).canonical;
      if (seen.has(key)) duplicates.add(key);
      seen.add(key);
    }
    if (duplicates.size) return { ...result, status: 'ambiguous',
      reason: '同じ切片番号が複数あるため、前後の切片を確定できません。Masterで対象データを確認してください：' + [...duplicates].join(', ') };
    return { ...result, status: 'ready', previous: items[index - 1] || null, next: items[index + 1] || null };
  }
  global.SectionNavigation = Object.freeze({ seriesOf, naturalCor, sortCoronal, buildCatalog });
})(window);
