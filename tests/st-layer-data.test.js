'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { load, create } = require('../comparison/layer-data.js');
const folder = path.join(__dirname, '../comparison/data/layer-analysis');

function readSection(id) {
  const meta = JSON.parse(fs.readFileSync(path.join(folder, id.toLowerCase() + '.json')));
  const bytes = fs.readFileSync(path.join(folder, meta.dataFile));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), meta.dataSha256);
  const tests = {};
  for (const [contrast, ref] of Object.entries(meta.tests || {})) {
    const content = fs.readFileSync(path.join(folder, ref.file));
    assert.equal(crypto.createHash('sha256').update(content).digest('hex'), ref.sha256);
    tests[contrast] = JSON.parse(content);
  }
  return create(meta, bytes, tests);
}

test('T503 reproduces the reference profile, unweighted layer comparison and whole V1/V2 denominator', () => {
  const ds = readSection('T503');
  assert.equal(ds.genes.length, 30009);
  assert.deepEqual(ds.contrasts, ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'V1']);
  const profile = ds.profile('HTR2A'), l4 = profile.find(g => g.group === 'L4');
  assert.equal(l4.n, 1053);
  assert.equal(l4.detected, 1029);
  assert.ok(Math.abs(l4.mean - 2.2713066699364455) < 1e-12);
  const result = ds.compare('HTR2A', 'L4');
  assert.equal(result.referenceN, 7205 - 1053);
  assert.ok(Math.abs(result.log2FC - 1.46127601878) < 1e-9);
  assert.equal(result.referencePct, profile.slice(0, 6).filter(g => g.group !== 'L4')
    .reduce((sum, g) => sum + g.pct, 0) / 5);
  const whole = ds.compare('HTR2A', 'V1');
  assert.equal(whole.targetN, profile[6].n);
  assert.equal(whole.referenceMean, profile[7].mean);
  assert.equal(whole.testStatus, 'not_tested');
  assert.equal(whole.p, null);
  assert.equal(whole.q, null);
  assert.deepEqual(ds.profile('absent feature'), []);
  assert.equal(ds.compare('HTR2A', 'L7'), null);
});

test('all features remain in each contrast including zero or one-sided expression', () => {
  const ds = readSection('T503');
  const types = new Set();
  for (const c of ds.contrasts) {
    const rows = ds.rows(c);
    assert.equal(rows.length, ds.genes.length);
    for (const r of rows) {
      types.add(r.status);
      if (r.status === 'both_positive') assert.ok(Number.isFinite(r.averageLog2) && Number.isFinite(r.log2FC));
      else {
        assert.equal(r.averageLog2, null);
        assert.equal(r.log2FC, { both_zero: null, target_only: Infinity, reference_only: -Infinity }[r.status]);
      }
    }
  }
  assert.deepEqual(types, new Set(['both_zero', 'both_positive', 'target_only', 'reference_only']));
});

test('incomplete anatomical coverage does not fabricate missing strata or comparisons', async () => {
  const groups = ['L1', 'L2', 'V2'];
  const manifest = { section: 'T479', format: 'marmoset-layer-summary-v1',
    genes: ['a'], nBins: 4, groups, counts: [1, 3, 2] };
  const ds = create(manifest, Buffer.alloc(30));
  assert.deepEqual(ds.contrasts, []);
  assert.deepEqual(ds.profile('a').map(s => s.group), groups);
  assert.deepEqual(ds.rows('V1'), []);
  assert.equal(await load('no such section'), null);
  assert.throws(() => create(manifest, Buffer.alloc(31)), /形式またはサイズ/);
});

test('coverage is specific to the cortical section used in each bundled summary', () => {
  const expected = {
    T420: [4410, 27624, false, false], T430: [6101, 28887, false, false], T462: [8407, 29724, false, false],
    T479: [7964, 29777, false, true], T503: [7205, 30009, true, true], T512: [6225, 29628, true, true]
  };
  for (const [id, [bins, genes, v1, v2]] of Object.entries(expected)) {
    const ds = readSection(id);
    assert.equal(ds.meta.section, id);
    assert.equal(ds.meta.nBins, bins);
    assert.equal(ds.genes.length, genes);
    assert.equal(ds.contrasts.includes('V1'), v1 && v2);
    assert.equal(ds.groups.includes('V1'), v1);
    assert.equal(ds.groups.includes('V2'), v2);
    assert.equal(ds.contrasts.length, v1 && v2 ? 7 : 6);
    assert.equal(ds.meta.testStatus, id === 'T503' ? 'partial' : 'not_tested');
  }
  const t462 = readSection('T462');
  assert.equal(t462.meta.sourceAnnotationMismatches.layer, 358);
  assert.ok(t462.meta.nLayerBins < t462.meta.nBins);
});

