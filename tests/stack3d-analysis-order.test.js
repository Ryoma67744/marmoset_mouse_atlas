'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'intensity-order.js'), 'utf8'), { window });
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'stack3d', 'analysis.js'), 'utf8'), { window });
const { sortGroupsByMedian, sortGroupsByMean } = window.Stack3DAnalysisUI;

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

test('mean ranking uses existing all-pixel statistics and reverses median order without changing values', () => {
  const groups = Object.freeze([
    Object.freeze({ key: 'skewed ROI', distribution: Object.freeze({ n: 100, median: 1, points: [1, 1] }),
      statistics: Object.freeze({ n: 100, mean: 20, sd: 180 }) }),
    Object.freeze({ key: 'uniform ROI', distribution: Object.freeze({ n: 4, median: 10, points: [10, 10] }),
      statistics: Object.freeze({ n: 4, mean: 10, sd: 0 }) })
  ]);
  const before = JSON.stringify(groups);
  assert.deepEqual(Array.from(sortGroupsByMedian(groups), group => group.key), ['uniform ROI', 'skewed ROI']);
  assert.deepEqual(Array.from(sortGroupsByMean(groups), group => group.key), ['skewed ROI', 'uniform ROI']);
  assert.equal(JSON.stringify(groups), before);
});

test('mean ranking keeps equal means stable and requires valid samples, placing unavailable means last', () => {
  const entry = (key, mean, n = 12) => ({ key, statistics: { n, mean }, distribution: { n: 12, median: 999 } });
  const groups = [entry('first tie', 10), entry('empty', 999, 0), entry('negative', -2), entry('null', null),
    entry('second tie', 10), entry('nan', NaN), entry('missing count', 1000, undefined),
    entry('infinity', Infinity), entry('zero', 0), { key: 'missing statistics' }];
  delete groups[6].statistics.n;
  assert.deepEqual(Array.from(sortGroupsByMean(groups), group => group.key),
    ['first tie', 'second tie', 'zero', 'negative', 'empty', 'null', 'nan', 'missing count', 'infinity', 'missing statistics']);
});
