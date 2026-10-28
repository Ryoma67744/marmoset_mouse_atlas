'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const { chromium } = require('playwright');
const { buildOffline } = require('../scripts/build-offline.cjs');
const { start } = require('../offline/server.cjs');
const { seedAnalysisStack, sectionId, readyAnalysisStack } = require('./stack3d-analysis-fixture.cjs');

const closeServer = server => new Promise(resolve => server.close(resolve));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const mime = name => name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'application/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.json') ? 'application/json' : 'application/octet-stream';

async function fixture(output) {
  const built = await buildOffline({ output, includeRuntime: false });
  // All app JS, CSS, workers and libraries are real build artifacts. Only the
  // Windows executable is a sentinel: this test runs the real launcher module
  // under CI's Node. The deployment build separately verifies official Node's
  // archive checksum and includes its actual executable and license.
  const files = built.entries;
  files.set('runtime/node.exe', Buffer.from('synthetic-runtime-not-executed'));
  files.set('runtime/LICENSE', Buffer.from('Synthetic test fixture only'));
  files.set('offline/package-files.json', Buffer.from(JSON.stringify({ format: 'marmoset-atlas-package-files', version: 1, files: [...files.keys()].sort() })));
  const zip = new JSZip();
  for (const [name, bytes] of files) zip.file(name, bytes, { createFolders: false });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const manifest = { ...built.manifest, runtimeIncluded: true, size: bytes.length, sha256: digest(bytes) };
  const server = http.createServer((req, res) => {
    let name;
    try { name = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch (_) { res.writeHead(400); res.end(); return; }
    if (name === '/__test_seed') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><script src="/lib/storage.js"></script><script src="/lib/msi.js"></script><script src="/lib/normalization-scope.js"></script><script src="/lib/normalization.js"></script><script src="/lib/display-range.js"></script>');
      return;
    }
    const data = name === '/offline/atlas-app.zip' ? bytes : name === '/offline/atlas-app.manifest.json' ? Buffer.from(JSON.stringify(manifest)) : files.get('app/' + (name === '/' ? 'index.html' : name.slice(1)));
    if (!data) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', mime(name === '/' ? 'index.html' : name));
    res.setHeader('Content-Length', data.length); res.end(data);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, baseURL: 'http://127.0.0.1:' + server.address().port };
}
async function takeDownload(page, selector, statusSelector) {
  try {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator(selector).click()]);
    assert.equal(await download.failure(), null);
    return fs.readFile(await download.path());
  } catch (error) { throw new Error(error.message + '\nExport status: ' + await page.locator(statusSelector).innerText()); }
}
async function extract(bytes, root) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    assert.ok(!name.includes('\\') && !name.split('/').some(part => !part || part === '..' || part === '.' || part.includes(':')), 'safe package path');
    const filename = path.resolve(root, ...name.split('/'));
    assert.ok(filename.startsWith(root + path.sep));
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, await entry.async('nodebuffer'));
  }
}
async function snapshot(page) {
  return page.evaluate(async () => {
    const data = await ProjectStorage.exportWorkspaceSnapshot();
    const blobs = [];
    for (const record of data.blobs) {
      const hash = await crypto.subtle.digest('SHA-256', await record.blob.arrayBuffer());
      blobs.push({ id: record.id, size: record.blob.size, type: record.blob.type, hash: Array.from(new Uint8Array(hash), v => v.toString(16).padStart(2, '0')).join('') });
    }
    return { projects: data.projects.sort((a, b) => a.id.localeCompare(b.id)), folders: data.folders.sort((a, b) => a.id.localeCompare(b.id)), blobs: blobs.sort((a, b) => a.id.localeCompare(b.id)) };
  });
}
function assertNumericWorkbook(bytes, hasSections = false) {
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  assert.deepEqual(workbook.SheetNames, hasSections ? ['Statistics', 'Conditions', 'Sections'] : ['Statistics', 'Conditions']);
  const sheet = workbook.Sheets.Statistics;
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  assert.ok(rows.length > 1);
  for (const column of ['中央値', '平均値', '標準偏差']) {
    const index = rows[0].indexOf(column);
    assert.ok(index >= 0);
    const cell = sheet[XLSX.utils.encode_cell({ r: 1, c: index })];
    assert.equal(cell.t, 'n', column + ' remains numeric without ± symbols');
    assert.ok(Number.isFinite(cell.v));
  }
}
async function readyOffline(page, errors) {
  try {
    await page.waitForFunction(() => document.getElementById('offline-status')?.textContent.startsWith('オフライン版を開きました') && !document.getElementById('offline-export').disabled);
    assert.equal(await page.evaluate(() => ProjectStorage.hasWorkspaceRestore()), true);
  }
  catch (error) { throw new Error(error.message + '\nBootstrap: ' + await page.locator('#offline-status').innerText() + '\nPage errors: ' + JSON.stringify(errors)); }
}

