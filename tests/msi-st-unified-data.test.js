'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { create } = require('../comparison/st-data.js');
const baseUrl = 'https://example.com/marmoset_mouse_atlas/comparison/data/t462/';
const asPlain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const manifest = { format: 'marmoset-st-unified-v1', id: 'T462', valueType: 'RNA counts', n: 10,
    x: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], y: Array(10).fill(3),
    region: { categories: ['A', 'Tha'], values: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1] },
    layer: { categories: ['L1', '対象外（皮質下）'], values: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1] },
    sources: [{ id: 'Cortex', label: '皮質', offset: 0, n: 6, genes: ['A', 'B', 'Z'] },
      { id: 'Thalamus', label: '視床', offset: 6, n: 4, genes: ['A', 'C', 'Z'] }],
    genes: ['A', 'B', 'C', 'Z'], geneChunks: { B: 'chunk-000.json.gz', C: 'chunk-000.json.gz', A: 'chunk-001.json.gz', Z: 'chunk-001.json.gz' },
    chunks: {}, initialGenes: { A: [0, 3, 0, 0, 0, 0, 0, 6, 0, 0] } };
  const payloads = new Map([
    ['chunk-000.json.gz', { format: 'marmoset-st-counts-v1', section: 'T462', n: 10,
      genes: { B: { deltaIndices: [0, 2], values: [2, 7] }, C: { deltaIndices: [8], values: [9] } } }],
    ['chunk-001.json.gz', { format: 'marmoset-st-counts-v1', section: 'T462', n: 10,
      genes: { A: { deltaIndices: [1, 6], values: [3, 6] }, Z: { deltaIndices: [], values: [] } } }],
  ]), encoded = new Map(), calls = [];
  function pack() {
    for (const [filename, payload] of payloads) {
      const bytes = zlib.gzipSync(JSON.stringify(payload)); encoded.set(filename, bytes);
      manifest.chunks[filename] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    }
  }
  pack();
  async function fetcher(url, options) {
    calls.push({ url, options }); const name = new URL(url).pathname.split('/').pop();
    return encoded.has(name) ? new Response(encoded.get(name)) : new Response('', { status: 404 });
  }
  return { manifest, payloads, encoded, calls, pack, fetcher,
    provider(options = {}) { return create(manifest, { baseUrl, fetch: fetcher, ...options }); } };
}

test('unified coordinates, provenance and initial counts preserve source order and avoid network reads', async () => {
  const f = fixture(), provider = f.provider();
  assert.deepEqual(provider.section.bounds, [0, 9, 3, 3]);
  assert.deepEqual(provider.section.x, f.manifest.x);
  assert.deepEqual(provider.genes, ['A', 'B', 'C', 'Z']);
  assert.equal(provider.sourceAt(0).id, 'Cortex'); assert.equal(provider.sourceAt(6).id, 'Thalamus');
  assert.equal(provider.sourceAt(-1), null); assert.equal(provider.sourceAt(10), null); assert.equal(provider.sourceAt(1.5), null);
  const result = await provider.fetchGenes(['A', 'unknown', '__proto__']);
  assert.deepEqual(result.A.values, f.manifest.initialGenes.A); assert.equal(result.A.status, 'ready');
  assert.deepEqual(asPlain(result.unknown), { status: 'unavailable' });
  assert.deepEqual(asPlain(result.__proto__), { status: 'unavailable' });
  assert.equal(Object.getPrototypeOf(result), null); assert.equal(f.calls.length, 0);
});

test('on-demand delta counts separate measured zero from genes absent in one source', async () => {
  const f = fixture(), provider = f.provider();
  const result = await provider.fetchGenes(['B', 'C', 'Z']);
  assert.deepEqual(result.B.values, [2, 0, 7, 0, 0, 0, null, null, null, null]);
  assert.deepEqual(result.C.values, [null, null, null, null, null, null, 0, 0, 9, 0]);
  assert.deepEqual(result.Z.values, Array(10).fill(0));
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.url.startsWith(baseUrl) && call.options.credentials === 'omit' && call.options.redirect === 'error'));
  result.B.values[0] = 999;
  assert.equal((await provider.fetchGenes(['B'])).B.values[0], 2, 'caller mutation must not change cached source counts');
  assert.equal(f.calls.length, 2);
});

test('concurrent genes in one shard share the in-flight request', async () => {
  const f = fixture(); let resolveGate;
  const gate = new Promise(resolve => { resolveGate = resolve; });
  let fetches = 0;
  const provider = f.provider({ fetch: async (...args) => { fetches++; await gate; return f.fetcher(...args); } });
  const first = provider.fetchGenes(['B']), second = provider.fetchGenes(['C']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 1); resolveGate();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.B.values[2], 7); assert.equal(b.C.values[8], 9); assert.equal(fetches, 1);
});

