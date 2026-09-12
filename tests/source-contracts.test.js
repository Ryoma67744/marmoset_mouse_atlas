'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

test('all production scripts and inline scripts parse without executing', () => {
  for (const name of fs.readdirSync(path.join(root, 'lib')).filter(name => name.endsWith('.js'))) {
    new vm.Script(fs.readFileSync(path.join(root, 'lib', name), 'utf8'), {filename:name});
  }
  for (const name of ['index.html', 'viewer/index.html']) {
    const source = fs.readFileSync(path.join(root, name), 'utf8');
    for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (!/\bsrc\s*=/.test(match[1])) new vm.Script(match[2], {filename:name});
    }
    const sources = [...source.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match=>match[1]);
    assert.ok(sources.some(src=>src.endsWith('/normalization.js')));
    for (const src of sources.filter(src=>!/^https?:/.test(src))) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(path.join(root,name)), src)), src + ' exists');
    }
  }
});

test('new normalization configuration remains project metadata without a DB migration', () => {
  const storage = fs.readFileSync(path.join(root,'lib/storage.js'),'utf8');
  assert.match(storage, /const DB_VERSION = 2;/);
  assert.match(storage, /putProjectsIfUnchanged/);
  const master = fs.readFileSync(path.join(root,'index.html'),'utf8');
  assert.match(master, /normalization: result\.normalization/);
  assert.match(master, /compression: 'STORE'/);
  assert.match(master, /Cloud\.patchRowIfUnchanged/);
});
