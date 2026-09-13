/* Display windows are independent of numerical normalization profiles.
 * Never mutate source rasters, numerical profiles or their fingerprints here.
 * Quantiles use nearest rank on a finite-value COPY, including measured zero.
 */
(function (global) {
  'use strict';
  const VERSION = 1, QUANTILE = 0.99, ALGORITHM = 'finite-nearest-rank-p99-v1';
  const sortedCache = new WeakMap();
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const stable = value => global.Normalization && typeof global.Normalization.stableStringify === 'function' ? global.Normalization.stableStringify(value) : JSON.stringify(value);
  const memberId = project => project.normalizationBinding && project.normalizationBinding.memberId || project.id;
  const nameOf = molecule => String(molecule && molecule.name || '').normalize('NFC').trim();
  const isCorrected = channel => !!channel && channel.applicable !== false && ['pixel_ratio', 'section_scale'].includes(channel.method);
  const validWindow = value => !!value && Number.isFinite(value.min) && Number.isFinite(value.max) && value.max > value.min && Number.isFinite(value.max - value.min);
  const asWindow = value => {
    const window = Array.isArray(value) ? { min: value[0], max: value[1] } : value;
    return validWindow(window) ? { min: window.min, max: window.max } : null;
  };
  function digest(value) {
    // Two independent words keep portable display-cache identities compact.
    // This is a cache checksum; numerical validation remains Normalization's job.
    const text = stable(value); let a = 2166136261, b = 2246822519;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 3266489917); }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
  }
  function sortedFinite(values) {
    if (!values || typeof values !== 'object') return new Float64Array(0);
    let sorted = sortedCache.get(values);
    if (sorted) return sorted;
    let count = 0;
    for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) count++;
    sorted = new Float64Array(count);
    for (let i = 0, j = 0; i < values.length; i++) if (Number.isFinite(values[i])) sorted[j++] = values[i];
    sorted.sort(); sortedCache.set(values, sorted); return sorted;
  }
  function upperBound(sorted, value) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (sorted[mid] <= value) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function lowerBound(sorted, value) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (sorted[mid] < value) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function statsFromSorted(sorted) {
    const n = sorted.length;
    if (!n) return { min: 0, max: 1, actualMin: null, actualMax: null, nFinite: 0, nClipped: 0, clippedFraction: 0, status: 'NO_FINITE_VALUES', quantile: QUANTILE };
    const actualMin = sorted[0], actualMax = sorted[n - 1];
    let min = Math.min(0, actualMin), max = sorted[Math.max(0, Math.ceil(QUANTILE * n) - 1)], status = 'OK';
    if (actualMin === 0 && actualMax === 0) { max = 1; status = 'ALL_ZERO'; }
    else if (actualMin === actualMax && actualMin < 0) {
      const step = Math.max(Math.abs(actualMin) * 0.01, Number.MIN_VALUE);
      min = actualMin - step; max = actualMin + step; status = 'CONSTANT';
      if (!Number.isFinite(min)) { min = actualMin; max = actualMin / 2; }
    } else if (!(max > min)) {
      const start = upperBound(sorted, min), length = n - start;
      if (length) { max = sorted[start + Math.max(0, Math.ceil(QUANTILE * length) - 1)]; status = 'SPARSE_FALLBACK'; }
    }
    if (!validWindow({ min, max })) {
      // Finite endpoints alone can still overflow their difference.
      min = Math.max(-Number.MAX_VALUE / 2, min); max = Math.min(Number.MAX_VALUE / 2, max);
      if (!(max > min)) { min = 0; max = actualMax > 0 ? actualMax : 1; }
    }
    const nClipped = lowerBound(sorted, min) + n - upperBound(sorted, max);
    return { min, max, actualMin, actualMax, nFinite: n, nClipped, clippedFraction: nClipped / n, status, quantile: QUANTILE };
  }
  function stats(values) { return statsFromSorted(sortedFinite(values)); }
  function freshState(strategy, manual, legacy) { return { strategy: strategy || 'individual', manual: manual || null, legacy: legacy || null, identity: null }; }
  function prepareProject(project) {
    if (!project || typeof project !== 'object') throw new Error('DISPLAY_PROJECT_REQUIRED');
    if (!project.valueDisplay || typeof project.valueDisplay !== 'object') project.valueDisplay = { mode: 'raw', scale: 'individual' };
    if (!project.layerDisplay || typeof project.layerDisplay !== 'object') project.layerDisplay = {};
    const display = project.valueDisplay;
    const legacyMode = display.mode === 'normalized' ? 'normalized' : 'raw';
    let migrated = false;
    for (const molecule of project.molecules || []) {
      const key = molecule.key;
      if (!project.layerDisplay[key] || typeof project.layerDisplay[key] !== 'object') project.layerDisplay[key] = {};
      const layer = project.layerDisplay[key];
      if (layer.displayRanges && layer.displayRanges.version === VERSION) continue;
      const raw = asWindow(layer.rawRange) || (legacyMode === 'raw' ? asWindow({ min: layer.vmin, max: layer.vmax }) : null);
      const normalized = asWindow(layer.normalizedRange) || (legacyMode === 'normalized' ? asWindow({ min: layer.vmin, max: layer.vmax }) : null);
      layer.displayRanges = { version: VERSION, raw: freshState(raw ? 'manual' : 'individual', raw), normalized: freshState('individual', null, normalized) };
      if (normalized) migrated = true;
    }
    if (display.rangeVersion !== VERSION) {
      display.scale = 'individual';
      if (migrated) display.rangeMigration = { version: VERSION, normalizedToIndividual: true };
    }
    display.rangeVersion = VERSION;
    if (!['raw', 'normalized'].includes(display.mode)) display.mode = 'raw';
    return display;
  }
  function layerState(project, key, mode) {
    prepareProject(project); mode = mode === 'normalized' ? 'normalized' : 'raw';
    const layer = project.layerDisplay[key] || (project.layerDisplay[key] = {});
    if (!layer.displayRanges || layer.displayRanges.version !== VERSION) layer.displayRanges = { version: VERSION, raw: freshState(), normalized: freshState() };
    if (!layer.displayRanges[mode]) layer.displayRanges[mode] = freshState();
    const state = layer.displayRanges[mode];
    if (!['individual', 'common', 'manual'].includes(state.strategy)) state.strategy = 'individual';
    if (mode === 'raw' && state.strategy === 'common') state.strategy = 'individual';
    return state;
  }
  function setStrategy(project, key, mode, strategy) {
    if (!['individual', 'common', 'manual'].includes(strategy)) throw new Error('DISPLAY_STRATEGY_INVALID');
    const state = layerState(project, key, mode);
    state.strategy = mode !== 'normalized' && strategy === 'common' ? 'individual' : strategy;
    if (state.strategy === 'manual' && !validWindow(state.manual)) state.strategy = 'individual';
    return state;
  }
  function setManual(project, key, mode, min, max) {
    const window = typeof min === 'object' ? asWindow(min) : asWindow({ min, max });
    if (!window) throw new Error('DISPLAY_WINDOW_INVALID');
    const state = layerState(project, key, mode); state.manual = window; state.strategy = 'manual'; return state;
  }
  function restoreLegacy(project, key, mode) {
    const state = layerState(project, key, mode), window = asWindow(state.legacy);
    if (!window) return false;
    setManual(project, key, mode, window); return true;
  }
  function serializeLayer(project, key, existing) {
    prepareProject(project);
    const current = project.layerDisplay[key] || {};
    return Object.assign({}, current, existing || {}, { displayRanges: clone(current.displayRanges) });
  }
  function analyteKey(project, key, channel) {
    if (!isCorrected(channel) || channel.rangeScope === 'individual') return null;
    const molecule = (project.molecules || []).find(m => m.key === key), name = nameOf(molecule);
    if (!name || /^(?:unknown|unnamed|未同定|不明|分子|molecule|msi)(?:[\s_-]*\d+)?$/i.test(name) ||
      (project.molecules || []).filter(m => nameOf(m) === name).length !== 1) return null;
    return JSON.stringify([channel.method, name, channel.unit || '']);
  }
  function sourceIdentity(project, key, mode, channel, rawFingerprint) {
    const profile = project.normalization;
    return 'display-source-v1:' + digest({ key, name: nameOf((project.molecules || []).find(m => m.key === key)), mode,
      rawFingerprint: rawFingerprint || profile && profile.rawFingerprint || null,
      // The numerical raw fingerprint already covers calibrated geometry.
      // ZIP imports may materialize absent optional fields as null, so never
      // hash the serialized grid object as a display identity.
      grid: { W: Number(project.grid && project.grid.W), H: Number(project.grid && project.grid.H) },
      normalization: mode === 'normalized' ? profile && { id: profile.id, revision: profile.revision, calculationFingerprint: profile.calculationFingerprint, invalidated: profile.invalidated || null } : null,
      method: mode === 'normalized' && channel && channel.method || null, unit: mode === 'normalized' && channel && channel.unit || 'raw a.u.' });
  }
  function memberRecord(project, rawFingerprint) {
    const profile = project.normalization;
    return { memberId: memberId(project), profileId: profile.id, revision: profile.revision,
      calculationFingerprint: profile.calculationFingerprint, rawFingerprint: rawFingerprint || profile.rawFingerprint,
      skipped: !!(global.Normalization && global.Normalization.isSkippedProfile(profile)) };
  }
  function snapshotPayload(snapshot) {
    const out = Object.assign({}, snapshot); delete out.id; delete out.createdAt; return out;
  }
  function commonFor(project, key, channel, rawFingerprint) {
    const snapshot = project.valueDisplay && project.valueDisplay.groupRangeSnapshot;
    if (!snapshot) return { reason: 'COMMON_RANGE_NOT_BUILT' };
    if (snapshot.version !== VERSION || snapshot.algorithm !== ALGORITHM || snapshot.quantile !== QUANTILE ||
      snapshot.id !== 'display-group-v1:' + digest(snapshotPayload(snapshot))) return { reason: 'COMMON_RANGE_INVALID' };
    const profile = project.normalization, scope = profile && profile.scope;
    const binding = project.normalizationBinding;
    if (!scope || snapshot.groupId !== scope.groupId || stable(snapshot.folderPath) !== stable(scope.folderPath) ||
      stable(snapshot.memberIds) !== stable((scope.memberIds || []).slice().sort(compare)) ||
      Object.prototype.hasOwnProperty.call(project, 'normalizationBinding') && (!binding || binding.groupId !== scope.groupId || !scope.memberIds.includes(binding.memberId))) return { reason: 'COMMON_RANGE_SCOPE_CHANGED' };
    const member = (snapshot.members || []).find(m => m.memberId === memberId(project));
    if (!member || stable(member) !== stable(memberRecord(project, rawFingerprint)) || profile.invalidated) return { reason: 'COMMON_RANGE_SOURCE_CHANGED' };
    const identity = analyteKey(project, key, channel), range = identity && snapshot.ranges && snapshot.ranges[identity];
    if (!range || !validWindow(range)) return { reason: 'COMMON_RANGE_UNAVAILABLE' };
    return { range, snapshot, analyteId: identity };
  }
  function resolve(options) {
    const { project, key, channel, values, rawFingerprint } = options;
    const mode = options.mode === 'normalized' ? 'normalized' : 'raw', state = layerState(project, key, mode);
    const identity = sourceIdentity(project, key, mode, channel, rawFingerprint), actual = stats(values);
    let reason = null;
    if (state.identity && state.identity !== identity) { state.strategy = 'individual'; reason = 'DISPLAY_SOURCE_CHANGED'; }
    state.identity = identity;
    const requestedStrategy = state.strategy;
    let window = actual, strategy = requestedStrategy, source = 'image', common = null;
    if (strategy === 'manual') {
      if (validWindow(state.manual)) { window = state.manual; source = 'manual'; }
      else { strategy = 'individual'; reason = 'MANUAL_RANGE_INVALID'; }
    } else if (strategy === 'common') {
      common = commonFor(project, key, channel, rawFingerprint);
      if (common.range) { window = common.range; source = 'group'; }
      else { strategy = 'individual'; reason = common.reason; }
    }
    const sorted = sortedFinite(values), nClipped = lowerBound(sorted, window.min) + sorted.length - upperBound(sorted, window.max);
    const result = Object.assign({}, actual, { min: window.min, max: window.max, nClipped, clippedFraction: sorted.length ? nClipped / sorted.length : 0,
      strategy, requestedStrategy, reason, source, identity, quantile: strategy === 'manual' ? null : QUANTILE });
    if (common && common.range) Object.assign(result, { groupId: common.snapshot.groupId, folderPath: clone(common.snapshot.folderPath), snapshotId: common.snapshot.id,
      groupMemberCount: common.snapshot.memberIds.length, groupContributorCount: common.range.memberIds.length, maximum: clone(common.range.maximum),
      groupActualMin: common.range.actualMin, groupActualMax: common.range.actualMax, groupNFinite: common.range.nFinite,
      groupClippedFraction: common.range.clippedFraction, analyteId: common.analyteId });
    return result;
  }
  function buildGroupSnapshot(entries) {
    const N = global.Normalization;
    if (!N || !Array.isArray(entries) || !entries.length) throw new Error('DISPLAY_GROUP_INVALID');
    const first = entries[0].project.normalization, scope = first && first.scope;
    if (!scope || !scope.groupId || !Array.isArray(scope.memberIds) || !Array.isArray(scope.folderPath)) throw new Error('DISPLAY_GROUP_INVALID');
    const memberIds = entries.map(e => memberId(e.project)).sort(compare), expected = scope.memberIds.slice().sort(compare);
    if (new Set(memberIds).size !== memberIds.length || stable(memberIds) !== stable(expected)) throw new Error('DISPLAY_GROUP_INCOMPLETE');
    const members = [], pooled = new Map();
    for (const entry of entries.slice().sort((a, b) => compare(memberId(a.project), memberId(b.project)))) {
      const project = entry.project, profile = project.normalization, binding = project.normalizationBinding;
      if (!profile || stable(profile.scope) !== stable(scope) || profile.id !== first.id || profile.revision !== first.revision ||
        Object.prototype.hasOwnProperty.call(project, 'normalizationBinding') && (!binding || binding.groupId !== scope.groupId || !memberIds.includes(binding.memberId))) throw new Error('DISPLAY_GROUP_INVALID');
      const evaluation = entry.evaluation && entry.evaluation.profile === profile ? entry.evaluation : N.evaluate(project, entry.rasters);
      if (profile.invalidated || evaluation.fingerprint !== profile.rawFingerprint ||
        (evaluation.reasonCodes || []).some(code => ['NORMALIZATION_PROFILE_STALE', 'NORMALIZATION_SCOPE_INVALID', 'GROUP_MEMBERSHIP_CHANGED'].includes(code))) throw new Error('DISPLAY_PROFILE_STALE');
      const record = memberRecord(project, evaluation.fingerprint); members.push(record);
      if (record.skipped) continue;
      for (const [key, channel] of Object.entries(evaluation.channels || {})) {
        const identity = analyteKey(project, key, channel);
        if (!identity || !channel.values) continue;
        const local = stats(channel.values);
        if (!local.nFinite) continue;
        let group = pooled.get(identity);
        if (!group) { group = { arrays: [], count: 0, memberIds: [], maximum: null }; pooled.set(identity, group); }
        group.arrays.push(channel.values); group.count += local.nFinite; group.memberIds.push(record.memberId);
        if (!group.maximum || local.actualMax > group.maximum.value) {
          const index = channel.values.findIndex(v => v === local.actualMax), width = project.grid && project.grid.W || 1;
          const maximum = { memberId: record.memberId, dataName: project.displayName || project.name || project.id, key, index,
            x: index % width, y: Math.floor(index / width), value: local.actualMax };
          if (channel.method === 'pixel_ratio') {
            const standard = entry.rasters && entry.rasters[profile.mapping && profile.mapping.d4];
            const standardValues = ArrayBuffer.isView(standard) ? standard : standard && standard.values;
            maximum.denominator = standardValues && Number.isFinite(standardValues[index]) ? standardValues[index] : null;
          }
          group.maximum = maximum;
        }
      }
    }
    const ranges = {};
    for (const [identity, group] of Array.from(pooled.entries()).sort((a, b) => compare(a[0], b[0]))) {
      const sorted = new Float64Array(group.count); let offset = 0;
      for (const values of group.arrays) for (const value of values) if (Number.isFinite(value)) sorted[offset++] = value;
      sorted.sort();
      ranges[identity] = Object.assign(statsFromSorted(sorted), { memberIds: group.memberIds, maximum: group.maximum });
    }
    const snapshot = { version: VERSION, algorithm: ALGORITHM, quantile: QUANTILE, groupId: scope.groupId, folderPath: clone(scope.folderPath), memberIds, members, ranges };
    snapshot.id = 'display-group-v1:' + digest(snapshot); snapshot.createdAt = new Date().toISOString(); return snapshot;
  }
  global.DisplayRange = { VERSION, QUANTILE, ALGORITHM, stats, prepareProject, layerState, resolve, setStrategy, setManual, restoreLegacy,
    serializeLayer, buildGroupSnapshot, analyteKey, sourceIdentity, commonFor };
})(window);
