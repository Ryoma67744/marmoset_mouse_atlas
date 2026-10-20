'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'stack3d', 'analysis.js'), 'utf8'), { window });
const { sortGroupsByMedian } = window.Stack3DAnalysisUI;

test('median ranking is stable, missing values are last, and source statistics are unchanged', () => {
  const entry = (key, median, n = 12) => Object.freeze({ key, distribution: Object.freeze({ median, n }) });
  const groups = Object.freeze([
    entry('first tie', 20), Object.freeze({ key: 'missing', distribution: null }),
    entry('low', -1e308), entry('second tie', 20), entry('nan', NaN),
    entry('high', 1e308), entry('empty', 99, 0), entry('infinite', Infinity)
  ]);
  const before = groups.slice();
  const sorted = sortGroupsByMedian(groups);
  assert.deepEqual(Array.from(sorted, group => group.key),
    ['high', 'first tie', 'second tie', 'low', 'missing', 'nan', 'empty', 'infinite']);
  assert.notEqual(sorted, groups);
  assert.deepEqual(groups, before);
  for (const group of sorted) assert.ok(groups.includes(group), 'display order retains stable source identity');
});

test('ranking uses the full-population median rather than count, mean, maximum or sampled dots', () => {
  const groups = [
    { key: 'large ROI', distribution: { n: 20000, median: 3, max: 1e6, points: [{ value: 100000 }] }, statistics: { mean: 100 } },
    { key: 'small ROI', distribution: { n: 2, median: 10, max: 10, points: [{ value: 1 }] }, statistics: { mean: 10 } }
  ];
  assert.deepEqual(Array.from(sortGroupsByMedian(groups), group => group.key), ['small ROI', 'large ROI']);
});
