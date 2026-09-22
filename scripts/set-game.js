#!/usr/bin/env node
'use strict';
/**
 * Sets the game build that ships INSIDE the installer (game/game.html + game/game.json).
 *   npm run set-game -- <file.html | file.zip | file.html.gz> [--version 185] [--notes "…"]
 * The launcher still downloads newer builds on its own; this is only the offline starting point.
 */
const fs = require('fs');
const path = require('path');
const { extractGameHtml } = require('../src/shared/gamePackage');
const { detectGameVersion, normalizeVersion } = require('../src/shared/versioning');

function arg(name) { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; }

const file = process.argv.slice(2).find((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--')));
if (!file) { console.error('usage: npm run set-game -- <file.html|.zip|.html.gz> [--version N] [--notes "…"]'); process.exit(1); }

const { html, innerName } = extractGameHtml(fs.readFileSync(file));
const version = normalizeVersion(arg('version')) || detectGameVersion(html, innerName || path.basename(file));
if (!version) { console.error('Could not work out the version from the file. Pass --version N.'); process.exit(1); }

const dir = path.join(__dirname, '..', 'game');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'game.html'), html);
fs.writeFileSync(path.join(dir, 'game.json'), JSON.stringify({
  version,
  notes: arg('notes') || '',
  date: new Date().toISOString().slice(0, 10),
  source: path.basename(file),
}, null, 2) + '\n');
console.log(`Bundled game set to v${version} (${(html.length / 1048576).toFixed(1)} MB) from ${path.basename(file)}`);
