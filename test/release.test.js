'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { buildGameRelease, mergeManifest, gameHistory, versionFromTag, commands } = require('../scripts/release');
const { parseManifest } = require('../src/shared/manifest');
const { makeZip, fakeGameHtml } = require('./helpers/fakeGithub');

test('tag names map to versions only when they are version tags', () => {
  assert.equal(versionFromTag('v185'), '185');
  assert.equal(versionFromTag('185.1'), '185.1');
  assert.equal(versionFromTag('launcher-v1.0.0'), null);
  assert.equal(versionFromTag('test'), null);
});

test('game release: gzips, hashes and points at the tag', () => {
  const html = fakeGameHtml(185);
  const r = buildGameRelease({ input: makeZip([{ name: 'pokemon_battle_v185.html', data: html }]), inputName: 'x_DROPIN_3.zip', repo: 'sasha/pb', tag: 'v185', notes: '- fixed stuff\n' });
  assert.equal(r.version, '185');
  assert.equal(r.fileName, 'pokemon_battle_v185.html.gz');
  assert.deepEqual(zlib.gunzipSync(r.gz), html);
  assert.equal(r.entry.url, 'https://github.com/sasha/pb/releases/download/v185/pokemon_battle_v185.html.gz');
  assert.equal(r.entry.size, r.gz.length);
  assert.equal(r.entry.notes, '- fixed stuff');
});

test('game release: version from header when the tag is not a version', () => {
  const r = buildGameRelease({ input: fakeGameHtml(186), inputName: 'game.html', repo: 'a/b', tag: 'test-build' });
  assert.equal(r.version, '186');
});

test('manifest merge keeps the other block and stays valid', () => {
  const launcher = { version: '1.0.0', url: 'https://github.com/a/b/releases/download/launcher-v1.0.0/Setup.exe', sha256: 'a'.repeat(64), size: 5 };
  const r = buildGameRelease({ input: fakeGameHtml(185), repo: 'a/b', tag: 'v185' });
  const m = mergeManifest({ schema: 1, launcher, game: { version: '184', url: 'https://x/y' } }, { game: r.entry });
  assert.equal(m.game.version, '185');
  assert.deepEqual(m.launcher, launcher);
  assert.doesNotThrow(() => parseManifest(m, 'https://github.com/'));
  const fresh = mergeManifest(null, { game: r.entry });
  assert.equal(fresh.launcher, undefined);
});

test('`release game` writes the two files to attach', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-rel-'));
  const htmlPath = path.join(dir, 'pokemon_battle_v187.html');
  fs.writeFileSync(htmlPath, fakeGameHtml(187));
  const out = path.join(dir, 'out');
  const log = console.log; console.log = () => {};
  try {
    await commands.game({ html: htmlPath, repo: 'sasha/pb', tag: 'v187', out, baseManifest: null, notes: 'hello' });
  } finally { console.log = log; }
  assert.deepEqual(fs.readdirSync(out).sort(), ['latest.json', 'pokemon_battle_v187.html.gz']);
  const m = JSON.parse(fs.readFileSync(path.join(out, 'latest.json'), 'utf8'));
  assert.equal(m.game.version, '187');
  assert.equal(m.game.notes, 'hello');
});

test('CI: publishing a release with a .zip attached adds the .gz and a latest.json that carries the launcher forward', { skip: process.platform === 'win32' }, async () => {
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-gh-'));
  const ghDir = path.join(dir, 'gh'); const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'gh'), `#!/bin/sh\nexec node ${JSON.stringify(path.join(__dirname, 'helpers', 'fake-gh.js'))} "$@"\n`, { mode: 0o755 });
  const mk = (tag, created, files, body = '') => {
    fs.mkdirSync(path.join(ghDir, tag, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(ghDir, tag, 'release.json'), JSON.stringify({ tag_name: tag, body, draft: false, published_at: new Date(Date.UTC(2026, 8, 22, 12, Math.round(created * 10))).toISOString() }));
    for (const [n, d] of Object.entries(files)) fs.writeFileSync(path.join(ghDir, tag, 'assets', n), d);
  };
  const launcher = { version: '1.0.0', url: 'https://github.com/sasha/pb/releases/download/launcher-v1.0.0/Setup.exe', sha256: 'f'.repeat(64), size: 9 };
  mk('launcher-v1.0.0', 1, { 'latest.json': JSON.stringify({ schema: 1, launcher }) });
  // A newer PRE-release (a test build) must never become the base for a real release.
  mk('v185-test', 1.5, { 'latest.json': JSON.stringify({ schema: 1, launcher: { ...launcher, version: '9.9.9' } }) });
  const pre = JSON.parse(fs.readFileSync(path.join(ghDir, 'v185-test', 'release.json'), 'utf8'));
  fs.writeFileSync(path.join(ghDir, 'v185-test', 'release.json'), JSON.stringify({ ...pre, prerelease: true }));
  mk('v185', 2, { 'pokemon_battle_v183_DROPIN_11.zip': makeZip([{ name: 'pokemon_battle_v185.html', data: fakeGameHtml(185) }]) }, '## Що нового\n- **Нове:** щось');

  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, FAKE_GH_DIR: ghDir };
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'release.js'), 'ci-game', '--repo', 'sasha/pb', '--tag', 'v185'], { env, stdio: 'pipe' });

  const assetsNow = fs.readdirSync(path.join(ghDir, 'v185', 'assets')).sort();
  assert.deepEqual(assetsNow, ['latest.json', 'pokemon_battle_v183_DROPIN_11.zip', 'pokemon_battle_v185.html.gz']);
  const m = JSON.parse(fs.readFileSync(path.join(ghDir, 'v185', 'assets', 'latest.json'), 'utf8'));
  assert.equal(m.game.version, '185');
  assert.equal(m.game.notes, '## Що нового\n- **Нове:** щось');
  assert.equal(m.game.url, 'https://github.com/sasha/pb/releases/download/v185/pokemon_battle_v185.html.gz');
  assert.deepEqual(m.launcher, launcher, 'launcher block carried forward from the previous release');
  const gz = fs.readFileSync(path.join(ghDir, 'v185', 'assets', 'pokemon_battle_v185.html.gz'));
  assert.equal(m.game.sha256, require('crypto').createHash('sha256').update(gz).digest('hex'));

  // A release with no game file (e.g. an announcement) becomes "latest" too, so it gets a copy of
  // the current latest.json instead of breaking the feed.
  mk('announcement', 3, {});
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'release.js'), 'ci-game', '--repo', 'sasha/pb', '--tag', 'announcement'], { env, stdio: 'pipe' });
  assert.deepEqual(fs.readdirSync(path.join(ghDir, 'announcement', 'assets')), ['latest.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ghDir, 'announcement', 'assets', 'latest.json'), 'utf8')), m);
});