test('a model applies only to its own contrast, ordered genes and accepted BH family', () => {
  const manifest = { section: 'T503', format: 'marmoset-layer-summary-v1', genes: ['a', 'b', 'c'],
    groups: ['V1', 'V2'], nBins: 4, counts: [2, 2], dataSha256: 'summary', sourceSha256: 'counts' };
  const bytes = Buffer.alloc(60);
  const model = { format: 'marmoset-st-contrast-tests-v1', section: 'T503', contrast: 'V1',
    summarySha256: 'summary', sourceSha256: 'counts', genes: ['a', 'b', 'c'],
    analysis: { method: 'fixture', scope: 'test only', modelVersion: '1', adjustment: 'BH', filter: 'fixture filter',
      qcStatus: 'accepted', calibration: 'fixture calibration', nTested: 2 },
    p: [0.04, 0.01, null], q: [0.04, 0.02, null], modelLog2FC: [0.1, -0.4, null] };
  const ds = create(manifest, bytes, { V1: model });
  assert.equal(ds.compare('a', 'V1').testStatus, 'validated');
  assert.equal(ds.compare('b', 'V1').modelLog2FC, -0.4);
  assert.equal(ds.compare('b', 'V1').q, 0.02);
  assert.equal(ds.compare('c', 'V1').testStatus, 'not_tested');
  for (const diff of [{ contrast: 'L4' }, { genes: ['c', 'b', 'a'] }, { q: [0.04, 0.01, null] },
    { sourceSha256: 'different' }, { analysis: { ...model.analysis, qcStatus: 'failed' } }]) {
    const stale = create(manifest, bytes, { V1: { ...model, ...diff } });
    assert.ok(stale.meta.testErrors.V1);
    assert.equal(stale.compare('a', 'V1').testStatus, 'unavailable');
    assert.equal(stale.compare('b', 'V1').q, null);
    assert.equal(stale.profile('b').length, 2);
  }
});

test('public T503 model matches the retained spatial calibration and the H5AD summary', () => {
  const ds = readSection('T503');
  assert.deepEqual(Object.keys(ds.meta.testErrors), []);
  assert.deepEqual(Object.keys(ds.meta.analyses), ['L3']);
  const info = ds.meta.analyses.L3;
  const report = fs.readFileSync(path.join(folder, info.reportFile));
  assert.equal(crypto.createHash('sha256').update(report).digest('hex'), info.reportSha256);
  const validation = JSON.parse(report);
  assert.equal(validation.source_sha256, ds.meta.sourceSha256);
  const accepted = Object.entries(validation.results).filter(([, r]) => r.calibration_gate_passed);
  assert.deepEqual(accepted.map(([name]) => name), ['L3_vs_other5']);
  assert.equal(accepted[0][1].calibration.length, 15);
  assert.ok(accepted[0][1].calibration.every(s => s.passes && s.draws === 384));
  const rows = ds.rows('L3');
  const tested = rows.filter(r => r.testStatus === 'validated');
  assert.equal(tested.length, info.nTested);
  assert.equal(tested.length, 20830);
  for (const r of tested) assert.ok(Math.abs(r.log2FC - r.modelLog2FC) < 1e-10);
  const htr = ds.compare('HTR2A', 'L3');
  assert.ok(Math.abs(htr.p - 4.921404527080988e-5) < 1e-13);
  assert.ok(Math.abs(htr.q - 0.0009809842708047559) < 1e-12);
  for (const c of ds.contrasts.filter(c => c !== 'L3')) {
    assert.equal(ds.compare('HTR2A', c).p, null);
    assert.equal(ds.compare('HTR2A', c).q, null);
  }
  assert.equal(ds.compare('SLC17A7', 'L3').testStatus, 'not_tested');
  assert.equal(ds.compare('SLC17A7', 'L3').p, null);
});

test('layer extraction returns one measured row per catalog gene, including zeros and only cortical layers', () => {
  const ds = readSection('T503');
  const l4 = ds.layerRows('L4');
  assert.deepEqual(ds.layers, ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
  assert.deepEqual(l4.map(r => r.gene), ds.genes);
  assert.ok(l4.some(r => r.mean === 0 && r.detected === 0 && r.pct === 0 && r.n === 1053));
  assert.deepEqual(l4.find(r => r.gene === 'HTR2A'), {
    gene: 'HTR2A', group: 'L4', mean: 2.2713066699364455, detected: 1029, n: 1053, pct: 100 * 1029 / 1053,
  });
  assert.deepEqual(ds.layerRows('V1'), []);
  assert.deepEqual(ds.layerRows('L7'), []);
});

test('profiles retry a failed transfer, share concurrent requests, and never require contrast data', async () => {
  const vm = require('node:vm');
  const paths = [];
  let rejectOnce = true;
  const browser = {
    location: { href: 'https://atlas.test/comparison/index.html' },
    crypto: crypto.webcrypto,
    async fetch(url) {
      const name = path.basename(url.pathname);
      paths.push(name);
      if (rejectOnce && name.endsWith('.bin')) {
        rejectOnce = false;
        return new Response(null, { status: 503 });
      }
      return new Response(fs.readFileSync(path.join(folder, name)));
    },
  };
  const code = fs.readFileSync(path.join(__dirname, '../comparison/layer-data.js'), 'utf8');
  vm.runInNewContext(code, { window: browser, URL, TextDecoder });
  const api = browser.STLayerData;
  await assert.rejects(api.loadProfiles('T503'), /読み込めません/);
  const [first, second] = await Promise.all([api.loadProfiles('T503'), api.loadProfiles('T503')]);
  assert.equal(first, second);
  assert.equal(await api.loadProfiles('unknown'), null);
  assert.equal(paths.filter(name => name === 't503.json').length, 2);
  assert.equal(paths.filter(name => name.endsWith('.bin')).length, 2);
  assert.equal(paths.length, 4);
  assert.equal(first.layerRows('L1').length, 30009);
  const full = await api.load('T503');
  assert.equal(paths.length, 5);
  assert.match(paths.at(-1), /^t503-l3-.*\.json$/);
  assert.equal(full.compare('HTR2A', 'L3').testStatus, 'validated');
});
