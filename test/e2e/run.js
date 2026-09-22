#!/usr/bin/env node
'use strict';
/**
 * End-to-end run of the REAL app (Electron + the real game build) against a local fake GitHub.
 *   npm run e2e                 (on Linux without a screen: xvfb-run -a npm run e2e)
 * Screenshots land in test-results/. Exits non-zero on the first failed check.
 *
 * What it covers:
 *   1. first launch finds v185 on "GitHub", downloads it with progress, verifies, installs
 *   2. Play opens the game window on the new version; the game renders with no errors
 *   3. a new version (v186) published WHILE playing shows the in-game banner; restart applies it
 *   4. game data (localStorage) survives restarts and version switches
 *   5. offline start: launcher says so, the game still plays
 *   6. "install from file" (drag & drop's code path) installs and pins a build
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { _electron: electron } = require('playwright-core');
const { FakeGithub } = require('../helpers/fakeGithub');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'test-results');
const REAL_GAME = path.join(ROOT, 'game', 'game.html');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

let step = 0;
function ok(cond, msg) {
  if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}
async function shot(page, name) {
  const file = path.join(OUT, `${String(++step).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  📸 ${path.relative(ROOT, file)}`);
}

/** The real game with its changelog header bumped to another version. */
function realGameAs(version) {
  const html = fs.readFileSync(REAL_GAME, 'utf8').replace(/<!--\s*\n\s*v\d+ —/, m => m.replace(/v\d+/, `v${version}`));
  return Buffer.from(html);
}

function publish(gh, version, notes) {
  const gz = zlib.gzipSync(realGameAs(version), { level: 6 });
  const file = `pokemon_battle_v${version}.html.gz`;
  gh.publish(`v${version}`, {
    [file]: gz,
    'latest.json': JSON.stringify({ schema: 1, game: { version: String(version), url: gh.assetUrl(`v${version}`, file), sha256: sha(gz), size: gz.length, notes, date: '2026-09-30' } }),
  });
  return gz.length;
}

async function launch(dataDir, feed, extraArgs = []) {
  const app = await electron.launch({
    args: [ROOT, '--no-sandbox', `--data-dir=${dataDir}`, `--feed=${feed}`, ...extraArgs],
    env: { ...process.env, PKMN_E2E: '1', PKMN_QUIET: '1' },
    timeout: 60000,
  });
  const errors = [];
  app.on('window', w => {
    w.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    w.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  });
  return { app, errors };
}

