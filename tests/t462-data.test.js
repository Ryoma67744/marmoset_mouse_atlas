'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const directory = path.join(root, 'comparison/data/t462');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(directory, 'manifest.js'), 'utf8'), context);
const manifest = JSON.parse(JSON.stringify(context.window.MSI_ST_T462));
const expected = [
  ['Cortex', 8407, 29724, 169656337, 47911689, 'T462.h5ad', 'e251aa707c618c9595db702a7823f9f29e6fc625c4cbd7e72ebb924ebe5c7b33'],
  ['Thalamus', 2647, 31738, 26221044, 10503394, 'obj_Thalamus.rds', '3deef89ce3f317f50022cef5e2547bf3c3c8c2acfaefe4fb5ca78c85dadbcfab'],
  ['Striatum', 283, 32226, 3190407, 1220639, 'obj_Striatum.rds', '770b74aa050f192b530246a1aa05729883c4785b9472d9a07b19891bec4aa17c'],
];
const categories = (annotation, count) => {
  assert.equal(annotation.values.length, count);
  assert.equal(new Set(annotation.categories).size, annotation.categories.length);
  assert.ok(annotation.categories.every(value => typeof value === 'string'));
  assert.ok(annotation.values.every(value => Number.isInteger(value) && value >= 0 && value < annotation.categories.length));
  return annotation.values.map(index => annotation.categories[index]);
};
const strictKeys = (value, allowed) => assert.deepEqual(Object.keys(value).sort(), [...allowed].sort());

test('T462 manifest contains only the audited public cortex, thalamus and striatum coordinates', () => {
  strictKeys(manifest, ['format', 'id', 'valueType', 'n', 'x', 'y', 'sources', 'genes', 'geneChunks', 'initialGenes', 'chunks', 'provenance', 'region', 'layer']);
  assert.equal(manifest.format, 'marmoset-st-unified-v1');
  assert.equal(manifest.id, 'T462');
  assert.equal(manifest.valueType, 'RNA counts');
  assert.equal(manifest.n, 11337);
  assert.equal(manifest.x.length, manifest.n);
  assert.equal(manifest.y.length, manifest.n);
  assert.ok([...manifest.x, ...manifest.y].every(Number.isInteger));
  assert.equal(new Set(manifest.x.map((x, i) => x + ',' + manifest.y[i])).size, manifest.n);
  assert.equal(manifest.sources.length, 3);
  let offset = 0;
  for (let i = 0; i < expected.length; i++) {
    const [id, n, genes, counts, nnz, file, sha] = expected[i], source = manifest.sources[i];
    strictKeys(source, ['id', 'label', 'offset', 'n', 'genes', 'sha256', 'url', 'totalCounts', 'nonzeroEntries', 'nCounts', 'nFeatures']);
    assert.equal(source.id, id);
    assert.equal(source.offset, offset);
    assert.equal(source.n, n);
    assert.equal(source.genes.length, genes);
    assert.equal(new Set(source.genes).size, genes);
    assert.ok(source.genes.every(gene => typeof gene === 'string' && gene.length > 0));
    assert.equal(source.totalCounts, counts);
    assert.equal(source.nonzeroEntries, nnz);
    assert.equal(source.sha256, sha);
    assert.equal(source.url, 'https://ftp.cngb.org/pub/SciRAID/stomics/STDS0000395/' + file);
    assert.equal(source.nCounts.length, n);
    assert.equal(source.nFeatures.length, n);
    assert.ok([...source.nCounts, ...source.nFeatures].every(value => Number.isSafeInteger(value) && value >= 0));
    offset += n;
  }
  assert.equal(offset, manifest.n);
  assert.equal(manifest.genes.length, 32891);
  assert.equal(new Set(manifest.genes).size, 32891);
  assert.deepEqual([...new Set(manifest.sources.flatMap(source => source.genes))].sort(), manifest.genes);
  const region = categories(manifest.region, manifest.n), layer = categories(manifest.layer, manifest.n);
  assert.equal(region.slice(8407, 11054).filter(value => value === 'Tha').length, 2023);
  assert.equal(region.slice(8407, 11054).filter(value => value === 'Lgn').length, 624);
  assert.deepEqual([...new Set(region.slice(11054))], ['Cd']);
  assert.deepEqual([...new Set(layer.slice(8407))], ['対象外（皮質下）']);
  strictKeys(manifest.provenance, ['pairedMsiSection', 'scope', 'coordinateTransformApplied', 'msiRegistration',
    'downloadPage', 'paper', 'matrixTypes', 'corticalLayerSource', 'corticalLayerDifferences',
    'countValidation', 'rdsIntegrity', 'limits']);
  strictKeys(manifest.provenance.matrixTypes, ['Cortex', 'Thalamus', 'Striatum']);
  assert.equal(manifest.provenance.scope, 'cortex_plus_available_thalamus_striatum');
  assert.equal(manifest.provenance.coordinateTransformApplied, 'none');
  assert.equal(manifest.provenance.msiRegistration, 'not_registered');
  assert.equal(manifest.provenance.pairedMsiSection, 'Cor_9_3');
  assert.deepEqual(fs.readdirSync(directory).sort(), ['manifest.js', ...Object.keys(manifest.chunks)].sort(),
    'public data directory must contain only the reviewed manifest and count shards');
});

