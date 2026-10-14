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

test('wrapped rows share the full channel axis while drawing and selecting only their own groups', () => {
  const first = setup(), second = setup();
  const low = { key: 'low', distribution: distribution() };
  const high = { key: 'high', distribution: distribution({ max: 1000 }) };
  const axisRois = [low, high];
  const selected = [];
  const left = first.draw(first.canvas, { width: 350, height: 360, fitWidth: true,
    rois: [low], axisRois, onSelect: key => selected.push(key) });
  const right = second.draw(second.canvas, { width: 350, height: 360, fitWidth: true,
    rois: [high], axisRois });
  assert.deepEqual(Array.from(left.domain), Array.from(right.domain));
  assert.ok(left.domain[1] >= 1000, 'a later row determines the shared upper limit');
  assert.equal(left.groups.length, 1);
  assert.equal(first.calls.filter(call => call.method === 'strokeRect').length, 1);
  assert.equal(first.calls.filter(call => call.method === 'arc').length, low.distribution.points.length);
  assert.doesNotMatch(first.attributes['aria-label'], /high:/, 'off-row groups only supply the axis');
  assert.deepEqual(first.calls.filter(call => call.method === 'arc').map(call => call.args[1]),
    second.calls.filter(call => call.method === 'arc').map(call => call.args[1]),
    'the same intensities occupy the same y coordinates on both rows');
  first.canvas.onclick({ clientX: -110 + left.groups[0].center / 2, clientY: 80 + 100 / 2 });
  assert.deepEqual(selected, ['low']);
  const independent = first.draw(first.canvas, { rois: [low] });
  assert.ok(independent.domain[1] < 1000, 'the default still derives its scale from visible groups');
});

test('fitWidth fits a narrow row without changing legacy widths, DPR or hit testing', () => {
  const { draw, canvas, calls } = setup(2);
  const roi = { key: 'narrow', distribution: distribution() }, selected = [];
  const result = draw(canvas, { width: 220, height: 360, fitWidth: true,
    rois: [roi], onSelect: key => selected.push(key) });
  assert.equal(result.width, 220);
  assert.equal(canvas.width, 440);
  assert.equal(canvas.height, 720);
  assert.equal(canvas.style.width, '220px');
  assert.ok(result.groups[0].left >= 84 && result.groups[0].right <= 200);
  canvas.onclick({ clientX: -110 + result.groups[0].center / 2, clientY: 80 + 100 / 2 });
  assert.deepEqual(selected, ['narrow']);
  for (const call of calls) for (const arg of call.args) if (typeof arg === 'number') assert.ok(Number.isFinite(arg));
  assert.equal(draw(canvas, { width: 180, fitWidth: true, rois: [roi] }).width, 220);
  assert.equal(draw(canvas, { width: 220, rois: [roi] }).width, 300);
  const rois = Array.from({ length: 4 }, (_, index) => ({ key: String(index), distribution: distribution() }));
  assert.equal(draw(canvas, { width: 460, fitWidth: true, rois }).width, 460);
  assert.equal(draw(canvas, { width: 460, rois }).width, 510);
});

test('explicit finite domain overrides row and full-channel limits without changing 2D defaults', () => {
  const { draw, canvas } = setup();
  const roi = { key: 'a', distribution: distribution({ max: 1000 }) };
  const axisRois = [{ key: 'other-row', distribution: distribution({ max: 10000 }) }];
  const domain = [0, 5];
  const result = draw(canvas, { domain, rois: [roi], axisRois });
  assert.deepEqual(Array.from(result.domain), domain);
  result.domain[1] = 6;
  assert.deepEqual(domain, [0, 5], 'drawing geometry does not alias the caller domain');
  for (const invalid of [[0, 0], [5, 0], [0, Infinity], [NaN, 5], [0, 5, 10], null]) {
    const fallback = draw(canvas, { domain: invalid, rois: [roi], axisRois });
    assert.ok(fallback.domain[1] >= 10000, 'invalid domains retain the full-channel fallback');
  }
  const legacy = draw(canvas, { width: 220, rois: [roi] });
  assert.equal(legacy.height, 320);
  assert.equal(legacy.width, 300);
  assert.ok(legacy.domain[1] >= 1000);
});

