/* The gene shelf and spatial map own the active gene. This controller owns
 * the within-ST contrast and presentation filters, and shares them on export. */
(function (global) {
  'use strict';
  const GROUPS=['L1','L2','L3','L4','L5','L6','V1','V2'];
  const DRUGS=['5-HT','DA','NE','D4-5-HT'];
  const PAGE=8;
  const count=n=>Number.isFinite(n)?n.toLocaleString('ja-JP'):'—';
  const val=(n,digits=3)=>n===Infinity?'+∞':n===-Infinity?'−∞':Number.isFinite(n)?n.toLocaleString('ja-JP',{maximumFractionDigits:digits}):'—';
  const label=k=>k==='V1'?'V1全体 対 V2全体':k+' 対 他5層';
  const compKey=(group, keys)=>keys.includes(group)?group:group==='V2'&&keys.includes('V1')?'V1':null;
  function option(v,t){const e=document.createElement('option');e.value=v;e.textContent=t;return e;}
  function cell(row,t){const e=document.createElement('td');e.textContent=t;row.append(e);return e;}
  function interactiveCell(row,t,fn){const e=cell(row,''),b=document.createElement('button');b.type='button';b.textContent=t;b.addEventListener('click',fn);e.append(b);}
  const dependencies=new Map();
  function loadLibrary(url,name) {
    if(global[name])return Promise.resolve();
    if(!dependencies.has(url)){
      const request=new Promise((resolve,reject)=>{
        const script=document.createElement('script');script.src=url;
        script.onload=()=>global[name]?resolve():reject(Error(name+'の初期化に失敗しました。'));
        script.onerror=()=>reject(Error(name+'を読み込めません。接続またはオフライン版の配置を確認してください。'));
        document.head.append(script);
      });
      dependencies.set(url,request);
      request.catch(()=>dependencies.delete(url));
    }
    return dependencies.get(url);
  }
  function sortRows(rows,order,mode){
    if(order==='gene')return rows.sort((a,b)=>a.gene.localeCompare(b.gene,'en'));
    const field=order==='lowFC'?'log2FC':order;
    const key=mode==='volcano'&&field==='log2FC'?'modelLog2FC':field;
    const asc=order==='lowFC' || order==='q';
    return rows.sort((a,b)=>{
      const x=a[key],y=b[key];
      if(x==null || y==null)return x==null&&y==null?0:x==null?1:-1;
      return x===y?a.gene.localeCompare(b.gene,'en'):(x<y?-1:1)*(asc?1:-1);
    });
  }
  function create(root, actions) {
    const by=id=>root.querySelector('#la-'+id);
    let context=null, data=null, fetched='', loading=false, failure='', token=0;
    let group='L4', contrast='L4', mode='ma', direction='all', fc=1, q=.05, page=0, order='targetMean', query='';
    let rows=[], filtered=[], cachedKey=null, previous=null, lastWidth=0;
    let view='analysis', matrixPage=0, matrixGenes=[], matrixQuery='', matrixMetric='mean';
    const plot=by('plot'), plotAPI=global.STLayerPlot;
    function pickContrast(value, specific=value, notify=true) {
      group=specific;contrast=value; page=0; cachedKey=null;
      if(notify)actions.group(specific);
      draw();
    }
    function renderRows() {
      const gene=context.gene;
      const body=by('gene-rows');body.replaceChildren();
      const begin=page*PAGE;
      for(const row of filtered.slice(begin,begin+PAGE)){
        const tr=document.createElement('tr');if(row.gene===gene)tr.setAttribute('aria-current','true');
        interactiveCell(tr,row.gene,()=>actions.gene(row.gene));
        cell(tr,val(row.targetMean));cell(tr,val(row.targetPct,1)+'%');
        cell(tr,val(mode==='volcano'?row.modelLog2FC:row.log2FC,2));
        if(mode==='volcano')cell(tr,Number.isFinite(row.q)?row.q.toPrecision(3):'—');
        body.append(tr);
      }
      by('count').textContent=filtered.length?(begin+1)+'–'+Math.min(begin+PAGE,filtered.length)+' / '+count(filtered.length)+' 遺伝子':'該当する遺伝子はありません';
      by('prev').disabled=!page;by('next').disabled=begin+PAGE>=filtered.length;
    }
    function rank(){
      filtered=sortRows(rows.filter(r=>(mode!=='volcano'||plotAPI.validated(r))&&r.gene.toUpperCase().includes(query)&&
        plotAPI.matches(r,mode,direction,fc,q)),order,mode);
      page=Math.min(page,Math.max(0,Math.ceil(filtered.length/PAGE)-1));
      renderRows();
    }
    function drawMatrix() {
      if (!data || view !== 'matrix') return;
      const header = by('matrix-head');
      header.replaceChildren();
      for (const title of ['遺伝子', ...data.groups]) {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = title;
        header.append(th);
      }
      const start = matrixPage * PAGE;
      const body = by('matrix-rows');
      body.replaceChildren();
      for (const gene of matrixGenes.slice(start, start + PAGE)) {
        const tr = document.createElement('tr');
        if (gene === context.gene) tr.setAttribute('aria-current', 'true');
        interactiveCell(tr, gene, () => actions.gene(gene));
        for (const region of data.profile(gene)) {
          cell(tr, val(region[matrixMetric], matrixMetric === 'pct' ? 1 : 3));
        }
        body.append(tr);
      }
      by('matrix-count').textContent = matrixGenes.length
        ? (start + 1) + '–' + Math.min(start + PAGE, matrixGenes.length) + ' / ' + count(matrixGenes.length) + ' 遺伝子'
        : '該当する遺伝子はありません';
      by('matrix-prev').disabled = matrixPage === 0;
      by('matrix-next').disabled = start + PAGE >= matrixGenes.length;
    }
    function changeView(next) {
      view = next;
      by('analysis').hidden = view !== 'analysis';
      by('matrix').hidden = view !== 'matrix';
      by('show-analysis').setAttribute('aria-pressed', String(view === 'analysis'));
      by('show-matrix').setAttribute('aria-pressed', String(view === 'matrix'));
      if (view === 'matrix') drawMatrix();
      else drawFigure();
    }
    function drawFigure(){
      if(!data||!contrast||!context||view!=='analysis')return;
      const n=plotAPI.render(plot,rows,{mode,gene:context.gene,fc,q,direction,label:data.meta.section+'　'+label(contrast),tooltip:by('tooltip')},actions.gene);
      by('plot-note').textContent=(mode==='ma'?'有限の発現比を持つ遺伝子を表示。':'空間ブロックモデルによる切片内の効果量・BH調整Pを表示。')+
        count(n)+' 遺伝子。点にカーソルを置くと値を表示し、クリックで選択できます。';
      if (mode === 'volcano') {
        const analysis=data.meta.analyses[contrast];
        by('plot-note').textContent+=' '+analysis.nTested.toLocaleString('ja-JP')+' 遺伝子を検定。空間構造を考慮した単一切片内の探索的比較。';
      } else if (by('mode').options[1].disabled) {
        by('plot-note').textContent += data.meta.testErrors[contrast]
          ? ' この対比の検定ファイルを確認できず、P値を表示できません。'
          : ' この対比のP値は未収録です。';
      }
    }
    function profile(){
      const stRows=data?.profile(context.gene)||[];
      const regions=GROUPS.filter(key=>data?.groups.includes(key)||context.msiRows.some(r=>r.region===key&&r.roiId!=null));
      const body=by('profile-rows');body.replaceChildren();
      for(const region of regions){
        const tr=document.createElement('tr'),msi=context.msiRows.find(r=>r.region===region),st=stRows.find(r=>r.group===region);
        if(region===group)tr.setAttribute('aria-current','true');
        interactiveCell(tr,region,()=>pickContrast(compKey(region,data?.contrasts||[]),region));
        const med=cell(tr,msi?.median!=null?val(msi.median,2):'—');
        med.title=msi?.reason||'';
        cell(tr,msi?.geometryPixels!=null?count(msi.measuredPixels)+' / '+count(msi.geometryPixels):'—');
        cell(tr,val(st?.mean));cell(tr,st?count(st.detected)+' / '+count(st.n):'—');cell(tr,st?val(st.pct,1)+'%':'—');body.append(tr);
      }
      const name=context.gene||'未選択',active=context.msiRows.find(r=>r.region===group);
      by('profile-title').textContent='同名領域の実測値　'+context.molecule+' / '+name;
      const msiNote=active?.status==='ok'?'MSI '+group+'　中央値 '+val(active.median,2)+' a.u.':group+' のMSI　'+(active?.reason||'対応ROIを確認できません');
      by('profile-note').textContent=msiNote+'。'+(data?.groups.includes('V1')?'層別とV1・V2全体は重複する集計です。':'');
      const result = data?.compare(context.gene, contrast);
      const stats = by('gene-stats');
      stats.hidden = !result;
      if (result) {
        const values = [label(contrast) + '　' + result.gene, '記述的log₂FC ' + val(result.log2FC, 2)];
        if (plotAPI.validated(result)) {
          values.push('モデルlog₂FC ' + val(result.modelLog2FC, 2), 'P ' + result.p.toPrecision(3), 'BH調整P ' + result.q.toPrecision(3));
        } else {
          values.push(result.testStatus === 'unavailable' ? '検定結果の取得・検証不可' : 'P・BH調整P 未算出');
        }
        stats.textContent = values.join('　·　');
      }
    }
    function draw() {
      if(!context)return;
      const cmp=data?.contrasts||[];
      const src=context.source;
      by('scope').textContent=src.section+' '+(src.mode==='reference'?'（同名領域の参照）':'（登録ペア）')+' × '+context.section;
      by('pair-note').textContent=src.mode==='reference'?'別個体の近接切片を同名領域で参照。MSIとSTの注釈範囲は各資料に従います。':'MSIの登録ROIと別個体のST注釈を同名領域で集計します。';
      const select=by('contrast');
      if(previous!==data||!select.children.length||!contrast){
        select.replaceChildren(...cmp.map(k=>option(k,label(k))));
        if(!contrast)select.append(option('',group+'（比較対象なし）'));
      }
      previous=data;select.value=contrast||'';select.disabled=!cmp.length;
      const molecule=by('molecule');
      if(!molecule.children.length)molecule.append(...DRUGS.map(g=>option(g,g)));
      molecule.value=context.molecule;
      const modelError=data?.meta.testErrors[contrast];
      by('retry').hidden=!failure && !modelError;
      by('retry').textContent=modelError?'この切片の検定結果を再読込':'層別集計を再読込';
      by('status').textContent=loading?'ST集計を読み込み中…':failure?'ST集計を取得できませんでした。'+failure:
        data?data.meta.scope+' · '+count(data.meta.nBins)+' bin · '+count(data.genes.length)+' 遺伝子':
        'このST切片の検証済み層別集計は未収録です。保存済みMSIのROIは引き続き確認できます。';
      if(modelError)by('status').textContent+='　'+label(contrast)+'の検定結果の読み込み・検証に失敗しました。'+modelError;
      profile();
      by('results').hidden = !data;
      by('show-matrix').disabled = !data;
      by('analysis').hidden = !contrast || view !== 'analysis';
      by('matrix').hidden = view !== 'matrix';
      by('save').disabled = by('save').getAttribute('aria-busy') === 'true' || !data || !contrast;
      by('export-scope').querySelector('option[value="gene"]').disabled = !data?.compare(context.gene, contrast);
      if (by('export-scope').selectedOptions[0]?.disabled) by('export-scope').value='contrast';
      if (!data) return;
      drawMatrix();
      if (!contrast) return;
      const key=context.section+'|'+contrast;
      if(cachedKey!==key){
        rows=data.rows(contrast);cachedKey=key;
        const enabled=rows.some(plotAPI.validated);
        by('mode').options[1].disabled=!enabled;
        by('mode').options[1].textContent=enabled?'ボルケーノ（BH調整P）':modelError?'ボルケーノ（取得・検証失敗）':'ボルケーノ（検定未収録）';
        if(!enabled)mode='ma';
        const links=by('tested-links');
        links.replaceChildren();
        for(const key of Object.keys(data.meta.analyses)){
          if(key===contrast)continue;
          const button=document.createElement('button');
          button.type='button';
          button.textContent=key+'のボルケーノを開く';
          button.onclick=()=>{mode='volcano';pickContrast(key);};
          links.append(button);
        }
      }
      by('order').querySelector('option[value="q"]').disabled = mode !== 'volcano';
      if (mode !== 'volcano' && order === 'q') {
        order = 'targetMean';
        by('order').value = order;
      }
      by('mode').value=mode;by('plot-title').textContent=mode==='ma'?'STのMA図':'STのボルケーノ';
      by('q-heading').hidden=by('q-label').hidden=mode!=='volcano';
      by('fc-heading').textContent=mode==='ma'?'log₂FC':'モデルlog₂FC';
      by('table-title').textContent=label(contrast)+' の遺伝子発現差';
      drawFigure();rank();
    }
    async function fetchSection(id){
      const request=++token; fetched=id; loading=true;failure='';data=null;cachedKey=null;previous=null;draw();
      try{const result=await global.STLayerData.load(id);if(request!==token)return;data=result||null;
        matrixGenes=data?.genes || [];
        if(data&&!data.contrasts.includes(contrast)){
          contrast=data.contrasts.includes('L4')?'L4':data.contrasts[0]||null;
          group=contrast||data.groups[0]||'L4';
        }
      }catch(err){if(request!==token)return;failure=String(err?.message||err);}
      if(request!==token)return;loading=false;draw();
    }
    function update(value){
      const prev=context;context=value;
      if(fetched!==context.section){group='L4';contrast='L4';mode='ma';query='';by('query').value='';page=0;
        matrixPage=0;matrixQuery='';matrixGenes=[];by('matrix-query').value='';
        fetchSection(context.section);return;}
      if(prev && prev.molecule===context.molecule && prev.source.projectId===context.source.projectId &&
         prev.gene===context.gene && prev.roiSection===context.roiSection && prev.msiStatus===context.msiStatus)return;
      draw();
    }
    by('show-analysis').onclick=()=>changeView('analysis');
    by('show-matrix').onclick=()=>changeView('matrix');
    by('matrix-query').oninput=e=>{
      matrixQuery=e.target.value.trim().toUpperCase();
      matrixGenes=data?.genes.filter(g=>g.toUpperCase().includes(matrixQuery)) || [];
      matrixPage=0;drawMatrix();
    };
    by('matrix-metric').onchange=e=>{matrixMetric=e.target.value;drawMatrix();};
    by('matrix-prev').onclick=()=>{if(matrixPage>0){matrixPage--;drawMatrix();}};
    by('matrix-next').onclick=()=>{if((matrixPage+1)*PAGE<matrixGenes.length){matrixPage++;drawMatrix();}};
    by('contrast').onchange=e=>pickContrast(e.target.value);
    by('molecule').onchange=e=>actions.molecule(e.target.value);
    by('mode').onchange=e=>{mode=e.target.value;page=0;draw();};
    by('retry').onclick=()=>fetchSection(context.section);
    by('query').oninput=e=>{query=e.target.value.trim().toUpperCase();page=0;rank();};
    by('order').onchange=e=>{order=e.target.value;page=0;rank();};
    by('direction').onchange=e=>{direction=e.target.value;page=0;draw();};
    function threshold(e,isQ){
      const n=e.target.valueAsNumber;
      if(!Number.isFinite(n)||n<0||(isQ&&(n<=0||n>1))){
        e.target.setCustomValidity(isQ?'0超1以下を指定してください。':'0以上を指定してください。');e.target.reportValidity();return;
      }
      e.target.setCustomValidity('');if(isQ)q=n;else fc=n;page=0;draw();
    }
    by('fc').oninput=e=>threshold(e,false);by('q').oninput=e=>threshold(e,true);
    by('prev').onclick=()=>{page=Math.max(0,page-1);renderRows();};
    by('next').onclick=()=>{if((page+1)*PAGE<filtered.length)page++;renderRows();};
    by('format').onchange=e=>{by('export-scope').disabled=['png','svg'].includes(e.target.value);};
    by('save').onclick=async()=>{
      if(!data||!contrast)return;
      const btn=by('save'),format=by('format').value;
      const params={st:data,sectionId:context.section,source:context.roiSection?.source,
        sampleMode:context.source.mode==='reference'?'reference':'paired',msiSection:context.source.section,projectId:context.source.projectId,
        molecule:context.molecule,contrast,group,gene:context.gene,scope:by('export-scope').value,plotMode:mode,qCutoff:q,fcCutoff:fc,direction,
        query:view==='matrix'?matrixQuery:query,order:view==='matrix'?'matrix':order,
        msiRows:context.msiRows.map(r=>({...r,group:r.region,n:r.measuredPixels,geometry:r.geometryPixels})),
        msiStatus:context.msiStatus,figureSvg:''};
      if (view === 'matrix' && ['svg','png'].includes(format)) {
        changeView('analysis');
      }
      if (view === 'matrix') {
        const exportPlot = plot.cloneNode(false);
        plotAPI.render(exportPlot,rows,{mode,gene:context.gene,fc,q,direction,label:data.meta.section+'　'+label(contrast)},()=>{});
        params.figureSvg = new XMLSerializer().serializeToString(exportPlot);
      } else params.figureSvg = new XMLSerializer().serializeToString(plot);
      btn.disabled=true;btn.setAttribute('aria-busy','true');by('save-status').textContent='出力を準備中…';
      try{
        if(format==='xlsx' || format==='zip')await loadLibrary(root.dataset.zipSrc,'JSZip');
        await global.LayerExport.save(format,params);by('save-status').textContent='保存を開始しました。';
      }catch(err){by('save-status').textContent='出力できませんでした。'+String(err?.message||err);}
      finally{btn.removeAttribute('aria-busy');btn.disabled=!data||!contrast;}
    };
    if(typeof ResizeObserver==='function')new ResizeObserver(()=>{
      const w=Math.round(plot.getBoundingClientRect().width);if(w>0&&w!==lastWidth){lastWidth=w;drawFigure();}
    }).observe(plot);
    return {update,setGroup(region){if(context&&GROUPS.includes(region))pickContrast(compKey(region,data?.contrasts||[]),region,false);}};
  }
  global.STLayerPanel={create};
})(window);
