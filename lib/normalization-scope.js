/* Folder membership is resolved from records, never from display-name prefixes.
 * Saved numerical scope is immutable; this module describes current structure.
 * Snapshot guards are transient local CAS inputs, not numerical fingerprints.
 */
(function (global) {
  'use strict';
  const textId = value => typeof value === 'string' && value.trim().length > 0;
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const copy = value => JSON.parse(JSON.stringify(value));
  function memberId(project) {
    return project && project.normalizationBinding && project.normalizationBinding.memberId || project && project.id;
  }
  function indexFolders(folders) {
    const byId = new Map(), duplicates = new Set(), errors = [];
    for (const folder of folders || []) {
      if (!folder || !textId(folder.id)) { errors.push({ code: 'FOLDER_ID_INVALID', reason: 'フォルダーIDが不正です。' }); continue; }
      if (byId.has(folder.id)) {
        duplicates.add(folder.id);
        errors.push({ code: 'FOLDER_ID_DUPLICATE', folderId: folder.id, reason: 'フォルダーIDが重複しています。' });
      } else byId.set(folder.id, folder);
    }
    function ancestry(id) {
      const chain = [], seen = new Set();
      while (id != null && id !== '') {
        if (seen.has(id)) return { error: { code: 'FOLDER_CYCLE', folderId: id, reason: 'フォルダー階層が循環しています。' } };
        if (duplicates.has(id)) return { error: { code: 'FOLDER_ID_DUPLICATE', folderId: id, reason: 'フォルダーIDが重複しています。' } };
        const folder = byId.get(id);
        if (!folder) return { error: { code: 'FOLDER_PARENT_MISSING', folderId: id, reason: '所属先または親フォルダーが見つかりません。' } };
        if (!textId(folder.name)) return { error: { code: 'FOLDER_NAME_INVALID', folderId: id, reason: 'フォルダー名が不正です。' } };
        seen.add(id); chain.unshift(folder); id = folder.parentId;
      }
      return { chain: chain };
    }
    return { byId: byId, ancestry: ancestry, errors: errors };
  }
  function descriptor(chain) {
    if (!chain || chain.length < 2) return null;
    const path = chain.slice(0, 2).map(f => f.name);
    return { folderId: chain[1].id, path: path, key: JSON.stringify(path), label: path.join(' / ') };
  }
  function groupForFolder(folderId, folders) { return descriptor(indexFolders(folders).ancestry(folderId).chain); }
  function buildGroups(projects, folders) {
    const index = indexFolders(folders), errors = index.errors.slice(), byFolder = new Map(), ungrouped = [];
    const addError = error => { if (!errors.some(e => JSON.stringify(e) === JSON.stringify(error))) errors.push(error); };
    for (const folder of index.byId.values()) {
      const result = index.ancestry(folder.id);
      if (result.error) { addError(result.error); continue; }
      if (result.chain.length !== 2) continue;
      const group = Object.assign(descriptor(result.chain), { projects: [], projectIds: [], groupId: null, identityConflict: false });
      byFolder.set(group.folderId, group);
    }
    const projectIds = new Set(), duplicateIds = new Set();
    for (const project of projects || []) {
      if (project && projectIds.has(project.id)) duplicateIds.add(project.id);
      if (project) projectIds.add(project.id);
    }
    for (const project of projects || []) {
      if (!project || !textId(project.id) || duplicateIds.has(project.id)) {
        addError({ code: 'PROJECT_ID_INVALID', projectId: project && project.id || null, reason: 'データIDが不正または重複しています。' });
        if (project) ungrouped.push(project);
        continue;
      }
      const result = index.ancestry(project.folderId), desc = descriptor(result.chain);
      if (result.error) addError(Object.assign({ projectId: project.id }, result.error));
      const group = desc && byFolder.get(desc.folderId);
      if (group) { group.projects.push(project); group.projectIds.push(project.id); }
      else ungrouped.push(project);
    }
    for (const group of byFolder.values()) {
      const folder = index.byId.get(group.folderId), candidates = new Set();
      for (const project of group.projects) {
        const binding = project.normalizationBinding;
        if (binding && textId(binding.groupId) && JSON.stringify(binding.folderPath) === group.key) candidates.add(binding.groupId);
      }
      if (textId(folder.normalizationGroupId)) group.groupId = folder.normalizationGroupId;
      else if (candidates.size === 1) group.groupId = Array.from(candidates)[0];
      group.identityConflict = candidates.size > 1 || !!group.groupId && Array.from(candidates).some(id => id !== group.groupId);
      if (group.identityConflict) addError({ code: 'GROUP_ID_CONFLICT', folderId: group.folderId, reason: '同じフォルダーに異なる補正グループIDが存在します。再設定が必要です。' });
      group.projectIds.sort(compare); group.projects.sort((a, b) => compare(a.id, b.id));
    }
    const byGroupId = new Map();
    for (const group of byFolder.values()) {
      if (!group.groupId) continue;
      if (!byGroupId.has(group.groupId)) byGroupId.set(group.groupId, []);
      byGroupId.get(group.groupId).push(group);
    }
    for (const groups of byGroupId.values()) if (groups.length > 1) {
      for (const group of groups) {
        group.identityConflict = true;
        addError({ code: 'GROUP_ID_CONFLICT', folderId: group.folderId, reason: '別々の第2階層フォルダーで同じ補正グループIDが使われています。独立したグループとして再設定してください。' });
      }
    }
    return { groups: Array.from(byFolder.values()).sort((a, b) => compare(a.label, b.label) || compare(a.folderId, b.folderId)), ungrouped: ungrouped, errors: errors };
  }
  function snapshot(projects, folders, folderId) {
    const index = indexFolders(folders), target = index.ancestry(folderId), desc = descriptor(target.chain);
    if (!desc || target.chain.length !== 2) return { valid: false, folderId: folderId || null, memberIds: [], folders: [], errors: [target.error || { code: 'GROUP_FOLDER_INVALID' }] };
    const built = buildGroups(projects, folders), group = built.groups.find(g => g.folderId === folderId);
    const relevant = new Set([target.chain[0].id, folderId]);
    // Walk child links as well as ancestry so an ambiguous descendant ID cannot
    // disappear from the guard while the apparent valid subset is saved.
    let added = true;
    while (added) {
      added = false;
      for (const folder of folders || []) {
        if (folder && folder.parentId !== target.chain[0].id && relevant.has(folder.parentId) && !relevant.has(folder.id)) { relevant.add(folder.id); added = true; }
      }
    }
    const relevantProjects = new Set((projects || []).filter(p => p && relevant.has(p.folderId) && p.folderId !== target.chain[0].id).map(p => p.id));
    const errors = built.errors.filter(e => e.code !== 'GROUP_ID_CONFLICT' && (relevant.has(e.folderId) || relevantProjects.has(e.projectId)));
    const records = (folders || []).filter(f => f && relevant.has(f.id)).map(f => ({ id: f.id, name: f.name, parentId: f.parentId || null, normalizationGroupId: f.normalizationGroupId || null }))
      .sort((a, b) => compare(a.id, b.id) || compare(JSON.stringify(a), JSON.stringify(b)));
    return { valid: !!group && !errors.length, folderId: folderId, memberIds: group ? group.projectIds.slice() : [], folders: records,
      members: group ? group.projects.map(p => ({ id: p.id, folderId: p.folderId || null, memberId: memberId(p), bindingGroupId: p.normalizationBinding ? p.normalizationBinding.groupId : null })) : [], errors: errors };
  }
  function equalsSnapshot(a, b) {
    if (!a || !b || a.valid !== true || b.valid !== true) return false;
    const clean = snapshot => { const result = copy(snapshot); delete result.groupId; delete result.reassignGroupId; return result; };
    return JSON.stringify(clean(a)) === JSON.stringify(clean(b));
  }
  function assess(project, group) {
    const profile = project && project.normalization, scope = profile && profile.scope, binding = project && project.normalizationBinding;
    const isSkipped = saved => !!(saved && saved.schemaVersion === 3 && saved.application &&
      saved.application.status === 'skipped' && saved.application.reasonCode === 'INTERNAL_STANDARD_MISSING');
    const skipped = isSkipped(profile);
    if (!profile) return { status: 'UNCONFIGURED', reason: '補正未設定です。' };
    if (!scope) return { status: 'LEGACY', reason: '従来の補正設定です。第2階層フォルダーの設定には未移行です。' };
    if (Object.prototype.hasOwnProperty.call(project, 'normalizationBinding') && (!binding || binding.groupId !== scope.groupId)) return { status: 'MOVED', reason: '補正時と現在のグループが異なります。現在のグループで再設定してください。', numericalSnapshotPreserved: true };
    if (group && group.groupId && group.groupId !== scope.groupId) return { status: 'MOVED', reason: '現在のフォルダーには別グループの補正が保存されています。', numericalSnapshotPreserved: true };
    if (!group) return { status: 'CURRENT', reason: skipped
      ? '内部標準なしのため補正をスキップしました。生値を表示します。現在のグループ全体の構成は未確認です。'
      : '保存済みの基準値・係数を使用します。現在のグループ全体の構成は未確認です。', membershipVerified: false,
      ...(skipped ? { uncorrected: true } : {}) };
    const references = profile.reference && Array.isArray(profile.reference.entries) ? profile.reference.entries : [];
    const changedReferences = references.filter(reference => {
      const current = (group.projects || []).find(p => memberId(p) === (reference.memberId || reference.projectId));
      const saved = current && current.normalization;
      return saved && (saved.invalidated || reference.rawFingerprint && saved.rawFingerprint !== reference.rawFingerprint ||
        reference.geometryFingerprint && saved.referenceGeometryFingerprint !== reference.geometryFingerprint);
    }).map(reference => reference.memberId || reference.projectId);
    if (changedReferences.length) return { status: 'MIXED', reason: '固定基準データの生値・参照ROIまたは設定が変更されています。保存済みの係数は保持し、グループの基準確認が必要です。',
      referenceReviewRequired: true, changedReferenceMemberIds: changedReferences, numericalSnapshotPreserved: true };
    const scoped = (group.projects || []).filter(p => p.normalization && p.normalization.scope), signatures = new Set(scoped.map(p => {
      const saved = p.normalization;
      // IDs and revisions can coincide after importing another format. A v2
      // detailed profile and a v3 simple profile are never one applied batch.
      return JSON.stringify([saved.schemaVersion, saved.methodVersion || null, saved.mode || null,
        saved.scope.groupId, saved.id, saved.revision, saved.scope.memberIds]);
    }));
    if (group.identityConflict || signatures.size > 1 || (group.projects || []).some(p => p.normalization && !p.normalization.scope)) {
      return { status: 'MIXED', reason: 'グループ内に異なる補正設定または版が混在しています。全件に同じ設定が適用された状態ではありません。', numericalSnapshotPreserved: true };
    }
    const current = (group.projects || []).map(memberId).sort(compare), expected = Array.isArray(scope.memberIds) ? scope.memberIds.slice().sort(compare) : [];
    const added = current.filter(id => !expected.includes(id)), missing = expected.filter(id => !current.includes(id));
    if (added.length || missing.length || new Set(current).size !== current.length || (group.projects || []).some(p => !p.normalization)) {
      return { status: 'COMPOSITION_CHANGED', reason: '保存時とグループ構成が異なります。保存済みの基準値・係数は保持し、再計算は行っていません。', addedMemberIds: added, missingMemberIds: missing, numericalSnapshotPreserved: true };
    }
    const skippedCount = scoped.filter(p => isSkipped(p.normalization)).length;
    if (skippedCount) return { status: 'CURRENT', reason:
      (skipped ? '内部標準なしのため補正をスキップしました。生値を表示します。' : '') +
      'グループの補正対象 ' + (scoped.length - skippedCount) + '件・スキップ ' + skippedCount + '件の処理結果が保存されています。',
      membershipVerified: true, uncorrected: skipped, skippedCount: skippedCount, correctedCount: scoped.length - skippedCount };
    return { status: 'CURRENT', reason: '現在のグループに同じ補正設定が適用されています。', membershipVerified: true };
  }
  // This copy is for evaluation and provenance only. Neither current binding
  // nor folder labels may rewrite the immutable calculation snapshot.
  function resolveContext(project, folders, projects) {
    const evaluated = Object.assign({}, project || {});
    let group = null, currentFolderPath = null;
    if (Array.isArray(folders)) {
      const location = indexFolders(folders).ancestry(evaluated.folderId);
      currentFolderPath = location.chain ? location.chain.map(folder => folder.name) : [];
      evaluated.folderPath = currentFolderPath.slice();
      const members = (Array.isArray(projects) ? projects : []).filter(p => p && p.id !== evaluated.id).concat(evaluated);
      const descriptor = groupForFolder(evaluated.folderId, folders);
      group = descriptor && buildGroups(members, folders).groups.find(g => g.folderId === descriptor.folderId) || null;
      if (evaluated.normalization && evaluated.normalization.scope) {
        evaluated.normalizationBinding = {
          groupId: group && group.groupId || null,
          folderPath: group ? group.path.slice() : [], memberId: memberId(evaluated)
        };
      }
    } else if (Array.isArray(evaluated.folderPath)) currentFolderPath = evaluated.folderPath.slice();
    else if (evaluated.normalizationBinding && Array.isArray(evaluated.normalizationBinding.folderPath)) {
      currentFolderPath = evaluated.normalizationBinding.folderPath.slice();
    }
    return { project: evaluated, group: group, assessment: assess(evaluated, Array.isArray(projects) ? group : null),
      currentFolderPath: currentFolderPath, hierarchyAvailable: Array.isArray(folders), membershipAvailable: Array.isArray(projects) };
  }
  global.NormalizationScope = { buildGroups: buildGroups, groupForFolder: groupForFolder, memberId: memberId, snapshot: snapshot, equalsSnapshot: equalsSnapshot, assess: assess, resolveContext: resolveContext };
})(window);