test('upper-edge labels use exact supplied population count, not sampled point counts', () => {
  const { draw, canvas, calls, attributes } = setup();
  const name = 'A long complete anatomical ROI name that does not fit its axis slot';
  const d = distribution({ n: 10000, max: 5000, sampled: true, points: [
    { value: 2, rank: 2 }, { value: 1000, rank: 9999 }
  ] });
  const before = JSON.stringify(d);
  const result = draw(canvas, { width: 400, fitWidth: true, domain: [0, 5], compactTitle: true,
    title: 'DA', rois: [{ key: 'long', name, distribution: d, aboveCount: 1234 }] });
  assert.equal(result.outsideCounts.long.above, 1234);
  assert.equal(result.outsideCounts.long.max, 5000);
  assert.equal(calls.filter(call => call.method === 'arc').length, 1);
  assert.ok(calls.some(call => call.method === 'fillText' && call.args[0] === '↑ 1,234画素'));
  assert.ok(calls.some(call => call.method === 'fillText' && call.args[0] === '最大 5000'));
  assert.ok(!calls.some(call => call.method === 'fillText' && call.args[0] === 'DA'), 'compact titles are not duplicated');
  assert.match(attributes['aria-label'], /DA Intensity Box Plot/);
  assert.ok(attributes['aria-label'].includes(name));
  assert.ok(attributes['aria-description'].includes(name));
  assert.match(attributes['aria-description'], /表示範囲 0–5/);
  assert.match(attributes['aria-description'], /1,234画素、最大 5000/);
  assert.match(attributes['aria-description'], /範囲外の値も統計に含みます/);
  assert.equal(JSON.stringify(d), before, 'the renderer leaves statistics and observations unchanged');
});

test('observations beyond either bound are omitted rather than relocated to the visible edges', () => {
  const { draw, canvas, calls } = setup();
  const points = [-100, 0, 2, 5, 100].map((value, rank) => ({ value, rank }));
  const result = draw(canvas, { domain: [0, 5], height: 360, compactTitle: true,
    rois: [{ key: 'a', aboveCount: 1, distribution: distribution({ min: -100, max: 100, points }) }] });
  assert.deepEqual(Array.from(result.domain), [0, 5]);
  const arcs = calls.filter(call => call.method === 'arc');
  assert.equal(arcs.length, 3, 'only the values 0, 2 and 5 are drawn');
  assert.deepEqual(arcs.map(call => call.args[1]), [312, 206.39999999999998, 48]);
  assert.deepEqual(calls.filter(call => call.method === 'fill').map(call => call.fillStyle),
    ['#2496ed', '#2496ed', '#f08080'], 'point colors still use P99, independently of the visible domain');
});

test('missing or invalid supplied counts never become sample-derived count labels', () => {
  const { draw, canvas, calls, attributes } = setup();
  const d = distribution({ max: 1000 });
  for (const aboveCount of [undefined, -1, 1.5, NaN, Infinity, 6]) {
    calls.length = 0;
    const result = draw(canvas, { domain: [0, 3], rois: [{ key: 'a', distribution: d, aboveCount }] });
    assert.equal(result.outsideCounts.a.above, null);
    assert.ok(!calls.some(call => call.method === 'fillText' && call.args[0].startsWith('↑')));
    assert.doesNotMatch(attributes['aria-description'], /画素/);
  }
  draw(canvas, { domain: [0, 3], rois: [{ key: 'a', distribution: d, aboveCount: 2 }] });
  assert.match(attributes['aria-description'], /2画素/);
  calls.length = 0;
  const zero = draw(canvas, { rois: [{ key: 'a', distribution: d, aboveCount: 0 }] });
  assert.equal(zero.outsideCounts.a.above, 0);
  assert.equal(attributes['aria-description'], '', 'redrawing clears the old clipping description');
  assert.ok(!calls.some(call => call.method === 'fillText' && call.args[0].startsWith('↑')));
});

test('upper-edge annotations preserve title space, fitWidth and current ROI hit testing', () => {
  const { draw, canvas, calls } = setup(2);
  const selected = [];
  const result = draw(canvas, { width: 260, height: 400, fitWidth: true, title: 'DA', domain: [0, 5],
    rois: [{ key: 'a', aboveCount: 1, distribution: distribution({ max: 100 }) }],
    onSelect: key => selected.push(key) });
  assert.equal(result.width, 260);
  assert.equal(canvas.width, 520);
  assert.equal(canvas.height, 800);
  const labels = calls.filter(call => call.method === 'fillText');
  assert.equal(labels.find(call => call.args[0] === 'DA').args[2], 22);
  assert.equal(labels.find(call => call.args[0] === '↑ 1画素').args[2], 40);
  assert.equal(labels.find(call => call.args[0] === '最大 100').args[2], 56);
  canvas.onclick({ clientX: -110 + result.groups[0].center / 2, clientY: 80 + 100 / 2 });
  canvas.onclick({ clientX: -110 + result.groups[0].center / 2, clientY: 80 + 40 / 2 });
  assert.deepEqual(selected, ['a'], 'marker text above the chart does not select an ROI');
});

test('explicit domains keep clipped box geometry finite even with extreme finite statistics', () => {
  const { draw, canvas, calls } = setup();
  const d = distribution({ min: -1e308, max: 1e308, q1: -1e308, median: 0, q3: 1e308,
    whiskerLow: -1e308, whiskerHigh: 1e308, points: [{ value: -1e308 }, { value: 0 }, { value: 1e308 }] });
  draw(canvas, { domain: [-1e-200, 1e-200], compactTitle: true, rois: [{ key: 'a', distribution: d }] });
  assert.equal(calls.filter(call => call.method === 'arc').length, 1);
  for (const call of calls) for (const arg of call.args) if (typeof arg === 'number') assert.ok(Number.isFinite(arg), call.method);
});
