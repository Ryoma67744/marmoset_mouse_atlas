/* Each row describes one gene in one annotated cortical layer. */
(function (global) {
  'use strict';
  const layers = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
  const pageSize = 10;
  const count = new Intl.NumberFormat('ja-JP');
  const expression = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 3 });
  const percent = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
  const names = new Intl.Collator('en');
  let xlsxRequest;

  function numberText(value, formatter, precision) {
    if (!Number.isFinite(value)) return '—';
    if (value !== 0 && Math.abs(value) < precision) return value.toPrecision(2);
    return formatter.format(value);
  }

  function ensureXlsx(url) {
    if (global.XLSX) return Promise.resolve();
    if (!xlsxRequest) {
      xlsxRequest = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.onload = () => global.XLSX ? resolve() : reject(new Error('Excel出力を初期化できませんでした。'));
        script.onerror = () => reject(new Error('Excel出力のライブラリを読み込めませんでした。'));
        document.head.append(script);
      }).catch(error => {
        xlsxRequest = null;
        throw error;
      });
    }
    return xlsxRequest;
  }

  function create(root, actions) {
    const el = name => root.querySelector('#la-' + name);
    const layerInput = el('layer'), search = el('query'), order = el('order');
    const download = el('save'), exportStatus = el('export-status');
    let context, data = null, request = 0, loading = false, errorMessage = '', saving = false;
    let layer = 'L1', rows = [], filtered = [], page = 0;

    function updateDownload() {
      download.disabled = !data || saving;
      download.setAttribute('aria-busy', String(saving));
    }

    function renderRows() {
      const body = el('gene-rows');
      const start = page * pageSize;
      body.replaceChildren();
      for (const row of filtered.slice(start, start + pageSize)) {
        const tr = body.insertRow();
        if (context.gene === row.gene) tr.setAttribute('aria-current', 'true');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = row.gene;
        button.title = row.gene + ' の空間図を表示';
        button.addEventListener('click', () => actions.gene(row.gene));
        tr.insertCell().append(button);
        tr.insertCell().textContent = numberText(row.mean, expression, 0.001);
        tr.insertCell().textContent = count.format(row.detected);
        tr.insertCell().textContent = count.format(row.n);
        tr.insertCell().textContent = numberText(row.pct, percent, 0.1) + '%';
      }
      el('count').textContent = filtered.length
        ? count.format(start + 1) + '–' + count.format(Math.min(start + pageSize, filtered.length)) + ' / ' + count.format(filtered.length) + ' 遺伝子'
        : '該当する遺伝子はありません。';
      el('prev').disabled = page === 0;
      el('next').disabled = start + pageSize >= filtered.length;
    }

    function filterRows() {
      const query = search.value.trim().toUpperCase();
      filtered = query ? rows.filter(row => row.gene.toUpperCase().includes(query)) : rows;
      page = 0;
      renderRows();
    }

    function sortRows() {
      const field = order.value;
      rows.sort((a, b) => (field === 'gene' ? 0 : b[field] - a[field]) || names.compare(a.gene, b.gene));
      filterRows();
    }

    function renderMsi() {
      const row = context.msiRows.find(item => item.region === layer);
      const prefix = context.source.section + ' · ' + layer + ' · ' + context.molecule + '　';
      el('molecule').value = context.molecule;
      el('msi-summary').textContent = prefix + (row?.status === 'ok'
        ? '中央値 ' + numberText(row.median, expression, 0.001) + ' a.u.（実測 ' + count.format(row.measuredPixels) + ' / ROI ' + count.format(row.geometryPixels) + ' 画素）'
        : row?.reason || '保存ROIの測定値がありません。');
    }

    function renderStatus() {
      el('results').hidden = !data;
      layerInput.disabled = search.disabled = order.disabled = !data;
      el('retry').hidden = !errorMessage;
      if (data) {
        const bins = data.meta.counts[data.groups.indexOf(layer)];
        el('status').textContent = context.section + ' · ' + layer + ' · ' + count.format(bins) + ' bin · ' + count.format(data.genes.length) + ' 遺伝子';
      } else {
        el('status').textContent = loading ? context.section + ' の層別データを読み込み中…' : errorMessage;
      }
      updateDownload();
    }

    function refreshLayer() {
      layerInput.value = layer;
      // Sorting the table must leave the source gene order unchanged for downloads.
      rows = data ? [...data.layerRows(layer)] : [];
      sortRows();
      renderStatus();
      renderMsi();
    }

    async function fetchSection(section) {
      const current = ++request;
      data = null;
      loading = true;
      errorMessage = '';
      refreshLayer();
      try {
        const result = await global.STLayerData.loadProfiles(section);
        if (current !== request) return;
        if (!result || !layers.some(key => result.groups.includes(key))) {
          throw new Error('この切片には層別の集計がありません。');
        }
        data = result;
        for (const option of layerInput.options) {
          option.disabled = !data.groups.includes(option.value);
        }
        if (!data.groups.includes(layer)) {
          layer = layers.find(key => data.groups.includes(key));
          actions.group(layer);
        }
      } catch (error) {
        if (current !== request) return;
        errorMessage = '層別データを取得できませんでした。' + (error.message || error);
      }
      loading = false;
      refreshLayer();
    }

    function setGroup(value) {
      if (!layers.includes(value) || value === layer || (data && !data.groups.includes(value))) return;
      layer = value;
      refreshLayer();
    }

    layerInput.addEventListener('change', () => {
      setGroup(layerInput.value);
      actions.group(layer);
    });
    el('molecule').addEventListener('change', event => actions.molecule(event.target.value));
    el('retry').addEventListener('click', () => fetchSection(context.section));
    search.addEventListener('input', filterRows);
    order.addEventListener('change', sortRows);
    el('prev').addEventListener('click', () => { if (page > 0) { page--; renderRows(); } });
    el('next').addEventListener('click', () => { if ((page + 1) * pageSize < filtered.length) { page++; renderRows(); } });

    download.addEventListener('click', async () => {
      if (!data || saving) return;
      const chosenLayers = el('export-scope').value === 'all' ? layers.filter(key => data.groups.includes(key)) : [layer];
      const params = {
        data, section: context.section, layers: chosenLayers, format: el('format').value,
        msiRows: context.msiRows, msiSection: context.source.section, molecule: context.molecule
      };
      const subject = params.section + ' ' + chosenLayers.join('・');
      saving = true;
      updateDownload();
      exportStatus.textContent = subject + ' の出力を準備中…';
      try {
        if (params.format === 'xlsx') await ensureXlsx(root.dataset.xlsxSrc);
        await global.STLayerExtract.save(params);
        exportStatus.textContent = subject + ' の保存を開始しました。';
      } catch (error) {
        exportStatus.textContent = '出力できませんでした。' + (error.message || error);
      } finally {
        saving = false;
        updateDownload();
      }
    });

    function update(value) {
      const previous = context;
      context = value;
      if (value.section !== previous?.section) {
        if (!saving) exportStatus.textContent = '';
        fetchSection(value.section);
      } else {
        renderMsi();
        if (value.gene !== previous.gene) renderRows();
      }
    }

    return { update, setGroup };
  }

  global.STLayerPanel = { create };
})(window);
