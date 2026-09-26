'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { parseVersion, compareVersions, isNewer, normalizeVersion, detectGameVersion } = require('../src/shared/versioning');
const { extractGameHtml } = require('../src/shared/gamePackage');
const { feedUrlFrom, parseUpdateSource, parseManifest, isConfiguredRepo } = require('../src/shared/manifest');
const { makeZip, fakeGameHtml } = require('./helpers/fakeGithub');

test('versions compare numerically, part by part', () => {
  assert.deepEqual(parseVersion('v185'), [185]);
  assert.deepEqual(parseVersion(' 1.10.2 '), [1, 10, 2]);
  assert.equal(parseVersion('beta'), null);
  assert.ok(isNewer('185', '184'));
  assert.ok(isNewer('1.10.0', '1.9.9'));
  assert.ok(isNewer('185.1', '185'));
  assert.equal(compareVersions('185', '185.0'), 0);
  assert.equal(compareVersions('v184', '184'), 0);
  assert.ok(isNewer('1', null), 'anything beats nothing');
  assert.equal(normalizeVersion('v185'), '185');
  assert.equal(normalizeVersion('launcher'), null);
});

test('game version comes from the changelog header first, then the file name', () => {
  assert.equal(detectGameVersion('<!DOCTYPE html>\n<!--\n  v184 — seasonal regulations', 'pokemon_battle_v183.html'), '184');
  assert.equal(detectGameVersion('<!DOCTYPE html><html>', 'pokemon_battle_v190_DROPIN_2.html'), '190');
  assert.equal(detectGameVersion('<!DOCTYPE html><html>', 'game.html'), null);
});

// The launcher release bundles whatever game is newest (fetch-game), so the expected version comes
// from game/game.json, not from a number written here (a hard-coded 184 failed once v190 was bundled).
test('the real bundled build is detected by its own header, as game/game.json says', { skip: !fs.existsSync(path.join(__dirname, '..', 'game', 'game.html')) }, () => {
  const fd = fs.openSync(path.join(__dirname, '..', 'game', 'game.html'), 'r');
  const head = Buffer.alloc(20000);
  fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);
  const v = detectGameVersion(head, 'pokemon_battle_v1.html');
  assert.ok(v && v !== '1', `version read from the changelog header, not the file name (${v})`);
  const metaFile = path.join(__dirname, '..', 'game', 'game.json');
  if (fs.existsSync(metaFile)) assert.equal(v, JSON.parse(fs.readFileSync(metaFile, 'utf8')).version);
});

test('game builds unpack from .html, .html.gz and .zip', () => {
  const html = fakeGameHtml(185);
  assert.deepEqual(extractGameHtml(html).html, html);
  assert.deepEqual(extractGameHtml(zlib.gzipSync(html)).html, html);
  const zip = makeZip([{ name: 'readme.txt', data: Buffer.from('hi') }, { name: 'pokemon_battle_v185.html', data: html }]);
  const fromZip = extractGameHtml(zip);
  assert.deepEqual(fromZip.html, html);
  assert.equal(fromZip.innerName, 'pokemon_battle_v185.html');
  const stored = makeZip([{ name: 'x/game.html', data: html, deflate: false }]);
  assert.deepEqual(extractGameHtml(stored).html, html);
});

test('non-game files are refused with a readable message', () => {
  assert.throws(() => extractGameHtml(Buffer.from('just some text')), /not a game build/);
  assert.throws(() => extractGameHtml(makeZip([{ name: 'a.txt', data: Buffer.from('x') }])), /no \.html/);
  assert.throws(() => extractGameHtml(zlib.gzipSync(Buffer.from('plain'))), /does not contain an HTML page/);
});

test('feed URL comes from a GitHub repo, a direct URL, or nothing', () => {
  assert.equal(feedUrlFrom({ github: 'sasha/pokemon-battle' }), 'https://github.com/sasha/pokemon-battle/releases/latest/download/latest.json');
  assert.equal(feedUrlFrom({ github: 'OWNER/REPO' }), null, 'placeholder means not configured');
  assert.equal(feedUrlFrom({ feedUrl: 'https://example.com/latest.json', github: 'a/b' }), 'https://example.com/latest.json');
  assert.equal(feedUrlFrom({}), null);
  assert.ok(!isConfiguredRepo('not a repo'));
});

test('update source input accepts owner/repo, repo URLs and latest.json links', () => {
  assert.deepEqual(parseUpdateSource('sasha/pokemon-battle'), { github: 'sasha/pokemon-battle', feedUrl: null });
  assert.deepEqual(parseUpdateSource('https://github.com/sasha/pokemon-battle.git'), { github: 'sasha/pokemon-battle', feedUrl: null });
  assert.deepEqual(parseUpdateSource('https://github.com/sasha/pb/releases/download/v185-test/latest.json'), { github: null, feedUrl: 'https://github.com/sasha/pb/releases/download/v185-test/latest.json' });
  assert.deepEqual(parseUpdateSource(''), { github: null, feedUrl: null });
  assert.throws(() => parseUpdateSource('hello world'));
});

test('manifest parsing validates and resolves relative URLs', () => {
  const sha = 'a'.repeat(64);
  const m = parseManifest({ schema: 1, game: { version: 'v185', url: 'game.html.gz', sha256: sha.toUpperCase(), size: 10, notes: 'hi', minLauncher: '1.0' } }, 'https://x.test/rel/latest.json');
  assert.equal(m.game.version, '185');
  assert.equal(m.game.url, 'https://x.test/rel/game.html.gz');
  assert.equal(m.game.sha256, sha);
  assert.equal(m.game.minLauncher, '1.0');
  assert.equal(m.launcher, null);
  assert.throws(() => parseManifest({ game: { version: 'x', url: 'a' } }, 'https://x.test/'), /version/);
  assert.throws(() => parseManifest({ game: { version: '1', url: 'a', sha256: 'nope' } }, 'https://x.test/'), /SHA-256/);
  assert.throws(() => parseManifest({}, 'https://x.test/'), /neither/);
  assert.throws(() => parseManifest({ game: { version: '1', url: 'javascript:alert(1)' } }, 'https://x.test/'), /http/);
});

test('game.history in latest.json is optional and cleaned, never a reason to reject the feed', () => {
  const base = { version: '191', url: 'https://github.com/a/b/releases/download/v191/g.gz' };
  assert.deepEqual(parseManifest({ schema: 1, game: base }, 'https://github.com/').game.history, [], 'old feeds: no history');
  const h = parseManifest({ schema: 1, game: { ...base, history: [
    { version: '190', notes: 'a', date: '2026-09-26' }, { version: 'v189', notes: 5 }, null, 'x', { notes: 'no version' },
    { version: '191', notes: 'the current one again' }, { version: '190', notes: 'dup' },
    ...Array.from({ length: 20 }, (_, i) => ({ version: String(170 + i), notes: 'n' })),
  ] } }, 'https://github.com/').game.history;
  assert.equal(h[0].version, '190');
  assert.deepEqual(h[1], { version: '189', notes: '', date: null });
  assert.ok(!h.some(x => x.version === '191'), 'the current version is not its own history');
  assert.equal(h.filter(x => x.version === '190').length, 1);
  assert.equal(h.length, 12, 'capped');
  assert.equal(parseManifest({ schema: 1, game: { ...base, history: 'nonsense' } }, 'https://github.com/').game.history.length, 0);
});