test('complete offline package restores, analyzes and re-exports edited data without external requests', { timeout: 180000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-offline-e2e-'));
  let browser, online, first, second;
  const contexts = [], errors = [], external = [], workerRequests = [];
  try {
    online = await fixture(path.join(temp, 'build'));
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE_PATH;
    const args = process.env.PLAYWRIGHT_CHROMIUM_ARGS ? JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS) : [];
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args });
    async function context() {
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true }); contexts.push(ctx);
      ctx.on('page', page => { page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept()); });
      ctx.on('request', req => { if (/\/stack3d\/analysis-worker\.js(?:\?|$)/.test(req.url())) workerRequests.push(req.url()); });
      await ctx.route('**/*', route => {
        const url = route.request().url();
        if (/^http:\/\/127\.0\.0\.1:\d+\//.test(url) || /^(data:|blob:)/.test(url)) return route.continue();
        external.push(url); return route.abort();
      });
      return ctx;
    }
    const sourceContext = await context(), source = await sourceContext.newPage();
    const ids = await seedAnalysisStack({ page: source, context: sourceContext, baseURL: online.baseURL }, { count: 2, width: 256, height: 200, missingCorrection: false });
    await source.evaluate(async ids => {
      await ProjectStorage.putFolder({ id: 'empty-child', name: 'Empty preserved folder', parentId: 'analysis-coronal' });
      for (const id of ids) {
        const project = await ProjectStorage.getProject(id);
        // This ROI has 51,199 finite pixels, exercising the real worker path.
        project.roi.roi_names.whole = 'Whole tissue';
        project.roi.roi_items.whole = [{ poly_msi: [[-.5, -.5], [255.5, -.5], [255.5, 199.5], [-.5, 199.5]] }];
        project.roi.roi_show_flags.whole = true; project.roi.palette.whole = [255, 200, 100];
        await ProjectStorage.putProject(project);
      }
      await ProjectStorage.putBlob({ id: 'synthetic-image', name: 'synthetic.png', blob: new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMfoAAAAASUVORK5CYII='), c => c.charCodeAt(0))], { type: 'image/png' }) });
      const project = await ProjectStorage.getProject(ids[0]);
      project.images.ATLAS = { blobId: 'synthetic-image', name: 'synthetic.png' };
      await ProjectStorage.putProject(project);
    }, ids);
    const original = await snapshot(source);
    assert.equal(original.projects.length, 2); assert.equal(original.folders.length, 3);
    await source.goto(online.baseURL + '/');
    await source.waitForFunction(() => window.OfflineUI && !document.getElementById('offline-export').disabled);
    assert.equal((await snapshot(source)).projects.length, 2, 'source navigation retains registered datasets');
    const firstBytes = await takeDownload(source, '#offline-export', '#offline-status');
    const exportedPackage = await JSZip.loadAsync(firstBytes);
    const exportedWorkspace = await JSZip.loadAsync(await exportedPackage.file('app/data/workspace.zip').async('nodebuffer'));
    const exportedManifest = JSON.parse(await exportedWorkspace.file('manifest.json').async('string'));
    assert.equal(exportedManifest.counts.projects, 2, 'the complete package must contain both registered datasets');
    const root1 = path.join(temp, 'first'); await extract(firstBytes, root1); first = await start(root1);
    const base1 = 'http://127.0.0.1:' + first.port;
    const offlineContext = await context(), page = await offlineContext.newPage();
    await page.goto(base1 + '/');
    await readyOffline(page, errors);
    assert.equal(await page.evaluate(() => Cloud.configured()), false);
    const initial = await snapshot(page);
    assert.equal(initial.projects.length, 2, 'initial restore project count');
    assert.deepEqual(initial, original, 'IDs, groups, empty folders, raw Float32 bits, image and saved settings survive initial restore');
    const firstId = await page.evaluate(() => ATLAS_OFFLINE.workspaceId);
    await page.goto(base1 + '/viewer/index.html?project=' + sectionId(1));
    await page.waitForFunction(() => typeof viewerReady !== 'undefined' && viewerReady);
    await page.locator('.roi-item[data-roi-key="whole"]').click();
    await page.getByLabel('並び順', { exact: true }).selectOption('mean');
    assertNumericWorkbook(await takeDownload(page, '#graph-export-excel', '#graph-export-status'));
    await page.locator('#notes-add').click();
    await page.locator('#notes-others [data-note-field="text"]').last().fill('Offline edit survives restart and a second PC');
    await page.waitForFunction(() => document.getElementById('notes-status').textContent === 'このPCに保存済み');
    assert.equal(await page.evaluate(async id => (await ProjectStorage.getProject(id)).notes?.others?.some(note => note.text === 'Offline edit survives restart and a second PC'), sectionId(1)), true);
    const edited = await snapshot(page);
    assert.deepEqual(edited.blobs, original.blobs);
    await page.goto('about:blank'); await closeServer(first.server);
    first = await start(root1); assert.equal('http://127.0.0.1:' + first.port, base1);
    await page.goto(base1 + '/');
    await readyOffline(page, errors);
    assert.deepEqual(await snapshot(page), edited, 'restart must not overwrite edited records with the original embedded snapshot');
    await page.goto(base1 + '/stack3d/index.html?project=' + sectionId(1));
    await readyAnalysisStack(page, 2);
    await page.waitForFunction(() => !document.getElementById('analysis-export-excel').disabled);
    assert.ok(workerRequests.some(url => url.startsWith(base1)), '3D analysis uses the bundled Web Worker');
    assertNumericWorkbook(await takeDownload(page, '#analysis-export-excel', '#analysis-export-status'), true);
    await page.goto(base1 + '/');
    await readyOffline(page, errors);
    const beforeResave = await snapshot(page);
    assert.deepEqual(beforeResave.blobs, original.blobs);
    const secondBytes = await takeDownload(page, '#offline-export', '#offline-status');
    const root2 = path.join(temp, 'second'); await extract(secondBytes, root2); second = await start(root2);
    const restoredContext = await context(), restored = await restoredContext.newPage();
    await restored.goto('http://127.0.0.1:' + second.port + '/');
    await readyOffline(restored, errors);
    assert.notEqual(await restored.evaluate(() => ATLAS_OFFLINE.workspaceId), firstId);
    assert.deepEqual(await snapshot(restored), beforeResave, 'a fresh browser restores the edited portable copy exactly');
    assert.deepEqual(external, [], 'all runtime resources must be local, with no attempted CDN/cloud access');
    assert.deepEqual(errors, []);
  } finally {
    for (const ctx of contexts) await ctx.close().catch(() => {});
    if (browser) await browser.close();
    for (const item of [online, first, second]) if (item?.server?.listening) await closeServer(item.server);
    await fs.rm(temp, { recursive: true, force: true });
  }
});
