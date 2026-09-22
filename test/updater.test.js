'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { GameStore } = require('../src/main/gameStore');
const { UpdateService } = require('../src/main/updater');
const { FakeGithub, fakeGameHtml } = require('./helpers/fakeGithub');

const sha = b => crypto.createHash('sha256').update(b).digest('hex');

async function setup({ bundled = '184', appVersion = '1.0.0', autoDownload = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-upd-'));
  const bundledDir = path.join(dir, 'bundled');
  fs.mkdirSync(bundledDir);
  fs.writeFileSync(path.join(bundledDir, 'game.html'), fakeGameHtml(bundled));
  fs.writeFileSync(path.join(bundledDir, 'game.json'), JSON.stringify({ version: bundled }));
  const store = new GameStore({ rootDir: path.join(dir, 'games'), bundledDir });
  const gh = await new FakeGithub().start();
  let feed = gh.feedUrl;
  let auto = autoDownload;
  const states = [];
  const updater = new UpdateService({
    getFeedUrl: () => feed, appVersion, fetchImpl: fetch, store,
    downloadsDir: path.join(dir, 'downloads'), getAutoDownload: () => auto, platform: 'linux',
  });
  updater.on('state', s => states.push(s));
  return { dir, store, gh, updater, states, setFeed: f => { feed = f; }, setAuto: a => { auto = a; } };
}

/** Publishes game version v (gzipped, like the release script does) as the latest release. */
function publishGame(gh, v, { launcher, minLauncher, notes = `notes for ${v}`, corrupt = false } = {}) {
  const gz = zlib.gzipSync(fakeGameHtml(v));
  const file = `pokemon_battle_v${v}.html.gz`;
  const manifest = {
    schema: 1,
    game: { version: String(v), url: gh.assetUrl(`v${v}`, file), sha256: corrupt ? 'c'.repeat(64) : sha(gz), size: gz.length, notes, date: '2026-09-30', ...(minLauncher ? { minLauncher } : {}) },
    ...(launcher ? { launcher } : {}),
  };
  gh.publish(`v${v}`, { [file]: gz, 'latest.json': JSON.stringify(manifest) });
  return manifest;
}

test('no feed configured: nothing happens, state says so', async () => {
  const t = await setup();
  try {
    t.setFeed(null);
    const s = await t.updater.check();
    assert.equal(s.feedConfigured, false);
    assert.equal(t.gh.requests.length, 0);
  } finally { await t.gh.stop(); }
});

test('no releases yet (404) is not an error', async () => {
  const t = await setup();
  try {
    const s = await t.updater.check();
    assert.equal(s.error, null);
    assert.equal(s.feedEmpty, true);
  } finally { await t.gh.stop(); }
});

test('newer game release is downloaded, verified and installed automatically', async () => {
  const t = await setup();
  try {
    publishGame(t.gh, 185);
    const installed = new Promise(r => t.updater.once('game-installed', r));
    const s = await t.updater.check();
    const b = await installed;
    assert.equal(b.version, '185');
    assert.equal(s.game.status, 'ready');
    assert.equal(s.game.justInstalled, '185');
    assert.equal(t.store.resolveActive(null).version, '185');
    assert.match(fs.readFileSync(t.store.resolveActive(null).path, 'utf8'), /GAME v185/);
    assert.ok(t.states.some(x => x.game.status === 'downloading' && x.game.progress), 'reported download progress');
    // Second check: nothing new, no second download.
    const before = t.gh.requests.filter(r => r.endsWith('.gz')).length;
    const s2 = await t.updater.check();
    assert.equal(s2.game.status, 'ready');
    assert.equal(t.gh.requests.filter(r => r.endsWith('.gz')).length, before);
  } finally { await t.gh.stop(); }
});

test('same or older release than what is installed: up to date', async () => {
  const t = await setup({ bundled: '186' });
  try {
    publishGame(t.gh, 185);
    const s = await t.updater.check();
    assert.equal(s.game.status, 'up-to-date');
    assert.equal(t.store.list().length, 1);
  } finally { await t.gh.stop(); }
});

test('with auto-download off, an update waits for the player', async () => {
  const t = await setup({ autoDownload: false });
  try {
    publishGame(t.gh, 185);
    let s = await t.updater.check();
    assert.equal(s.game.status, 'available');
    assert.equal(s.game.latest.version, '185');
    assert.equal(s.game.latest.notes, 'notes for 185');
    await t.updater.downloadGame();
    s = t.updater.getState();
    assert.equal(s.game.status, 'ready');
  } finally { await t.gh.stop(); }
});

test('a tampered download is rejected and nothing gets installed', async () => {
  const t = await setup();
  try {
    publishGame(t.gh, 185, { corrupt: true });
    const s = await t.updater.check();
    assert.equal(s.game.status, 'error');
    assert.match(s.game.error, /Checksum/);
    assert.equal(t.store.resolveActive(null).version, '184');
  } finally { await t.gh.stop(); }
});

test('a game that needs a newer launcher is held back', async () => {
  const t = await setup({ appVersion: '1.0.0' });
  try {
    publishGame(t.gh, 185, { minLauncher: '1.1.0' });
    const s = await t.updater.check();
    assert.equal(s.game.status, 'blocked');
    assert.equal(t.store.resolveActive(null).version, '184');
  } finally { await t.gh.stop(); }
});

test('launcher update is detected; on non-Windows it is offered but not downloaded', async () => {
  const t = await setup({ appVersion: '1.0.0' });
  try {
    publishGame(t.gh, 184, { launcher: { version: '1.1.0', url: t.gh.assetUrl('launcher-v1.1.0', 'Setup.exe'), sha256: 'd'.repeat(64), size: 10 } });
    const s = await t.updater.check();
    assert.equal(s.launcher.status, 'available');
    assert.equal(s.launcher.latest.version, '1.1.0');
    assert.equal(s.launcher.canInstall, false);
    assert.equal(t.updater.runLauncherInstaller({ relaunch: true }), false);
  } finally { await t.gh.stop(); }
});

test('launcher installer download (Windows path) is verified and becomes ready', async () => {
  const t = await setup({ appVersion: '1.0.0' });
  try {
    const exe = crypto.randomBytes(200 * 1024);
    t.gh.publish('launcher-v1.1.0', { 'Pokemon-Battle-Setup-1.1.0.exe': exe }, { latest: false });
    publishGame(t.gh, 184, { launcher: { version: '1.1.0', url: t.gh.assetUrl('launcher-v1.1.0', 'Pokemon-Battle-Setup-1.1.0.exe'), sha256: sha(exe), size: exe.length } });
    t.updater.o.platform = 'win32';
    t.updater.state.launcher.canInstall = true;
    const s = await t.updater.check();
    assert.equal(s.launcher.status, 'ready');
    assert.ok(t.updater.launcherUpdateReady());
    assert.deepEqual(fs.readFileSync(t.updater.installerPath), exe);
  } finally { await t.gh.stop(); }
});

test('a hand-installed test build of the same version is replaced by the published one', async () => {
  const t = await setup();
  try {
    t.store.install(fakeGameHtml(185, '<!-- local test -->'), { version: '185', source: 'file', packageSha256: 'e'.repeat(64) });
    publishGame(t.gh, 185);
    const s = await t.updater.check();
    assert.equal(s.game.status, 'ready');
    const active = t.store.resolveActive(null);
    assert.equal(active.source, 'download');
    assert.doesNotMatch(fs.readFileSync(active.path, 'utf8'), /local test/);
  } finally { await t.gh.stop(); }
});

test('offline / broken feed: error is reported, game still playable', async () => {
  const t = await setup();
  try {
    t.setFeed('http://127.0.0.1:1/latest.json');
    let s = await t.updater.check();
    assert.ok(s.error);
    assert.equal(t.store.resolveActive(null).version, '184');
    t.gh.publish('v185', { 'latest.json': '{ not json' });
    t.setFeed(t.gh.feedUrl);
    s = await t.updater.check();
    assert.ok(s.error);
  } finally { await t.gh.stop(); }
});

test('concurrent checks share one request', async () => {
  const t = await setup({ autoDownload: false });
  try {
    publishGame(t.gh, 185);
    await Promise.all([t.updater.check(), t.updater.check(), t.updater.check()]);
    assert.equal(t.gh.requests.filter(r => r.endsWith('/releases/latest/download/latest.json')).length, 1);
  } finally { await t.gh.stop(); }
});
