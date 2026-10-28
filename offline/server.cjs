'use strict';
// Local, read-only launcher. No npm installation or Internet connection is needed.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.zip': 'application/zip' };
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0') && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes(':'));
}
function parseConfig(source) {
  const match = source.match(/^\s*window\.ATLAS_OFFLINE\s*=\s*(\{[^]*?\});\s*(?:window\.ATLAS_OFFLINE_WORKSPACE_ID\s*=\s*window\.ATLAS_OFFLINE\.workspaceId;\s*)?$/);
  if (!match) throw new Error('Invalid offline configuration. Download the complete package again.');
  const config = JSON.parse(match[1]);
  if (config.enabled !== true || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(config.workspaceId || '') || config.workspaceArchive !== 'data/workspace.zip') throw new Error('Invalid offline workspace.');
  return config;
}
async function loadPackage(root) {
  const realRoot = await fs.realpath(root);
  const config = parseConfig(await fs.readFile(path.join(realRoot, 'app/lib/offline-config.js'), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(realRoot, 'offline/package-files.json'), 'utf8'));
  if (manifest.format !== 'marmoset-atlas-package-files' || manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.every(safeRelative) || new Set(manifest.files).size !== manifest.files.length) throw new Error('Invalid package file manifest.');
  if (manifest.files.includes('app/data/workspace.zip')) throw new Error('Workspace data must not be part of the app template.');
  const files = new Set(manifest.files);
  const instance = sha256(realRoot + '\n' + config.workspaceId);
  async function read(relative) {
    if (!safeRelative(relative)) throw new Error('Invalid path.');
    const filename = await fs.realpath(path.join(realRoot, ...relative.split('/')));
    if (!filename.startsWith(realRoot + path.sep)) throw new Error('Path outside package.');
    return fs.readFile(filename);
  }
  return { root: realRoot, config, files, instance, read };
}
function createServer(pkg) {
  return http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const host = '127.0.0.1:' + request.socket.localPort;
    // Block DNS rebinding and cross-origin reads of the user's data/template.
    if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== 'http://' + host) || request.headers['sec-fetch-site'] === 'cross-site') { response.writeHead(403); response.end('Forbidden'); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://' + host).pathname);
      if (pathname === '/__atlas_status') {
        response.setHeader('Content-Type', MIME['.json']);
        response.end(request.method === 'HEAD' ? '' : JSON.stringify({ instance: pkg.instance }));
        return;
      }
      if (pathname === '/__atlas_files.json') {
        const files = [];
        for (const relative of pkg.files) { const bytes = await pkg.read(relative); files.push({ path: relative, size: bytes.length, sha256: sha256(bytes) }); }
        response.setHeader('Content-Type', MIME['.json']);
        response.end(request.method === 'HEAD' ? '' : JSON.stringify({ format: 'marmoset-atlas-package-files', version: 1, files }));
        return;
      }
      let relative;
      if (pathname.startsWith('/__atlas_package/')) {
        relative = pathname.slice('/__atlas_package/'.length);
        if (!pkg.files.has(relative)) throw new Error('Not allowed.');
      } else {
        relative = 'app/' + (pathname === '/' ? 'index.html' : pathname.slice(1));
        if (!pkg.files.has(relative) && relative !== 'app/data/workspace.zip') throw new Error('Not allowed.');
      }
      const data = await pkg.read(relative);
      response.setHeader('Content-Type', MIME[path.extname(relative).toLowerCase()] || 'application/octet-stream');
      response.setHeader('Content-Length', data.length);
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch (_) { response.writeHead(404); response.end('Not found'); }
  });
}
function listen(server, port) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
}
async function isSameInstance(port, instance) {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/__atlas_status', { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).instance === instance;
  } catch (_) { return false; }
}
async function start(root) {
  const pkg = await loadPackage(root);
  const portFile = path.join(pkg.root, '.atlas-port.json');
  let saved;
  try { saved = JSON.parse(await fs.readFile(portFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read saved launcher port. Keep .atlas-port.json with this package.'); }
  if (saved && (saved.workspaceId !== pkg.config.workspaceId || !Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535)) throw new Error('Invalid saved launcher port.');
  const base = saved ? saved.port : 42000 + parseInt(sha256(pkg.config.workspaceId).slice(0, 8), 16) % 12000;
  for (let attempt = 0; attempt < (saved ? 1 : 32); attempt++) {
    const port = base + attempt;
    const server = createServer(pkg);
    try {
      await listen(server, port);
      // Keep a stable origin so browser edits remain available on the next launch.
      try { await fs.writeFile(portFile, JSON.stringify({ workspaceId: pkg.config.workspaceId, port }) + '\n'); }
      catch (error) { await new Promise(resolve => server.close(resolve)); throw new Error('Extract the ZIP to a writable folder before starting Atlas.'); }
      return { server, port, existing: false, config: pkg.config };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      if (await isSameInstance(port, pkg.instance)) return { server: null, port, existing: true, config: pkg.config };
      if (saved) throw new Error('Port ' + port + ' is in use by another program. Close that program and retry. The port is kept unchanged to preserve your browser edits.');
    }
  }
  throw new Error('No local port is available. Close other Atlas launchers and retry.');
}
function openBrowser(url) {
  if (process.platform === 'win32') spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
if (require.main === module) {
  start(path.resolve(__dirname, '..')).then(result => {
    const url = 'http://127.0.0.1:' + result.port + '/';
    console.log('\nMarmoset / Mouse Atlas (offline)\n' + url + '\n');
    console.log(result.existing ? 'Atlas is already running.' : 'Keep this window open while using Atlas. Press Ctrl+C to stop.');
    console.log('Use the app download button to save edits into a new complete package.');
    if (!process.argv.includes('--no-open')) openBrowser(url);
  }).catch(error => { console.error('\nAtlas could not start: ' + error.message); process.exitCode = 1; });
}
module.exports = { safeRelative, parseConfig, loadPackage, createServer, start };
