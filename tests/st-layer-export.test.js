'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const XLSX=require('xlsx'),JSZip=require('jszip');
const source=fs.readFileSync(path.join(__dirname,'../comparison/layer-export.js'),'utf8');
const root={XLSX,JSZip,APP_VERSION:'test'};
vm.runInNewContext(source,{window:root,Blob,TextEncoder,Uint8Array,setTimeout});
const exporter=root.LayerExport;
function fixture(scope){
  const genes=['GENE1','G"2</script>'],groups=['L1','L2','V1','V2'],contrasts=['L1','V1'];
  const st={genes,groups,contrasts,meta:{version:'v-test'},
    profile:g=>groups.map((group,i)=>({group,mean:i&&g===genes[0]?2:0,detected:i,n:10,pct:i*10})),
    compare:(gene,contrast)=>({gene,contrast,targetMean:0,referenceMean:2,targetDetected:0,targetN:10,
      targetPct:0,referenceDetected:3,referenceN:9,referencePct:33,log2FC:-Infinity,averageLog2:null,
      status:'reference_only',p:null,q:null,testStatus:'not_tested'})};
  return {scope,st,sectionId:'T503',sampleMode:'reference',msiSection:'Cor_2_2',molecule:'5-HT',gene:genes[0],contrast:'L1',
    msiRows:[{group:'L1',median:0,n:1,geometry:2,status:'available'}]};
}
test('Excel preserves all contrast fields, zero, missing tests and source information at each scope',async()=>{
  for (const scope of ['all','contrast','gene']) {
    const c=fixture(scope),bytes=await exporter.buildWorkbook(c);
    const book=XLSX.read(bytes,{type:'array'});
    const rows=name=>XLSX.utils.sheet_to_json(book.Sheets[name],{raw:true,defval:null});
    const contrasts=book.SheetNames.filter(name=>name.startsWith('Contrast_'));
    assert.deepEqual(contrasts,scope==='all'?['Contrast_L1','Contrast_V1']:['Contrast_L1']);
    assert.equal(rows('ST_expression').length,scope==='gene'?1:2);
    assert.equal(rows('MSI_ROI')[0].median,0);
    assert.equal(rows('Regions')[0].n_bins,10);
    for(const name of contrasts) {
      const result=rows(name);
      assert.equal(result.length,scope==='gene'?1:2);
      assert.equal(result[0].targetMean,0);assert.equal(result[0].referenceN,9);
      assert.equal(result[0].q,null);assert.equal(result[0].log2FC,'-Inf');
      if(scope!=='gene')assert.equal(result[1].gene,c.st.genes[1]);
    }
    const conditions=Object.fromEntries(rows('Conditions').map(r=>[r.key,r.value]));
    assert.equal(conditions.genesExported,scope==='gene'?1:2);
    assert.equal(conditions['st.version'],'v-test');
    const archive=await JSZip.loadAsync(bytes,{checkCRC32:true});
    const text=await archive.file('xl/worksheets/sheet1.xml').async('string');
    assert.match(text,/state="frozen"/);assert.match(text,/<autoFilter ref="A1:/);
  }
});
test('TSV ZIP scope preserves each group and contrast and excludes unselected genes',async()=>{
  for(const scope of ['gene','contrast','all']){
    const z=await JSZip.loadAsync(await exporter.buildZip(fixture(scope)));
    assert.equal(!!z.file('contrast_V1.tsv'),scope==='all');
    const rows=(await z.file('st_region_expression.tsv').async('string')).trim().split('\n');
    assert.equal(rows.length,1+(scope==='gene'?4:8)); const meta=JSON.parse(await z.file('conditions.json').async('string'));
    assert.equal(meta.pairing,'同名領域の解剖学的参照');
    const contrast=await z.file('contrast_L1.tsv').async('string');assert.match(contrast,/-Inf/);
  }
});
test('standalone interactive report snapshots exact selected scopes and safely encodes gene names',()=>{
  const h=exporter.buildHtml(fixture('all')),data=JSON.parse(h.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.rows[1][0],'G"2</script>');assert.equal(data.rows[0][3][0][0],'-Inf');
  assert.equal(data.rows[0][3][0][4],null);assert.equal(data.msi[0].median,0);assert.equal(data.keys.length,2);
  assert.doesNotMatch(h,/<script[^>]+src=/);assert.equal(JSON.parse(exporter.buildHtml(fixture('gene')).match(/id="data">([^<]*)</)[1]).rows.length,1);
});

test('tested model estimates, original P and BH q retain their meaning across formats',async()=>{
  const c=fixture('all'),compare=c.st.compare;
  c.st.compare=(gene,contrast)=>({...compare(gene,contrast),modelLog2FC:2,p:0.001,q:0.007,testStatus:'validated'});
  const b=XLSX.read(await exporter.buildWorkbook(c),{type:'array'});
  const row=XLSX.utils.sheet_to_json(b.Sheets.Contrast_V1,{defval:null})[0];
  assert.equal(row.modelLog2FC,2);assert.equal(row.log2FC,'-Inf');assert.equal(row.p,.001);assert.equal(row.q,.007);
  const z=await JSZip.loadAsync(await exporter.buildZip(c));
  assert.match(await z.file('contrast_L1.tsv').async('string'),/2\t0.001\t0.007\tvalidated/);
  const d=JSON.parse(exporter.buildHtml(c).match(/id="data">([^<]*)</)[1]);
  assert.deepEqual(d.rows[0][3][0],['-Inf',null,2,.001,.007,'validated']);
});

test('complete exports keep region denominators when the gene shelf is empty or points to an unmeasured gene', async () => {
  for (const gene of [null, 'NOT_IN_CORTEX']) {
    const c = fixture('all');
    const profile = c.st.profile;
    c.st.profile = symbol => c.st.genes.includes(symbol) ? profile(symbol) : [];
    c.gene = gene;
    const book = XLSX.read(await exporter.buildWorkbook(c), { type: 'array' });
    assert.equal(XLSX.utils.sheet_to_json(book.Sheets.Regions).length, c.st.groups.length);
    const html = exporter.buildHtml(c);
    const report = JSON.parse(html.match(/id="data">([^<]*)</)[1]);
    assert.deepEqual(report.counts, [10, 10, 10, 10]);
    assert.equal(report.rows.length, 2);
    assert.equal(report.settings.gene, gene);
  }
});