test('CI: the new latest.json keeps the NEWEST launcher even when GitHub lists an older release first (the v185 bug)', { skip: process.platform === 'win32' }, async () => {
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-gh2-'));
  const ghDir = path.join(dir, 'gh'); const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'gh'), `#!/bin/sh\nexec node ${JSON.stringify(path.join(__dirname, 'helpers', 'fake-gh.js'))} "$@"\n`, { mode: 0o755 });
  const mk = (tag, minute, files) => {
    fs.mkdirSync(path.join(ghDir, tag, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(ghDir, tag, 'release.json'), JSON.stringify({ tag_name: tag, body: '', draft: false, published_at: new Date(Date.UTC(2026, 8, 22, 19, minute)).toISOString() }));
    for (const [n, d] of Object.entries(files)) fs.writeFileSync(path.join(ghDir, tag, 'assets', n), d);
  };
  const g184 = { version: '184', url: 'https://github.com/a/b/releases/download/v184/g.gz', sha256: 'a'.repeat(64), size: 1 };
  const L = v => ({ version: v, url: `https://github.com/a/b/releases/download/launcher-v${v}/S.exe`, sha256: 'b'.repeat(64), size: 2 });
  // Exactly today's repo: v184 (no launcher yet), then launchers 1.0.1 and 1.0.2 carrying game 184.
  mk('v184', 15, { 'latest.json': JSON.stringify({ schema: 1, game: g184 }) });
  mk('launcher-v1.0.1', 19, { 'latest.json': JSON.stringify({ schema: 1, game: g184, launcher: L('1.0.1') }) });
  mk('launcher-v1.0.2', 11 + 60, { 'latest.json': JSON.stringify({ schema: 1, game: g184, launcher: L('1.0.2') }) });
  mk('v185', 20 + 60, { 'pokemon_battle_v185.zip': makeZip([{ name: 'pokemon_battle_v185.html', data: fakeGameHtml(185) }]) });
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, FAKE_GH_DIR: ghDir };
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'release.js'), 'ci-game', '--repo', 'a/b', '--tag', 'v185'], { env, stdio: 'pipe' });
  const m = JSON.parse(fs.readFileSync(path.join(ghDir, 'v185', 'assets', 'latest.json'), 'utf8'));
  assert.equal(m.game.version, '185');
  assert.equal(m.launcher && m.launcher.version, '1.0.2', 'launcher 1.0.2 carried forward, not dropped');
});

test('the file\'s own version wins over a mistyped tag (v1.8.8 for build 188)', () => {
  const r = buildGameRelease({ input: fakeGameHtml(188), inputName: 'pokemon_battle_v188.zip', repo: 'a/b', tag: 'v1.8.8' });
  assert.equal(r.version, '188');
  assert.equal(r.fileName, 'pokemon_battle_v188.html.gz');
  assert.match(r.entry.url, /\/download\/v1\.8\.8\/pokemon_battle_v188\.html\.gz$/);
});

