'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

/** Hermetic app server; no real cloud accounts, credentials, or user data. */
async function startBrowserHarness() {
  const root = path.resolve(__dirname, '..');
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/__test_seed') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><meta charset="utf-8"><script src="/lib/storage.js"></script><script src="/lib/msi.js"></script><script src="/lib/normalization-scope.js"></script><script src="/lib/normalization.js"></script>');
        return;
      }
      const filename = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!filename.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
      const data = await fs.readFile(filename);
      response.setHeader('Content-Type', filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'application/octet-stream');
      response.end(data);
    } catch (_) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseURL = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE_PATH;
    const args = process.env.PLAYWRIGHT_CHROMIUM_ARGS ? JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS) : [];
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args });
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    // Third-party script loading must not turn a local regression into a cloud action.
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(baseURL) || /^(data:|blob:)/.test(url)) return route.continue();
      // Functional tests only: essential layout utilities replace the third-party CDN.
      // Pixel-perfect visual QA must use the production stylesheet separately.
      const css = 'body{margin:0}.hidden{display:none!important}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1 1 0%}.flex-wrap{flex-wrap:wrap}.shrink-0{flex-shrink:0}.h-screen{height:100vh}.min-h-0{min-height:0}.min-w-0{min-width:0}.relative{position:relative}.absolute{position:absolute}.fixed{position:fixed}.inset-0{inset:0}.w-full{width:100%}.h-full{height:100%}.overflow-hidden{overflow:hidden}.overflow-auto{overflow:auto}.overflow-y-auto{overflow-y:auto}.items-center{align-items:center}.justify-between{justify-content:space-between}.pointer-events-none{pointer-events:none}.opacity-0{opacity:0}';
      const body = url.includes('cdn.tailwindcss.com') ? 'const s=document.createElement("style");s.textContent=' + JSON.stringify(css) + ';document.head.append(s)' : '';
      return route.fulfill({ status: 200, contentType: 'application/javascript', body });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    return { browser, context, page, baseURL, errors, async close() { await browser.close(); await new Promise(resolve => server.close(resolve)); } };
  } catch (error) {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    throw error;
  }
}

async function seedViewerProject(page, baseURL, { savedOtsu = false, id = 'viewer-test' } = {}) {
  await page.goto(baseURL + '/__test_seed');
  return page.evaluate(async ({ savedOtsu, id }) => {
    const p = {
      id, displayName: 'Synthetic viewer regression', grid: { W: 4, H: 2 }, images: {},
      molecules: [], visibleLayers: ['MSI_5-HT'],
      roi: { roi_items: { all: [{ poly_msi: [[0, 0], [4, 0], [4, 2], [0, 2]] }] }, roi_names: { all: 'All pixels' }, palette: { all: [255, 0, 0, 255] }, roi_show_flags: { all: true } },
      valueDisplay: { mode: 'normalized', scale: 'common' },
      otsu: { applied: savedOtsu, strength: 0, manualThreshold: null, sourceKeys: ['MSI_5-HT', 'MSI_DA'] },
    };
    const definitions = [
      ['MSI_5-HT', '5-HT', [0, 2, 3, 4, 50, 60, 70, 80]],
      ['MSI_D4-5-HT', 'D4-5-HT', [2, 2, 2, 2, 2, 2, 2, 2]],
      ['MSI_DA', 'DA', [1, 1, 1, 1, 25, 30, 35, 40]],
      ['MSI_NE', 'NE', [2, 2, 2, 2, 50, 60, 70, 80]],
    ];
    const rasters = {};
    for (const [key, name, source] of definitions) {
      const values = new Float32Array(source);
      const blobId = await ProjectStorage.putValueRaster(values);
      p.molecules.push({ key, name, blobId, stats: MSIRaster.deriveBakeStats(values) });
      rasters[key] = { W: 4, H: 2, values };
    }
    const created = Normalization.createProfiles([{ project: p, rasters, mapping: Normalization.suggestMapping(p.molecules) }], {
      id: 'viewer-profile', revision: 1, batchId: 'synthetic-batch', prepId: 'synthetic-prep', quality: 'provisional',
      coordinateMatchConfirmed: true, comparabilityConfirmed: true,
      qc: { minD4: 0, saturationD4: 1000, minCoverage: 0.8 },
      reference: { kind: 'whole_tissue', projectIds: [p.id], roiNames: [] }, calibration: null, otsuSourceRoles: ['ht', 'da'],
    });
    p.normalization = created.profiles[0].normalization;
    await ProjectStorage.putProject(p);
    return p.id;
  }, { savedOtsu, id });
}

module.exports = { startBrowserHarness, seedViewerProject };
