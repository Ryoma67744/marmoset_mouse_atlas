/* Descriptive expression for native cortical layers. Exports retain the full gene catalog. */
(function (root) {
  'use strict';
  const fields = ['gene', 'mean_cp10k', 'detected_bins', 'total_bins', 'detection_pct'];

  function validate({ data, section, layers }) {
    if (!data || data.meta.section !== section || !Array.isArray(layers) || !layers.length ||
        new Set(layers).size !== layers.length || !layers.every(layer => data.layers.includes(layer))) {
      throw new Error('出力する切片と皮質層を選択してください。');
    }
  }

  function cells(row) {
    return [row.gene, row.mean, row.detected, row.n, row.pct];
  }

  function csvField(value) {
    const text = String(value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function buildCsv(selection) {
    validate(selection);
    const { data, section, layers } = selection;
    const parts = ['\uFEFF', ['st_section', 'layer', ...fields].join(',') + '\r\n'];
    for (const layer of layers) {
      const lines = data.layerRows(layer).map(row =>
        [section, layer, ...cells(row)].map(csvField).join(','));
      parts.push(lines.join('\r\n') + '\r\n');
    }
    return new Blob(parts, { type: 'text/csv;charset=utf-8' });
  }

  function buildWorkbook(selection) {
    validate(selection);
    const { data, section, layers, msiRows, msiSection, molecule } = selection;
    const xlsx = root.XLSX;
    if (!xlsx) throw new Error('Excelの出力ライブラリを読み込めませんでした。');
    const workbook = xlsx.utils.book_new();

    function sheet(name, header, rows, widths) {
      const table = xlsx.utils.aoa_to_sheet([header, ...rows], { dense: true });
      table['!cols'] = widths.map(wch => ({ wch }));
      table['!autofilter'] = { ref: table['!ref'] };
      xlsx.utils.book_append_sheet(workbook, table, name);
    }

    for (const layer of layers) {
      sheet(layer, fields, data.layerRows(layer).map(cells), [25, 21, 16, 16, 21]);
    }
    const meta = data.meta;
    sheet('Metadata', ['key', 'value'], [
      ['st_section', section], ['layers', layers.join(', ')], ['gene_count_per_layer', data.genes.length],
      ['scope', meta.scope], ['normalization', meta.normalization],
      ['detection_pct', '100 × bins with positive raw counts / eligible bins in the layer'],
      ['source', meta.sourceUrl], ['source_sha256', meta.sourceSha256], ['summary_sha256', meta.dataSha256],
    ], [25, 90]);

    if (msiSection && Array.isArray(msiRows)) {
      const roi = new Map(msiRows.map(row => [row.region, row]));
      const header = ['msi_section', 'molecule', 'layer', 'median_au', 'measured_pixels',
        'roi_pixels', 'missing_pixels', 'status', 'reason', 'roi_id', 'source_keys', 'rule_version'];
      const rows = layers.map(layer => {
        const row = roi.get(layer);
        return [msiSection, molecule, layer, row?.median, row?.measuredPixels, row?.geometryPixels,
          row?.missingPixels, row?.status || 'not_loaded', row?.reason, row?.roiId,
          row?.sourceKeys?.join(', '), row?.ruleVersion];
      });
      sheet('MSI_ROI', header, rows, [18, 16, 10, 16, 18, 16, 16, 22, 60, 20, 28, 18]);
    }
    // SheetJS 0.18 returns Uint8Array in browsers for buffer output. The array
    // mode converts the whole archive through a binary string and doubles peak memory.
    return xlsx.write(workbook, { bookType: 'xlsx', type: 'buffer', compression: true });
  }

  async function save(selection) {
    const { format, section, layers } = selection;
    let blob;
    if (format === 'csv') {
      blob = buildCsv(selection);
    } else if (format === 'xlsx') {
      blob = new Blob([buildWorkbook(selection)], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    } else {
      throw new Error('CSVまたはExcelを選択してください。');
    }
    const link = root.document.createElement('a');
    const url = URL.createObjectURL(blob);
    const label = layers.length === 6 ? 'L1-L6' : layers.join('-');
    link.download = section + '_' + label + '.' + format;
    link.href = url;
    root.document.body.append(link);
    try {
      link.click();
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  }

  const api = Object.freeze({ buildCsv, buildWorkbook, save });
  root.STLayerExtract = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
