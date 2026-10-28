'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'intensity-order.js'), 'utf8'), { window });
const { sortByValue } = window.IntensityOrder;

test('numeric display sorting preserves finite zeroes, stable ties and unavailable entries without coercion or mutation', () => {
  const values = [null, -1e308, undefined, 0, 20, Infinity, 20, NaN, 1e308, '100', -Infinity];
  const items = Object.freeze(values.map((value, id) => Object.freeze({ id, value })));
  const calls = [];
  const result = sortByValue(items, item => { calls.push(item.id); return item.value; });
  assert.deepEqual(Array.from(result, item => item.id), [8, 4, 6, 3, 1, 0, 2, 5, 7, 9, 10]);
  assert.notEqual(result, items);
  assert.deepEqual(items.map(item => item.value), values);
  assert.deepEqual(calls, items.map(item => item.id), 'compute each numeric key once');
  for (const item of result) assert.equal(item, items[item.id], 'keep source objects and keys');
  assert.deepEqual(Array.from(sortByValue([], item => item.value)), []);
});