test('failed fetches and integrity failures are not cached and can be retried', async () => {
  const f = fixture(); let fetches = 0;
  const provider = f.provider({ fetch: async (...args) => {
    fetches++;
    if (fetches === 1) throw Error('Temporary connection error');
    if (fetches === 2) return new Response('', { status: 503 });
    if (fetches === 3) {
      const bytes = Buffer.from(f.encoded.get('chunk-000.json.gz')); bytes[12] ^= 1; return new Response(bytes);
    }
    return f.fetcher(...args);
  } });
  await assert.rejects(provider.fetchGenes(['B']), /Temporary connection/);
  await assert.rejects(provider.fetchGenes(['B']), /503/);
  await assert.rejects(provider.fetchGenes(['B']), /検証値/);
  assert.equal((await provider.fetchGenes(['B'])).B.values[2], 7);
  assert.equal(fetches, 4);
});

test('a synchronous fetch error also leaves no stale request cache', async () => {
  const f = fixture(); let calls = 0;
  const provider = f.provider({ fetch: (...args) => { if (calls++ === 0) throw Error('sync failure'); return f.fetcher(...args); } });
  await assert.rejects(provider.fetchGenes(['C']), /sync failure/);
  assert.equal((await provider.fetchGenes(['C'])).C.values[8], 9);
});

test('manifest validation rejects duplicate coordinates, invalid source offsets and ambiguous missing values', () => {
  const changes = [
    m => { m.x[1] = m.x[0]; },
    m => { m.x[0] = .5; },
    m => { m.sources[1].offset = 5; },
    m => { m.sources[1].n = 3; },
    m => { m.sources[1].genes.push('missing-from-union'); },
    m => { m.genes.push('not-in-any-source'); m.geneChunks['not-in-any-source'] = 'chunk-000.json.gz'; },
    m => { m.genes.push('A'); },
    m => { m.layer.values[8] = 3; },
    m => { m.initialGenes.B = Array(10).fill(0); },
    m => { m.initialGenes.A[0] = null; },
    m => { m.initialGenes.A[0] = -1; },
    m => { m.geneChunks.B = '../chunk-000.json.gz'; },
    m => { m.chunks['chunk-000.json.gz'].bytes = 0; },
    m => { m.chunks['chunk-000.json.gz'].sha256 = 'not-a-hash'; },
  ];
  for (const change of changes) { const f = fixture(); change(f.manifest); assert.throws(() => f.provider(), /STデータ/); }
});

test('validated compressed shards still reject wrong sections, catalogs, coordinate deltas and counts', async () => {
  const changes = [
    p => { p.section = 'T430'; },
    p => { p.n = 9; },
    p => { delete p.genes.C; },
    p => { p.genes.extra = { deltaIndices: [], values: [] }; },
    p => { p.genes.B.deltaIndices = [0, 0]; },
    p => { p.genes.B.deltaIndices = [2, -1]; },
    p => { p.genes.B.deltaIndices = [0, .5]; },
    p => { p.genes.B.deltaIndices = [-1, 2]; },
    p => { p.genes.B.deltaIndices = [0, 10]; },
    p => { p.genes.B.deltaIndices = [0, 8]; },
    p => { p.genes.B.deltaIndices = [1, Number.MAX_SAFE_INTEGER]; },
    p => { p.genes.B.values[0] = -1; },
    p => { p.genes.B.values[0] = 0; },
    p => { p.genes.B.values[0] = 1.5; },
    p => { p.genes.B.values.pop(); },
    p => { p.genes.B.indices = [0, 2]; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f.payloads.get('chunk-000.json.gz')); f.pack();
    await assert.rejects(f.provider().fetchGenes(['B']), /STデータ/);
  }
});

test('truncated compressed data is rejected before interpreting it as a zero map', async () => {
  const f = fixture(), bytes = f.encoded.get('chunk-000.json.gz');
  const provider = f.provider({ fetch: async () => new Response(bytes.subarray(0, bytes.length - 1)) });
  await assert.rejects(provider.fetchGenes(['B']), /途中で切れ/);
});

test('the sparse-shard cache retains only sixteen most recently used files', async () => {
  const f = fixture(), genes = Array.from({ length: 17 }, (_, i) => 'G' + i);
  f.payloads.clear(); f.encoded.clear(); f.manifest.chunks = {}; f.manifest.geneChunks = {};
  f.manifest.genes = genes; f.manifest.initialGenes = {};
  for (const source of f.manifest.sources) source.genes = genes.slice();
  for (let i = 0; i < genes.length; i++) {
    const filename = 'chunk-' + String(i).padStart(3, '0') + '.json.gz';
    f.manifest.geneChunks[genes[i]] = filename;
    f.payloads.set(filename, { format: 'marmoset-st-counts-v1', section: 'T462', n: 10,
      genes: { [genes[i]]: { deltaIndices: [0], values: [i + 1] } } });
  }
  f.pack(); const provider = f.provider();
  for (const gene of genes) await provider.fetchGenes([gene]);
  assert.equal(f.calls.length, 17);
  await provider.fetchGenes(['G16']); assert.equal(f.calls.length, 17);
  await provider.fetchGenes(['G0']); assert.equal(f.calls.length, 18);
});
