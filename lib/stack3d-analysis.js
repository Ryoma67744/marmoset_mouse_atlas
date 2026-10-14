/* Read-only intensity analysis of loaded sections. No display or storage state is changed. */
(function (global) {
  'use strict';
  const MODES = ['selected', 'by-section', 'pooled'];
  const CHANNELS = ['DA', 'NE', '5-HT'];
  const MAX_CACHE_ENTRIES = 1024, MAX_CACHE_BYTES = 16 * 1024 * 1024;
  let sectionCache = new WeakMap(), cacheLru = new Map(), cacheBytes = 0;
  const nameOf = value => String(value == null ? '' : value).normalize('NFC').trim();
  const unique = values => Array.from(new Set(values));
  const emptyStatistics = () => ({ mean: null, sd: null, n: 0 });
  const abort = signal => { if (signal && signal.aborted) { const error = new Error('解析を中止しました'); error.name = 'AbortError'; throw error; } };
  const yieldTask = () => typeof global.setTimeout === 'function' ? new Promise(resolve => global.setTimeout(resolve, 0)) : Promise.resolve();

  function parseSelection(text, sections) {
    const count = sections.length, source = String(text == null ? '' : text).trim();
    if (!source) throw new Error('対象切片を指定してください（例：5–20, 24, 30–35）。');
    const selected = new Set();
    for (const token of source.split(/[,、，]/)) {
      const match = token.trim().match(/^(\d+)\s*(?:[-–—−]\s*(\d+))?$/);
      if (!match) throw new Error('切片番号または範囲をカンマで区切って指定してください。');
      const first = Number(match[1]), last = match[2] === undefined ? first : Number(match[2]);
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last > count || last < first) {
        throw new Error(`切片番号は1〜${count}の昇順範囲で指定してください。`);
      }
      for (let i = first; i <= last; i++) selected.add(i);
    }
    const numbers = Array.from(selected).sort((a, b) => a - b);
    return { sectionIds: numbers.map(n => sections[n - 1].id), numbers, count: numbers.length };
  }

  function polygonsFor(section) {
    // roi_show_flags controls 3D presentation, not this independent analysis selection.
    return global.Stack3D.roiPolygons(section).filter(polygon => nameOf(polygon.name));
  }
  function regionCatalog(sections) {
    const found = new Map();
    for (const section of sections) for (const name of unique(polygonsFor(section).map(polygon => nameOf(polygon.name)))) {
      if (!found.has(name)) found.set(name, []);
      found.get(name).push(section.id);
    }
    return Array.from(found, ([name, sectionIds]) => ({ name, sectionIds, sectionCount: sectionIds.length }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function clearCache() { sectionCache = new WeakMap(); cacheLru.clear(); cacheBytes = 0; }
  function forget(entry) {
    if (!cacheLru.delete(entry)) return;
    cacheBytes -= entry.mask.byteLength;
    if (entry.owner.get(entry.name) === entry) entry.owner.delete(entry.name);
  }
  function roiEntry(section, roiName) {
    const polygons = polygonsFor(section).filter(polygon => nameOf(polygon.name) === roiName);
    if (!polygons.length) return null;
    const W = section.W, H = section.H;
    if (!Number.isSafeInteger(W) || !Number.isSafeInteger(H) || W < 1 || H < 1 || W * H > 16777216) throw new Error('切片の画素寸法が不正です。');
    const signature = JSON.stringify([W, H, polygons.map(polygon => polygon.vertices)]);
    let owner = sectionCache.get(section);
    if (!owner) { owner = new Map(); sectionCache.set(section, owner); }
    const old = owner.get(roiName);
    if (old && old.signature === signature && old.rasters === section.rasters && old.evaluation === section.evaluation) {
      cacheLru.delete(old); cacheLru.set(old, true); return old;
    }
    if (old) forget(old);
    const mask = new Uint8Array(W * H);
    for (const polygon of polygons) global.MSIRaster.markRoiMask(mask, W, H, polygon.vertices);
    const rows = global.Normalization.quantifyRoi(section.project, section.rasters, section.evaluation, mask);
    const nGeometry = rows.length ? rows[0].nGeometry : mask.reduce((sum, value) => sum + value, 0);
    const entry = { owner, name: roiName, signature, mask, rows, nGeometry, rasters: section.rasters, evaluation: section.evaluation };
    if (mask.byteLength <= MAX_CACHE_BYTES) {
      owner.set(roiName, entry); cacheLru.set(entry, true); cacheBytes += mask.byteLength;
      while (cacheLru.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) forget(cacheLru.keys().next().value);
    }
    return entry;
  }

  function normalizationCompatibility(parts, valueMode) {
    if (valueMode === 'raw') return { status: 'NOT_APPLICABLE', reasonCodes: [] };
    if (parts.length < 2) return { status: 'SINGLE_SECTION', reasonCodes: [] };
    const signatures = new Set(), reasons = [];
    for (const part of parts) {
      const profile = part.section.evaluation.profile, channel = part.channel;
      if (!profile || !profile.scope || !profile.scope.groupId) {
        reasons.push('NORMALIZATION_SCOPE_UNVERIFIED'); continue;
      }
      if (['MIXED', 'MOVED', 'COMPOSITION_CHANGED', 'UNCONFIGURED'].includes(part.section.scope && part.section.scope.status)) {
        reasons.push('NORMALIZATION_SCOPE_INCOMPATIBLE');
      }
      // Ds and k legitimately differ by section. They must not be equality gates.
      // Raw/geometry fingerprints also describe separate sections, not a shared reference.
      const reference = profile.reference || {};
      const entries = (reference.entries || []).map(entry => ({
        id: entry.memberId || entry.projectId, Ds: entry.Ds,
        rawFingerprint: entry.rawFingerprint, geometryFingerprint: entry.geometryFingerprint
      })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
      signatures.add(global.Normalization.stableStringify({
        schemaVersion: profile.schemaVersion, methodVersion: profile.methodVersion,
        id: profile.id, revision: profile.revision,
        scope: { groupId: profile.scope.groupId, type: profile.scope.type, depth: profile.scope.depth,
          includeDescendants: profile.scope.includeDescendants,
          memberIds: (profile.scope.memberIds || []).slice().sort() },
        method: channel.method, unit: channel.unit, quality: profile.quality,
        qc: profile.qc, batchId: profile.batchId || null, prepId: profile.prepId || null,
        Dref: profile.section && profile.section.Dref,
        reference: { kind: reference.kind, ids: (reference.projectIds || []).slice().sort(),
          roiNames: (reference.roiNames || []).map(nameOf).sort(), entries }
      }));
    }
    if (signatures.size > 1) reasons.push('NORMALIZATION_INCOMPATIBLE');
    return { status: reasons.length ? 'BLOCKED' : 'COMPATIBLE', reasonCodes: unique(reasons) };
  }

  function exclusion(section, code, reasonCodes) {
    return { sectionId: section.id, sectionName: section.name, code, reasonCodes: unique(reasonCodes && reasonCodes.length ? reasonCodes : [code]) };
  }
  function selectedSections(sections, request) {
    const ids = request.sectionIds === undefined ? sections.map(section => section.id) : request.sectionIds;
    if (!Array.isArray(ids)) throw new TypeError('sectionIds must be an array');
    const desired = new Set(ids);
    if (ids.some(id => !sections.some(section => section.id === id))) throw new Error('選択した切片が読み込まれていません。対象を確認してください。');
    const selected = sections.filter(section => desired.has(section.id));
    return request.mode === 'selected' ? selected.slice(0, 1) : selected;
  }

  /**
   * Analyze loaded immutable section snapshots. An optional async summarize(values,
   * {signal,maxPoints,includeUpperTailValues}) hook may transfer its private Float64Array to a Worker;
   * source raster buffers and cached masks are never passed to that hook.
   */
  async function analyze(sections, request, options) {
    options = options || {}; request = Object.assign({ mode: 'selected', valueMode: 'raw', channels: CHANNELS }, request || {});
    if (!MODES.includes(request.mode) || !['raw', 'normalized'].includes(request.valueMode)) throw new TypeError('解析モードが不正です。');
    if (!Array.isArray(request.channels) || request.channels.some(key => !CHANNELS.includes(key))) throw new TypeError('解析分子が不正です。');
    const maxPoints = options.maxPoints === undefined ? 2000 : options.maxPoints;
    if (!Number.isInteger(maxPoints) || maxPoints < 2) throw new RangeError('maxPoints must be at least 2');
    if (!global.IntensityAxis) throw new Error('Load intensity-axis.js before analyzing intensities.');
    abort(options.signal);
    const selected = selectedSections(sections, request), channels = unique(request.channels);
    if (selected.some(section => section.released)) throw new Error('切片データが解放されています。再読込してください。');
    const roiNames = unique((request.roiNames === undefined ? regionCatalog(selected).map(row => row.name) : request.roiNames).map(nameOf)).filter(Boolean);
    if (request.mode === 'by-section' && roiNames.length !== 1) throw new Error('切片別比較ではROIを1つ選択してください。');
    const selection = { sectionIds: selected.map(section => section.id), names: selected.map(section => section.name),
      numbers: selected.map(section => sections.indexOf(section) + 1), count: selected.length };
    const result = { mode: request.mode, valueMode: request.valueMode, selection, roiNames, channels: [] };
    const specifications = request.mode === 'by-section'
      ? selected.map(section => ({ key: section.id, name: section.name, roiName: roiNames[0], sections: [section], sectionId: section.id }))
      : roiNames.map(roiName => ({ key: roiName, name: roiName, roiName, sections: selected,
        ...(request.mode === 'selected' && selected[0] ? { sectionId: selected[0].id } : {}) }));
    let completed = 0;
    const total = specifications.length * channels.length;
    if (options.onProgress) options.onProgress({ completed, total });
    for (const analyte of channels) {
      const output = { key: analyte, name: analyte, unit: request.valueMode === 'raw' ? 'Intensity (a.u.)' : '補正値（単位未確定）',
        status: 'UNAVAILABLE', compatibility: { status: 'NOT_APPLICABLE', reasonCodes: [] }, groups: [] };
      // All groups within one molecular plot share a numerical axis. Verify the whole
      // comparison, including disjoint ROIs that each occur in only one section.
      const comparisonParts = [];
      const temporaryTails = new Map();
      for (const spec of specifications) {
        abort(options.signal);
        const counts = { targetSections: spec.sections.length, roiSections: 0, includedSections: 0,
          nGeometry: 0, nMeasured: 0, nValid: 0, nIncluded: 0 };
        const group = { key: spec.key, name: spec.name, roiName: spec.roiName, sectionIds: spec.sections.map(section => section.id),
          ...(spec.sectionId ? { sectionId: spec.sectionId } : {}), distribution: null, statistics: emptyStatistics(),
          counts, exclusions: [], status: 'UNAVAILABLE', unit: output.unit, warnings: [] };
        const parts = [];
        for (const section of spec.sections) {
          abort(options.signal);
          const entry = roiEntry(section, spec.roiName);
          if (!entry) { group.exclusions.push(exclusion(section, 'ROI_MISSING')); continue; }
          counts.roiSections++; counts.nGeometry += entry.nGeometry;
          const mapped = section.channels[analyte], row = mapped && entry.rows.find(row => row.key === mapped.key);
          if (!row) { group.exclusions.push(exclusion(section, 'CHANNEL_MISSING')); continue; }
          const channel = section.evaluation.channels[mapped.key];
          if (request.valueMode === 'normalized' && channel && channel.unit) group.unit = channel.unit;
          counts.nMeasured += row.nMeasured;
          const corrected = request.valueMode === 'normalized', statistic = corrected ? row.normalized : row.raw;
          counts.nValid += corrected ? row.nValid : row.raw.n;
          const values = corrected ? channel && channel.values : section.rasters[mapped.key] && section.rasters[mapped.key].values;
          const reasons = corrected ? row.reasonCodes : row.rawReasonCodes;
          if (corrected && !global.Normalization.isCorrectedChannel(channel)) {
            group.exclusions.push(exclusion(section, 'NORMALIZATION_UNAVAILABLE', reasons)); continue;
          }
          if (!values || !statistic.n || !Number.isFinite(statistic.mean)) {
            group.exclusions.push(exclusion(section, corrected ? 'NORMALIZATION_UNAVAILABLE' : 'NO_MEASURED_PIXELS', reasons)); continue;
          }
          const unit = corrected ? channel.unit : 'Intensity (a.u.)';
          const part = { section, entry, row, channel, values, n: statistic.n, unit };
          parts.push(part); comparisonParts.push(part); group.unit = unit;
          // Yield even within a pooled group, allowing rapid condition changes to cancel.
          await yieldTask(); abort(options.signal);
        }
        group.compatibility = normalizationCompatibility(parts, request.valueMode);
        if (group.compatibility.status === 'BLOCKED') {
          group.status = 'BLOCKED';
          for (const part of parts) group.exclusions.push(exclusion(part.section, 'NORMALIZATION_INCOMPATIBLE', group.compatibility.reasonCodes));
        } else if (parts.length) {
          const n = parts.reduce((sum, part) => sum + part.n, 0), pooled = new Float64Array(n);
          let offset = 0;
          for (const part of parts) {
            const mask = part.entry.mask, values = part.values;
            for (let i = 0; i < mask.length; i++) if (mask[i] && Number.isFinite(values[i])) pooled[offset++] = values[i];
          }
          if (offset !== n) throw new Error('画素数とROI集計が一致しません。再読込して確認してください。');
          group.statistics = global.Normalization.statistics(pooled);
          const summary = await (options.summarize
            ? options.summarize(pooled, { signal: options.signal, maxPoints, includeUpperTailValues: true })
            : global.RoiDistribution.summarize(pooled, { maxPoints, includeUpperTailValues: true }));
          abort(options.signal);
          if (summary) {
            const { upperTailValues, ...distribution } = summary;
            group.distribution = distribution;
            temporaryTails.set(group, upperTailValues);
          }
          counts.includedSections = parts.length; counts.nIncluded = n;
          const partial = group.exclusions.length || parts.some(part => request.valueMode === 'raw' ? part.row.rawStatus === 'PARTIAL' : part.row.status === 'PARTIAL');
          group.status = partial ? 'PARTIAL' : request.valueMode === 'normalized' && parts.some(part => part.row.status === 'PROVISIONAL') ? 'PROVISIONAL' : 'VALID';
          group.reasonCodes = unique(parts.flatMap(part => request.valueMode === 'normalized' ? part.row.reasonCodes : part.row.rawReasonCodes));
          if (parts.length > 1) group.warnings.push('PIXEL_WEIGHTED');
          if (new Set(parts.map(part => `${part.section.umPerPxX}:${part.section.umPerPxY}`)).size > 1) group.warnings.push('MIXED_PIXEL_SIZE');
        }
        if (group.unit) output.unit = group.unit;
        output.groups.push(group); completed++;
        if (options.onProgress) options.onProgress({ completed, total });
        await yieldTask(); abort(options.signal);
      }
      if (request.mode !== 'selected') {
        const distinctParts = Array.from(new Map(comparisonParts.map(part => [part.section.id, part])).values());
        const comparison = normalizationCompatibility(distinctParts, request.valueMode);
        if (comparison.status === 'BLOCKED') for (const group of output.groups) {
          if (!group.distribution) continue;
          group.compatibility = comparison; group.distribution = null; group.statistics = emptyStatistics();
          group.counts.nIncluded = 0; group.counts.includedSections = 0; group.status = 'BLOCKED';
          for (const id of group.sectionIds) {
            const section = selected.find(section => section.id === id);
            if (section && !group.exclusions.some(row => row.sectionId === id)) {
              group.exclusions.push(exclusion(section, 'NORMALIZATION_INCOMPATIBLE', comparison.reasonCodes));
            }
          }
        }
      }
      const blocked = output.groups.filter(group => group.status === 'BLOCKED');
      const available = output.groups.filter(group => group.distribution);
      // Normalized comparison filtering above can invalidate otherwise valid
      // individual groups. Resolve the common axis only from the final groups.
      const autoDomain = global.IntensityAxis.autoDomain(available.map(group => group.distribution));
      output.plot = { autoDomain };
      for (const group of available) {
        const distribution = group.distribution, tail = temporaryTails.get(group);
        if (distribution.max <= autoDomain[1]) distribution.aboveAutoCount = 0;
        else {
          if (!tail || tail.length !== distribution.upperTailCount) throw new Error('Exact upper-tail values are required for automatic-axis counts.');
          distribution.aboveAutoCount = global.IntensityAxis.countAbove(tail, autoDomain[1]);
        }
      }
      temporaryTails.clear();
      output.compatibility = { status: blocked.length ? 'BLOCKED' : request.valueMode === 'raw' ? 'NOT_APPLICABLE' : 'COMPATIBLE',
        reasonCodes: unique(blocked.flatMap(group => group.compatibility.reasonCodes)) };
      output.status = available.length ? (available.length < output.groups.length || available.some(group => group.status === 'PARTIAL') ? 'PARTIAL'
        : available.some(group => group.status === 'PROVISIONAL') ? 'PROVISIONAL' : 'VALID') : blocked.length ? 'BLOCKED' : 'UNAVAILABLE';
      result.channels.push(output);
    }
    return result;
  }

  global.Stack3DAnalysis = { parseSelection, regionCatalog, analyze, clearCache };
})(typeof window !== 'undefined' ? window : globalThis);
