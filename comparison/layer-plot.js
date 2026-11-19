/* An interactive density plot for all finite effects. Each hit resolves to
 * an actual gene at its original location, even when several share a glyph. */
(function (global) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  function validated(row) {
    return row.testStatus === 'validated' && Number.isFinite(row.modelLog2FC) &&
      Number.isFinite(row.q) && row.q >= 0 && row.q <= 1;
  }
  function numeric(row, mode) {
    if (mode === 'volcano') {
      return validated(row) ? [row.modelLog2FC, -Math.log10(Math.max(Number.MIN_VALUE, row.q))] : null;
    }
    return Number.isFinite(row.averageLog2) && Number.isFinite(row.log2FC) ? [row.averageLog2, row.log2FC] : null;
  }
  function matches(row, mode, direction, fc, q) {
    if (direction === 'all') return true;
    const effect = mode === 'volcano' ? row.modelLog2FC : row.log2FC;
    return (mode !== 'volcano' || (validated(row) && row.q <= q)) &&
      typeof effect === 'number' && (direction === 'up' ? effect > 0 && effect >= fc : effect < 0 && effect <= -fc);
  }
  function render(svg, rows, options, choose) {
    const {mode, gene, fc, q, direction, label} = options;
    const width = Math.max(285, Math.round(svg.getBoundingClientRect().width || 600));
    const height = 294, left = 52, right = width - 15, top = 25, bottom = height - 44;
    // XMLSerializer writes the default SVG namespace on standalone downloads.
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', width); svg.setAttribute('height', height);
    svg.setAttribute('aria-label', label + (mode === 'volcano' ? ' ボルケーノプロット' : ' MA図'));
    svg.replaceChildren();
    const stamp = (type, attrs, text) => {
      const el = document.createElementNS(NS, type);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
      if (text != null) el.textContent = text;
      svg.append(el);
      return el;
    };
    stamp('rect', {width, height, fill:'#fff'});
    const text = (x, y, value, anchor='middle') => stamp('text', {x, y, fill:'#334d62', 'font-size':12,
      'font-family':'system-ui, sans-serif', 'text-anchor':anchor}, value);
    const line = (x1,y1,x2,y2, color, dashed) => stamp('line', {
      x1,y1,x2,y2,stroke:color, 'stroke-width':1, 'stroke-dasharray':dashed ? '4 3' : 'none'
    });
    const points = [];
    let xmin=Infinity, xmax=-Infinity, ymin=0, ymax=0;
    for (const row of rows) {
      const pair = numeric(row,mode);
      if (!pair) continue;
      const [x,y] = pair;
      xmin=Math.min(xmin,x); xmax=Math.max(xmax,x); ymin=Math.min(ymin,y); ymax=Math.max(ymax,y);
      if (matches(row, mode, direction, fc, q)) points.push({x,y,row,gene:row.gene});
    }
    if (!Number.isFinite(xmin)) { xmin=-1; xmax=1; }
    if (mode==='volcano') { xmin=Math.min(xmin,-fc); xmax=Math.max(xmax,fc); ymax=Math.max(ymax,-Math.log10(q)); }
    else { ymin=Math.min(ymin,-fc); ymax=Math.max(ymax,fc); }
    const dx=(xmax-xmin||1)*.03, dy=(ymax-ymin||1)*.04;
    xmin-=dx; xmax+=dx; ymax+=dy; if(mode==='ma') ymin-=dy;
    const X=x=>left+(x-xmin)/(xmax-xmin)*(right-left);
    const Y=y=>bottom-(y-ymin)/(ymax-ymin)*(bottom-top);
    const fmt=n=>Number(n.toFixed(1)).toString();
    text(left,15,label,'start');
    for(let i=0;i<=4;i++){
      const y=ymin+(ymax-ymin)*i/4, yy=Y(y); line(left,yy,right,yy,'#dce3e8');text(left-7,yy+4,fmt(y),'end');
      const x=xmin+(xmax-xmin)*i/4; text(X(x),bottom+17,fmt(x));
    }
    line(left,top,left,bottom,'#708093'); line(left,bottom,right,bottom,'#708093');
    if(mode==='volcano'){
      line(X(-fc),top,X(-fc),bottom,'#8299ae',true);line(X(fc),top,X(fc),bottom,'#8299ae',true);
      line(left,Y(-Math.log10(q)),right,Y(-Math.log10(q)),'#8299ae',true);
    }else for(const y of [-fc,fc]) line(left,Y(y),right,Y(y),'#8299ae',true);
    text((left+right)/2,height-5,mode==='volcano'?'モデル推定 log₂FC':'平均発現量（平均 log₂ CP10k）');
    text(0,0,mode==='volcano'?'−log₁₀（BH調整P）':'log₂FC（対象 / 対照）').setAttribute('transform',
      'translate(15,'+(top+bottom)/2+') rotate(-90)');
    const bins=new Map();
    let selected;
    for(const p of points){
      p.sx=X(p.x);p.sy=Y(p.y);
      if(p.gene===gene) selected=p;
      const bx=Math.round(p.sx/3.4),by=Math.round(p.sy/3.4),key=bx+','+by;
      const bin=bins.get(key);
      if(bin)bin.n++;else bins.set(key,{x:bx*3.4,y:by*3.4,n:1});
    }
    const paths=[[],[],[],[]];
    for(const bin of bins.values()){
      const level=Math.min(3,Math.floor(Math.log2(bin.n)));
      const r=1.15+level*.28;
      paths[level].push('M'+(bin.x-r).toFixed(1)+' '+bin.y.toFixed(1)+'a'+r+' '+r+' 0 1 0 '+2*r+' 0a'+r+' '+r+' 0 1 0 '+(-2*r)+' 0');
    }
    paths.forEach((p,i)=>{ if(p.length)stamp('path',{d:p.join(''),fill:['#9bb7c9','#779caf','#4b7b98','#265979'][i]}); });
    if(selected){stamp('circle',{cx:selected.sx,cy:selected.sy,r:4,stroke:'#072d48','stroke-width':2,fill:'#ffc367'});}
    if(!points.length)text((left+right)/2,(top+bottom)/2,'表示条件に一致する遺伝子がありません');
    const tooltip=options.tooltip;
    if (tooltip) tooltip.hidden=true;
    function hit(event) {
      const rect=svg.getBoundingClientRect();
      if(!rect.width || !rect.height)return;
      const x=(event.clientX-rect.left)*width/rect.width,y=(event.clientY-rect.top)*height/rect.height;
      let best=12*12, nearest;
      for(const p of points){const d=(x-p.sx)**2+(y-p.sy)**2;if(d<best){nearest=p;best=d;}}
      return nearest;
    }
    svg.onclick=event=>{
      const nearest=hit(event);
      if(nearest) choose(nearest.gene);
    };
    if (tooltip) {
      // Use the same point selection as click. Never show the nearest cluster's averaged value.
      svg.onpointermove=event=>{
        const nearest=hit(event);
        tooltip.hidden=!nearest;
        if (!nearest) return;
        const row=nearest.row;
        const effect=mode==='volcano'?row.modelLog2FC:row.log2FC;
        tooltip.textContent=row.gene+'　log₂FC '+effect.toFixed(2)+(mode==='volcano'
          ? '　BH調整P '+row.q.toPrecision(3) : '　対象の平均CP10k '+row.targetMean.toPrecision(3));
        const rect=svg.getBoundingClientRect();
        const tx=Math.max(0, Math.min(event.clientX-rect.left+12, rect.width-tooltip.offsetWidth));
        const ty=Math.max(0, Math.min(event.clientY-rect.top+12, rect.height-tooltip.offsetHeight));
        tooltip.style.left=tx+'px';
        tooltip.style.top=ty+'px';
      };
      svg.onpointerleave=()=>{tooltip.hidden=true;};
    }
    return points.length;
  }
  const api={render,matches,validated,numeric};
  if(typeof module==='object' && module.exports) module.exports=api;
  global.STLayerPlot=api;
})(typeof window==='object'?window:globalThis);
