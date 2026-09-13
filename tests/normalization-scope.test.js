'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sandbox = { window: {} }; vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'normalization-scope.js'), 'utf8'), sandbox);
const S = sandbox.window.NormalizationScope, json = value => JSON.parse(JSON.stringify(value));
function fixture() {
  return { folders: [
    { id: 'm', name: 'Marmoset', parentId: null }, { id: 'c', name: 'Coronal', parentId: 'm' },
    { id: 's', name: 'Sagittal', parentId: 'm' }, { id: 'deep', name: 'Nested', parentId: 'c' },
    { id: 'mouse', name: 'Mouse', parentId: null }, { id: 'mc', name: 'Coronal', parentId: 'mouse' },
    { id: 'top', name: 'Coronal', parentId: null }
  ], projects: [
    { id: 'a', folderId: 'c' }, { id: 'b', folderId: 'deep' }, { id: 's1', folderId: 's' },
    { id: 'mouse1', folderId: 'mc' }, { id: 'top1', folderId: 'top' }, { id: 'root1', folderId: null }
  ] };
}
function profile(project, ids = ['a', 'b'], overrides = {}) {
  project.normalization = { schemaVersion: 2, id: 'p', revision: 1, scope: { type: 'folder-depth', depth: 2, includeDescendants: true,
    groupId: 'uuid-c', folderPath: ['Marmoset', 'Coronal'], memberIds: ids }, ...overrides };
  project.normalizationBinding = { groupId: 'uuid-c', folderPath: ['Marmoset', 'Coronal'], memberId: project.id };
}
test('intentional missing-standard skips keep folder membership current without claiming every member was corrected', () => {
  const f = fixture(), active = f.projects[0], skipped = f.projects[1];
  const reference = {projectIds:['a'],entries:[{projectId:'a',memberId:'a',rawFingerprint:'raw-a'}]};
  profile(active, ['a','b'], {schemaVersion:3,methodVersion:'2.0.0',mode:'simple',rawFingerprint:'raw-a',reference});
  profile(skipped, ['a','b'], {schemaVersion:3,methodVersion:'2.0.0',mode:'simple',reference,
    application:{status:'skipped',reasonCode:'INTERNAL_STANDARD_MISSING'}});
  const group = () => S.buildGroups(f.projects,f.folders).groups.find(g=>g.folderId==='c');
  const correction = S.assess(active,group()), omission = S.assess(skipped,group());
  assert.equal(correction.status,'CURRENT'); assert.equal(correction.uncorrected,false);
  assert.equal(omission.status,'CURRENT'); assert.equal(omission.uncorrected,true);
  assert.equal(omission.correctedCount,1); assert.equal(omission.skippedCount,1);
  assert.match(omission.reason,/内部標準なし.*生値/); assert.match(correction.reason,/補正対象 1件・スキップ 1件/);
  assert.match(S.assess(skipped,null).reason,/スキップ.*未確認/);
  assert.doesNotMatch(S.assess(skipped,null).reason,/係数を使用/);
  // Portable IDs survive restoration; intentional omission is not a missing member.
  active.id='restored-a'; skipped.id='restored-b';
  assert.equal(S.assess(skipped,group()).status,'CURRENT');
  skipped.normalization.revision=2;
  assert.equal(S.assess(active,group()).status,'MIXED');
  skipped.normalization.revision=1; skipped.normalizationBinding.groupId='other';
  assert.equal(S.assess(skipped,group()).status,'MOVED');
});
test('all-skipped groups are recorded as zero corrections and scope still detects added members', () => {
  const f=fixture();
  for (const p of f.projects.slice(0,2)) profile(p,['a','b'],{schemaVersion:3,methodVersion:'2.0.0',mode:'simple',
    reference:{projectIds:[],entries:[]},application:{status:'skipped',reasonCode:'INTERNAL_STANDARD_MISSING'}});
  const group=()=>S.buildGroups(f.projects,f.folders).groups.find(g=>g.folderId==='c');
  const assessment=S.assess(f.projects[0],group());
  assert.equal(assessment.status,'CURRENT');assert.equal(assessment.correctedCount,0);assert.equal(assessment.skippedCount,2);
  f.projects.push({id:'new',folderId:'deep'});
  assert.equal(S.assess(f.projects[0],group()).status,'COMPOSITION_CHANGED');
});
test('actual second ancestor includes descendants and separates identical terminal names and top-level datasets', () => {
  const f = fixture(), built = S.buildGroups(f.projects, f.folders);
  assert.deepEqual(json(built.groups.map(g => [g.folderId, g.path, g.projectIds])), [
    ['c', ['Marmoset', 'Coronal'], ['a', 'b']], ['s', ['Marmoset', 'Sagittal'], ['s1']], ['mc', ['Mouse', 'Coronal'], ['mouse1']]
  ]);
  assert.deepEqual(json(built.ungrouped.map(p => p.id)), ['top1', 'root1']);
  assert.equal(S.groupForFolder('deep', f.folders).folderId, 'c');
  assert.equal(S.groupForFolder('m', f.folders), null); assert.equal(S.groupForFolder(null, f.folders), null);
  // Display path is not a merge key even if two sibling names are identical.
  f.folders.push({ id: 'c2', name: 'Coronal', parentId: 'm' }); f.projects.push({ id: 'c2p', folderId: 'c2' });
  const duplicateNames = S.buildGroups(f.projects, f.folders).groups.filter(g => g.label === 'Marmoset / Coronal');
  assert.equal(duplicateNames.length, 2); assert.notEqual(duplicateNames[0].folderId, duplicateNames[1].folderId);
});
test('cycle, missing parent and duplicate IDs fail closed without silently assigning a valid-looking group', () => {
  const f = fixture();
  f.folders.push({ id: 'x', name: 'X', parentId: 'y' }, { id: 'y', name: 'Y', parentId: 'x' }, { id: 'lost', name: 'Lost', parentId: 'missing' });
  f.projects.push({ id: 'cycle', folderId: 'x' }, { id: 'broken', folderId: 'lost' });
  const built = S.buildGroups(f.projects, f.folders);
  assert.ok(built.errors.some(e => e.code === 'FOLDER_CYCLE')); assert.ok(built.errors.some(e => e.code === 'FOLDER_PARENT_MISSING'));
  assert.ok(built.ungrouped.some(p => p.id === 'cycle')); assert.equal(S.groupForFolder('lost', f.folders), null);
  f.folders.push({ id: 'c', name: 'Pretend', parentId: 'mouse' });
  assert.ok(S.buildGroups(f.projects, f.folders).ungrouped.some(p => p.id === 'a'));
  assert.equal(S.snapshot(f.projects, f.folders, 'c').valid, false);
  const g = fixture(); g.projects.push({ id: 'a', folderId: 'c' });
  assert.equal(S.snapshot(g.projects, g.folders, 'c').valid, false);
});
test('snapshot catches additions, deletes, moves, renamed ancestors and empty descendant structure changes', () => {
  const original = fixture(), before = S.snapshot(original.projects, original.folders, 'c');
  assert.equal(before.valid, true); assert.deepEqual(json(before.memberIds), ['a', 'b']);
  for (const change of [
    f => f.projects.push({ id: 'new', folderId: 'deep' }),
    f => f.projects.splice(0, 1),
    f => { f.projects[0].folderId = 's'; },
    f => { f.projects[1].folderId = 'c'; },
    f => { f.folders[0].name = 'New name'; },
    f => { f.folders[3].parentId = 's'; },
    f => f.folders.push({ id: 'empty', name: 'Empty', parentId: 'deep' }),
    f => { f.folders[1].normalizationGroupId = 'unexpected'; }
  ]) { const f = fixture(); change(f); assert.equal(S.equalsSnapshot(before, S.snapshot(f.projects, f.folders, 'c')), false); }
});
test('snapshot ignores unrelated groups, display changes, record order and the proposed save group ID', () => {
  const f = fixture(), before = S.snapshot(f.projects, f.folders, 'c');
  f.folders.find(x => x.id === 's').name = 'Other label'; f.projects[0].displayName = 'Display only'; f.projects[0].updatedAt = 100;
  f.projects.push({ id: 'other', folderId: 's' }); f.projects.reverse(); f.folders.reverse();
  const after = S.snapshot(f.projects, f.folders, 'c'); after.groupId = 'new-confirmed-id';
  assert.equal(S.equalsSnapshot(before, after), true);
  assert.equal(S.equalsSnapshot({ valid: false }, { valid: false }), false);
});
test('group identity is recovered from matching portable bindings and conflicts remain explicit', () => {
  const f = fixture(); profile(f.projects[0]); profile(f.projects[1]);
  let group = S.buildGroups(f.projects, f.folders).groups.find(g => g.folderId === 'c');
  assert.equal(group.groupId, 'uuid-c'); assert.equal(group.identityConflict, false);
  f.projects[1].normalizationBinding.groupId = 'foreign';
  group = S.buildGroups(f.projects, f.folders).groups.find(g => g.folderId === 'c');
  assert.equal(group.groupId, null); assert.equal(group.identityConflict, true);
  f.folders[1].normalizationGroupId = 'uuid-c';
  group = S.buildGroups(f.projects, f.folders).groups.find(g => g.folderId === 'c');
  assert.equal(group.groupId, 'uuid-c'); assert.equal(group.identityConflict, true);
});
test('assessment separates portable restoration, composition changes, mixed revision and explicit moved state', () => {
  const f = fixture(); profile(f.projects[0]); profile(f.projects[1]);
  const group = () => S.buildGroups(f.projects, f.folders).groups.find(g => g.folderId === 'c');
  assert.equal(S.assess(f.projects[0], group()).status, 'CURRENT');
  f.projects[0].id = 'imported-a'; f.projects[1].id = 'imported-b';
  assert.equal(S.memberId(f.projects[0]), 'a'); assert.equal(S.assess(f.projects[0], group()).status, 'CURRENT');
  const archived = JSON.stringify(f.projects[0].normalization);
  f.projects.splice(1, 1);
  let status = S.assess(f.projects[0], group());
  assert.equal(status.status, 'COMPOSITION_CHANGED'); assert.deepEqual(json(status.missingMemberIds), ['b']); assert.equal(status.numericalSnapshotPreserved, true);
  assert.equal(JSON.stringify(f.projects[0].normalization), archived);
  assert.equal(S.assess(f.projects[0], null).membershipVerified, false);
  const b = { id: 'b', folderId: 'c' }; profile(b, ['a', 'b'], { revision: 2 }); f.projects.push(b);
  assert.equal(S.assess(f.projects[0], group()).status, 'MIXED');
  f.projects[0].normalizationBinding.groupId = null;
  assert.equal(S.assess(f.projects[0], group()).status, 'MOVED');
  assert.equal(S.assess({ normalization: { schemaVersion: 1 } }, null).status, 'LEGACY');
  assert.equal(S.assess({}, null).status, 'UNCONFIGURED');
});
test('one UUID across distinct physical second-level folders is an explicit identity conflict', () => {
  const f = fixture(); f.folders.find(x => x.id === 'c').normalizationGroupId = 'shared'; f.folders.find(x => x.id === 's').normalizationGroupId = 'shared';
  const built = S.buildGroups(f.projects, f.folders);
  assert.ok(built.groups.filter(g => ['c', 's'].includes(g.folderId)).every(g => g.identityConflict));
  assert.equal(built.groups.find(g => g.folderId === 'mc').identityConflict, false);
  // Conflict is visible and repairable by a reviewed guarded save; membership
  // guards remain valid and still capture the old UUID for compare-and-swap.
  assert.equal(S.snapshot(f.projects, f.folders, 'c').valid, true);
});
test('changed fixed-reference data require group review without invalidating the preserved numerical snapshot', () => {
  const f = fixture(); profile(f.projects[0]); profile(f.projects[1]);
  const saved = f.projects[0].normalization;
  saved.reference = { entries: [{ projectId: 'b', memberId: 'b', rawFingerprint: 'raw-before', geometryFingerprint: 'roi-before' }] };
  f.projects[1].normalization.rawFingerprint = 'raw-before'; f.projects[1].normalization.referenceGeometryFingerprint = 'roi-before';
  const group = () => S.buildGroups(f.projects, f.folders).groups.find(g => g.folderId === 'c');
  assert.equal(S.assess(f.projects[0], group()).status, 'CURRENT');
  f.projects[1].normalization.invalidated = { detail: 'reference ROI updated' };
  const before = JSON.stringify(saved), status = S.assess(f.projects[0], group());
  assert.equal(status.status, 'MIXED'); assert.equal(status.referenceReviewRequired, true);
  assert.deepEqual(json(status.changedReferenceMemberIds), ['b']); assert.equal(JSON.stringify(saved), before);
  delete f.projects[1].normalization.invalidated; f.projects[1].normalization.rawFingerprint = 'raw-changed';
  assert.equal(S.assess(f.projects[0], group()).referenceReviewRequired, true);
});

