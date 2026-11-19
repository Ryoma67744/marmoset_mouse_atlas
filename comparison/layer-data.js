/* Anatomically grouped cortical expression, computed from public raw ST counts. */
(function (global) {
  'use strict';
  const standardLayers = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
  const allowedGroups = [...standardLayers, 'V1', 'V2'];
  const scriptBase = global.document?.currentScript?.src || global.location?.href;
  const datasets = new Set(['T420', 'T430', 'T462', 'T479', 'T503', 'T512']);
  const summaries = new Map();
  const pending = new Map();

  function check(condition) {
    if (!condition) throw new Error('ST層別データの形式またはサイズが一致しません。');
  }

  function validateTest(manifest, contrast, result) {
    const message = '検定結果の対象・検証条件・値が一致しません。';
    function requireTest(ok) { if (!ok) throw new Error(message); }
    requireTest(result?.format === 'marmoset-st-contrast-tests-v1' && result.section === manifest.section &&
      result.contrast === contrast && result.summarySha256 === manifest.dataSha256 &&
      result.sourceSha256 === manifest.sourceSha256);
    const analysis = result.analysis;
    requireTest(analysis?.adjustment === 'BH' && analysis.qcStatus === 'accepted' &&
      ['method', 'modelVersion', 'scope', 'calibration', 'filter'].every(k =>
        typeof analysis[k] === 'string' && analysis[k].trim().length > 0));
    const genes = manifest.genes;
    requireTest(Array.isArray(result.genes) && result.genes.length === genes.length &&
      result.genes.every((gene, i) => gene === genes[i]));
    const { p, q, modelLog2FC } = result;
    requireTest([p, q, modelLog2FC].every(vector => Array.isArray(vector) && vector.length === genes.length));
    const tested = [];
    for (let i = 0; i < genes.length; i++) {
      if (p[i] === null && q[i] === null && modelLog2FC[i] === null) continue;
      requireTest([p[i], q[i], modelLog2FC[i]].every(Number.isFinite) &&
        p[i] >= 0 && p[i] <= 1 && q[i] >= 0 && q[i] <= 1);
      tested.push(i);
    }
    requireTest(tested.length > 0 && tested.length === analysis.nTested);
    tested.sort((a, b) => p[a] - p[b]);
    let bh = 1;
    for (let j = tested.length - 1; j >= 0; j--) {
      const i = tested[j];
      bh = Math.min(bh, p[i] * tested.length / (j + 1));
      requireTest(Math.abs(q[i] - bh) <= 1e-8 * Math.max(bh, Number.MIN_VALUE));
    }
    return result;
  }

  function create(manifest, bytes, testFiles = {}, testErrors = {}) {
    check(manifest && manifest.format === 'marmoset-layer-summary-v1' && datasets.has(manifest.section));
    const { counts, genes, groups } = manifest;
    check(Array.isArray(groups) && groups.length > 0 && groups.every(name => allowedGroups.includes(name)) &&
      new Set(groups).size === groups.length);
    const allLayers = standardLayers.every(name => groups.includes(name));
    const contrasts = allLayers ? standardLayers.slice() : [];
    if (groups.includes('V1') && groups.includes('V2')) contrasts.push('V1');
    const targetIndices = contrasts.map(name => groups.indexOf(name));
    const referenceGroups = contrasts.map(name => name === 'V1' ? [groups.indexOf('V2')] :
      standardLayers.filter(other => other !== name).map(other => groups.indexOf(other)));
    check(Array.isArray(counts) && counts.length === groups.length &&
      counts.every(n => Number.isInteger(n) && n > 0 && n <= 65535) &&
      Number.isInteger(manifest.nBins) && manifest.nBins >= Math.max(...counts) &&
      counts.reduce((sum, n, i) => sum + (standardLayers.includes(groups[i]) ? n : 0), 0) <= manifest.nBins);
    check(Array.isArray(genes) && genes.length > 0 && genes.length <= 100000 &&
      genes.every(g => typeof g === 'string' && g.length > 0) && new Set(genes).size === genes.length);
    const n = genes.length * groups.length;
    const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    check(array.byteLength === 10 * n);
    const data = new DataView(array.buffer, array.byteOffset, array.byteLength);
    const pos = (geneIndex, groupIndex) => geneIndex * groups.length + groupIndex;
    const meanAt = index => data.getFloat64(8 * index, true);
    const detectedAt = index => data.getUint16(8 * n + 2 * index, true);
    for (let i = 0; i < n; i++) {
      const mean = meanAt(i), detected = detectedAt(i);
      check(Number.isFinite(mean) && mean >= 0 && mean <= 10000.000001 &&
        detected <= counts[i % groups.length] && (detected > 0) === (mean > 0));
    }
    const indices = new Map(genes.map((gene, i) => [gene, i]));
    const tests = new Map(), analyses = {};
    for (const [contrast, file] of Object.entries(testFiles)) {
      check(contrasts.includes(contrast));
      try {
        tests.set(contrast, validateTest(manifest, contrast, file));
        analyses[contrast] = file.analysis;
      } catch (error) { testErrors[contrast] = error.message; }
    }

    function measurement(geneIndex, groupIndex) {
      const cell = pos(geneIndex, groupIndex);
      const detected = detectedAt(cell), n = counts[groupIndex];
      return { group: groups[groupIndex], mean: meanAt(cell), detected, n, pct: 100 * detected / n };
    }

    function profile(gene) {
      const geneIndex = indices.get(gene);
      if (geneIndex === undefined) return [];
      return groups.map((group, i) => measurement(geneIndex, i));
    }

    const layers = Object.freeze(standardLayers.filter(layer => groups.includes(layer)));
    function layerRows(layer) {
      if (!layers.includes(layer)) return [];
      const groupIndex = groups.indexOf(layer);
      return genes.map((gene, i) => ({ gene, ...measurement(i, groupIndex) }));
    }

    function row(geneIndex, i) {
      const targetIndex = targetIndices[i], cell = pos(geneIndex, targetIndex);
      const targetMean = meanAt(cell), targetDetected = detectedAt(cell), targetN = counts[targetIndex];
      let referenceMean = 0, referenceDetected = 0, referenceN = 0, referencePct = 0;
      const other = referenceGroups[i];
      for (const j of other) {
        const reference = pos(geneIndex, j), detected = detectedAt(reference);
        // Add the other layers directly: subtracting from a total can erase small positive means.
        referenceMean += meanAt(reference);
        referencePct += 100 * detected / counts[j];
        referenceN += counts[j];
        referenceDetected += detected;
      }
      referenceMean /= other.length;
      referencePct /= other.length;
      let status = 'both_zero', log2FC = null, averageLog2 = null;
      if (targetMean > 0 && referenceMean > 0) {
        status = 'both_positive';
        log2FC = Math.log2(targetMean / referenceMean);
        averageLog2 = (Math.log2(targetMean) + Math.log2(referenceMean)) / 2;
      } else if (targetMean > 0) {
        status = 'target_only';
        log2FC = Infinity;
      } else if (referenceMean > 0) {
        status = 'reference_only';
        log2FC = -Infinity;
      }
      const contrast = contrasts[i], test = tests.get(contrast);
      const hasTest = !!test && test.p[geneIndex] !== null;
      let testStatus = 'not_tested';
      if (hasTest) testStatus = 'validated';
      else if (testErrors[contrast]) testStatus = 'unavailable';
      return {
        gene: genes[geneIndex], contrast, targetMean, targetDetected, targetN,
        targetPct: 100 * targetDetected / targetN, referenceMean, referenceDetected, referenceN,
        referencePct, log2FC, averageLog2, status, p: hasTest ? test.p[geneIndex] : null,
        q: hasTest ? test.q[geneIndex] : null, modelLog2FC: hasTest ? test.modelLog2FC[geneIndex] : null, testStatus
      };
    }

    function compare(gene, contrast) {
      const i = contrasts.indexOf(contrast), geneIndex = indices.get(gene);
      return i === -1 || geneIndex === undefined ? null : row(geneIndex, i);
    }

    function rows(contrast) {
      const i = contrasts.indexOf(contrast);
      return i < 0 ? [] : genes.map((_, geneIndex) => row(geneIndex, i));
    }

    const { genes: catalog, ...meta } = manifest;
    meta.analyses = analyses;
    meta.testErrors = testErrors;
    return { genes: Object.freeze(catalog), groups: Object.freeze(groups), contrasts: Object.freeze(contrasts), meta, layers, layerRows, profile, compare, rows };
  }

  async function verifiedBytes(response, sha) {
    if (!response.ok) throw new Error('ST集計ファイルを読み込めませんでした。');
    const bytes = await response.arrayBuffer();
    if (global.crypto?.subtle) {
      const digest = new Uint8Array(await global.crypto.subtle.digest('SHA-256', bytes));
      check(Array.from(digest, b => b.toString(16).padStart(2, '0')).join('') === sha);
    }
    return bytes;
  }

  async function fetchSummary(section) {
    const url = new URL('data/layer-analysis/' + section.toLowerCase() + '.json', scriptBase);
    const response = await global.fetch(url);
    if (!response.ok) throw new Error('ST層別データの目録を読み込めませんでした。再試行してください。');
    const manifest = await response.json();
    check(manifest?.section === section && /^[a-f0-9]{64}$/.test(manifest.dataSha256) &&
      manifest.dataFile === section.toLowerCase() + '-' + manifest.dataSha256.slice(0, 16) + '.bin');
    const bytes = await verifiedBytes(await global.fetch(new URL(manifest.dataFile, url)), manifest.dataSha256);
    return { url, manifest, bytes, profiles: create(manifest, bytes) };
  }

  function summary(section) {
    if (!summaries.has(section)) {
      const request = fetchSummary(section).catch(error => {
        summaries.delete(section);
        throw error;
      });
      summaries.set(section, request);
    }
    return summaries.get(section);
  }

  async function loadProfiles(section) {
    if (!datasets.has(section)) return null;
    return (await summary(section)).profiles;
  }

  async function retrieve(section) {
    const { url, manifest, bytes, profiles } = await summary(section);
    if (!Object.keys(manifest.tests || {}).length) return profiles;
    const files = {}, errors = {};
    await Promise.all(Object.entries(manifest.tests || {}).map(async ([contrast, ref]) => {
      check(allowedGroups.includes(contrast) && contrast !== 'V2');
      try {
        check(/^[a-f0-9]{64}$/.test(ref.sha256) && ref.file ===
          [section.toLowerCase(), contrast.toLowerCase(), ref.sha256.slice(0, 16)].join('-') + '.json');
        const model = await verifiedBytes(await global.fetch(new URL(ref.file, url)), ref.sha256);
        files[contrast] = JSON.parse(new TextDecoder().decode(model));
      } catch (error) { errors[contrast] = error.message; }
    }));
    return create(manifest, bytes, files, errors);
  }

  function load(section) {
    if (!datasets.has(section)) return Promise.resolve(null);
    if (!pending.has(section)) {
      const request = retrieve(section).then(data => {
        // Keep a valid summary usable during an optional test-file failure,
        // and let an explicit retry re-fetch that contrast.
        if (Object.keys(data.meta.testErrors).length) pending.delete(section);
        return data;
      }).catch(error => { pending.delete(section); throw error; });
      pending.set(section, request);
    }
    return pending.get(section);
  }

  const api = { load, loadProfiles, create };
  global.STLayerData = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
