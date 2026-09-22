#!/usr/bin/env node
'use strict';
/**
 * Just enough of the GitHub CLI for scripts/release.js, backed by a folder:
 *   $FAKE_GH_DIR/<tag>/release.json  {tag_name, body, draft, prerelease, created}
 *   $FAKE_GH_DIR/<tag>/assets/<file>
 */
const fs = require('fs');
const path = require('path');

const root = process.env.FAKE_GH_DIR;
const a = process.argv.slice(2);
const opt = name => { const i = a.indexOf(name); return i >= 0 ? a[i + 1] : null; };
const rel = tag => path.join(root, tag);
const assets = tag => { const d = path.join(rel(tag), 'assets'); return fs.existsSync(d) ? fs.readdirSync(d).map(n => ({ name: n, size: fs.statSync(path.join(d, n)).size })) : []; };
const meta = tag => JSON.parse(fs.readFileSync(path.join(rel(tag), 'release.json'), 'utf8'));
const fail = msg => { process.stderr.write(msg + '\n'); process.exit(1); };

if (a[0] === 'api' && /releases/.test(a[1])) {
  // Deliberately NOT newest-first: GitHub's own order is unreliable (it listed v184 ahead of the newer
  // launcher-v1.0.2), so list by tag name, descending, which reproduces exactly that.
  const list = fs.readdirSync(root).map(t => ({ ...meta(t), assets: assets(t) })).sort((x, y) => y.tag_name.localeCompare(x.tag_name));
  process.stdout.write(JSON.stringify(list));
} else if (a[0] === 'release' && a[1] === 'view') {
  const m = meta(a[2]);
  process.stdout.write(JSON.stringify({ body: m.body, isPrerelease: !!m.prerelease, assets: assets(a[2]) }));
} else if (a[0] === 'release' && a[1] === 'download') {
  const file = path.join(rel(a[2]), 'assets', opt('--pattern'));
  if (!fs.existsSync(file)) fail('no asset');
  if (opt('--output') === '-') process.stdout.write(fs.readFileSync(file));
  else fs.copyFileSync(file, path.join(opt('--dir'), path.basename(file)));
} else if (a[0] === 'release' && a[1] === 'upload') {
  const files = a.slice(3).filter((x, i, all) => !x.startsWith('--') && !(all[i - 1] || '').startsWith('--repo'));
  fs.mkdirSync(path.join(rel(a[2]), 'assets'), { recursive: true });
  for (const f of files) fs.copyFileSync(f, path.join(rel(a[2]), 'assets', path.basename(f)));
} else {
  fail(`fake gh: unsupported: ${a.join(' ')}`);
}
