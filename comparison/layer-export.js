/* Exports take one immutable selection from the comparison panel. ST and MSI
   units, anatomical scope and replication are kept separate in every format. */
(function (root) {
  'use strict';
  const contrastFields = [
    'gene', 'contrast', 'targetMean', 'referenceMean', 'targetDetected', 'targetN',
    'targetPct', 'referenceDetected', 'referenceN', 'referencePct', 'log2FC',
    'averageLog2', 'status', 'modelLog2FC', 'p', 'q', 'testStatus'
  ];
  const msiFields = ['group', 'median', 'n', 'geometry', 'missingPixels', 'status', 'reason', 'roiId', 'sourceKeys', 'ruleVersion'];
  const profileFields = ['gene', 'group', 'mean', 'detected', 'n', 'pct'];
  const label = key => key === 'V1' ? 'V1 対 V2' : key + ' 対 他5層';
  const safeCell = value => value === Infinity ? '+Inf' : value === -Infinity ? '-Inf' :
    typeof value === 'number' && !Number.isFinite(value) ? null : value ?? null;
  const setOfGenes = c => c.scope === 'gene' ? [c.gene] : c.st.genes;
  const setOfContrasts = c => c.scope === 'all' ? c.st.contrasts : [c.contrast];
  function settings(c) {
    return {
      stSection: c.sectionId, msiSection: c.msiSection, projectId: c.projectId || null,
      pairing: c.sampleMode === 'reference' ? '同名領域の解剖学的参照' : '登録ペア',
      specimenRelationship: 'MSIとSTは別試料、同名領域で照合。座標は独立。',
      msiMolecule: c.molecule, msiUnit: '生信号 a.u.', msiStatus: c.msiStatus || null,
      msiSavedAt: c.source?.updatedAt || null, msiLoadedAt: c.source?.loadedAt || null,
      roiRule: c.source?.roiRuleVersion || null, msiSourceUrl: c.source?.projectUrl || null,
      msiSummary: '登録ROI内の選択分子の有限な生信号の中央値。ゼロを含み、欠測は除外。',
      contrast: label(c.contrast), gene: c.gene, groupsExported: c.st.groups,
      contrastsExported: setOfContrasts(c).map(label), genesExported: setOfGenes(c).length,
      selectedRegion: c.group || c.contrast, geneQuery: c.query || null, tableOrder: c.order || null,
      scope: c.scope || 'contrast', plot: c.plotMode || 'MA', effectThreshold: c.fcCutoff ?? null,
      adjustedPThreshold: c.qCutoff ?? null, displayDirection: c.direction || null,
      exportedAt: new Date().toISOString(), applicationVersion: root.APP_VERSION || null,
      stScope: '収録皮質の同番号層を合算。V1/V2は領域全体。両集計軸は重複。',
      stUnit: '各binの全遺伝子総RNAでCP10k正規化。実測ゼロを含む算術平均。',
      comparisonRule: '他5層の発現と検出率は各層を等重み。V1はV2全体と比較。',
      testInterpretation: 'p と q は空間ブロックモデルによる単一切片内の探索的比較。q は検定対象遺伝子に対する対比別のBH調整P値。空欄の理由は testStatus に記録。画素・binは個体反復に数えない。',
      displayFilter: '図・画面の絞り込みは遺伝子表の収録範囲を変えない。',
      data: c.st.meta
    };
  }
  function values(row, fields) { return fields.map(k => Array.isArray(row[k]) ? JSON.stringify(row[k]) : safeCell(row[k])); }
  function* profiles(c) {
    for (const gene of setOfGenes(c)) {
      for (const row of c.st.profile(gene)) yield values({ gene, ...row }, profileFields);
    }
  }
  function* contrasts(c, keys = setOfContrasts(c)) {
    for (const key of keys) {
      for (const gene of setOfGenes(c)) yield values(c.st.compare(gene, key), contrastFields);
    }
  }
  function msi(c) { return (c.msiRows || []).map(row => values(row, msiFields)); }
  const compression = { type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 3 } };
  function archive() {
    if (!root.JSZip) throw new Error('ZIP出力ライブラリを読み込めません。');
    return new root.JSZip();
  }
  // JSZip keeps compressed members on load and reuses their deflated bytes when
  // generating the final archive. Only the current worksheet/TSV is expanded.
  async function addTextFile(zip, name, lines) {
    const encoder = new TextEncoder(), chunks = [];
    let buf = '', size = 0, start = Date.now();
    function flush() {
      const chunk = encoder.encode(buf);
      chunks.push(chunk);
      size += chunk.length;
      buf = '';
    }
    for (const line of lines) {
      buf += line;
      if (buf.length >= 256 * 1024) {
        flush();
        if (Date.now() - start > 45) {
          await new Promise(resolve => setTimeout(resolve, 0));
          start = Date.now();
        }
      }
    }
    if (buf) flush();
    const member = archive();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
    chunks.length = 0;
    member.file(name, bytes, { createFolders: false });
    await zip.loadAsync(await member.generateAsync(compression));
  }
  function* tsv(header, rows) {
    function field(x) {
      const s = x == null ? '' : String(x);
      return /[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    yield '\uFEFF' + header.join('\t') + '\n';
    for (const row of rows) yield row.map(field).join('\t') + '\n';
  }
  const mainNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const pkgNs = 'http://schemas.openxmlformats.org/package/2006/';
  const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.';
  const xmlHead = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const xml = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function column(index) {
    let name = '';
    for (let i = index + 1; i > 0; i = Math.floor((i - 1) / 26)) name = String.fromCharCode(65 + (i - 1) % 26) + name;
    return name;
  }
  function* worksheet(header, rows, count) {
    const end = column(header.length - 1) + (count + 1);
    const cols = header.map((h, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' +
      (h === 'value' ? 75 : Math.max(12, Math.min(32, h.length + 3))) + '" customWidth="1"/>').join('');
    yield xmlHead + '<worksheet xmlns="' + mainNs + '"><dimension ref="A1:' + end + '"/>' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<cols>' + cols + '</cols><sheetData>';
    const letters = header.map((_, i) => column(i));
    function rowXml(row, n) {
      let out = '<row r="' + n + '">';
      for (let j = 0; j < row.length; j++) {
        const value = row[j];
        if (value == null || value === '') continue;
        const ref = letters[j] + n;
        if (typeof value === 'number' && Number.isFinite(value)) out += '<c r="' + ref + '"><v>' + value + '</v></c>';
        else {
          const str = String(value).replace(/_x[0-9a-f]{4}_/gi, match => '_x005F_' + match.slice(1))
            .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F]/g, ch => '_x' + ch.charCodeAt(0).toString(16).padStart(4, '0') + '_');
          out += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xml(str) + '</t></is></c>';
        }
      }
      return out + '</row>';
    }
    yield rowXml(header, 1);
    let n = 1;
    for (const row of rows) yield rowXml(row, ++n);
    if (n !== count + 1) throw new Error('Excel出力行数が一致しません。');
    yield '</sheetData><autoFilter ref="A1:' + end + '"/></worksheet>';
  }
  async function buildWorkbook(c) {
    const zip = archive(), names = [], genes = setOfGenes(c);
    async function sheet(name, header, rows, count) {
      names.push(name);
      await addTextFile(zip, 'xl/worksheets/sheet' + names.length + '.xml', worksheet(header, rows, count));
    }
    const regionRows = c.st.profile(genes[0]).map(r => [r.group, r.n]);
    function* wideProfiles() {
      for (const gene of genes) yield [gene, ...c.st.profile(gene).flatMap(r => [r.mean, r.detected, r.pct])];
    }
    await sheet('ST_expression', ['gene', ...c.st.groups.flatMap(k => [k+'_mean_cp10k',k+'_detected',k+'_pct'])], wideProfiles(), genes.length);
    for (const key of setOfContrasts(c)) await sheet('Contrast_' + key, contrastFields, contrasts(c, [key]), genes.length);
    await sheet('Regions', ['group','n_bins'], regionRows, regionRows.length);
    const roiRows = msi(c);
    await sheet('MSI_ROI', msiFields, roiRows, roiRows.length);
    const {data, ...config} = settings(c);
    const entries = [...Object.entries(config), ...Object.entries(data || {}).map(([k,v]) => ['st.' + k,v])];
    const meta = entries.map(([k, v]) => [k, typeof v === 'object' && v !== null ? JSON.stringify(v) : v]);
    await sheet('Conditions', ['key','value'], meta, meta.length);
    const rel = (id, type, target) => '<Relationship Id="rId' + id + '" Type="' + relNs + '/' + type + '" Target="' + target + '"/>';
    const relationships = list => xmlHead + '<Relationships xmlns="' + pkgNs + 'relationships">' + list.join('') + '</Relationships>';
    zip.file('_rels/.rels', relationships([rel(1, 'officeDocument', 'xl/workbook.xml')]));
    zip.file('xl/_rels/workbook.xml.rels', relationships(names.map((_, i) => rel(i+1, 'worksheet', 'worksheets/sheet' + (i+1) + '.xml'))));
    zip.file('xl/workbook.xml', xmlHead + '<workbook xmlns="' + mainNs + '" xmlns:r="' + relNs + '"><bookViews><workbookView/></bookViews><sheets>' +
      names.map((name,i) => '<sheet name="' + xml(name) + '" sheetId="' + (i+1) + '" r:id="rId' + (i+1) + '"/>').join('') + '</sheets></workbook>');
    zip.file('[Content_Types].xml', xmlHead + '<Types xmlns="' + pkgNs + 'content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="' + mime + 'sheet.main+xml"/>' +
      names.map((_,i) => '<Override PartName="/xl/worksheets/sheet' + (i+1) + '.xml" ContentType="' + mime + 'worksheet+xml"/>').join('') + '</Types>');
    return zip.generateAsync(compression);
  }
  async function buildZip(c) {
    const zip = archive();
    zip.file('conditions.json', JSON.stringify(settings(c), null, 2));
    await addTextFile(zip, 'msi_roi.tsv', tsv(msiFields, msi(c)));
    await addTextFile(zip, 'st_region_expression.tsv', tsv(profileFields, profiles(c)));
    for (const key of setOfContrasts(c)) await addTextFile(zip, 'contrast_' + key + '.tsv', tsv(contrastFields, contrasts(c,[key])));
    return zip.generateAsync(compression);
  }
  function reportData(c) {
    const keys = setOfContrasts(c), names = setOfGenes(c), groups = c.st.groups;
    const rows = names.map(gene => {
      const profile = c.st.profile(gene);
      return [gene,profile.map(r => r.mean),profile.map(r => r.detected),
        keys.map(k => {const r = c.st.compare(gene,k);return [safeCell(r.log2FC),r.averageLog2,r.modelLog2FC??null,r.p,r.q,r.testStatus];})];
    });
    return {settings:settings(c),msi:c.msiRows?.map(r => Object.fromEntries(msiFields.map(k => [k,safeCell(r[k])])))||[],
      keys,groups,counts:c.st.profile(names[0]).map(r => r.n),rows,active:c.contrast};
  }
  // Serialized into the report. It deliberately uses only the embedded snapshot.
  function mountReport() {
    const d = JSON.parse(document.getElementById('data').textContent);
    const $ = id => document.getElementById(id);
    const select = $('contrast'), query = $('gene'), list = $('suggestions');
    const mode = $('mode'), canvas = $('plot'), ctx = canvas.getContext('2d');
    const fcInput = $('fc'), qInput = $('q'), direction = $('direction');
    let fc = d.settings.effectThreshold ?? 1, q = d.settings.adjustedPThreshold ?? .05;
    fcInput.value = fc; qInput.value = q; direction.value = d.settings.displayDirection || 'all';
    const names = new Map(d.rows.map((r,i) => [r[0].toUpperCase(),i]));
    let index = names.get(d.settings.gene?.toUpperCase()) ?? 0;
    let points = [];
    const num = v => Number.isFinite(v) ? Number(v.toPrecision(5)).toLocaleString('ja-JP', {maximumSignificantDigits:5}) : v ?? '—';
    function textRow(target, vals) {
      const tr = document.createElement('tr');
      for (const v of vals) {const td = document.createElement('td');td.textContent = v ?? '—';tr.append(td);}
      target.append(tr);
    }
    function option(el, value, name) { const o = document.createElement('option');o.value = value;o.textContent = name;el.append(o); }
    d.keys.forEach(k => option(select,k,k === 'V1' ? 'V1 対 V2' : k+' 対 他5層'));
    select.value=d.active;
    function candidates() {
      const q = query.value.trim().toUpperCase();
      list.replaceChildren();
      let n=0;
      for (const row of d.rows) if (row[0].toUpperCase().includes(q)) {
        option(list,row[0],row[0]); if (++n === 40) break;
      }
    }
    function pick(i) {index=i;query.value=d.rows[i][0];$('message').textContent='';draw();}
    function choose() {
      const i=names.get(query.value.trim().toUpperCase());
      if (i !== undefined) pick(i); else $('message').textContent='該当する遺伝子がありません。';
    }
    for (const row of d.msi) textRow($('msi'),[row.group,num(row.median),num(row.n),num(row.geometry),row.reason||row.status]);
    const valid = a => a[5]==='validated' && Number.isFinite(a[2]) && Number.isFinite(a[4]) && a[4]>=0 && a[4]<=1;
    function matches(a, volcano) {
      if (volcano && !valid(a)) return false;
      if (direction.value === 'all') return true;
      if (volcano && a[4] > q) return false;
      const v = volcano ? a[2] : a[0];
      const effect = v === '+Inf' ? Infinity : v === '-Inf' ? -Infinity : v;
      if (effect == null) return false;
      return direction.value === 'up' ? effect > 0 && effect >= fc : effect < 0 && effect <= -fc;
    }
    const pageSize = 12, criterion = $('list-order'), term = $('list-query');
    term.value = d.settings.geneQuery || '';
    const savedOrder = d.settings.tableOrder;
    criterion.value = [...criterion.options].some(item => item.value === savedOrder) ? savedOrder : 'gene';
    let page = 0, listed = [];
    function showPage() {
      const body = $('results'); body.replaceChildren();
      const j = d.keys.indexOf(select.value);
      for (const i of listed.slice(page * pageSize, (page + 1) * pageSize)) {
        const row = d.rows[i], a = row[3][j], tr = document.createElement('tr'), td = document.createElement('td'), b = document.createElement('button');
        b.type = 'button'; b.textContent = row[0]; b.onclick = () => pick(i); td.append(b); tr.append(td);
        for (const value of [a[0], a[2], a[3], a[4]]) {
          const field = document.createElement('td'); field.textContent = num(value); tr.append(field);
        }
        body.append(tr);
      }
      const last = !listed.length || (page + 1) * pageSize >= listed.length;
      $('prev').disabled = !page; $('next').disabled = last;
      $('pages').textContent = listed.length ? (page * pageSize + 1) + '–' + Math.min((page + 1) * pageSize, listed.length) + ' / ' + listed.length.toLocaleString() + ' 遺伝子' : '該当する遺伝子がありません。';
    }
    function rank() {
      page = 0; const j = d.keys.indexOf(select.value), volcano = mode.value === 'volcano', find = term.value.trim().toUpperCase();
      const target = d.groups.indexOf(select.value), order = criterion.value;
      function sortValue(i) {
        const row = d.rows[i];
        if (order === 'targetMean') return row[1][target];
        if (order === 'targetPct') return row[2][target]; // Shared denominator within the target region.
        if (order === 'q') return row[3][j][4];
        const v = row[3][j][volcano ? 2 : 0];
        return v === '+Inf' ? Infinity : v === '-Inf' ? -Infinity : v;
      }
      listed = d.rows.map((_,i) => i).filter(i => matches(d.rows[i][3][j], volcano) && d.rows[i][0].toUpperCase().includes(find));
      const ascending = order === 'lowFC' || order === 'q';
      listed.sort((i,k) => {
        if (order !== 'gene') {
          const a = sortValue(i), b = sortValue(k);
          if (a == null && b != null) return 1;
          if (b == null && a != null) return -1;
          if (a !== b) return (a < b ? -1 : 1) * (ascending ? 1 : -1);
        }
        return d.rows[i][0].localeCompare(d.rows[k][0], 'en');
      });
      showPage();
    }
    function draw() {
      const j=d.keys.indexOf(select.value), row=d.rows[index], c=row[3][j];
      mode.options[1].disabled=!d.rows.some(r=>valid(r[3][j]));
      if (mode.options[1].disabled) mode.value='ma';
      mode.options[1].textContent = mode.options[1].disabled ? 'ボルケーノ（検定値なし）' : 'ボルケーノ';
      qInput.disabled = mode.value !== 'volcano';
      const qOrder = criterion.querySelector('option[value="q"]');
      qOrder.disabled = mode.value !== 'volcano';
      if (qOrder.disabled && criterion.value === 'q') criterion.value = 'targetMean';
      const volcano = mode.value==='volcano', width=canvas.width, height=canvas.height;
      $('gene-name').textContent=row[0];
      const state = {validated:'検定済み',not_tested:'検定未実施',unavailable:'検定結果を利用できません'};
      $('metrics').textContent='記述的log₂FC '+num(c[0])+'　 モデルlog₂FC '+num(c[2])+'　 P '+num(c[3])+'　 BH調整P '+num(c[4])+'　 '+(state[c[5]]||'');
      $('unit').textContent=volcano?'空間ブロックモデルによる切片内の探索的比較。横軸はモデル推定log₂FC、縦軸は −log₁₀(BH調整P)。':'横軸 両群の平均log₂ CP10k　縦軸 記述的log₂FC（両群陽性の遺伝子）';
      $('profile').replaceChildren();
      d.groups.forEach((g,k)=>textRow($('profile'),[g,num(row[1][k]),num(row[2][k]),num(d.counts[k]),d.counts[k]?num(100*row[2][k]/d.counts[k])+'%':'—']));
      let xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity;points=[];
      for (let i=0;i<d.rows.length;i++) {
        const a=d.rows[i][3][j];
        if (!matches(a, volcano)) continue;
        const x=volcano?a[2]:a[1], y=volcano?-Math.log10(Math.max(a[4],Number.MIN_VALUE)):a[0];
        if(!Number.isFinite(x)||!Number.isFinite(y)) continue;
        xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);points.push({x,y,i});
      }
      ctx.clearRect(0,0,width,height);ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);
      if (!points.length) {ctx.fillStyle='#233648';ctx.fillText('表示可能な遺伝子なし',55,40);return;}
      if (volcano) { xmin=Math.min(-fc,xmin);xmax=Math.max(fc,xmax);ymin=0;ymax=Math.max(ymax,-Math.log10(q)); }
      else { ymin=Math.min(ymin,-fc);ymax=Math.max(ymax,fc); }
      if (ymin===ymax){ymin-=1;ymax+=1;}if(xmin===xmax){xmin-=1;xmax+=1;}
      const px=x=>52+(x-xmin)/(xmax-xmin)*(width-76), py=y=>height-32-(y-ymin)/(ymax-ymin)*(height-52);
      ctx.strokeStyle='#8493a3';ctx.beginPath();ctx.moveTo(52,16);ctx.lineTo(52,height-32);ctx.lineTo(width-17,height-32);ctx.stroke();
      ctx.font='13px sans-serif';ctx.fillStyle='#384d61';
      for(let a=0;a<=4;a++) {
        const x=xmin+a*(xmax-xmin)/4,y=ymin+a*(ymax-ymin)/4;
        ctx.textAlign='center';ctx.fillText(x.toFixed(1),px(x),height-10);
        ctx.textAlign='right';ctx.fillText(y.toFixed(1),48,py(y)+3);
      }
      ctx.save();ctx.setLineDash([4,4]);ctx.strokeStyle='#9aaeba';ctx.beginPath();
      if (volcano) {
        for (const cut of [-fc,fc]) {ctx.moveTo(px(cut),16);ctx.lineTo(px(cut),height-32);}
        ctx.moveTo(52,py(-Math.log10(q)));ctx.lineTo(width-17,py(-Math.log10(q)));
      } else for (const cut of [-fc,fc]) {ctx.moveTo(52,py(cut));ctx.lineTo(width-17,py(cut));}
      ctx.stroke();ctx.restore();
      for(const point of points) {
        point.px=px(point.x);point.py=py(point.y);ctx.fillStyle='#315e8080';
        if(volcano){const a=d.rows[point.i][3][j];if(Math.abs(a[2])>=fc&&a[4]<=q) ctx.fillStyle=a[2]>=0?'#b45132':'#245caa';}
        ctx.fillRect(point.px-1,point.py-1,2,2);
      }
      const active=points.find(p=>p.i===index);if(active) {ctx.beginPath();ctx.arc(active.px,active.py,5,0,2*Math.PI);ctx.strokeStyle='#b33721';ctx.lineWidth=2;ctx.stroke();ctx.lineWidth=1;}
    }
    function nearest(e) {
      const bounds=canvas.getBoundingClientRect(),x=(e.clientX-bounds.left)*canvas.width/bounds.width,y=(e.clientY-bounds.top)*canvas.height/bounds.height;
      let best=null,distance=144;
      for(const p of points){const dd=(p.px-x)**2+(p.py-y)**2;if(dd<distance){best=p;distance=dd;}}
      return best;
    }
    canvas.addEventListener('click', e=>{const best=nearest(e);if(best) pick(best.i);});
    canvas.addEventListener('pointermove', e=>{
      const best = nearest(e);
      if (!best) { $('hover').textContent = ''; return; }
      const gene = d.rows[best.i], result = gene[3][d.keys.indexOf(select.value)];
      $('hover').textContent = gene[0] + (mode.value === 'volcano'
        ? '　モデルlog₂FC ' + num(result[2]) + '　P ' + num(result[3]) + '　BH調整P ' + num(result[4])
        : '　記述的log₂FC ' + num(result[0]) + '　対象の平均CP10k ' + num(gene[1][d.groups.indexOf(select.value)]));
    });
    canvas.addEventListener('pointerleave', ()=>$('hover').textContent='');
    function refresh() { draw();rank(); }
    direction.addEventListener('change',refresh);
    [fcInput,qInput].forEach(el=>el.addEventListener('change',()=>{
      if (!el.reportValidity() || !Number.isFinite(el.valueAsNumber) || (el===qInput && el.valueAsNumber<=0)) {
        el.value = el===fcInput?fc:q;return;
      }
      if (el===fcInput) fc=el.valueAsNumber;else q=el.valueAsNumber;
      refresh();
    }));
    $('prev').onclick=()=>{if(page){page--;showPage();}};
    $('next').onclick=()=>{if((page+1)*pageSize<listed.length){page++;showPage();}};
    term.addEventListener('input',rank);criterion.addEventListener('change',rank);
    $('settings').textContent=JSON.stringify(d.settings,null,2);
    select.addEventListener('change',refresh);mode.addEventListener('change',refresh);
    query.addEventListener('input',candidates);query.addEventListener('change',choose);
    query.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();choose();}});
    $('find').addEventListener('click',choose);
    mode.value=String(d.settings.plot).toLowerCase().includes('volcano')?'volcano':'ma';pick(index);rank();
  }
  function buildHtml(c) {
    const d=reportData(c), json=JSON.stringify(d).replace(/</g,'\\u003c');
    const esc = s => String(s??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    return '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MSI–ST 層別解析</title><style>'+
      'body{font:15px/1.55 system-ui,sans-serif;color:#1a354b;background:#f7fafc;max-width:1050px;margin:auto;padding:18px}h1,h2{line-height:1.3}section{background:white;padding:16px;margin:12px 0;border:1px solid #ccd9e3;border-radius:7px}label,select,input,button{font:inherit}label{margin-right:12px}canvas{width:100%;max-width:820px;height:auto}table{border-collapse:collapse;width:100%}td,th{text-align:left;border-bottom:1px solid #d8e2e8;padding:5px}pre{white-space:pre-wrap;overflow-wrap:anywhere}input{max-width:90%}input[type=number]{width:6em}output{display:block;min-height:1.5em}button{cursor:pointer}section{overflow-x:auto}</style></head><body>'+
      '<h1>MSI–ST 層別解析</h1><p>'+esc(c.msiSection)+' × '+esc(c.sectionId)+'　'+esc(d.settings.pairing)+'　／　'+esc(c.molecule)+'</p><section><h2>MSIの登録ROI</h2><p>'+esc(d.settings.msiStatus)+'</p><table><thead><tr><th>ROI</th><th>中央値（a.u.）</th><th>有効画素</th><th>ROI画素</th><th>状態</th></tr></thead><tbody id="msi"></tbody></table></section>'+
      '<section><h2>STの領域間比較</h2><label>対比 <select id="contrast"></select></label><label>表示 <select id="mode"><option value="ma">MA図</option><option value="volcano">ボルケーノ</option></select></label><label>方向 <select id="direction"><option value="all">すべて</option><option value="up">対象で高い</option><option value="down">対象で低い</option></select></label><label>|log₂FC| <input type="number" id="fc" min="0" step="any" required></label><label>BH調整P <input type="number" id="q" min="0" max="1" step="any" required></label><p id="unit"></p><canvas id="plot" width="820" height="350" aria-label="遺伝子の比較図。点は下の検索欄でも選択できます"></canvas><output id="hover"></output></section>'+
      '<section><label>遺伝子 <input id="gene" type="search" list="suggestions"><datalist id="suggestions"></datalist></label><button id="find">表示</button> <span role="status" id="message"></span><h2 id="gene-name"></h2><p id="metrics"></p><table><thead><tr><th>領域</th><th>平均CP10k</th><th>検出bin</th><th>対象bin</th><th>検出率</th></tr></thead><tbody id="profile"></tbody></table></section>'+
      '<section><h2>対比別の遺伝子一覧</h2><label>絞り込み <input id="list-query" type="search"></label><label>並び順 <select id="list-order"><option value="targetMean">対象の平均発現（高い順）</option><option value="targetPct">検出率（高い順）</option><option value="gene">遺伝子名</option><option value="log2FC">log₂FCの高い順</option><option value="lowFC">log₂FCの低い順</option><option value="q">BH調整Pの小さい順</option></select></label><table><thead><tr><th>遺伝子</th><th>記述的log₂FC</th><th>モデルlog₂FC</th><th>P</th><th>BH調整P</th></tr></thead><tbody id="results"></tbody></table><button id="prev">前へ</button> <span id="pages"></span> <button id="next">次へ</button></section>'+
      '<details><summary>出力時の条件と出典</summary><pre id="settings"></pre></details><script type="application/json" id="data">'+json+'</script><script>('+mountReport.toString()+')();</script></body></html>';
  }
  async function png(svg) {
    const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}));
    try{
      const img=new Image();img.src=url;await img.decode();
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,img.naturalWidth)*2;canvas.height=Math.max(1,img.naturalHeight)*2;
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
      return await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('PNG変換に失敗しました。')),'image/png'));
    }finally{URL.revokeObjectURL(url);}
  }
  async function save(format,selection) {
    const c={scope:'contrast',...selection};
    if(!c.st?.genes?.length||!c.st.contrasts.includes(c.contrast)||(c.scope==='gene'&&!c.st.genes.includes(c.gene))) throw new Error('出力対象の切片・対比・遺伝子を再選択してください。');
    if(!['gene','contrast','all'].includes(c.scope))throw new Error('出力対象の指定が不正です。');
    let blob;
    if(format==='xlsx')blob=new Blob([await buildWorkbook(c)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    else if(format==='zip')blob=new Blob([await buildZip(c)],{type:'application/zip'});
    else if(format==='html')blob=new Blob([buildHtml(c)],{type:'text/html;charset=utf-8'});
    else if((format==='svg'||format==='png')&&c.figureSvg){
      const figure=typeof c.figureSvg==='string'?c.figureSvg:new XMLSerializer().serializeToString(c.figureSvg);
      const svg=figure.replace(/<svg\b[^>]*>/, tag=>tag+'<desc>'+xml(c.sectionId+' '+label(c.contrast)+' '+c.gene+' '+c.plotMode)+'</desc><metadata>'+xml(JSON.stringify(settings(c)))+'</metadata>');
      blob=format==='svg'?new Blob([svg],{type:'image/svg+xml;charset=utf-8'}):await png(svg);
    }else throw new Error('選択した形式で保存できる結果がありません。');
    const a=document.createElement('a'),url=URL.createObjectURL(blob);
    const figure = format==='svg'||format==='png';
    const parts=[c.sectionId,c.msiSection,c.molecule,figure?c.contrast:c.scope==='all'?'all':c.contrast,
      figure||c.scope==='gene'?c.gene:null,figure?c.plotMode:'layer'];
    a.href=url;a.download=parts.filter(Boolean).join('_').replace(/[^\p{L}\p{N}._-]/gu,'_')+'.'+format;
    document.body.append(a);try{a.click();}finally{a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  }
  root.LayerExport=Object.freeze({save,buildWorkbook,buildZip,buildHtml});
})(typeof window==='object'?window:globalThis);