test('game history: earlier versions only, newest first, one per version, notes preferred, at most 9', () => {
  const e = (v, notes = '', date = null) => ({ version: v, notes, date, url: 'https://x/y' });
  const h = gameHistory([[e('190', 'n190', '2026-09-26')], [e('189', ''), e('191', 'newer'), e('188', 'n188')], [e('189', 'n189'), e('190', 'dup')],
    Array.from({ length: 12 }, (_, i) => e(String(170 + i), `n${170 + i}`))], '191');
  assert.deepEqual(h.map(x => x.version), ['190', '189', '188', '181', '180', '179', '178', '177', '176']);
  assert.equal(h[0].notes, 'n190');
  assert.equal(h[1].notes, 'n189', 'an entry with notes replaces one without');
  assert.deepEqual(Object.keys(h[0]).sort(), ['date', 'notes', 'version'], 'no urls or hashes: just what the launcher shows');
  assert.deepEqual(gameHistory([null, undefined, []], '185'), []);
});

test('`release game` carries the previous version and its history into game.history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-rel-'));
  const htmlPath = path.join(dir, 'pokemon_battle_v191.html');
  fs.writeFileSync(htmlPath, fakeGameHtml(191));
  const base = { schema: 1, game: { version: '190', url: 'https://x/190.gz', notes: 'profile', date: '2026-09-26', history: [{ version: '189', notes: 'bots', date: '2026-09-24' }] } };
  const log = console.log; console.log = () => {};
  let m;
  try { m = await commands.game({ html: htmlPath, repo: 'sasha/pb', tag: 'v191', out: path.join(dir, 'out'), baseManifest: base, notes: 'stats' }); }
  finally { console.log = log; }
  assert.deepEqual(m.game.history, [{ version: '190', notes: 'profile', date: '2026-09-26' }, { version: '189', notes: 'bots', date: '2026-09-24' }]);
  const parsed = parseManifest(m, 'https://github.com/');
  assert.deepEqual(parsed.game.history.map(x => x.version), ['190', '189']);
});

test('CI: history is rebuilt from recent releases, including ones published before history existed', { skip: process.platform === 'win32' }, async () => {
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-gh3-'));
  const ghDir = path.join(dir, 'gh'); const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'gh'), `#!/bin/sh\nexec node ${JSON.stringify(path.join(__dirname, 'helpers', 'fake-gh.js'))} "$@"\n`, { mode: 0o755 });
  const mk = (tag, minute, files, body = '') => {
    fs.mkdirSync(path.join(ghDir, tag, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(ghDir, tag, 'release.json'), JSON.stringify({ tag_name: tag, body, draft: false, published_at: new Date(Date.UTC(2026, 8, 22, 10, minute)).toISOString() }));
    for (const [n, d] of Object.entries(files)) fs.writeFileSync(path.join(ghDir, tag, 'assets', n), d);
  };
  const g = v => ({ version: String(v), url: `https://github.com/a/b/releases/download/v${v}/g.gz`, sha256: 'a'.repeat(64), size: 1, notes: `## Що нового у v${v}\n- change ${v}`, date: `2026-09-${v - 170}` });
  const L = { version: '1.0.2', url: 'https://github.com/a/b/releases/download/launcher-v1.0.2/S.exe', sha256: 'b'.repeat(64), size: 2 };
  // Old-style latest.json files (no history), a launcher release carrying game 188, then v189/v190.
  [186, 187, 188].forEach((v, i) => mk(`v${v}`, i, { 'latest.json': JSON.stringify({ schema: 1, game: g(v), launcher: L }) }));
  mk('launcher-v1.0.2', 5, { 'latest.json': JSON.stringify({ schema: 1, game: g(188), launcher: L }) });
  [189, 190].forEach((v, i) => mk(`v${v}`, 10 + i, { 'latest.json': JSON.stringify({ schema: 1, game: g(v), launcher: L }) }));
  mk('v191', 20, { 'pokemon_battle_v191.zip': makeZip([{ name: 'pokemon_battle_v191.html', data: fakeGameHtml(191) }]) }, '## Що нового у v191\n- stats');
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, FAKE_GH_DIR: ghDir };
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'release.js'), 'ci-game', '--repo', 'a/b', '--tag', 'v191'], { env, stdio: 'pipe' });
  const m = JSON.parse(fs.readFileSync(path.join(ghDir, 'v191', 'assets', 'latest.json'), 'utf8'));
  assert.equal(m.game.version, '191');
  assert.deepEqual(m.game.history.map(x => x.version), ['190', '189', '188', '187', '186']);
  assert.match(m.game.history[0].notes, /change 190/);
  assert.equal(m.launcher.version, '1.0.2');
  // and the next one carries it on (v192 sees v191's history)
  mk('v192', 30, { 'pokemon_battle_v192.zip': makeZip([{ name: 'pokemon_battle_v192.html', data: fakeGameHtml(192) }]) }, 'next');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'release.js'), 'ci-game', '--repo', 'a/b', '--tag', 'v192'], { env, stdio: 'pipe' });
  const m2 = JSON.parse(fs.readFileSync(path.join(ghDir, 'v192', 'assets', 'latest.json'), 'utf8'));
  assert.deepEqual(m2.game.history.map(x => x.version), ['191', '190', '189', '188', '187', '186']);
  assert.match(m2.game.history[0].notes, /stats/);
});
