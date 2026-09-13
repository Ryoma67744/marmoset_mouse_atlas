/*
 * excelio.js — 解析用 Excel ワークブックの生成
 *
 * 既存の復元用 ZIP とは独立し、生値と補正解析を別シートとして XLSX にする。
 * DOM やダウンロード処理には依存せず、一括出力側から再利用できる API を公開する。
 */
(function (global) {
  'use strict';

  const EXCEL_MAX_ROWS = 1048576;
  const EXCEL_MAX_COLUMNS = 16384;
  const DEFAULT_CHUNK_ROWS = 2000;
  const DEFAULT_NAME_LENGTH = 120;
  const MAX_WORKBOOK_NAME_LENGTH = 180;

  function requireDependency(value, message) {
    if (!value) throw new Error(message);
    return value;
  }

  function asDate(value) {
    const d = value instanceof Date ? new Date(value.getTime())
      : value == null ? new Date() : new Date(value);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }

  function exportedAt(value) {
    return asDate(value).toISOString();
  }

  function appVersion() {
    return String(global.APP_VERSION ||
      (global.AppVersion && global.AppVersion.version) || '');
  }

  function stringValue(value) {
    if (value == null) return '';
    return String(value);
  }

  function folderPathValue(value) {
    if (Array.isArray(value)) return value.map(stringValue).filter(Boolean).join(' / ');
    return stringValue(value);
  }

  function warningText(value) {
    if (Array.isArray(value)) return value.map(stringValue).filter(Boolean).join(' | ');
    return stringValue(value);
  }

  function errorText(value) {
    if (!value) return '';
    return value instanceof Error ? value.message : String(value);
  }

  function moleculeNameList(record) {
    if (!record) return [];
    const source = record.moleculeNames != null ? record.moleculeNames : record.molecules;
    const items = Array.isArray(source) ? source : (source == null ? [] : [source]);
    return items.map(item => {
      if (item && typeof item === 'object') return stringValue(item.name);
      return stringValue(item);
    }).filter(Boolean);
  }

  // Excel の 1 セルは最大 32,767 文字。Index は読みやすい要約にとどめ、
  // 完全な一覧は Molecules シートへ 1 分子 1 行で必ず残す。
  function moleculeNameSummary(names) {
    const text = names.join(' | ');
    const suffix = ' ... (see Molecules sheet(s))';
    if (text.length <= 32767) return text;
    return truncateUtf16(text, 32767 - suffix.length) + suffix;
  }

  // Windows の 1 ファイル名上限は UTF-16 code unit で数えられるため、
  // 絵文字の surrogate pair を途中で切らずに、その単位で収める。
  function truncateUtf16(value, maxLength) {
    let out = '';
    let length = 0;
    for (const char of Array.from(value)) {
      if (length + char.length > maxLength) break;
      out += char;
      length += char.length;
    }
    return out;
  }

  /**
   * Unicode は保ったまま、単一のファイル名要素として危険な文字だけを除く。
   * Windows の予約名と末尾のピリオド/空白にも対応する。
   */
  function sanitizeFileComponent(value, maxLength) {
    let name = stringValue(value);
    try { name = name.normalize('NFC'); } catch (e) { /* 古いブラウザではそのまま使う */ }

    // 先にパス要素へ分解し、`.` / `..` を落として traversal を成立させない。
    name = name.split(/[\\/]+/)
      .filter(part => part && part !== '.' && part !== '..')
      .join('_');
    name = name
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '_')
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[. ]+|[. ]+$/g, '');

    const limit = Number.isFinite(maxLength) && maxLength > 0
      ? Math.floor(maxLength) : DEFAULT_NAME_LENGTH;
    name = truncateUtf16(name, limit).replace(/[. ]+$/g, '');
    if (!name || name === '.' || name === '..') name = 'dataset';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
    return truncateUtf16(name, limit).replace(/[. ]+$/g, '') || 'dataset';
  }

  function shortProjectId(project) {
    const raw = stringValue(project && project.id);
    const compact = raw.replace(/[^0-9A-Za-z]/g, '');
    return compact ? compact.slice(0, 8) : 'noid';
  }

  function hasCaseInsensitive(set, candidate) {
    const wanted = candidate.toLowerCase();
    for (const item of set) {
      if (String(item).toLowerCase() === wanted) return true;
    }
    return false;
  }

  /**
   * `0001_表示名_短いID.xlsx` を作る。index は 1 始まり。
   * usedSet を渡すと、大文字小文字を無視して必ず一意な名前を予約する。
   */
  function makeUniqueWorkbookName(project, index, usedSet) {
    const n = Number.isFinite(Number(index)) ? Math.max(1, Math.floor(Number(index))) : 1;
    const sequence = String(n).padStart(4, '0');
    const id = shortProjectId(project);
    const fixedLength = sequence.length + id.length + '.xlsx'.length + 2;
    const nameLimit = Math.max(1, MAX_WORKBOOK_NAME_LENGTH - fixedLength);
    const displayName = sanitizeFileComponent(
      project && (project.displayName || project.name || project.id), nameLimit);
    const base = sequence + '_' + displayName + '_' + id;
    const names = usedSet instanceof Set ? usedSet : new Set();

    let serial = 1;
    let candidate = base + '.xlsx';
    while (hasCaseInsensitive(names, candidate)) {
      serial += 1;
      const suffix = '_' + serial;
      const allowed = Math.max(1, MAX_WORKBOOK_NAME_LENGTH - '.xlsx'.length - suffix.length);
      candidate = truncateUtf16(base, allowed).replace(/[. ]+$/g, '') + suffix + '.xlsx';
    }
    names.add(candidate);
    return candidate;
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  /** `marmoset_atlas_excel_YYYYMMDD_HHMMSS[_PARTIAL].zip` を返す。 */
  function makeArchiveFilename(partial, date) {
    let isPartial = !!partial;
    let timestampSource = date;
    if (partial instanceof Date || typeof partial === 'string' || typeof partial === 'number') {
      timestampSource = partial;
      isPartial = false;
    } else if (partial && typeof partial === 'object') {
      isPartial = !!partial.partial;
      timestampSource = partial.date || partial.exportedAt;
    }
    const d = asDate(timestampSource);
    const stamp = String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    return 'marmoset_atlas_excel_' + stamp + (isPartial ? '_PARTIAL' : '') + '.zip';
  }

  function excelColumnName(index) {
    let n = index + 1;
    let out = '';
    while (n > 0) {
      n -= 1;
      out = String.fromCharCode(65 + (n % 26)) + out;
      n = Math.floor(n / 26);
    }
    return out;
  }

  // x/y、分子、ROI の全列を通して一意にする。従来 CSV の見出しは変えず、
  // 解析用 XLSX だけで衝突を解消し、Metadata に実際の対応を残す。
  function uniqueWorkbookHeaders(values) {
    const used = new Set();
    return values.map((raw, index) => {
      const base = stringValue(raw) || ('col' + (index + 1));
      let candidate = base;
      let serial = 1;
      while (used.has(candidate.toLowerCase())) {
        serial += 1;
        candidate = base + '#' + serial;
      }
      used.add(candidate.toLowerCase());
      return candidate;
    });
  }

  function mappingRows(table, exportedHeaders) {
    const rows = [
      [],
      ['Column mapping'],
      ['Type', 'Source index (0-based)', 'Key', 'Original name', 'Exported header', 'Excel column', 'Data column number'],
    ];
    const molecules = Array.isArray(table.molecules) ? table.molecules : [];
    const rois = Array.isArray(table.rois) ? table.rois : [];
    molecules.forEach((molecule, index) => {
      const columnIndex = 2 + index;
      rows.push([
        'Molecule',
        molecule.index == null ? index : molecule.index,
        stringValue(molecule.key),
        stringValue(molecule.name),
        stringValue(exportedHeaders[columnIndex]),
        excelColumnName(columnIndex),
        columnIndex + 1,
      ]);
    });
    rois.forEach((roi, index) => {
      const columnIndex = 2 + molecules.length + index;
      rows.push([
        'ROI',
        roi.index == null ? index : roi.index,
        stringValue(roi.key),
        stringValue(roi.name),
        stringValue(exportedHeaders[columnIndex]),
        excelColumnName(columnIndex),
        columnIndex + 1,
      ]);
    });
    return rows;
  }

  function makeMetadataSheet(XLSXRef, project, table, info) {
    const grid = project.grid || {};
    const warnings = Array.isArray(table.warnings) ? table.warnings.map(stringValue).filter(Boolean) : [];
    const rows = [
      ['Field', 'Value'],
      ['Format', 'marmoset_atlas_excel_v1'],
      ['Project ID', stringValue(project.id)],
      ['Project name', stringValue(project.displayName || project.name)],
      ['Folder', folderPathValue(project.folderPath)],
      ['Grid width (pixels)', table.W],
      ['Grid height (pixels)', table.H],
      ['Pixel size X (um/pixel)', Number.isFinite(grid.umPerPxX) ? grid.umPerPxX : ''],
      ['Pixel size Y (um/pixel)', Number.isFinite(grid.umPerPxY) ? grid.umPerPxY : ''],
      ['Orientation', stringValue(project.orientation)],
      ['Plane', stringValue(project.plane)],
      ['Slice ID', stringValue(project.sliceId)],
      ['Molecule columns', info.moleculeCount],
      ['ROI columns', info.roiCount],
      ['Exported data rows', info.rowCount],
      ['Data sheets', info.dataSheetCount],
      ['Exported at (ISO 8601)', info.exportedAt],
      ['App version', info.appVersion],
      ['Coordinate convention', 'x and y are 1-based pixel coordinates.'],
      ['ROI convention', 'ROI columns are 1 inside any valid polygon belonging to that ROI, otherwise 0.'],
      ['Value provenance (Data sheets only)', 'MSI values in Data / Data_NNN are stored raw Float32 intensities; non-finite values are blank. No display range, color, rotation, alignment, Otsu threshold, interpolation, or normalization is applied to Data sheets. Derived values are separate in Normalized_Data and ROI_Quantification.'],
      ['Warnings', warnings.length],
    ];
    if (warnings.length) {
      rows.push([], ['Warning number', 'Message']);
      warnings.forEach((warning, index) => rows.push([index + 1, warning]));
    }
    rows.push.apply(rows, mappingRows(table, info.headers));
    const ws = XLSXRef.utils.aoa_to_sheet(rows);
    ws['!cols'] = [
      { wch: 25 }, { wch: 72 }, { wch: 24 }, { wch: 36 },
      { wch: 36 }, { wch: 14 }, { wch: 20 },
    ];
    return ws;
  }

  function notifyProgress(options, detail) {
    if (options && typeof options.onProgress === 'function') options.onProgress(detail);
  }

  function checkCancelled(options) {
    if (options && typeof options.shouldCancel === 'function' && options.shouldCancel()) {
      const error = new Error('Excel 書き出しをキャンセルしました');
      error.code = 'EXPORT_CANCELLED';
      throw error;
    }
  }

  function finiteCell(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function codes(value) {
    return Array.isArray(value) ? value.filter(Boolean) : (value ? [String(value)] : []);
  }

  function reasonsText(value) {
    const exportReasons = {
      NORMALIZATION_ENGINE_UNAVAILABLE: '補正計算機能が読み込まれていないため算出できません。アプリを再読み込みしてください。',
      NORMALIZATION_CALCULATION_FAILED: '補正計算中にエラーが発生したため算出できません。生値は Data に保持されています。',
      NORMALIZED_VALUE_UNAVAILABLE: 'この画素の補正値を算出できません。入力値と補正条件を確認してください。',
      NO_ROI_QUANTIFICATION: '5-HT の ROI 定量対象がないため絶対定量を集計できません。分子の割り当てと ROI を確認してください。',
      OTSU_ENGINE_UNAVAILABLE: 'Otsu 計算機能が読み込まれていないため表示判定を再現できません。',
      OTSU_CALCULATION_FAILED: 'Otsu 表示判定の再現に失敗しました。解析値には影響しません。',
    };
    return codes(value).map(code => exportReasons[code] || (global.Normalization && global.Normalization.reasonText
      ? global.Normalization.reasonText(code) : String(code))).join(' | ');
  }

  function safeJSON(value) {
    try { return JSON.stringify(value == null ? null : value); }
    catch (error) { return '[serialization unavailable]'; }
  }

  const GROUP_COLUMNS = [
    'Normalization group ID', 'Normalization folder at calculation', 'Current normalization folder',
    'Group membership status', 'Profile schema version', 'Normalization method version',
    'Section D4 median (Ds)', 'Group reference D4 (Dref)',
  ];

  // The immutable calculation scope and mutable current binding are separate
  // provenance. A stand-alone archive cannot attest to full group membership.
  function groupProvenance(project) {
    const profile = project.normalization || {}, scope = profile.scope;
    const binding = project.normalizationBinding;
    const explicitBinding = !!binding && Object.prototype.hasOwnProperty.call(binding, 'groupId');
    return {
      groupId: scope && scope.groupId || '',
      scopePath: folderPathValue(scope && scope.folderPath),
      currentPath: folderPathValue(explicitBinding ? binding.folderPath
        : Array.isArray(project.folderPath) && project.folderPath.length >= 2 ? project.folderPath.slice(0, 2) : ''),
      groupStatus: !scope ? 'LEGACY' : explicitBinding
        ? binding.groupId === scope.groupId ? 'SAVED_GROUP' : 'MOVED' : 'SAVED_SNAPSHOT',
      schemaVersion: profile.schemaVersion == null ? '' : profile.schemaVersion,
      methodVersion: profile.methodVersion || '',
      Ds: finiteCell(profile.section && profile.section.Ds),
      Dref: finiteCell(profile.section && profile.section.Dref),
    };
  }

  function groupCells(record) {
    return [record.groupId || '', folderPathValue(record.scopePath), folderPathValue(record.currentPath),
      record.groupStatus || '', record.schemaVersion == null ? '' : record.schemaVersion,
      record.methodVersion || '', finiteCell(record.Ds), finiteCell(record.Dref)];
  }

  function unavailableEvaluation(project, table, code) {
    const channels = {};
    table.molecules.forEach(m => {
      channels[m.key] = { role: 'other', method: 'not_applied', unit: '', values: null,
        status: 'UNAVAILABLE', reasonCodes: [code], pixelReasons: null };
    });
    return { profile: project.normalization || null, status: 'UNAVAILABLE',
      reasonCodes: [code], channels: channels, section: {}, fingerprint: '' };
  }

  // Use the one shared scientific implementation. A failed derived calculation
  // must not discard an otherwise valid raw workbook or be represented as zero.
  function prepareAnalysis(project, table) {
    const rasters = {};
    table.molecules.forEach(m => {
      rasters[m.key] = { W: table.W, H: table.H, values: m.raster };
    });
    let evaluation;
    let calculationError = '';
    try {
      if (!global.Normalization || typeof global.Normalization.evaluate !== 'function') {
        evaluation = unavailableEvaluation(project, table, 'NORMALIZATION_ENGINE_UNAVAILABLE');
      } else {
        evaluation = global.Normalization.evaluate(project, rasters);
      }
    } catch (error) {
      calculationError = errorText(error);
      evaluation = unavailableEvaluation(project, table, 'NORMALIZATION_CALCULATION_FAILED');
    }
    let otsu = { usable: false, status: 'NOT_APPLIED', reasonCodes: [], keep: null, evaluable: null };
    const settings = project.otsu || {};
    if (settings.applied) {
      try {
        otsu = global.Otsu && typeof global.Otsu.buildProjectRecord === 'function'
          ? global.Otsu.buildProjectRecord(project, rasters, settings)
          : { usable: false, status: 'NOT_EVALUABLE', reasonCodes: ['OTSU_ENGINE_UNAVAILABLE'] };
      } catch (error) {
        otsu = { usable: false, status: 'NOT_EVALUABLE', reasonCodes: ['OTSU_CALCULATION_FAILED'] };
      }
    }
    return { rasters: rasters, evaluation: evaluation, otsu: otsu, calculationError: calculationError };
  }

  function normalizedHeaders(table, analysis) {
    const values = table.molecules.map(m => {
      // The original registered name is preserved, even for unsupported channels.
      const channel = analysis.evaluation.channels[m.key] || {};
      const label = channel.role === 'ht' ? '5-HT / d4-5-HT ratio'
        : (channel.role === 'da' || channel.role === 'ne') ? 'section normalized intensity'
          : 'not normalized; see Data';
      return m.name + ' [' + label + ']';
    });
    return uniqueWorkbookHeaders(['x', 'y'].concat(values).concat(table.roiHeaders)
      .concat(table.molecules.flatMap(m => [m.name + ' [status]', m.name + ' [reason codes]', m.name + ' [reason]']))
      .concat(['Otsu_Visible', 'Otsu_Status', 'Otsu_Reason']));
  }

  function normalizedRow(sourceRow, table, analysis) {
    const index = (sourceRow[1] - 1) * table.W + sourceRow[0] - 1;
    const values = [], statuses = [];
    table.molecules.forEach(m => {
      const channel = analysis.evaluation.channels[m.key] || {};
      const value = channel.values ? finiteCell(channel.values[index]) : null;
      const pixelCodes = codes(channel.pixelReasons && channel.pixelReasons[index]);
      // Channel summaries can contain faults belonging to OTHER pixels. Only
      // genuine whole-channel cautions accompany a successfully computed pixel.
      const globalCautions = codes(channel.reasonCodes).filter(code => [
        'NORMALIZATION_PROVISIONAL', 'D4_SATURATION_UNKNOWN',
        'WHOLE_TISSUE_PROVISIONAL', 'VALIDATION_EVIDENCE_MISSING',
      ].includes(code));
      let rowCodes, rowStatus;
      if (channel.values) {
        rowCodes = value === null
          ? (pixelCodes.length ? pixelCodes : ['NORMALIZED_VALUE_UNAVAILABLE']).concat(globalCautions)
          : globalCautions;
        rowStatus = value === null ? 'UNAVAILABLE'
          : (globalCautions.length || channel.status === 'PROVISIONAL' ? 'PROVISIONAL' : 'VALID');
      } else {
        rowCodes = codes(channel.reasonCodes);
        rowStatus = channel.status || 'NOT_APPLIED';
      }
      values.push(value);
      statuses.push(rowStatus, rowCodes.join(' | '), reasonsText(rowCodes));
    });
    const otsu = analysis.otsu;
    const applicable = !!(otsu && otsu.usable && otsu.keep &&
      (!otsu.evaluable || otsu.evaluable[index]));
    const visible = applicable ? (otsu.keep[index] ? 1 : 0) : null;
    const otsuStatus = applicable ? (visible ? 'VISIBLE' : 'HIDDEN')
      : ((table.project.otsu || {}).applied ? 'NOT_EVALUABLE' : 'NOT_APPLIED');
    const otsuReason = otsuStatus === 'NOT_EVALUABLE'
      ? (otsu.usable ? otsuPixelReason(table.project, analysis, index)
        : otsu.reasonText || reasonsText(otsu.reasonCodes)) : '';
    return [sourceRow[0], sourceRow[1]].concat(values)
      .concat(sourceRow.slice(2 + table.molecules.length)).concat(statuses)
      .concat([visible, otsuStatus, otsuReason]);
  }

  function otsuPixelReason(project, analysis, index) {
    const settings = project.otsu || {}, profile = project.normalization || {};
    const keys = analysis.otsu.sourceKeys || settings.sourceKeys || profile.otsuSourceKeys || [];
    const found = new Set();
    let sum = 0;
    keys.forEach(key => {
      const raster = analysis.rasters[key], value = raster && raster.values && raster.values[index];
      if (!Number.isFinite(value)) found.add('OTSU_SOURCE_PIXEL_NONFINITE');
      else if (value < 0) found.add('OTSU_SOURCE_PIXEL_NEGATIVE');
      else sum += value;
    });
    if (!found.size && !Number.isFinite(sum)) found.add('OTSU_SOURCE_SUM_NONFINITE');
    const fallback = {
      OTSU_SOURCE_PIXEL_NONFINITE: 'この画素は必要分子の生値に欠損または非有限値があるため、Otsu表示判定を算出できません。',
      OTSU_SOURCE_PIXEL_NEGATIVE: 'この画素は必要分子の生値に負の値があるため、Otsu表示判定を算出できません。',
      OTSU_SOURCE_SUM_NONFINITE: 'この画素は登録分子の信号和が非有限のため、Otsu表示判定を算出できません。',
    };
    return found.size ? Array.from(found, code => fallback[code]).join(' | ')
      : 'この画素にはOtsu表示判定に必要な有効入力がそろっていません。固定入力分子と元のMSI座標を確認してください。';
  }

  function rawStatsForMask(raster, mask) {
    let n = 0, mean = 0, m2 = 0;
    for (let i = 0; i < mask.length; i++) {
      const value = raster && raster[i];
      if (!mask[i] || !Number.isFinite(value)) continue;
      n += 1;
      const delta = value - mean;
      mean += delta / n;
      m2 += delta * (value - mean);
    }
    return { mean: n ? mean : null, sd: n ? Math.sqrt(Math.max(0, m2 / n)) : null, n: n };
  }

  function roiDefinitionsForQuantification(project, table) {
    const result = table.rois.slice();
    const included = new Set(result.flatMap(roi => roi.keys || [roi.key]));
    const items = (project.roi || {}).roi_items || {};
    const names = (project.roi || {}).roi_names || {};
    Object.keys(items).forEach(key => {
      if (!included.has(key)) result.push({ key: key, name: names[key] || key, polys: [] });
    });
    return result;
  }

  function roiQuantificationRows(project, table, analysis, options) {
    const profile = project.normalization || {}, provenance = groupProvenance(project);
    const rows = [[
      'ROI key', 'ROI name', 'Molecule key', 'Molecule name', 'Role', 'Method', 'Normalized unit',
      'Raw mean', 'Raw SD (population)', 'Raw n', 'Normalized mean', 'Normalized SD (population)', 'Normalized n',
      'Absolute value', 'Absolute unit', 'Absolute status', 'Absolute reason codes', 'Absolute reason',
      'Geometry pixels', 'Measured pixels', 'Valid normalized pixels', 'Valid coverage',
      'Status', 'Reason codes', 'Reason', 'Reason counts',
      ...GROUP_COLUMNS, 'Normalization profile ID', 'Profile revision', 'Section factor',
      'Otsu-visible analytical pixels',
    ]];
    const summaries = [];
    roiDefinitionsForQuantification(project, table).forEach(roi => {
      checkCancelled(options);
      const mask = new Uint8Array(table.W * table.H);
      for (let y = 0; y < table.H; y++) {
        for (let x = 0; x < table.W; x++) {
          if (roi.polys.some(poly => table.pointInPolygon(x, y, poly))) mask[y * table.W + x] = 1;
        }
      }
      let results;
      try {
        if (!global.Normalization || typeof global.Normalization.quantifyRoi !== 'function') throw new Error('Unavailable');
        results = global.Normalization.quantifyRoi(project, analysis.rasters, analysis.evaluation, mask);
      } catch (error) {
        const nGeometry = mask.reduce((sum, v) => sum + v, 0);
        results = table.molecules.map(m => {
          const raw = rawStatsForMask(m.raster, mask);
          return { key: m.key, name: m.name, role: 'other', raw: raw,
            normalized: { mean: null, sd: null, n: 0 },
            absolute: { status: 'UNAVAILABLE', reasonCodes: ['NORMALIZATION_CALCULATION_FAILED'] },
            nGeometry: nGeometry, nMeasured: raw.n, nValid: 0, coverage: raw.n ? 0 : null,
            status: 'UNAVAILABLE', reasonCodes: ['NORMALIZATION_CALCULATION_FAILED'] };
        });
      }
      results.forEach(result => {
        const channel = analysis.evaluation.channels[result.key] || {};
        const raw = result.raw || {}, normalized = result.normalized || {}, absolute = result.absolute || {};
        let visible = null;
        if (analysis.otsu.usable && analysis.otsu.keep && channel.values) {
          visible = 0;
          for (let i = 0; i < mask.length; i++) {
            if (mask[i] && analysis.otsu.keep[i] && (!analysis.otsu.evaluable || analysis.otsu.evaluable[i]) &&
                Number.isFinite(channel.values[i])) visible += 1;
          }
        }
        rows.push([roi.key, roi.name, result.key, result.name, result.role,
          channel.method || '', channel.unit || '', finiteCell(raw.mean), finiteCell(raw.sd), finiteCell(raw.n),
          finiteCell(normalized.mean), finiteCell(normalized.sd), finiteCell(normalized.n),
          finiteCell(absolute.value), absolute.unit || '', absolute.status || 'UNAVAILABLE',
          codes(absolute.reasonCodes).join(' | '), reasonsText(absolute.reasonCodes),
          finiteCell(result.nGeometry), finiteCell(result.nMeasured), finiteCell(result.nValid), finiteCell(result.coverage),
          result.status || 'UNAVAILABLE', codes(result.reasonCodes).join(' | '), reasonsText(result.reasonCodes),
          safeJSON(result.reasonCounts || {}), ...groupCells(provenance), profile.id || '',
          profile.revision == null ? '' : profile.revision, finiteCell(profile.section && profile.section.k), visible]);
        summaries.push(result);
      });
    });
    return { rows: rows, summaries: summaries };
  }

  function normalizationSummary(project, analysis, roiResults) {
    const evaluation = analysis.evaluation, profile = evaluation.profile || project.normalization || {};
    const section = evaluation.section || profile.section || {};
    const absolute = roiResults.summaries.filter(r => r.role === 'ht').map(r => r.absolute || {});
    const absCodes = [...new Set(absolute.flatMap(r => codes(r.reasonCodes)))];
    if (!absolute.length) {
      absCodes.push('NO_ROI_QUANTIFICATION');
      if (!profile.calibration) absCodes.push('CALIBRATION_MISSING');
    }
    return {
      ...groupProvenance(project),
      status: evaluation.status || 'UNAVAILABLE', reasonCodes: codes(evaluation.reasonCodes),
      reasonText: reasonsText(evaluation.reasonCodes), batchId: profile.batchId || '',
      profileId: profile.id || '', revision: profile.revision == null ? '' : profile.revision,
      factor: finiteCell(section.k), quality: profile.quality || '',
      absoluteStatus: absolute.length ? [...new Set(absolute.map(a => a.status || 'UNAVAILABLE'))].join(' | ') : 'UNAVAILABLE',
      absoluteReasonCodes: absCodes, absoluteReasonText: reasonsText(absCodes),
      qcStatus: section.status || 'UNKNOWN',
    };
  }

  function normalizationMetadataRows(project, table, analysis, summary, headers) {
    const rows = [
      ['Field', 'Value'], ['Format', 'marmoset_atlas_normalization_v2'],
      ['Status', summary.status], ['Reason codes', summary.reasonCodes.join(' | ')], ['Reason', summary.reasonText],
      ...GROUP_COLUMNS.map((label, index) => [label, groupCells(summary)[index]]),
      ['Normalization profile ID', summary.profileId], ['Profile revision', summary.revision],
      ['Section factor', summary.factor],
      ['Group comparison', summary.groupId ? 'DA / NE use an independently fixed reference within this normalization group. Separate groups are not a shared comparison scale.' : 'Legacy profile: no folder-group scope was recorded.'],
      ['Group membership status convention', 'SAVED_GROUP: binding matches the saved group; full membership is not revalidated by export. SAVED_SNAPSHOT: no explicit current binding, e.g. standalone restoration. MOVED: current binding differs; derived values are unavailable. LEGACY: no saved folder scope.'],
      ['Raw data statement', 'Data / Data_NNN only: original raw Float32 intensities. No source values are modified.'],
      ['Registered raw completeness', 'A missing registered raw raster stops this workbook to avoid incomplete Data. An absent d4 channel or normalization profile does not stop raw export.'],
      ['Derived row convention', 'Same row universe, x/y and ROI membership as Data. Missing/invalid derived results remain blank, never zero-filled.'],
      ['Derived row status/reasons', 'Per-pixel usability and local failure reasons, plus whole-channel cautions. Faults at other pixels and channel-level PARTIAL/coverage summaries are not attached to a valid pixel; see channel metadata and ROI summaries.'],
      ['5-HT formula', 'Per-pixel 5-HT / d4-5-HT; finite numerator and accepted positive denominator at identical original MSI coordinates.'],
      ['DA / NE formula', 'Raw intensity * fixed section.k (Dref / Ds); not absolute quantification and not local analyte / d4.'],
      ['D4 and other channels', 'D4 is raw QC only; unsupported channels have no derived value. Consult Data for their raw intensities.'],
      ['Absolute quantification', 'ROI only, with validated compatible calibration and its declared responseAggregation; no pixelwise absolute values.'],
      ['Otsu convention', 'Display only. Otsu_Visible: 1 visible, 0 hidden, blank not applied/not evaluable. Neither tissue membership nor analytical validity.'],
      ['Otsu source', 'Saved committed raw-channel recipe only; export does not request consent, enable Otsu or alter the profile.'],
      ['Otsu status', analysis.otsu.status || 'NOT_APPLIED'],
      ['Otsu reason codes', codes(analysis.otsu.reasonCodes).join(' | ')],
      ['Otsu reason', analysis.otsu.reasonText || reasonsText(analysis.otsu.reasonCodes)],
      ['Current raw fingerprint', analysis.evaluation.fingerprint || ''],
      ['Calculation error', analysis.calculationError],
      [], ['Snapshot path', 'Value'],
    ];
    function appendSnapshot(path, value) {
      if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        if (!keys.length) rows.push([path, Array.isArray(value) ? '[]' : '{}']);
        keys.forEach(key => appendSnapshot(path + '.' + key, value[key]));
      } else {
        const text = typeof value === 'string' ? value : value == null ? '' : value;
        if (typeof text === 'string' && text.length > 32767) {
          for (let i = 0; i < text.length; i += 32000) rows.push([path + ' [part ' + (Math.floor(i / 32000) + 1) + ']', text.slice(i, i + 32000)]);
        } else rows.push([path, text]);
      }
    }
    appendSnapshot('normalization', project.normalization || null);
    appendSnapshot('normalizationBinding', project.normalizationBinding || null);
    appendSnapshot('valueDisplay', project.valueDisplay || null);
    appendSnapshot('otsu', project.otsu || { applied: false });
    rows.push([], ['Molecule key', 'Molecule name', 'Role', 'Method', 'Unit', 'Derived header', 'Status', 'Reason codes', 'Reason']);
    table.molecules.forEach((m, index) => {
      const c = analysis.evaluation.channels[m.key] || {};
      rows.push([m.key, m.name, c.role || '', c.method || '', c.unit || '', headers[2 + index],
        c.status || 'NOT_APPLIED', codes(c.reasonCodes).join(' | '), reasonsText(c.reasonCodes)]);
    });
    return rows;
  }

  function appendRowSheets(XLSXRef, workbook, rows, baseName) {
    const header = rows[0], data = rows.slice(1);
    const count = Math.max(1, Math.ceil(data.length / (EXCEL_MAX_ROWS - 1)));
    for (let index = 0; index < count; index++) {
      const sheetRows = [header].concat(data.slice(index * (EXCEL_MAX_ROWS - 1), (index + 1) * (EXCEL_MAX_ROWS - 1)));
      const sheet = XLSXRef.utils.aoa_to_sheet(sheetRows);
      const name = count === 1 ? baseName : baseName.slice(0, 27) + '_' + String(index + 1).padStart(3, '0');
      XLSXRef.utils.book_append_sheet(workbook, sheet, name);
    }
  }

  /**
   * 1 プロジェクト分の解析用 XLSX を ArrayBuffer として組み立てる。
   * Data は Excel の行上限を超える場合だけ Data_001, Data_002, ... に分割する。
   */
  async function buildProjectXlsx(project, deps, options) {
    const XLSXRef = requireDependency(global.XLSX, 'SheetJS (XLSX) が読み込まれていません');
    const ZipIORef = requireDependency(global.ZipIO, 'ZipIO が読み込まれていません');
    if (typeof ZipIORef.prepareProjectTable !== 'function' ||
        typeof ZipIORef.forEachProjectTableRow !== 'function') {
      throw new Error('ZipIO の Excel 書き出し API が利用できません');
    }
    if (!project || typeof project !== 'object') throw new Error('プロジェクトが指定されていません');

    const opts = options || {};
    const moleculeEstimate = Array.isArray(project.molecules) ? project.molecules.length : 0;
    if (2 + moleculeEstimate > EXCEL_MAX_COLUMNS) {
      throw new Error('Excel の列上限 (16,384 列) を超えています: 少なくとも ' +
        (2 + moleculeEstimate) + ' 列');
    }
    const table = await ZipIORef.prepareProjectTable(project, deps, {
      strict: true,
      groupRoisByName: true,
    });
    const headers = Array.isArray(table && table.headers)
      ? uniqueWorkbookHeaders(table.headers) : [];
    if (!headers.length) throw new Error('書き出す列がありません');
    if (headers.length > EXCEL_MAX_COLUMNS) {
      throw new Error('Excel の列上限 (16,384 列) を超えています: ' + headers.length + ' 列');
    }
    const analysis = prepareAnalysis(project, table);
    const derivedHeaders = normalizedHeaders(table, analysis);
    if (derivedHeaders.length > EXCEL_MAX_COLUMNS) {
      throw new Error('補正シートが Excel の列上限 (16,384 列) を超えています: ' + derivedHeaders.length + ' 列');
    }

    const chunkSize = Number.isFinite(opts.chunkSize) && opts.chunkSize > 0
      ? Math.min(10000, Math.floor(opts.chunkSize)) : DEFAULT_CHUNK_ROWS;
    const maxDataRows = EXCEL_MAX_ROWS - 1;
    const sheets = [];
    let current = null;
    let rowCount = 0;

    function newDataSheet() {
      current = {
        sheet: XLSXRef.utils.aoa_to_sheet([headers]),
        normalizedSheet: XLSXRef.utils.aoa_to_sheet([derivedHeaders]),
        batch: [],
        normalizedBatch: [],
        nextRow: 1,
        dataRows: 0,
      };
      sheets.push(current);
    }

    function flush() {
      if (!current || !current.batch.length) return;
      XLSXRef.utils.sheet_add_aoa(current.sheet, current.batch, {
        origin: { r: current.nextRow, c: 0 },
      });
      XLSXRef.utils.sheet_add_aoa(current.normalizedSheet, current.normalizedBatch, {
        origin: { r: current.nextRow, c: 0 },
      });
      current.nextRow += current.batch.length;
      current.batch = [];
      current.normalizedBatch = [];
      notifyProgress(opts, {
        phase: 'rows',
        rowCount: rowCount,
        dataSheetCount: sheets.length,
      });
      checkCancelled(opts);
    }

    newDataSheet();
    ZipIORef.forEachProjectTableRow(table, function (sourceRow) {
      checkCancelled(opts);
      if (!Array.isArray(sourceRow) || sourceRow.length !== headers.length) {
        throw new Error('データ行の列数がヘッダと一致しません (行 ' + (rowCount + 1) + ')');
      }
      if (current.dataRows >= maxDataRows) {
        flush();
        newDataSheet();
      }

      // Float32 生値を丸めたり文字列化したりせず、有限値だけ数値セルへ渡す。
      const row = sourceRow.map(value =>
        typeof value === 'number' ? (Number.isFinite(value) ? value : null) :
          (value == null ? null : value));
      current.batch.push(row);
      current.normalizedBatch.push(normalizedRow(sourceRow, table, analysis));
      current.dataRows += 1;
      rowCount += 1;
      if (current.batch.length >= chunkSize) flush();
    });
    flush();

    const moleculeCount = Array.isArray(table.molecules) ? table.molecules.length : 0;
    const roiCount = Array.isArray(table.rois) ? table.rois.length : 0;
    const when = exportedAt(opts.exportedAt);
    const roiResults = roiQuantificationRows(project, table, analysis, opts);
    const summary = normalizationSummary(project, analysis, roiResults);
    const info = {
      rowCount: rowCount,
      columnCount: headers.length,
      moleculeCount: moleculeCount,
      roiCount: roiCount,
      dataSheetCount: sheets.length,
      normalizedDataSheetCount: sheets.length,
      normalization: summary,
      warnings: Array.isArray(table.warnings) ? table.warnings.slice() : [],
      exportedAt: when,
      appVersion: stringValue(opts.appVersion || appVersion()),
      headers: headers,
    };

    const workbook = XLSXRef.utils.book_new();
    sheets.forEach((entry, index) => {
      const name = sheets.length === 1 ? 'Data' : 'Data_' + String(index + 1).padStart(3, '0');
      XLSXRef.utils.book_append_sheet(workbook, entry.sheet, name);
    });
    sheets.forEach((entry, index) => {
      const name = sheets.length === 1 ? 'Normalized_Data' : 'Normalized_Data_' + String(index + 1).padStart(3, '0');
      XLSXRef.utils.book_append_sheet(workbook, entry.normalizedSheet, name);
    });
    appendRowSheets(XLSXRef, workbook, roiResults.rows, 'ROI_Quantification');
    appendRowSheets(XLSXRef, workbook,
      normalizationMetadataRows(project, table, analysis, summary, derivedHeaders), 'Normalization_Metadata');
    XLSXRef.utils.book_append_sheet(workbook,
      makeMetadataSheet(XLSXRef, project, table, info), 'Metadata');
    workbook.Props = {
      Title: stringValue(project.displayName || project.name || project.id),
      Subject: 'Raw MSI intensities, separately derived normalization, and ROI quantification',
      Creator: 'marmoset_mouse_atlas' + (info.appVersion ? ' ' + info.appVersion : ''),
      CreatedDate: asDate(when),
    };

    checkCancelled(opts);
    notifyProgress(opts, { phase: 'workbook', rowCount: rowCount, dataSheetCount: sheets.length });
    const bytes = XLSXRef.write(workbook, { bookType: 'xlsx', type: 'array', compression: true });
    notifyProgress(opts, { phase: 'done', rowCount: rowCount, dataSheetCount: sheets.length });
    return Object.assign({ bytes: bytes }, info);
  }

  function normalizedRecord(record, index) {
    const warnings = record && (record.warnings == null ? record.warning : record.warnings);
    const error = record && (record.error == null ? record.errorMessage : record.error);
    let status = stringValue(record && record.status).toLowerCase();
    if (status === 'failed' || status === 'failure') status = 'error';
    if (errorText(error)) status = 'error';
    else if (warningText(warnings) && status !== 'error') status = 'warning';
    else if (!status || status === 'ok' || status === 'completed') status = 'success';

    return {
      sequence: record && (record.sequence != null ? record.sequence
        : record.index != null ? record.index : index + 1),
      status: status,
      projectId: stringValue(record && (record.projectId || record.id)),
      projectName: stringValue(record && (record.projectName || record.displayName || record.name)),
      folderPath: folderPathValue(record && (record.folderPath || record.folder)),
      workbookPath: stringValue(record &&
        (record.workbookPath || record.workbookName || record.filename || record.path)),
      rowCount: record && record.rowCount != null ? record.rowCount : '',
      moleculeCount: record && record.moleculeCount != null ? record.moleculeCount : '',
      moleculeNames: moleculeNameList(record),
      roiCount: record && record.roiCount != null ? record.roiCount : '',
      dataSheetCount: record && record.dataSheetCount != null ? record.dataSheetCount : '',
      warnings: warningText(warnings),
      error: errorText(error),
      normalization: (record && record.normalization) || {},
    };
  }

  /** 一括出力の成功・警告・失敗を 1 枚の Index シートへまとめる。 */
  function buildIndexXlsx(records, metadata) {
    const XLSXRef = requireDependency(global.XLSX, 'SheetJS (XLSX) が読み込まれていません');
    const source = Array.isArray(records) ? records : [];
    const normalized = source.map(normalizedRecord);
    const successCount = normalized.filter(r => r.status === 'success' || r.status === 'warning').length;
    const warningCount = normalized.filter(r => r.status === 'warning').length;
    const errorCount = normalized.filter(r => r.status === 'error').length;
    const meta = metadata || {};
    const when = exportedAt(meta.exportedAt);
    const rows = [
      ['Marmoset Mouse Atlas - Excel batch export'],
      ['Exported at (ISO 8601)', when],
      ['App version', stringValue(meta.appVersion || appVersion())],
      ['Archive status', stringValue(meta.status || (errorCount ? 'PARTIAL' : 'COMPLETE'))],
      ['Requested datasets', meta.requestedCount == null ? normalized.length : meta.requestedCount],
      ['Succeeded datasets', successCount],
      ['Datasets with warnings', warningCount],
      ['Failed datasets', errorCount],
    ];
    if (meta.archiveFilename) rows.push(['Archive filename', stringValue(meta.archiveFilename)]);
    if (meta.note || meta.notes) rows.push(['Note', warningText(meta.note || meta.notes)]);
    rows.push([], [
      'No.', 'Status', 'Project ID', 'Project name', 'Folder', 'Workbook path',
      'Data rows', 'Molecules', 'Molecule names', 'ROIs', 'Data sheets', 'Warnings', 'Error',
      'Normalization status', 'Batch ID', 'Normalization profile ID', 'Profile revision',
      'Section factor', 'Normalization quality', 'QC status', 'Normalization reason codes',
      'Normalization reason', 'Absolute ROI status', 'Absolute reason codes', 'Absolute reason',
      ...GROUP_COLUMNS,
    ]);
    normalized.forEach(record => rows.push([
      record.sequence, record.status, record.projectId, record.projectName,
      record.folderPath, record.workbookPath, record.rowCount, record.moleculeCount,
      moleculeNameSummary(record.moleculeNames), record.roiCount, record.dataSheetCount,
      record.warnings, record.error,
      record.normalization.status || 'NOT_EVALUATED', record.normalization.batchId || '',
      record.normalization.profileId || '', record.normalization.revision == null ? '' : record.normalization.revision,
      finiteCell(record.normalization.factor), record.normalization.quality || '', record.normalization.qcStatus || 'UNKNOWN',
      codes(record.normalization.reasonCodes).join(' | '), record.normalization.reasonText || '',
      record.normalization.absoluteStatus || 'NOT_EVALUATED', codes(record.normalization.absoluteReasonCodes).join(' | '),
      record.normalization.absoluteReasonText || '',
      ...groupCells(record.normalization),
    ]));

    const moleculeHeader = [
      'No.', 'Status', 'Project ID', 'Project name', 'Folder',
      'Molecule No.', 'Molecule name',
    ];
    const moleculeRowSheets = [];
    let moleculeRows = [moleculeHeader];
    let moleculeNameCount = 0;
    normalized.forEach(record => {
      record.moleculeNames.forEach((name, index) => {
        if (moleculeRows.length >= EXCEL_MAX_ROWS) {
          moleculeRowSheets.push(moleculeRows);
          moleculeRows = [moleculeHeader];
        }
        moleculeRows.push([
          record.sequence, record.status, record.projectId, record.projectName,
          record.folderPath, index + 1, name,
        ]);
        moleculeNameCount += 1;
      });
    });
    moleculeRowSheets.push(moleculeRows);

    const workbook = XLSXRef.utils.book_new();
    const sheet = XLSXRef.utils.aoa_to_sheet(rows);
    sheet['!cols'] = [
      { wch: 8 }, { wch: 11 }, { wch: 38 }, { wch: 30 }, { wch: 36 }, { wch: 54 },
      { wch: 14 }, { wch: 12 }, { wch: 52 }, { wch: 10 }, { wch: 12 },
      { wch: 58 }, { wch: 58 },
      { wch: 24 }, { wch: 24 }, { wch: 36 }, { wch: 18 }, { wch: 18 }, { wch: 24 },
      { wch: 22 }, { wch: 44 }, { wch: 64 }, { wch: 24 }, { wch: 44 }, { wch: 64 },
      { wch: 38 }, { wch: 38 }, { wch: 38 }, { wch: 24 }, { wch: 18 }, { wch: 24 }, { wch: 22 }, { wch: 24 },
    ];
    XLSXRef.utils.book_append_sheet(workbook, sheet, 'Index');
    moleculeRowSheets.forEach((moleculeSheetRows, index) => {
      const moleculeSheet = XLSXRef.utils.aoa_to_sheet(moleculeSheetRows);
      moleculeSheet['!cols'] = [
        { wch: 8 }, { wch: 11 }, { wch: 38 }, { wch: 30 },
        { wch: 36 }, { wch: 14 }, { wch: 42 },
      ];
      const name = moleculeRowSheets.length === 1 ? 'Molecules' :
        'Molecules_' + String(index + 1).padStart(3, '0');
      XLSXRef.utils.book_append_sheet(workbook, moleculeSheet, name);
    });
    workbook.Props = {
      Title: 'Marmoset Mouse Atlas - Excel batch export index',
      Creator: 'marmoset_mouse_atlas' + (appVersion() ? ' ' + appVersion() : ''),
      CreatedDate: asDate(when),
    };
    const bytes = XLSXRef.write(workbook, { bookType: 'xlsx', type: 'array', compression: true });
    return {
      bytes: bytes,
      recordCount: normalized.length,
      successCount: successCount,
      warningCount: warningCount,
      errorCount: errorCount,
      moleculeNameCount: moleculeNameCount,
      moleculeSheetCount: moleculeRowSheets.length,
      exportedAt: when,
    };
  }

  global.ExcelIO = {
    buildProjectXlsx: buildProjectXlsx,
    buildIndexXlsx: buildIndexXlsx,
    sanitizeFileComponent: sanitizeFileComponent,
    makeUniqueWorkbookName: makeUniqueWorkbookName,
    makeArchiveFilename: makeArchiveFilename,
    limits: {
      maxRows: EXCEL_MAX_ROWS,
      maxColumns: EXCEL_MAX_COLUMNS,
      dataRowsPerSheet: EXCEL_MAX_ROWS - 1,
    },
  };
})(window);
