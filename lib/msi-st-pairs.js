/* Adopted anatomical pairs. Different specimens; no coordinate registration.
 * Match project IDs, never a display name alone: the MSI snapshot belongs to
 * one registered project, and copies may contain different measurements. */
(function (global) {
  'use strict';
  const pairs = Object.freeze([
    ['proj_msygjfit_em2hnv', 'Cor_13_12', 'T420'],
    ['proj_msygg6w6_kq1bom', 'Cor_13_6', 'T430'],
    ['proj_msy523hn_590k3n', 'Cor_9_3', 'T462'],
    ['proj_msrnmxr7_j7c1kx', 'Cor_6_3', 'T479'],
    ['proj_mu2doxrs_euob1x', 'Cor_2_3', 'T503'],
    ['proj_msrhau7t_ygecge', 'Cor_1_8', 'T512']
  ].map(([projectId, section, st]) => Object.freeze({ projectId, section, st,
    species: 'marmoset', plane: 'coronal', adoption: 'user_selected',
    registration: 'not_registered', msiSnapshotDate: '2026-11-16' })));
  // The nearby Cor_2_2 is a named anatomical reference, separate from the six adopted pairs.
  const corticalReference = Object.freeze({ projectId: 'proj_mu1e4mep_x3hlio', section: 'Cor_2_2', st: 'T503', mode: 'reference' });
  function getReferenceForSt(st) {
    return st === corticalReference.st ? corticalReference : null;
  }
  const byProject = new Map(pairs.map(pair => [pair.projectId, pair]));
  const bySection = new Map(pairs.map(pair => [pair.section, pair]));
  const bySt = new Map(pairs.map(pair => [pair.st, pair]));
  const sources = new Set(['viewer', 'stack3d']);

  function isMarmosetCoronalProject(project) {
    if (!project || typeof project !== 'object') return false;
    if (project.plane && project.plane !== 'coronal') return false;
    const atlas = project.atlas;
    return !(atlas && ((atlas.species && atlas.species !== 'marmoset') ||
        (atlas.seriesId && atlas.seriesId !== 'legacy_marmoset') || atlas.coordinateMode === 'pixel'));
  }
  function getPairForProject(value) {
    const project = value && (value.project || value);
    return isMarmosetCoronalProject(project) ? byProject.get(project.id) || null : null;
  }
  function comparisonUrl(project, { baseUrl, from } = {}) {
    const pair = getPairForProject(project);
    if (!pair) return null;
    const url = new URL('../comparison/index.html', baseUrl || global.location.href);
    url.searchParams.set('project', pair.projectId);
    url.searchParams.set('section', pair.section);
    url.searchParams.set('st', pair.st);
    if (sources.has(from)) url.searchParams.set('from', from);
    return url.href;
  }
  function resolveQuery(search) {
    const params = new URLSearchParams(search), selectors = [['project', byProject], ['section', bySection], ['st', bySt]];
    let pair = null;
    for (const [key, index] of selectors) {
      if (!params.has(key)) continue;
      if (params.getAll(key).length !== 1) return { pair: null, error: '切片の指定が重複しています。元の画面から開き直してください。' };
      const candidate = index.get(params.get(key));
      if (!candidate) return { pair: null, error: 'この切片のST対応は未登録です。登録済みの6組から選択してください。' };
      if (pair && pair !== candidate) return { pair: null, error: 'MSIとSTの切片指定が一致しません。元の画面から開き直してください。' };
      pair = candidate;
    }
    let reference = null;
    if (params.has('msiReference')) {
      if (params.getAll('msiReference').length !== 1 || params.get('msiReference') !== corticalReference.section ||
          (pair && pair.st !== corticalReference.st)) {
        return { pair: null, error: 'このMSI参照切片とSTの対応を確認できません。' };
      }
      reference = corticalReference;
      pair = bySt.get(reference.st);
    }
    return { pair, reference, error: null, from: sources.has(params.get('from')) ? params.get('from') : null };
  }
  global.MsiStPairs = Object.freeze({ pairs, getReferenceForSt, isMarmosetCoronalProject, getPairForProject, comparisonUrl, resolveQuery,
    getPairForSt: st => bySt.get(st) || null });
})(window);