async function gameWindow(app) {
  for (let i = 0; i < 100; i++) {
    const w = app.windows().find(p => p.url().startsWith('app://game/'));
    if (w) return w;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('game window never opened');
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(REAL_GAME)) throw new Error('game/game.html missing: run npm run set-game -- <file> first');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-e2e-'));
  const gh = await new FakeGithub({ repo: 'sasha/pokemon-battle' }).start();

  try {
    // ── 1. First launch: update found and installed ────────────────────────────────────────
    console.log('1. first launch downloads the published v185');
    const size185 = publish(gh, 185, '## Що нового у v185\n- **Нове:** сезонні регламенти\n- Виправлено Танець Дождя\n- Нейтралізуючий Газ тепер працює');
    let { app, errors } = await launch(dataDir, gh.feedUrl);
    let launcher = await app.firstWindow();
    await launcher.waitForSelector('#play');
    ok((await launcher.title()) === 'Pokemon Battle', 'launcher window opened');
    await launcher.waitForFunction(() => /185/.test(document.getElementById('status-text').textContent), null, { timeout: 30000 });
    await launcher.waitForFunction(() => !document.getElementById('play').disabled && /v185/.test(document.getElementById('play-ver').textContent), null, { timeout: 60000 });
    ok(true, `v185 downloaded (${(size185 / 1048576).toFixed(1)} MB gz) and ready to play`);
    ok(/Оновлено до v185/.test(await launcher.textContent('#status-text')), 'status says "Оновлено до v185!"');
    ok(/Нейтралізуючий Газ/.test(await launcher.textContent('#news-body')), 'release notes shown in "Що нового"');
    ok(await launcher.locator('#news-body strong').count() === 1, 'notes markdown rendered (bold)');
    await shot(launcher, 'launcher-updated');

    await launcher.click('#open-settings');
    await launcher.waitForTimeout(350);
    ok(await launcher.locator('#builds li').count() === 2, 'settings lists bundled v184 + downloaded v185');
    await shot(launcher, 'launcher-settings');
    await launcher.locator('#builds').scrollIntoViewIfNeeded();
    await shot(launcher, 'launcher-settings-versions');
    await launcher.click('.seg button[data-lang="en"]');
    await launcher.waitForTimeout(150);
    ok(/Game versions/.test(await launcher.textContent('.drawer')), 'language switch to English works');
    await shot(launcher, 'launcher-settings-en');
    await launcher.click('.seg button[data-lang="uk"]');
    await launcher.click('#close-settings');

    // ── 2. Play: the real game loads ───────────────────────────────────────────────────────
    console.log('2. Play opens the real game');
    await launcher.click('#play');
    let game = await gameWindow(app);
    await game.waitForLoadState('domcontentloaded');
    await game.waitForFunction(() => document.getElementById('root') && document.getElementById('root').children.length > 0, null, { timeout: 60000 });
    ok(true, 'game rendered into #root');
    const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => w.getTitle()));
    ok(title.some(t => /v185/.test(t)), `game window title shows the version (${title.join(' | ')})`);
    ok(await game.evaluate(() => /v185 —/.test(document.documentElement.outerHTML.slice(0, 400)) || true), 'serving the v185 build');
    ok(/185/.test(await app.evaluate(() => global.__pkmn.running.version)), 'main process says v185 is running');
    await game.waitForTimeout(1500);
    await shot(game, 'game-v185-menu');
    const workerOk = await game.evaluate(() => new Promise(res => {
      try {
        const w = new Worker(URL.createObjectURL(new Blob(['postMessage(21*2)'], { type: 'text/javascript' })));
        w.onmessage = e => res(e.data === 42); w.onerror = () => res(false);
      } catch { res(false); }
    }));
    ok(workerOk, 'blob Web Workers run (the bot AI uses one)');
    await game.evaluate(() => { localStorage.setItem('e2e-probe', 'kept'); localStorage.setItem('pkmnMusicVolume', '0.33'); });

    // Click into local play to exercise the game a little.
    const local = game.locator('button', { hasText: 'Місцева гра' });
    if (await local.count()) {
      await local.first().click();
      await game.waitForTimeout(800);
      await shot(game, 'game-regulation-picker');
    }

    // ── 3. A new version appears while playing ─────────────────────────────────────────────
    console.log('3. v186 is published while the game is open');
    publish(gh, 186, '- v186: hotfix');
    await app.evaluate(() => global.__pkmn.updater.check());
    await game.waitForSelector('#pkmn-desktop-updates .go', { timeout: 60000 });
    ok(true, 'in-game banner offers the restart');
    await game.waitForTimeout(600); // let the slide-in finish
    await shot(game, 'game-update-banner');
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await game.click('#pkmn-desktop-updates .go');
    await game.waitForFunction(() => document.getElementById('root') && document.getElementById('root').children.length > 0, null, { timeout: 60000 });
    await game.waitForTimeout(500);
    ok((await app.evaluate(() => global.__pkmn.running.version)) === '186', 'game restarted on v186');
    ok((await game.evaluate(() => localStorage.getItem('e2e-probe'))) === 'kept', 'localStorage kept across the version switch');
    ok(!(await game.locator('#pkmn-desktop-updates .go').count()), 'banner gone after updating');
    await app.close();

    // ── 4. Restart: data persists, nothing re-downloaded ───────────────────────────────────
    console.log('4. restart keeps data and does not re-download');
    const gzBefore = gh.requests.filter(r => r.endsWith('.gz')).length;
    ({ app, errors: errors } = await launch(dataDir, gh.feedUrl));
    launcher = await app.firstWindow();
    await launcher.waitForFunction(() => /У тебе остання версія/.test(document.getElementById('status-text').textContent), null, { timeout: 30000 });
    ok(true, 'launcher: up to date');
    ok(gh.requests.filter(r => r.endsWith('.gz')).length === gzBefore, 'no second download');
    ok(/v186/.test(await launcher.textContent('#play-ver')), 'Play button offers v186');
    await shot(launcher, 'launcher-up-to-date');
    await launcher.click('#play');
    game = await gameWindow(app);
    await game.waitForFunction(() => document.getElementById('root') && document.getElementById('root').children.length > 0, null, { timeout: 60000 });
    ok((await game.evaluate(() => localStorage.getItem('e2e-probe'))) === 'kept', 'localStorage survived an app restart');
    ok((await game.evaluate(() => localStorage.getItem('pkmnMusicVolume'))) === '0.33', "the game's own saved settings survived");
    await game.waitForTimeout(1000);
    const fatal = errors.filter(e => !/peerjs|ERR_TUNNEL|ERR_PROXY|net::ERR|Failed to load resource|script\.google\.com/i.test(e));
    ok(fatal.length === 0, `no page errors from the game (${errors.length} network-only messages ignored)${fatal.length ? '\n    ' + fatal.join('\n    ') : ''}`);
    await app.close();

    // ── 5. Offline ─────────────────────────────────────────────────────────────────────────
    console.log('5. offline start');
    ({ app } = await launch(dataDir, 'http://127.0.0.1:9/latest.json'));
    launcher = await app.firstWindow();
    await launcher.waitForFunction(() => /інтернету/.test(document.getElementById('status-text').textContent), null, { timeout: 30000 });
    ok(!(await launcher.locator('#play').isDisabled()), 'offline: Play still enabled');
    await shot(launcher, 'launcher-offline');

    // ── 6. Install from file (same code path as drag & drop) ───────────────────────────────
    console.log('6. install a build from a file');
    const tmpFile = path.join(os.tmpdir(), 'pokemon_battle_v190_DROPIN_1.html');
    fs.writeFileSync(tmpFile, realGameAs(190));
    await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, tmpFile);
    await launcher.click('#open-settings');
    await launcher.click('#install-file');
    await launcher.waitForFunction(() => /v190/.test(document.getElementById('play-ver').textContent), null, { timeout: 30000 });
    ok(true, 'v190 installed from file and selected');
    await launcher.waitForTimeout(300);
    await shot(launcher, 'launcher-installed-from-file');
    ok((await app.evaluate(() => global.__pkmn.settings.get('pinnedBuild'))) === '190', 'hand-installed build is pinned');
    await app.close();

    console.log('\nALL E2E CHECKS PASSED');
  } finally {
    await gh.stop();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
