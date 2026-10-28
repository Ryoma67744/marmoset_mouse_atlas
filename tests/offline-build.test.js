'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const JSZip = require('jszip');
const { buildOffline } = require('../scripts/build-offline.cjs');
const { start, parseConfig } = require('../offline/server.cjs');

test('offline build bundles local dependencies, licenses, workers and no user/cloud data', async t => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-build-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const { manifest, bytes, entries } = await buildOffline({ output, includeRuntime: false });
  assert.equal(manifest.runtimeIncluded, false);
  assert.equal(manifest.size, bytes.length);
  assert.equal(manifest.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const names = Object.keys(archive.files);
  assert.ok(names.includes('app/stack3d/analysis-worker.js'));
  assert.ok(names.includes('offline/server.cjs'));
  assert.ok(names.includes('START_ATLAS.cmd'));
  assert.ok(names.includes('LICENSES/Three.js.txt'));
  assert.ok(names.includes('app/USER_GUIDE.pdf'));
  assert.ok(names.includes('app/USER_GUIDE.md'));
  assert.ok(names.includes('app/STACK3D_GUIDE.md'));
  assert.ok(!names.some(name => /node_modules|\.git|cloudSession|^tests\/|data\/workspace\.zip/.test(name)));
  assert.match(entries.get('app/lib/cloud-config.js').toString(), /url: "", anonKey: ""/);
  for (const name of ['app/index.html', 'app/viewer/index.html', 'app/stack3d/index.html']) {
    const html = entries.get(name).toString();
    assert.doesNotMatch(html, /<script\b[^>]*src=["']https?:/);
    assert.ok(html.indexOf('pako.min.js') < html.indexOf('UTIF.js'));
    for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"?#]+)(?:[?#][^"]*)?"/g)) {
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]));
      assert.ok(entries.has(relative), name + ' references missing asset ' + relative);
    }
  }
  const css = entries.get('app/vendor/tailwind.css').toString();
  assert.match(css, /\.hidden\s*\{/);
  assert.match(css, /\.bg-blue-100\s*\{/);
  const allowed = JSON.parse(entries.get('offline/package-files.json').toString());
  assert.deepEqual(allowed.files, names.sort());
});

async function fixture(t, workspaceId = crypto.randomUUID()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-launcher-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = { 'app/index.html': '<!doctype html>offline test', 'app/lib/offline-config.js': 'window.ATLAS_OFFLINE = ' + JSON.stringify({ enabled: true, workspaceId, workspaceArchive: 'data/workspace.zip' }) + ';\nwindow.ATLAS_OFFLINE_WORKSPACE_ID = window.ATLAS_OFFLINE.workspaceId;\n', 'app/data/workspace.zip': 'private workspace', 'runtime/node.exe': 'synthetic runtime', '.secret': 'never served' };
  files['offline/package-files.json'] = JSON.stringify({ format: 'marmoset-atlas-package-files', version: 1, files: ['app/index.html', 'app/lib/offline-config.js', 'runtime/node.exe', 'offline/package-files.json'] });
  for (const [relative, data] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), data); }
  return root;
}
function request(port, pathname, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers, method }, res => { let body = ''; res.setEncoding('utf8'); res.on('data', part => { body += part; }); res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers })); });
    req.on('error', reject); req.end();
  });
}
function close(server) { return new Promise(resolve => server.close(resolve)); }

test('launcher is loopback-only, serves declared assets and blocks cross-origin/traversal reads', async t => {
  const root = await fixture(t);
  const result = await start(root);
  t.after(() => close(result.server));
  assert.equal(result.server.address().address, '127.0.0.1');
  assert.equal((await request(result.port, '/')).status, 200);
  assert.equal((await request(result.port, '/data/workspace.zip')).body, 'private workspace');
  assert.equal((await request(result.port, '/__atlas_package/runtime/node.exe')).body, 'synthetic runtime');
  for (const pathname of ['/__atlas_package/app/data/workspace.zip', '/__atlas_package/../.secret', '/__atlas_package/%2e%2e%2f.secret', '/%2e%2e%5c.secret', '/.secret', '/__atlas_package/.secret']) assert.equal((await request(result.port, pathname)).status, 404, pathname);
  assert.equal((await request(result.port, '/', { host: 'evil.example' })).status, 403);
  assert.equal((await request(result.port, '/', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await request(result.port, '/', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await request(result.port, '/', {}, 'POST')).status, 405);
  const manifest = JSON.parse((await request(result.port, '/__atlas_files.json')).body);
  assert.equal(manifest.files.length, 4);
  assert.ok(!manifest.files.some(file => file.path.includes('workspace.zip')));
  for (const file of manifest.files) {
    const bytes = await fs.readFile(path.join(root, file.path));
    assert.equal(file.size, bytes.length);
    assert.equal(file.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  }
  const repeat = await start(root);
  assert.equal(repeat.existing, true);
  assert.equal(repeat.port, result.port);
});

test('launcher retains browser origin and refuses to silently change a saved occupied port', async t => {
  const root = await fixture(t);
  const first = await start(root);
  await close(first.server);
  const second = await start(root);
  assert.equal(second.port, first.port);
  await close(second.server);
  const occupied = http.createServer((req, res) => { res.end('{}'); });
  await new Promise(resolve => occupied.listen(first.port, '127.0.0.1', resolve));
  t.after(() => close(occupied));
  await assert.rejects(start(root), /kept unchanged/);
});

test('first launch chooses another port for a different package instead of reusing its data', async t => {
  const workspaceId = crypto.randomUUID();
  const first = await start(await fixture(t, workspaceId));
  t.after(() => close(first.server));
  const second = await start(await fixture(t, workspaceId));
  t.after(() => close(second.server));
  assert.equal(second.existing, false);
  assert.notEqual(second.port, first.port);
});

test('launcher parses JSON configuration without executing JavaScript', () => {
  assert.throws(() => parseConfig('window.ATLAS_OFFLINE = {"enabled":true}; process.exit();'), /Invalid offline/);
  assert.throws(() => parseConfig('window.ATLAS_OFFLINE = {"enabled":true,"workspaceId":"../escape","workspaceArchive":"data/workspace.zip"};'), /Invalid offline/);
  for (const workspaceId of ['_workspace', 'x'.repeat(81)]) assert.throws(() => parseConfig('window.ATLAS_OFFLINE = ' + JSON.stringify({ enabled: true, workspaceId, workspaceArchive: 'data/workspace.zip' }) + ';'), /Invalid offline/);
});