test('T462 keeps all existing cortical points, labels and 20 initial gene vectors exactly', () => {
  const source = fs.readFileSync(path.join(root, 'comparison/bootstrap.js'), 'utf8');
  const encoded = JSON.parse(source.match(/window\.MARMOSET_BOOTSTRAP\s*=\s*("[^"\r\n]+")/)[1]);
  const bootstrap = JSON.parse(zlib.gunzipSync(Buffer.from(encoded, 'base64')));
  const cortex = bootstrap.sections.find(section => section.id === 'T462');
  assert.deepEqual(manifest.x.slice(0, 8407), cortex.x);
  assert.deepEqual(manifest.y.slice(0, 8407), cortex.y);
  for (const label of ['region', 'layer']) {
    assert.deepEqual(categories(manifest[label], manifest.n).slice(0, 8407), categories(cortex[label], 8407));
  }
  assert.deepEqual(Object.keys(manifest.initialGenes).sort(), Object.keys(cortex.genes).sort());
  assert.equal(Object.keys(manifest.initialGenes).length, 20);
  for (const [gene, values] of Object.entries(manifest.initialGenes)) {
    assert.equal(values.length, manifest.n);
    assert.deepEqual(values.slice(0, 8407), cortex.genes[gene]);
    for (const source of manifest.sources) {
      const available = source.genes.includes(gene);
      assert.ok(values.slice(source.offset, source.offset + source.n).every(value => available ? Number.isSafeInteger(value) && value >= 0 : value === null));
    }
  }
  assert.deepEqual(manifest.provenance.corticalLayerDifferences.annotation,
    [{ h5adLabel: 'L2/3/4', viewerLabel: 'L2-Allo', bins: 358 }]);
});

test('every lazy shard preserves public raw counts, source availability, per-bin QC and initial vectors', () => {
  const genes = new Set(manifest.genes), seen = new Set();
  const sourceSets = manifest.sources.map(source => new Set(source.genes));
  const sourceAt = new Uint8Array(manifest.n);
  for (const [i, source] of manifest.sources.entries()) sourceAt.fill(i, source.offset, source.offset + source.n);
  const counts = new Float64Array(manifest.n), features = new Uint32Array(manifest.n);
  const initialSeen = new Set();
  assert.deepEqual(Object.keys(manifest.geneChunks).sort(), manifest.genes);
  for (const [filename, integrity] of Object.entries(manifest.chunks)) {
    assert.match(filename, /^chunk-\d{3}\.json\.gz$/);
    strictKeys(integrity, ['sha256', 'bytes']);
    const bytes = fs.readFileSync(path.join(directory, filename));
    assert.equal(bytes.length, integrity.bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), integrity.sha256);
    const shard = JSON.parse(zlib.gunzipSync(bytes));
    strictKeys(shard, ['format', 'section', 'n', 'genes']);
    assert.equal(shard.format, 'marmoset-st-counts-v1');
    assert.equal(shard.section, 'T462');
    assert.equal(shard.n, manifest.n);
    const expectedGenes = Object.keys(manifest.geneChunks).filter(gene => manifest.geneChunks[gene] === filename);
    assert.deepEqual(Object.keys(shard.genes), expectedGenes);
    for (const [gene, sparse] of Object.entries(shard.genes)) {
      assert.ok(genes.has(gene) && !seen.has(gene));
      seen.add(gene);
      strictKeys(sparse, ['deltaIndices', 'values']);
      assert.equal(sparse.deltaIndices.length, sparse.values.length);
      let previous = -1, index = 0;
      const isInitial = Object.hasOwn(manifest.initialGenes, gene);
      const dense = isInitial ? new Array(manifest.n).fill(null) : null;
      if (isInitial) for (const [i, source] of manifest.sources.entries()) {
        if (sourceSets[i].has(gene)) dense.fill(0, source.offset, source.offset + source.n);
      }
      for (let i = 0; i < sparse.deltaIndices.length; i++) {
        const delta = sparse.deltaIndices[i], value = sparse.values[i];
        assert.ok(Number.isSafeInteger(delta) && (i === 0 ? delta >= 0 : delta > 0), 'nonnegative first index and positive subsequent deltas');
        index += delta;
        assert.ok(Number.isInteger(index) && index > previous && index < manifest.n, 'sorted unique in-range bin indices');
        assert.ok(Number.isSafeInteger(value) && value > 0, 'positive raw RNA count');
        assert.ok(sourceSets[sourceAt[index]].has(gene), 'no value invented for an unavailable source gene');
        counts[index] += value;
        features[index]++;
        if (isInitial) dense[index] = value;
        previous = index;
      }
      if (isInitial) {
        assert.deepEqual(dense, manifest.initialGenes[gene]);
        initialSeen.add(gene);
      }
    }
  }
  assert.equal(seen.size, 32891);
  assert.equal(initialSeen.size, 20);
  for (const [i, source] of manifest.sources.entries()) {
    const totals = [...counts.slice(source.offset, source.offset + source.n)];
    const detected = [...features.slice(source.offset, source.offset + source.n)];
    assert.deepEqual(totals, source.nCounts);
    assert.deepEqual(detected, source.nFeatures);
    assert.equal(totals.reduce((a, b) => a + b, 0), expected[i][3]);
    assert.equal(detected.reduce((a, b) => a + b, 0), expected[i][4]);
  }
});
