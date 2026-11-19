/* Public, precomputed ST counts. Source catalogs distinguish an unavailable gene from zero. */
(function (global) {
  'use strict';
  const scriptUrl = global.document?.currentScript?.src || global.location?.href;
  const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
  const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
  const CACHE_SHARDS = 16;
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const geneName = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
  function invalid(message, code = 'INVALID_ST_DATA') {
    const error = new Error('STデータを確認できません：' + message); error.code = code; return error;
  }
  function check(condition, message) { if (!condition) throw invalid(message); }
  function geneList(value, label) {
    check(Array.isArray(value) && value.length > 0 && value.length <= 100000 && value.every(geneName), label);
    check(new Set(value).size === value.length, label + 'に重複があります');
    return value.slice();
  }
  function categorical(value, n, label) {
    check(record(value) && Array.isArray(value.categories) && value.categories.length > 0 &&
      value.categories.every(name => typeof name === 'string' && name.length > 0) &&
      new Set(value.categories).size === value.categories.length &&
      Array.isArray(value.values) && value.values.length === n &&
      value.values.every(index => Number.isInteger(index) && index >= 0 && index < value.categories.length), label);
    return { categories: value.categories.slice(), values: value.values.slice() };
  }
  async function boundedBytes(stream, maximum, expected) {
    check(stream && typeof stream.getReader === 'function', '読み取りストリームがありません');
    const reader = stream.getReader(), parts = []; let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        total += value.byteLength;
        if (total > maximum || (expected !== undefined && total > expected)) {
          await reader.cancel(); throw invalid('ファイルのサイズが一致しません');
        }
        parts.push(value);
      }
    } finally { reader.releaseLock(); }
    check(expected === undefined || total === expected, 'ファイルが途中で切れています');
    const result = new Uint8Array(total); let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
    return result;
  }
  function create(manifest, options = {}) {
    check(record(manifest) && manifest.format === 'marmoset-st-unified-v1' && /^T\d+$/.test(manifest.id) &&
      manifest.valueType === 'RNA counts', '切片とカウントの形式');
    const n = manifest.n;
    check(Number.isSafeInteger(n) && n > 0 && n <= 1000000, '空間bin数');
    check(Array.isArray(manifest.x) && Array.isArray(manifest.y) && manifest.x.length === n &&
      manifest.y.length === n && manifest.x.every(Number.isSafeInteger) && manifest.y.every(Number.isSafeInteger), '空間座標');
    check(new Set(manifest.x.map((x, i) => x + ',' + manifest.y[i])).size === n, '空間座標に重複があります');
    const genes = geneList(manifest.genes, '切片の遺伝子一覧'), geneSet = new Set(genes);
    check(Array.isArray(manifest.sources) && manifest.sources.length > 0 && manifest.sources.length <= 32, 'データ由来');
    const binSources = new Uint8Array(n), sourceIds = new Set(), sourceGeneSets = [], sourceUnion = new Set();
    let nextOffset = 0;
    const sources = manifest.sources.map((source, sourceIndex) => {
      check(record(source) && typeof source.id === 'string' && source.id.length > 0 && !sourceIds.has(source.id) &&
        typeof source.label === 'string' && source.label.length > 0 && source.offset === nextOffset &&
        Number.isSafeInteger(source.n) && source.n > 0 && source.n <= n - nextOffset, 'データ由来とbinの対応');
      const sourceGenes = geneList(source.genes, source.id + 'の遺伝子一覧');
      sourceIds.add(source.id); sourceGeneSets.push(new Set(sourceGenes));
      for (const gene of sourceGenes) { check(geneSet.has(gene), '由来別の遺伝子一覧が切片一覧と異なります'); sourceUnion.add(gene); }
      binSources.fill(sourceIndex, nextOffset, nextOffset + source.n); nextOffset += source.n;
      return { ...source, genes: sourceGenes };
    });
    check(nextOffset === n && sourceUnion.size === genes.length, '由来別のbin数または遺伝子一覧が一致しません');
    const section = { id: manifest.id, n, valueType: manifest.valueType,
      x: manifest.x.slice(), y: manifest.y.slice(),
      region: categorical(manifest.region, n, '領域注釈'), layer: categorical(manifest.layer, n, '皮質層注釈'),
      sources, scope: sources.length === 1 && sources[0].id === 'Cortex' ? 'cortex' : 'cortex_plus_available_subcortex', provenance: manifest.provenance };
    section.bounds = [Infinity, -Infinity, Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      section.bounds[0] = Math.min(section.bounds[0], section.x[i]); section.bounds[1] = Math.max(section.bounds[1], section.x[i]);
      section.bounds[2] = Math.min(section.bounds[2], section.y[i]); section.bounds[3] = Math.max(section.bounds[3], section.y[i]);
    }
    check(record(manifest.geneChunks) && record(manifest.chunks) && record(manifest.initialGenes), '遺伝子ファイル一覧');
    check(Object.keys(manifest.geneChunks).length === genes.length, '遺伝子ファイルの対応数');
    const chunkGenes = new Map(), geneChunks = new Map(), chunks = new Map();
    for (const gene of genes) {
      check(own(manifest.geneChunks, gene), gene + 'のファイルがありません');
      const filename = manifest.geneChunks[gene];
      check(typeof filename === 'string' && /^chunk-\d{3,5}\.json\.gz$/.test(filename) && own(manifest.chunks, filename), '遺伝子ファイルのパス');
      geneChunks.set(gene, filename);
      if (!chunkGenes.has(filename)) chunkGenes.set(filename, new Set());
      chunkGenes.get(filename).add(gene);
    }
    check(Object.keys(manifest.chunks).length === chunkGenes.size, '遺伝子ファイル一覧の数');
    for (const filename of chunkGenes.keys()) {
      const chunk = manifest.chunks[filename];
      check(record(chunk) && /^[0-9a-f]{64}$/.test(chunk.sha256) && Number.isSafeInteger(chunk.bytes) &&
        chunk.bytes > 0 && chunk.bytes <= MAX_COMPRESSED_BYTES, '遺伝子ファイルの検証情報');
      chunks.set(filename, { sha256: chunk.sha256, bytes: chunk.bytes });
    }
    const hasGeneAt = (gene, index) => sourceGeneSets[binSources[index]].has(gene);
    const initialGenes = Object.create(null);
    for (const [gene, values] of Object.entries(manifest.initialGenes)) {
      check(geneSet.has(gene) && Array.isArray(values) && values.length === n, '初期遺伝子の配列');
      for (let i = 0; i < n; i++) check(hasGeneAt(gene, i) ? Number.isSafeInteger(values[i]) && values[i] >= 0 : values[i] === null,
        '初期値の未収録とカウントの対応');
      initialGenes[gene] = values.slice();
    }
    const baseUrl = options.baseUrl ? new URL(options.baseUrl, scriptUrl) : new URL('data/t462/', scriptUrl);
    check(['http:', 'https:', 'file:'].includes(baseUrl.protocol), 'データの取得先');
    const fetcher = options.fetch || global.fetch?.bind(global);
    const cache = new Map(), requests = new Map();
    function validateChunk(payload, filename) {
      const expectedGenes = chunkGenes.get(filename);
      check(record(payload) && payload.format === 'marmoset-st-counts-v1' && payload.section === section.id &&
        payload.n === n && record(payload.genes) && Object.keys(payload.genes).length === expectedGenes.size, '遺伝子ファイルの切片・サイズ');
      const result = new Map();
      for (const gene of expectedGenes) {
        check(own(payload.genes, gene), '遺伝子ファイル内の遺伝子一覧');
        const sparse = payload.genes[gene];
        check(record(sparse) && Array.isArray(sparse.deltaIndices) && !own(sparse, 'indices') && Array.isArray(sparse.values) &&
          sparse.deltaIndices.length === sparse.values.length && sparse.deltaIndices.length <= n, gene + 'の疎配列');
        const indices = new Uint32Array(sparse.deltaIndices.length);
        let index = 0;
        for (let k = 0; k < sparse.deltaIndices.length; k++) {
          const delta = sparse.deltaIndices[k], value = sparse.values[k];
          check(Number.isSafeInteger(delta) && (k === 0 ? delta >= 0 : delta > 0), gene + 'の座標差分');
          index += delta;
          check(Number.isSafeInteger(index) && index < n && Number.isSafeInteger(value) && value > 0 &&
            hasGeneAt(gene, index), gene + 'のカウントと座標の対応');
          indices[k] = index;
        }
        result.set(gene, { indices, values: sparse.values });
      }
      return result;
    }
    async function loadChunk(filename) {
      if (cache.has(filename)) { const cached = cache.get(filename); cache.delete(filename); cache.set(filename, cached); return cached; }
      if (requests.has(filename)) return requests.get(filename);
      const pending = Promise.resolve().then(async () => {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
        try {
          check(typeof fetcher === 'function' && global.crypto?.subtle && typeof DecompressionStream === 'function', 'このブラウザーのデータ読み込み機能');
          const response = await fetcher(new URL(filename, baseUrl).href, { signal: controller.signal, credentials: 'omit', redirect: 'error' });
          if (!response.ok) throw invalid('遺伝子ファイルを取得できません（' + response.status + '）', 'ST_FETCH_FAILED');
          const expected = chunks.get(filename), bytes = await boundedBytes(response.body, MAX_COMPRESSED_BYTES, expected.bytes);
          const digest = Array.from(new Uint8Array(await global.crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
          check(digest === expected.sha256, '遺伝子ファイルの検証値が一致しません');
          const expanded = await boundedBytes(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')), MAX_EXPANDED_BYTES);
          const result = validateChunk(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(expanded)), filename);
          cache.set(filename, result);
          while (cache.size > CACHE_SHARDS) cache.delete(cache.keys().next().value);
          return result;
        } catch (error) {
          if (error.name === 'AbortError') throw invalid('取得がタイムアウトしました。再試行できます。', 'ST_FETCH_TIMEOUT');
          throw error;
        } finally { clearTimeout(timer); }
      }).finally(() => requests.delete(filename));
      requests.set(filename, pending);
      return pending;
    }
    function dense(gene, sparse) {
      const values = new Array(n).fill(null);
      for (let i = 0; i < sources.length; i++) if (sourceGeneSets[i].has(gene)) values.fill(0, sources[i].offset, sources[i].offset + sources[i].n);
      for (let k = 0; k < sparse.indices.length; k++) values[sparse.indices[k]] = sparse.values[k];
      return values;
    }
    async function fetchGenes(requested) {
      check(Array.isArray(requested) && requested.every(geneName), '要求する遺伝子一覧');
      const result = Object.create(null);
      await Promise.all([...new Set(requested)].map(async gene => {
        if (!geneSet.has(gene)) { result[gene] = { status: 'unavailable' }; return; }
        if (own(initialGenes, gene)) { result[gene] = { status: 'ready', values: initialGenes[gene].slice() }; return; }
        const chunk = await loadChunk(geneChunks.get(gene));
        result[gene] = { status: 'ready', values: dense(gene, chunk.get(gene)) };
      }));
      return result;
    }
    return { section, genes, initialGenes, fetchGenes,
      sourceAt: index => Number.isInteger(index) && index >= 0 && index < n ? sources[binSources[index]] : null };
  }
  // The T503 bootstrap already holds coordinates and initial maps. Bind its
  // ordered catalog to the shard index before resolving any gene by position.
  async function createCortical(viewer, catalog, index, options = {}) {
    check(viewer?.id === 'T503' && index?.section === viewer.id && index.nBins === viewer.x.length &&
      index.nGenes === catalog.length && Number.isSafeInteger(index.genesPerChunk) &&
      index.genesPerChunk > 0, '皮質カウントの切片・サイズ');
    const bytes = new TextEncoder().encode(JSON.stringify(catalog));
    check(global.crypto?.subtle, '遺伝子一覧の検証機能');
    const hash = new Uint8Array(await global.crypto.subtle.digest('SHA-256', bytes));
    check(Array.from(hash, b => b.toString(16).padStart(2, '0')).join('') === index.catalogSha256,
      '皮質カウントの遺伝子順序');
    const geneChunks = Object.fromEntries(catalog.map((gene, i) =>
      [gene, 'chunk-' + String(Math.floor(i / index.genesPerChunk)).padStart(3, '0') + '.json.gz']));
    return create({
      format: 'marmoset-st-unified-v1', id: viewer.id, n: index.nBins, valueType: 'RNA counts',
      x: viewer.x, y: viewer.y, region: viewer.region, layer: viewer.layer, genes: catalog,
      sources: [{ id: 'Cortex', label: '皮質', offset: 0, n: index.nBins, genes: catalog }],
      initialGenes: viewer.genes, chunks: index.chunks, geneChunks,
      provenance: { sourceUrl: index.sourceUrl, sourceSha256: index.sourceSha256 }
    }, { baseUrl: 'data/t503/', ...options });
  }
  const api = Object.freeze({ create, createCortical });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.MsiStData = api;
})(typeof window === 'object' ? window : globalThis);
