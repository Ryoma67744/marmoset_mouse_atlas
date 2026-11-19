/* Descriptive expression for native cortical layers. Exports retain the full gene catalog. */
(function (root) {
  'use strict';
  const geneFields = {
    gene: '原データに収録された遺伝子名。各層の表は1行が1遺伝子です。',
    mean_cp10k: '各binの遺伝子カウントを総RNAカウントで割って10,000倍し、検出ゼロのbinも含めて層内で平均した値。',
    detected_bins: 'この遺伝子のRNA生カウントが1以上だったbinの数。',
    total_bins: 'その層の集計に使った全bin数。検出率の分母です。',
    detection_pct: '検出率（%）。100 × detected_bins ÷ total_bins。',
  };
  const fields = Object.keys(geneFields);

  const msiFields = {
    msi_section: 'MSI信号を取得した切片、または取得対象に選んだ切片の識別子。',
    molecule: '画面で選択したMSI分子名。',
    layer: 'MSIの保存ROIに対応する皮質層名。',
    median_au: 'ROI内で有限の信号値がある画素の生信号中央値（a.u.、任意単位）。',
    measured_pixels: '選択分子の生信号が有限値であるROI内の画素数。実測値0の画素も含みます。',
    roi_pixels: 'ROIの形状に含まれる全画素数。',
    missing_pixels: 'ROIの全画素のうち、選択分子の有限な測定値がない画素数。',
    status: 'MSIの集計状態。okは集計済みです。値を取得できない場合はreason欄を参照してください。',
    reason: '未読込、ROI未登録、信号の欠測などについての個別の理由。',
    roi_id: '集計に用いたROIの識別子。',
    source_keys: 'ROIの定義に使った元の保存領域のキー。',
    rule_version: 'ROIの定義に適用したルールの版。',
  };

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

    const meta = data.meta;
    const metadata = [
      ['st_section', section, 'ST切片の識別子。'],
      ['layers', layers.join(', '), 'このファイルに出力した皮質層。'],
      ['gene_count_per_layer', data.genes.length, '各層のシートに収録した遺伝子数。'],
      ['scope', meta.scope, '層の集計に使った切片内の解剖学的範囲。'],
      ['normalization', meta.normalization, '遺伝子の発現量を計算した方法。'],
      ['detection_pct', '100 × bins with positive raw counts / eligible bins in the layer', '検出率の計算式。'],
      ['source', meta.sourceUrl, '集計元の公開STデータのURL。'],
      ['source_sha256', meta.sourceSha256, '元データを識別するSHA-256チェックサム。'],
      ['summary_sha256', meta.dataSha256, '層別集計ファイルを識別するSHA-256チェックサム。'],
    ];
    const includeMsi = Boolean(msiSection && Array.isArray(msiRows));
    const guide = [
      ['収録内容', 'ST切片', section],
      ['収録内容', '集計範囲', meta.scope],
      ['読み方', 'bin', 'STの測定位置を区切った空間区画。検出率は発現を検出した区画の割合です。'],
      ...layers.map(layer => ['シート', layer,
        section + 'の皮質' + layer + '。対象' + meta.counts[data.groups.indexOf(layer)].toLocaleString('ja-JP') +
        ' bin、全' + data.genes.length.toLocaleString('ja-JP') + '遺伝子の層内集計を収録。']),
      ['シート', 'Metadata', '出力条件、集計方法、公開データの出典を記録しています。'],
    ];
    if (includeMsi) guide.push(['シート', 'MSI_ROI', 'MSI切片 ' + msiSection + ' の保存ROIについて、選択分子 ' + molecule + ' の集計状態と測定値を層別に収録。']);
    for (const [field, description] of Object.entries(geneFields)) guide.push(['遺伝子シートの列', field, description]);
    guide.push(['読み方', '遺伝子シートの0', 'detected_bins が0の行は、対象層のどのbinでもこの遺伝子のカウントが検出されなかったことを示します。']);
    for (const [key, , description] of metadata) guide.push(['Metadataの項目', key, description]);
    if (includeMsi) {
      for (const [field, description] of Object.entries(msiFields)) guide.push(['MSI_ROIの列', field, description]);
      guide.push(['読み方', 'MSIの0と空欄', '中央値の0は集計された数値です。中央値が空欄の場合はstatusとreasonで理由を確認できます。']);
    }
    sheet('説明', ['区分', '項目', '説明'], guide, [22, 25, 116]);
    for (const layer of layers) {
      sheet(layer, fields, data.layerRows(layer).map(cells), [25, 21, 16, 16, 21]);
    }
    sheet('Metadata', ['key', 'value'], metadata.map(([key, value]) => [key, value]), [25, 90]);

    if (includeMsi) {
      const roi = new Map(msiRows.map(row => [row.region, row]));
      const rows = layers.map(layer => {
        const row = roi.get(layer);
        return [msiSection, molecule, layer, row?.median, row?.measuredPixels, row?.geometryPixels,
          row?.missingPixels, row?.status || 'not_loaded', row?.reason, row?.roiId,
          row?.sourceKeys?.join(', '), row?.ruleVersion];
      });
      sheet('MSI_ROI', Object.keys(msiFields), rows, [18, 16, 10, 16, 18, 16, 16, 22, 60, 20, 28, 18]);
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
