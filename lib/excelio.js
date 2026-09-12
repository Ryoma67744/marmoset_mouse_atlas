/*
 * excelio.js — 解析用 Excel ワークブックの生成
 *
 * 既存の復元用 ZIP とは独立し、保存済み MSI 生値と ROI 所属だけを XLSX にする。
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
      ['Value provenance', 'MSI values are stored raw Float32 intensities; non-finite values are blank. No display range, color, rotation, alignment, Otsu threshold, interpolation, or normalization is applied.'],
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

    const chunkSize = Number.isFinite(opts.chunkSize) && opts.chunkSize > 0
      ? Math.min(10000, Math.floor(opts.chunkSize)) : DEFAULT_CHUNK_ROWS;
    const maxDataRows = EXCEL_MAX_ROWS - 1;
    const sheets = [];
    let current = null;
    let rowCount = 0;

    function newDataSheet() {
      current = {
        sheet: XLSXRef.utils.aoa_to_sheet([headers]),
        batch: [],
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
      current.nextRow += current.batch.length;
      current.batch = [];
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
      current.dataRows += 1;
      rowCount += 1;
      if (current.batch.length >= chunkSize) flush();
    });
    flush();

    const moleculeCount = Array.isArray(table.molecules) ? table.molecules.length : 0;
    const roiCount = Array.isArray(table.rois) ? table.rois.length : 0;
    const when = exportedAt(opts.exportedAt);
    const info = {
      rowCount: rowCount,
      columnCount: headers.length,
      moleculeCount: moleculeCount,
      roiCount: roiCount,
      dataSheetCount: sheets.length,
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
    XLSXRef.utils.book_append_sheet(workbook,
      makeMetadataSheet(XLSXRef, project, table, info), 'Metadata');
    workbook.Props = {
      Title: stringValue(project.displayName || project.name || project.id),
      Subject: 'Raw MSI intensity and ROI membership export',
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
    ]);
    normalized.forEach(record => rows.push([
      record.sequence, record.status, record.projectId, record.projectName,
      record.folderPath, record.workbookPath, record.rowCount, record.moleculeCount,
      moleculeNameSummary(record.moleculeNames), record.roiCount, record.dataSheetCount,
      record.warnings, record.error,
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
