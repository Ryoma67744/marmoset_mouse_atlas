'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const JSZip = require('jszip');
const tailwind = require('tailwindcss');
const postcss = createRequire(require.resolve('tailwindcss/package.json'))('postcss');

// Reviewed against https://nodejs.org/dist/v24.22.1/SHASUMS256.txt.
const NODE = Object.freeze({ version: '24.22.1', filename: 'node-v24.22.1-win-x64.zip', sha256: 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5' });
const ASSET_EXTENSIONS = new Set(['.js', '.css', '.html', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.txt']);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
async function walk(root, relative = '') {
  const files = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not supported in app assets: ' + name);
    if (entry.isDirectory()) files.push(...await walk(root, name));
    else if (entry.isFile() && ASSET_EXTENSIONS.has(path.extname(entry.name))) files.push(name);
  }
  return files.sort();
}
function rewriteHtml(source, prefix) {
  return source
    .replace(/<script\s+src="https:\/\/cdn\.tailwindcss\.com"\s*><\/script>/g, '<link rel="stylesheet" href="' + prefix + 'vendor/tailwind.css">')
    .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/xlsx@0\.18\.5\/dist\/xlsx\.full\.min\.js/g, prefix + 'vendor/xlsx.full.min.js')
    .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/jszip@3\.10\.1\/dist\/jszip\.min\.js/g, prefix + 'vendor/jszip.min.js')
    .replace(/<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/utif@3\.1\.0\/UTIF\.js"\s*><\/script>/g, '<script src="' + prefix + 'vendor/pako.min.js"></script>\n<script src="' + prefix + 'vendor/UTIF.js"></script>');
}
async function nodeRuntime(cacheDir) {
  await fs.mkdir(cacheDir, { recursive: true });
  const filename = path.join(cacheDir, NODE.filename);
  let bytes;
  try { bytes = await fs.readFile(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes) {
    const base = 'https://nodejs.org/dist/v' + NODE.version + '/';
    const sums = await fetch(base + 'SHASUMS256.txt', { signal: AbortSignal.timeout(60000) });
    if (!sums.ok) throw new Error('Cannot read official Node.js checksums: ' + sums.status);
    const official = (await sums.text()).split(/\r?\n/).find(line => line.endsWith('  ' + NODE.filename));
    if (!official || official.split(/\s+/)[0] !== NODE.sha256) throw new Error('Node.js release checksum does not match the reviewed version.');
    const response = await fetch(base + NODE.filename, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error('Cannot download Node.js: ' + response.status);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== NODE.sha256) throw new Error('Node.js download checksum mismatch.');
    await fs.writeFile(filename, bytes);
  }
  if (sha256(bytes) !== NODE.sha256) throw new Error('Cached Node.js archive checksum mismatch. Remove the cache and rebuild.');
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const prefix = 'node-v' + NODE.version + '-win-x64/';
  const exe = archive.file(prefix + 'node.exe');
  const license = archive.file(prefix + 'LICENSE');
  if (!exe || !license) throw new Error('Official Node.js archive is missing runtime or license.');
  return { exe: await exe.async('nodebuffer'), license: await license.async('nodebuffer') };
}
async function buildOffline(options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const output = options.output || path.join(root, 'offline');
  const includeRuntime = options.includeRuntime !== false;
  const entries = new Map();
  for (const directory of ['lib', 'viewer', 'stack3d']) {
    for (const relative of await walk(path.join(root, directory))) entries.set('app/' + directory + '/' + relative, await fs.readFile(path.join(root, directory, ...relative.split('/'))));
  }
  entries.set('app/index.html', await fs.readFile(path.join(root, 'index.html')));
  for (const name of ['USER_GUIDE.md', 'USER_GUIDE.pdf', 'STACK3D_GUIDE.md']) entries.set('app/' + name, await fs.readFile(path.join(root, name)));
  const versionSource = entries.get('app/lib/version.js').toString('utf8');
  const appVersion = versionSource.match(/const APP_VERSION\s*=\s*['"]([^'"]+)['"]/)[1];
  const content = [...entries.entries()].filter(([name]) => /\.(html|js)$/.test(name)).map(([name, bytes]) => ({ raw: bytes.toString('utf8'), extension: path.extname(name).slice(1) }));
  const css = await postcss([tailwind({ content, theme: {}, plugins: [], safelist: [{ pattern: /^(bg|text|border)-(blue|gray|red|green|amber|indigo|orange|slate)-(50|100|200|300|400|500|600|700|800|900)$/ }] })]).process('@tailwind base;\n@tailwind components;\n@tailwind utilities;', { from: undefined });
  entries.set('app/vendor/tailwind.css', Buffer.from(css.css));
  for (const [name, prefix] of [['app/index.html', ''], ['app/viewer/index.html', '../'], ['app/stack3d/index.html', '../']]) {
    const html = rewriteHtml(entries.get(name).toString('utf8'), prefix);
    if (/<(?:script|link)\b[^>]*(?:src|href)=["'](?:https?:)?\/\//i.test(html)) throw new Error('Unbundled remote dependency in ' + name);
    entries.set(name, Buffer.from(html));
  }
  entries.set('app/lib/cloud-config.js', Buffer.from('window.CLOUD_CONFIG = { url: "", anonKey: "", email: "", bucket: "atlas" };\n'));
  entries.set('app/lib/offline-config.js', Buffer.from('window.ATLAS_OFFLINE = {"enabled":false};\n'));
  for (const [from, to] of [
    ['jszip/dist/jszip.min.js', 'app/vendor/jszip.min.js'], ['xlsx/dist/xlsx.full.min.js', 'app/vendor/xlsx.full.min.js'],
    ['utif/UTIF.js', 'app/vendor/UTIF.js'], ['pako/dist/pako.min.js', 'app/vendor/pako.min.js'],
    ['jszip/LICENSE.markdown', 'LICENSES/JSZip.txt'], ['xlsx/LICENSE', 'LICENSES/SheetJS.txt'], ['utif/LICENSE', 'LICENSES/UTIF.txt'],
    ['pako/LICENSE', 'LICENSES/pako.txt'], ['tailwindcss/LICENSE', 'LICENSES/TailwindCSS.txt'],
  ]) entries.set(to, await fs.readFile(path.join(root, 'node_modules', ...from.split('/'))));
  entries.set('LICENSES/Three.js.txt', await fs.readFile(path.join(root, 'stack3d/vendor/LICENSE-THREE.txt')));
  for (const [from, to] of [['offline/server.cjs', 'offline/server.cjs'], ['offline/START_ATLAS.cmd', 'START_ATLAS.cmd'], ['offline/README.txt', 'README.txt']]) {
    const bytes = await fs.readFile(path.join(root, from));
    entries.set(to, to.endsWith('.cmd') ? Buffer.from(bytes.toString('utf8').replace(/\r?\n/g, '\r\n')) : bytes);
  }
  if (includeRuntime) {
    const runtime = await nodeRuntime(options.cacheDir || path.join(root, '.cache/offline'));
    entries.set('runtime/node.exe', runtime.exe);
    entries.set('runtime/LICENSE', runtime.license);
  }
  const paths = [...entries.keys(), 'offline/package-files.json'].sort();
  entries.set('offline/package-files.json', Buffer.from(JSON.stringify({ format: 'marmoset-atlas-package-files', version: 1, files: paths }, null, 2) + '\n'));
  const zip = new JSZip();
  // Stable entry dates and sorted paths make identical inputs reproducible.
  for (const name of paths) zip.file(name, entries.get(name), { date: new Date('2020-01-01T00:00:00Z'), createFolders: false });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' });
  const manifest = { format: 'marmoset-atlas-app-template', schemaVersion: 1, appVersion, platform: 'win32-x64', nodeVersion: NODE.version, runtimeIncluded: includeRuntime, archive: 'atlas-app.zip', size: bytes.length, sha256: sha256(bytes), files: paths.length };
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'atlas-app.zip'), bytes);
  await fs.writeFile(path.join(output, 'atlas-app.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, bytes, entries };
}
if (require.main === module) buildOffline({ includeRuntime: !process.argv.includes('--skip-runtime') }).then(({ manifest }) => console.log(JSON.stringify(manifest, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { buildOffline, rewriteHtml, nodeRuntime, NODE };
