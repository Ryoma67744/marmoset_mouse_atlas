'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = { SectionDisplay: { COLORS: {} } }; context.window = context;
vm.createContext(context);
for (const file of ['section-navigation.js', 'stack3d.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), context, { filename: file });
}
const nav = context.SectionNavigation;
const plain = value => JSON.parse(JSON.stringify(value));
const mouse = (number, extra = {}) => ({ id: 'mouse-' + number, displayName: 'Mouse_' + number, plane: 'coronal',
  atlas: { seriesId: 'mouse_tissue_1set', seriesName: 'tissue_1set', species: 'mouse', coordinateMode: 'pixel',
    sectionNumber: number, sourceCandidateId: number === 11 ? 'C028' : 'C' + number }, ...extra });
const cor = (name, id = name) => ({ id, displayName: name });
const remote = project => ({ id: project.id, display_name: project.displayName,
  meta: { atlas: project.atlas, plane: project.plane }, state: {} });

test('shared ordering API has parity with the production Stack3D functions', () => {
  const cases = [null, {}, 'Cor_001-02 (copy)', 'Cor_1_2unknown', cor('Cor_2_3'),
    mouse(11), mouse('12'), mouse(1.5), mouse(2, { plane: 'sagittal' }),
    mouse(3, { atlas: { seriesId: 'other', sectionNumber: true } }), { project: mouse(4) }];
  for (const value of cases) {
    assert.deepEqual(plain(nav.seriesOf(value)), plain(context.Stack3D.seriesOf(value)));
    assert.deepEqual(plain(nav.naturalCor(value)), plain(context.Stack3D.naturalCor(value)));
  }
  const input = [mouse(11), cor('Cor_2_1'), mouse(2), cor('Cor_1_10'), cor('Cor_1_2'),
    mouse(12), { id: 'unknown', displayName: 'Other' }];
  assert.deepEqual(plain(nav.sortCoronal(input)), plain(context.Stack3D.sortCoronal(input)));
});

test('confirmed mouse numbers govern neighbors, not names, candidate IDs or 3D selections', () => {
  const projects = [mouse(12), mouse(11), mouse(10)];
  projects[0].displayName = 'A'; projects[2].displayName = 'Z';
  const result = nav.buildCatalog(projects[1], projects);
  assert.equal(result.status, 'ready'); assert.equal(result.index, 1);
  assert.equal(result.previous.id, 'mouse-10'); assert.equal(result.next.id, 'mouse-12');
  assert.equal(result.items[1].atlas.sourceCandidateId, 'C028');
  assert.equal(result.source, 'local'); assert.equal(result.complete, false);
});

test('legacy names use numeric group and section order and canonical copy names collide', () => {
  const projects = [cor('Cor_2_1'), cor('Cor_1_10'), cor('Cor_1_2'), cor('Other')];
  const result = nav.buildCatalog(projects[1], projects);
  assert.equal(result.previous.displayName, 'Cor_1_2'); assert.equal(result.next.displayName, 'Cor_2_1');
  const duplicate = nav.buildCatalog(projects[2], [...projects, cor('Cor_01_02 (copy)', 'copy')]);
  assert.equal(duplicate.status, 'ambiguous'); assert.equal(duplicate.previous, null); assert.equal(duplicate.next, null);
});

test('the catalogue never crosses series, species or coordinate modes', () => {
  const current = mouse(11), other = mouse(12);
  const projects = [current, mouse(10), cor('Cor_1_1'),
    { ...other, id: 'other-series', atlas: { ...other.atlas, seriesId: 'second-mouse' } },
    { ...other, id: 'other-species', atlas: { ...other.atlas, species: 'marmoset' } },
    { ...other, id: 'other-coordinates', atlas: { ...other.atlas, coordinateMode: 'physical' } }];
  const result = nav.buildCatalog(current, projects);
  assert.deepEqual(plain(result.items.map(item => item.id)), ['mouse-10', 'mouse-11']);
  assert.equal(result.next, null);
});

test('gaps retain the confirmed numbers and endpoints do not wrap', () => {
  const projects = [mouse(1), mouse(7), mouse(48)];
  assert.equal(nav.buildCatalog(projects[0], projects).previous, null);
  assert.equal(nav.buildCatalog(projects[0], projects).next.atlas.sectionNumber, 7);
  assert.equal(nav.buildCatalog(projects[2], projects).previous.atlas.sectionNumber, 7);
  assert.equal(nav.buildCatalog(projects[2], projects).next, null);
});

test('new-PC direct links can navigate remote-only neighbors without loading their rasters', () => {
  const current = mouse(11), rows = [remote(mouse(10)), remote(current), remote(mouse(12))];
  delete rows[2].meta.atlas; rows[2].state.atlas = mouse(12).atlas;
  const result = nav.buildCatalog(current, [current], rows);
  assert.equal(result.status, 'ready'); assert.equal(result.complete, true); assert.equal(result.source, 'cloud-and-local');
  assert.equal(result.previous.localAvailable, false); assert.equal(result.previous.cloudAvailable, true);
  assert.equal(result.items[1].localAvailable, true); assert.equal(result.items[1].cloudAvailable, true);
  assert.equal(result.next.id, 'mouse-12');
});

test('local metadata wins for the same ID and duplicate rows do not create duplicate sections', () => {
  const current = mouse(11), next = mouse(12, { cloudPending: true });
  const old = remote({ ...next, displayName: 'Old name', atlas: { ...next.atlas, sectionNumber: 13 } });
  const result = nav.buildCatalog(current, [current, next], [remote(current), old, old]);
  assert.equal(result.status, 'ready'); assert.equal(result.items.length, 2);
  assert.equal(result.next.displayName, next.displayName); assert.equal(result.next.atlas.sectionNumber, 12);
});

test('an authoritative list removes deleted clean cloud caches but keeps local-only and pending work', () => {
  const current = mouse(11, { cloudUpdatedAt: '2026-10-21' });
  const deleted = mouse(10, { cloudUpdatedAt: '2026-10-20' });
  const localOnly = mouse(12), pending = mouse(13, { cloudUpdatedAt: '2026-10-20', cloudPending: true });
  const projects = [current, deleted, localOnly, pending];
  const result = nav.buildCatalog(current, projects, [remote(current)]);
  assert.deepEqual(plain(result.items.map(item => item.id)), ['mouse-11', 'mouse-12', 'mouse-13']);
  assert.equal(result.previous, null);
  const gone = nav.buildCatalog(current, projects, []);
  assert.equal(gone.status, 'unavailable'); assert.equal(gone.index, -1); assert.equal(gone.next, null);
  const offline = nav.buildCatalog(current, projects, null);
  assert.equal(offline.status, 'ready'); assert.equal(offline.previous.id, deleted.id);
  assert.equal(offline.complete, false);
});

test('offline partial catalogues do not imply that all 48 sections are available', () => {
  const current = mouse(11), result = nav.buildCatalog(current, [current]);
  assert.equal(result.status, 'ready'); assert.equal(result.complete, false);
  assert.equal(result.items.length, 1); assert.equal(result.previous, null); assert.equal(result.next, null);
});

test('different IDs with the same normalized section number disable both directions', () => {
  const current = mouse(11), duplicate = mouse('11', { id: 'copy', displayName: 'Copy' });
  const result = nav.buildCatalog(current, [mouse(10), current, duplicate, mouse(12)]);
  assert.equal(result.status, 'ambiguous'); assert.match(result.reason, /同じ切片番号/);
  assert.equal(result.previous, null); assert.equal(result.next, null);
});

test('unknown current order, absent current IDs and changed current numbers cannot guess neighbors', () => {
  for (const current of [null, cor('Unknown'), mouse(NaN), mouse(1.5), mouse(0), mouse(true)]) {
    const result = nav.buildCatalog(current, [mouse(10), mouse(11), mouse(12)]);
    assert.equal(result.status, 'unavailable'); assert.equal(result.index, -1);
    assert.equal(result.previous, null); assert.equal(result.next, null);
  }
  const absent = nav.buildCatalog(mouse(11), [mouse(10), mouse(12)]);
  assert.equal(absent.status, 'unavailable'); assert.equal(absent.index, -1);
  const changed = nav.buildCatalog(mouse(11), [mouse(10), mouse(12, { id: 'mouse-11' })]);
  assert.equal(changed.status, 'unavailable'); assert.equal(changed.next, null); assert.match(changed.reason, /番号が登録一覧と異なり/);
});

test('catalogue order accepts safe numeric strings but rejects inherited and malformed metadata', () => {
  const current = mouse(11), inheritedNumber = mouse(12, { id: 'inherited' });
  inheritedNumber.atlas = Object.assign(Object.create({ sectionNumber: 12 }), { seriesId: 'mouse_tissue_1set', species: 'mouse', coordinateMode: 'pixel' });
  const inheritedId = Object.assign(Object.create({ id: 'inherited-id' }), { displayName: 'Cor_1_2' });
  const invalid = [inheritedNumber, inheritedId, mouse(Infinity), mouse(Number.MAX_SAFE_INTEGER + 1),
    mouse(true), mouse(''), mouse(' '), mouse('not-a-number'), mouse(14, { plane: 'sagittal' })];
  const result = nav.buildCatalog(current, [current, mouse('12'), ...invalid]);
  assert.deepEqual(plain(result.items.map(item => item.id)), ['mouse-11', 'mouse-12']);
  const inheritedRemote = Object.assign(Object.create({ meta: { atlas: mouse(12).atlas } }), { id: 'remote-inherited', display_name: 'Mouse_12' });
  assert.equal(nav.buildCatalog(current, [current], [inheritedRemote]).items.length, 1);
});

test('building a catalogue does not mutate or retain mutable atlas references from input', () => {
  const current = mouse(11), locals = [mouse(10), current], rows = [remote(current), remote(mouse(12))];
  const before = plain({ current, locals, rows });
  const result = nav.buildCatalog(current, locals, rows);
  assert.deepEqual(plain({ current, locals, rows }), before);
  assert.notEqual(result.items[1].atlas, current.atlas);
  assert.notEqual(result.items[2].atlas, rows[1].meta.atlas);
});
