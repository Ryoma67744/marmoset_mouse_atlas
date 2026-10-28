'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { buildOffline } = require('./build-offline.cjs');
async function buildPages() {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, '_site');
  // The generated site contains only deployed assets, never npm caches or tests.
  if (path.dirname(output) !== root || path.basename(output) !== '_site') throw new Error('Invalid generated site path.');
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  for (const name of ['index.html', 'lib', 'viewer', 'stack3d', '.nojekyll', 'USER_GUIDE.md', 'USER_GUIDE.pdf', 'STACK3D_GUIDE.md']) await fs.cp(path.join(root, name), path.join(output, name), { recursive: true });
  const { manifest } = await buildOffline({ root, output: path.join(output, 'offline') });
  console.log('Site ready in _site; offline template ' + manifest.appVersion + ', ' + manifest.size + ' bytes.');
}
if (require.main === module) buildPages().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { buildPages };
