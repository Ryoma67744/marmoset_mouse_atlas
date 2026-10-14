'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(ratio = 1) {
  const window = { devicePixelRatio: ratio };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'intensity-boxplot.js'), 'utf8'), { window });
  const calls = [];
  const ctx = { measureText: text => ({ width: Array.from(text).length * 6 }) };
  for (const method of ['setTransform', 'fillRect', 'strokeRect', 'fillText', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'save', 'restore', 'translate', 'rotate', 'rect', 'clip', 'arc', 'fill']) {
    ctx[method] = (...args) => calls.push({ method, args, fillStyle: ctx.fillStyle, lineWidth: ctx.lineWidth });
  }
  const attributes = {};
  const canvas = { style: {}, setAttribute: (key, value) => { attributes[key] = value; }, getContext: () => ctx,
    getBoundingClientRect: () => ({ left: -110, top: 80, width: parseFloat(canvas.style.width) / 2, height: parseFloat(canvas.style.height) / 2 }) };
  return { draw: window.IntensityBoxPlot.draw, canvas, calls, attributes };
}

function distribution(overrides) {
  return Object.assign({ n: 5, min: 0, max: 4, q1: 1, median: 2, q3: 3, whiskerLow: 0, whiskerHigh: 3.96,
    points: [{ value: 0, rank: 0 }, { value: 2, rank: 2 }, { value: 3.96, rank: 3 }, { value: 4, rank: 4 }] }, overrides);
}

test('domain includes full outlier range even when display points have been sampled', () => {
  const { draw, canvas, calls } = setup(2);
  const result = draw(canvas, { width: 600, title: '5-HT', unit: 'Ratio (5-HT / D4-5-HT)', rois: [{ key: 'a', name: 'A', distribution: distribution({ max: 1000, points: [{ value: 2, rank: 2 }], sampled: true }) }] });
  assert.ok(result.domain[1] >= 1000);
  assert.equal(canvas.width, 1200);
  assert.equal(canvas.height, 640);
  assert.deepEqual(calls.find(call => call.method === 'setTransform').args, [2, 0, 0, 2, 0, 0]);
  assert.ok(calls.some(call => call.method === 'fillText' && call.args[0] === '5-HT'));
});

test('P99 ties are blue and upper-tail points are red; ROI selection keeps point colors', () => {
  const { draw, canvas, calls } = setup();
  draw(canvas, { width: 600, rois: [{ key: 'a', name: 'A', distribution: distribution() }], highlightRoiKey: 'a' });
  const fills = calls.filter(call => call.method === 'fill');
  assert.deepEqual(fills.map(call => call.fillStyle), ['#2496ed', '#2496ed', '#2496ed', '#f08080']);
  assert.ok(calls.some(call => call.method === 'strokeRect' && call.lineWidth > 1.5));
});

test('missing distributions never produce a point or zero-valued box', () => {
  const { draw, canvas, calls, attributes } = setup();
  draw(canvas, { rois: [{ key: 'a', name: 'Empty ROI', distribution: null }] });
  assert.equal(calls.filter(call => call.method === 'arc').length, 0);
  assert.equal(calls.filter(call => call.method === 'strokeRect').length, 0);
  assert.ok(calls.some(call => call.method === 'fillText' && call.args[0] === 'データなし'));
  assert.match(attributes['aria-label'], /Empty ROI: データなし/);
});

test('negative, zero, constant, and very large finite values keep finite drawing coordinates', () => {
  for (const value of [-1e308, -5, 0, 5, 1e308]) {
    const { draw, canvas, calls } = setup();
    const d = distribution({ n: 1, min: value, max: value, q1: value, median: value, q3: value,
      whiskerLow: value, whiskerHigh: value, points: [{ value, rank: 0 }] });
    const { domain } = draw(canvas, { rois: [{ key: 'a', distribution: d }] });
    assert.ok(domain[0] <= value && domain[1] >= value && domain[0] < domain[1]);
    for (const call of calls) for (const arg of call.args) if (typeof arg === 'number') assert.ok(Number.isFinite(arg), call.method + ' has non-finite coordinate for ' + value);
  }
});

test('clicks account for scroll offsets and CSS scale and use current ROI after redraw', () => {
  const { draw, canvas } = setup(2);
  const selected = [];
  const options = { width: 600, rois: [{ key: 'a', distribution: distribution() }, { key: 'b', distribution: distribution() }], onSelect: key => selected.push(key) };
  let result = draw(canvas, options);
  const click = group => canvas.onclick({ clientX: -110 + group.center / 2, clientY: 80 + 100 / 2 });
  click(result.groups[1]);
  assert.deepEqual(selected, ['b']);
  result = draw(canvas, Object.assign({}, options, { rois: [{ key: 'c', distribution: distribution() }] }));
  click(result.groups[0]);
  assert.deepEqual(selected, ['b', 'c']);
  canvas.onclick({ clientX: -110, clientY: 80 });
  assert.equal(selected.length, 2, 'title and axes do not select an ROI');
  draw(canvas, { rois: [] });
  assert.equal(canvas.onclick, null);
});

test('jitter for a given ROI is stable when other ROIs are hidden', () => {
  const { draw, canvas, calls } = setup();
  const a = { key: 'a', distribution: distribution() }, b = { key: 'b', distribution: distribution() };
  const first = draw(canvas, { width: 600, rois: [a, b] });
  const firstPositions = calls.filter(call => call.method === 'arc').slice(4).map(call => call.args[0] - first.groups[1].center);
  calls.length = 0;
  const second = draw(canvas, { width: 420, rois: [b] });
  const secondPositions = calls.filter(call => call.method === 'arc').map(call => call.args[0] - second.groups[0].center);
  for (let i = 0; i < firstPositions.length; i++) assert.ok(Math.abs(firstPositions[i] - secondPositions[i]) < 1e-10);
});

test('many ROI groups receive a scrollable width and long labels are abbreviated', () => {
  const { draw, canvas, calls, attributes } = setup();
  const rois = Array.from({ length: 12 }, (_, index) => ({ key: String(index), name: 'Very long ROI name for the full numeric table ' + index, distribution: distribution() }));
  const result = draw(canvas, { width: 350, rois });
  assert.ok(result.width >= 1310);
  assert.ok(calls.some(call => call.method === 'fillText' && call.args[0].endsWith('…')));
  assert.match(attributes['aria-label'], /Very long ROI name for the full numeric table 11/);
});

test('compact height preserves DPR, finite geometry and current selection hit testing', () => {
  const { draw, canvas, calls } = setup(2), selected = [];
  const result = draw(canvas, { width: 420, height: 228,
    rois: [{ key: 'compact', distribution: distribution() }], onSelect: key => selected.push(key) });
  assert.equal(result.height, 228);
  assert.equal(canvas.height, 456);
  assert.equal(canvas.style.height, '228px');
  canvas.onclick({ clientX: -110 + result.groups[0].center / 2, clientY: 80 + 100 / 2 });
  assert.deepEqual(selected, ['compact']);
  for (const call of calls) for (const arg of call.args) if (typeof arg === 'number') assert.ok(Number.isFinite(arg));
  assert.equal(draw(canvas, { height: 0 }).height, 228);
  assert.equal(draw(canvas, { height: NaN }).height, 320);
  assert.equal(draw(canvas, {}).height, 320);
});