test('shared evaluation context follows actual folders without changing a saved scope or stale binding', () => {
  const f = fixture(); profile(f.projects[0]); profile(f.projects[1]);
  f.folders.find(folder => folder.id === 'c').normalizationGroupId = 'uuid-c';
  f.folders.find(folder => folder.id === 's').normalizationGroupId = 'uuid-s';
  const p = f.projects[0], saved = JSON.stringify(p);
  let context = S.resolveContext(p, f.folders, f.projects);
  assert.equal(context.assessment.status, 'CURRENT'); assert.equal(context.assessment.membershipVerified, true);
  p.folderId = 's';
  const moved = JSON.stringify(p);
  context = S.resolveContext(p, f.folders, f.projects);
  assert.equal(context.assessment.status, 'MOVED'); assert.equal(context.project.normalizationBinding.groupId, 'uuid-s');
  assert.deepEqual(json(context.currentFolderPath), ['Marmoset', 'Sagittal']);
  assert.equal(JSON.stringify(p), moved); assert.equal(context.project.normalization, p.normalization);
  p.folderId = 'deep'; f.folders.find(folder => folder.id === 'c').name = 'Coronal renamed';
  context = S.resolveContext(p, f.folders, f.projects);
  assert.equal(context.assessment.status, 'CURRENT');
  assert.deepEqual(json(context.currentFolderPath), ['Marmoset', 'Coronal renamed', 'Nested']);
  assert.equal(context.project.normalization.scope.folderPath[1], 'Coronal');
  p.folderId = 'm'; context = S.resolveContext(p, f.folders, f.projects);
  assert.equal(context.assessment.status, 'MOVED'); assert.equal(context.project.normalizationBinding.groupId, null);
  assert.equal(saved.includes('uuid-c'), true);
});

