'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/intensity-axis.js'), 'utf8'), context);
const axis = context.window.IntensityAxis;
const d = (min, whiskerHigh, max = whiskerHigh) => ({ n: 1000, min, whiskerHigh, max });
const domain = distributions => Array.from(axis.autoDomain(distributions));

test('automatic axes share the largest P99, retain minima and exclude irrelevant maxima', () => {
  const groups = [d(0, 100, 1000000), d(10, 400, 9000000)];
  assert.deepEqual(domain(groups), [0, 500]);
  assert.deepEqual(domain(groups.slice().reverse()), [0, 500]);
  assert.deepEqual(domain([d(0, 100)]), [0, 120]);
  const negative = domain([d(-30, 100, 1000000)]);
  assert.ok(negative[0] <= -30 && negative[1] >= 100 && negative[1] < 1000000);
  assert.deepEqual(domain([null, { n: 0, min: -1e9, whiskerHigh: 1e9 }, d(0, 100)]), [0, 120]);
});

test('zero P99 and constant distributions have useful nonzero ranges without restoring outliers', () => {
  assert.deepEqual(domain([d(0, 0, 1e100)]), [0, 1]);
  assert.deepEqual(domain([d(0, 0)]), [0, 1]);
  assert.deepEqual(domain([]), [0, 1]);
  for (const value of [-8, 8]) {
    const range = domain([d(value, value)]);
    assert.ok(range[0] <= value && range[1] >= value && range[0] < range[1]);
  }
});

test('finite extremes, subnormals and negative-only data never create infinite or zero spans', () => {
  for (const [low, high] of [
    [-Number.MAX_VALUE, Number.MAX_VALUE], [-Number.MAX_VALUE, -Number.MAX_VALUE],
    [Number.MAX_VALUE, Number.MAX_VALUE], [-1e308, 1e308], [-5, -1],
    [0, Number.MIN_VALUE], [-Number.MIN_VALUE, -Number.MIN_VALUE],
    [Number.MIN_VALUE, Number.MIN_VALUE], [-Number.MIN_VALUE, Number.MIN_VALUE]
  ]) {
    const range = domain([d(low, high)]);
    assert.ok(range.every(Number.isFinite), String([low, high]));
    assert.ok(range[0] <= low && range[1] >= high && range[0] < range[1], String([low, high, ...range]));
  }
});

test('outside counts use a strict final boundary and preserve ties', () => {
  const values = new Float64Array([100, 100, 120, 120, 121, 10000]);
  assert.equal(axis.countAbove(values, 120), 2);
  assert.equal(axis.countAbove(values, 100), 4);
  assert.equal(axis.countAbove(values, 99), 6);
  assert.equal(axis.countAbove(values, 10000), 0);
  assert.equal(axis.countAbove(new Float64Array(), 0), 0);
});
