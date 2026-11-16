'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const context = { URL, URLSearchParams }; context.window = context;
vm.runInNewContext(fs.readFileSync(path.join(root, 'lib/msi-st-pairs.js'), 'utf8'), context);
const registry = context.MsiStPairs;

test('all six project IDs resolve consistently from both app entry points, including Pages subpaths', () => {
  assert.equal(registry.pairs.length, 6);
  assert.equal(new Set(registry.pairs.map(p => p.projectId)).size, 6);
  for (const pair of registry.pairs) for (const from of ['viewer', 'stack3d']) {
    const project = { id: pair.projectId, displayName: pair.section };
    const url = new URL(registry.comparisonUrl(project, { from,
      baseUrl: 'https://example.com/marmoset_mouse_atlas/' + from + '/index.html?project=old' }));
    assert.equal(url.pathname, '/marmoset_mouse_atlas/comparison/index.html');
    assert.equal(url.searchParams.get('project'), pair.projectId);
    assert.equal(url.searchParams.get('section'), pair.section);
    assert.equal(url.searchParams.get('st'), pair.st);
    assert.equal(url.searchParams.get('from'), from);
    assert.equal(registry.resolveQuery(url.search).pair, pair);
    assert.equal(registry.resolveQuery('?section=' + pair.section).pair, pair);
    assert.equal(registry.getPairForProject({ project }), pair);
  }
});

test('copies with the same name, explicit mouse/sagittal/other-series projects never show a registered snapshot', () => {
  const pair = registry.pairs[0], original = { id: pair.projectId, displayName: pair.section };
  assert.equal(registry.getPairForProject({ ...original, displayName: 'renamed section' }), pair);
  for (const project of [null, {}, { ...original, id: 'copy' },
    { ...original, plane: 'sagittal' }, { ...original, atlas: { species: 'mouse' } },
    { ...original, atlas: { seriesId: 'another-marmoset' } },
    { ...original, atlas: { coordinateMode: 'pixel' } }]) {
    assert.equal(registry.getPairForProject(project), null);
    assert.equal(registry.comparisonUrl(project), null);
  }
});

test('explicit unknown, contradictory, empty, or duplicate identifiers fail closed', () => {
  const [a, b] = registry.pairs;
  for (const search of ['?project=unknown', '?section=', '?st=unknown',
    `?project=${a.projectId}&section=${b.section}`, `?section=${a.section}&st=${b.st}`,
    `?project=unknown&st=${a.st}`, `?section=${a.section}&section=${a.section}`]) {
    const result = registry.resolveQuery(search);
    assert.equal(result.pair, null);
    assert.ok(result.error);
  }
  assert.equal(registry.resolveQuery('').error, null);
  assert.equal(registry.resolveQuery('?from=https://untrusted.example').from, null);
});

test('navigation registry matches the MSI project metadata and public ST payload', () => {
  const html = fs.readFileSync(path.join(root, 'comparison/index.html'), 'utf8');
  const embedded = id => JSON.parse(html.match(new RegExp('<script[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)<\\/script>'))[1]);
  const meta = embedded('mx-section-metadata');
  const bootstrap = fs.readFileSync(path.join(root, 'comparison/bootstrap.js'), 'utf8');
  const packed = JSON.parse(bootstrap.match(/^window\.MARMOSET_BOOTSTRAP=("[^"]+");/)[1]);
  const data = JSON.parse(require('node:zlib').gunzipSync(Buffer.from(packed, 'base64')));
  for (const pair of registry.pairs) {
    assert.equal(meta[pair.st].section, pair.section);
    assert.equal(new URL(meta[pair.st].app_url).searchParams.get('project'), pair.projectId);
    assert.ok(data.catalogs[pair.st].length > 20000);
    assert.ok(data.sections.find(section => section.id === pair.st));
  }
  for (const name of ['app.js', 'bootstrap.js', 'route.js'])
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(root, 'comparison', name), 'utf8'), { filename: name }));
});