test('null binding is moved; unavailable hierarchy preserves an unbound standalone snapshot', () => {
  const f = fixture(); const p = f.projects[0]; profile(p);
  p.normalizationBinding = null;
  assert.equal(S.assess(p, null).status, 'MOVED');
  assert.equal(S.resolveContext(p).assessment.status, 'MOVED');
  delete p.normalizationBinding;
  let context = S.resolveContext(p);
  assert.equal(context.assessment.status, 'CURRENT'); assert.equal(context.assessment.membershipVerified, false);
  assert.equal(Object.prototype.hasOwnProperty.call(context.project, 'normalizationBinding'), false);
  context = S.resolveContext(p, []);
  assert.equal(context.assessment.status, 'MOVED', 'an available empty hierarchy proves the group is absent');
  assert.equal(context.project.normalizationBinding.groupId, null);
});

test('simple scoped profiles preserve actual-folder context and detect mixed schema or methods with identical IDs', () => {
  const f = fixture();
  for (const p of f.projects.slice(0, 2)) profile(p, ['a', 'b'], { schemaVersion: 3, methodVersion: '2.0.0', mode: 'simple' });
  const group = () => S.buildGroups(f.projects, f.folders).groups.find(g => g.folderId === 'c');
  const before = JSON.stringify(f.projects[0].normalization);
  assert.equal(S.resolveContext(f.projects[0], f.folders, f.projects).assessment.status, 'CURRENT');
  f.projects[1].normalization.schemaVersion = 2;
  assert.equal(S.assess(f.projects[0], group()).status, 'MIXED');
  f.projects[1].normalization.schemaVersion = 3;
  f.projects[1].normalization.methodVersion = 'future';
  assert.equal(S.assess(f.projects[0], group()).status, 'MIXED');
  f.projects[1].normalization.methodVersion = '2.0.0';
  f.projects[1].normalization.mode = 'advanced';
  assert.equal(S.assess(f.projects[0], group()).status, 'MIXED');
  f.projects[0].folderId = 's';
  assert.equal(S.resolveContext(f.projects[0], f.folders, f.projects).assessment.status, 'MOVED');
  assert.equal(JSON.stringify(f.projects[0].normalization), before);
});
