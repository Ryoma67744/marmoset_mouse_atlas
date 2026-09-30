'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function cloud() {
  const context = { console, setTimeout, clearTimeout, AbortController }; context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/cloud.js'), 'utf8'), context);
  return context.Cloud;
}

test('synchronization state matches the JSON wire format without mutating local settings', () => {
  const c = cloud();
  const state = { layerDisplay: { HE_Stain: { rawRange: undefined, normalizedRange: null,
    vmin: 0, applyOpacity: false, label: '' } }, alignment: { autoAligned: undefined },
    values: [undefined, , 0, false, null] };
  const before = structuredClone(state), json = JSON.parse(JSON.stringify(state));
  assert.deepEqual(JSON.parse(JSON.stringify(c.serializableState(state))), json);
  assert.equal(c.hashSyncState(state), c.hashState(json));
  assert.equal(c.sameSyncState(state, json), true);
  assert.deepEqual(state, before);
  assert.equal(Object.hasOwn(state.layerDisplay.HE_Stain, 'rawRange'), true);
  // The old profile/general-purpose hash retains its historic semantics.
  assert.equal(c.hashState({ x: undefined }), c.hashState({ x: null }));
  assert.notEqual(c.hashState({ x: undefined }), c.hashState({}));
});

test('explicit null, zero, false, empty string and array order remain meaningful', () => {
  const c = cloud();
  for (const value of [null, 0, false, '', [], {}]) {
    assert.equal(c.sameSyncState({ setting: value }, {}), false);
  }
  assert.equal(c.sameSyncState({ a: 1, b: { x: 2, y: 3 } }, { b: { y: 3, x: 2 }, a: 1 }), true);
  assert.equal(c.sameSyncState({ a: [1, 2] }, { a: [2, 1] }), false);
  assert.equal(c.sameSyncState({ a: [undefined] }, { a: [null] }), true);
  assert.equal(c.sameSyncState({ a: [undefined] }, { a: [] }), false);
});

test('wire conversion preserves historic hashes for already serialized cloud states', () => {
  const c = cloud();
  const state = { rotation: { all: 90, msi: -180 }, normalization: { id: 'profile', revision: 2,
    section: { k: 3.25 }, reference: null }, futureSetting: { enabled: true } };
  assert.equal(c.hashSyncState(state), c.hashState(state));
  assert.equal(c.sameSyncState(state, c.stateOf(state)), false);
});

test('unserializable settings fail instead of being silently acknowledged', () => {
  const c = cloud(), cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => c.serializableState(cyclic), /circular/i);
  assert.throws(() => c.hashSyncState({ value: 1n }), /BigInt/i);
});
