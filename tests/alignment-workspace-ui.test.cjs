'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startBrowserHarness } = require('./browser-harness.cjs');

async function openWorkspace(h) {
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0}.modal-backdrop{position:fixed;inset:0;display:flex}.modal-box{background:white}.align-image-layer{position:absolute}.pick-pane{position:relative}</style>
  <link rel="stylesheet" href="/viewer/alignment-modal.css"><link rel="stylesheet" href="/viewer/alignment-workspace.css">
  <button id="outside">outside</button><div class="modal-backdrop alignment-modal"><div class="modal-box">
  <div class="align-header"><h3>登録のテスト</h3><button data-act="close">閉じる</button></div><div class="align-reference">参照分子</div>
  <div class="align-panels"><div data-pane="he" class="pick-pane align-viewport"><div data-layer="he" class="align-image-layer"><img data-img="he"></div></div>
  <div data-pane="msi" class="pick-pane align-viewport"><div data-layer="msi" class="align-image-layer"><img data-img="msi"></div></div></div>
  <div class="align-footer"><button data-act="close">キャンセル</button><button data-act="apply">保存</button></div></div></div>
  <script src="/viewer/alignment-workspace.js"></script><script>
  const tile=document.createElement('canvas');tile.width=100;tile.height=80;const tc=tile.getContext('2d');tc.fillStyle='#f00';tc.fillRect(0,0,50,80);tc.fillStyle='#0f0';tc.fillRect(50,0,50,80);
  Promise.all([...document.querySelectorAll('img')].map(async img=>{img.src=tile.toDataURL();await img.decode();})).then(()=>{
  window.pointClicks=0;window.renderCalls=0;window.pendingRenders=[];
  for(const pane of document.querySelectorAll('[data-pane]'))pane.addEventListener('click',()=>pointClicks++);
  window.workspace=MsiAlignmentWorkspace.mount(document.querySelector('.modal-box'),{canSync:()=>true,onClose:()=>workspace.destroy(),
    onComposite:({canvas,opacity})=>{const c=canvas.getContext('2d');c.fillStyle='rgb('+Math.round(opacity*255)+',0,0)';c.fillRect(0,0,canvas.width,canvas.height);},
    onFinalComposite:async ({canvas})=>{renderCalls++;await new Promise(resolve=>pendingRenders.push(resolve));canvas.getContext('2d').fillRect(0,0,canvas.width,canvas.height);}});
  });</script>`;
  await h.page.route(h.baseURL + '/workspace-synthetic.html', route => route.fulfill({ contentType: 'text/html', body: html }));
  await h.page.goto(h.baseURL + '/workspace-synthetic.html');
  await h.page.waitForFunction(() => !!window.workspace && document.querySelector('[data-img=he]').getBoundingClientRect().width > 0);
}

test('workspace fits a large side-by-side view, links pan/zoom and prevents a drag from becoming a point', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await h.page.setViewportSize({ width: 1440, height: 900 }); await openWorkspace(h);
    const sizes = await h.page.locator('.msi-align-viewport').evaluateAll(nodes => nodes.map(n => ({w:n.clientWidth,h:n.clientHeight})));
    assert.ok(sizes.every(s => s.w > 600 && s.h > 600), JSON.stringify(sizes));
    await h.page.locator('.msi-align-sync input').check();
    await h.page.locator('.msi-align-pane-header button[aria-label="HE/IF を拡大"]').click();
    const linked = await h.page.evaluate(() => workspace.getViewState());
    assert.deepEqual(linked.he, linked.msi);
    const pane = await h.page.locator('[data-pane=he]').boundingBox();
    await h.page.mouse.move(pane.x+pane.width/2,pane.y+pane.height/2); await h.page.mouse.down();
    await h.page.mouse.move(pane.x+pane.width/2+70,pane.y+pane.height/2+40,{steps:4}); await h.page.mouse.up();
    assert.equal(await h.page.evaluate(()=>pointClicks),0);
    const moved = await h.page.evaluate(()=>workspace.getViewState()); assert.deepEqual(moved.he,moved.msi); assert.notDeepEqual(moved.he,linked.he);
    assert.equal(await h.page.locator('#outside').evaluate(el=>el.inert),true);
    await h.page.keyboard.press('Escape'); assert.equal(await h.page.locator('#outside').evaluate(el=>el.inert),false);
    assert.deepEqual(h.errors,[]);
  } finally { await h.close(); }
});

test('overlay opacity changes only presentation and late final previews cannot replace a newer mode or closed workspace', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await openWorkspace(h); await h.page.locator('[data-view-mode=overlay]').click();
    const center = () => h.page.locator('.msi-align-composite > canvas').evaluate(c => Array.from(c.getContext('2d').getImageData(c.width/2,c.height/2,1,1).data));
    await h.page.waitForFunction(()=>document.querySelector('.msi-align-composite > canvas').width>10);
    await h.page.locator('.msi-align-opacity input').fill('0.8'); await h.page.waitForFunction(()=>{const c=document.querySelector('.msi-align-composite > canvas');return c.getContext('2d').getImageData(10,10,1,1).data[0]===204;});
    assert.deepEqual(await center(),[204,0,0,255]);
    await h.page.locator('[data-view-mode=final]').click(); await h.page.waitForFunction(()=>renderCalls>0);
    await h.page.locator('[data-view-mode=overlay]').click(); await h.page.evaluate(()=>pendingRenders.splice(0).forEach(r=>r()));
    await h.page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    assert.deepEqual(await center(),[204,0,0,255]);
    await h.page.locator('[data-view-mode=final]').click(); await h.page.waitForFunction(()=>renderCalls>1);
    await h.page.keyboard.press('Escape'); await h.page.evaluate(()=>pendingRenders.splice(0).forEach(r=>r()));
    assert.equal(await h.page.locator('.msi-align-composite').count(),0); assert.deepEqual(h.errors,[]);
  } finally { await h.close(); }
});


test('synchronized panes use relative fit magnification across different image resolutions', { timeout: 60000 }, async () => {
  const h = await startBrowserHarness();
  try {
    await h.page.setViewportSize({width:1440,height:900}); await openWorkspace(h);
    await h.page.evaluate(()=>{const img=document.querySelector('[data-img=he]');img.dataset.frameWidth='2000';img.dataset.frameHeight='1600';workspace.refresh({resetView:true});});
    await h.page.locator('.msi-align-sync input').check();
    await h.page.locator('.msi-align-pane-header button[aria-label="HE/IF を拡大"]').click();
    const state=await h.page.evaluate(()=>workspace.getViewState());
    assert.equal(state.he.centerX,state.msi.centerX); assert.equal(state.he.centerY,state.msi.centerY);
    assert.ok(Math.abs(state.he.pixelScale*20-state.msi.pixelScale)<1e-10,'A high-resolution HE image retains the same relative magnification as MSI');
    const sizes=await h.page.locator('.msi-align-content').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().width));
    assert.ok(Math.abs(sizes[0]-sizes[1])<2,JSON.stringify(sizes)); assert.deepEqual(h.errors,[]);
  } finally { await h.close(); }
});
