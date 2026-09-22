'use strict';
/**
 * Electron entry point.
 *
 *   launcher window  ──Play──►  game window (app://game/ = the active game build)
 *        ▲                            ▲
 *        └──── UpdateService ─────────┘   (checks GitHub, downloads builds, shows banners)
 *
 * Command-line flags (handy while developing; see README):
 *   --game=<file>      play this .html/.html.gz/.zip directly, skipping the launcher
 *   --feed=<url>       read latest.json from here instead of GitHub
 *   --data-dir=<dir>   keep settings/builds/logs here instead of the normal app data folder
 */
const { app, BrowserWindow, ipcMain, protocol, net, shell, dialog, Menu, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const { Settings } = require('./settings');
const { GameStore } = require('./gameStore');
const { UpdateService } = require('./updater');
const { createLogger } = require('./logger');
const { feedUrlFrom, parseUpdateSource } = require('../shared/manifest');
const { extractGameHtml } = require('../shared/gamePackage');
const { detectGameVersion, compareVersions } = require('../shared/versioning');
const { sha256File } = require('./downloader');

const APP_ROOT = path.join(__dirname, '..', '..');
const APP_ID = 'ua.sasha.pokemonbattle';
const CHECK_EVERY_MS = 30 * 60 * 1000;

// ── Command line ──────────────────────────────────────────────────────────────────────────────
function flag(name) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const FLAGS = { game: flag('game'), feed: flag('feed'), dataDir: flag('data-dir') };
if (FLAGS.dataDir) app.setPath('userData', path.resolve(FLAGS.dataDir));

// ── Config and paths ──────────────────────────────────────────────────────────────────────────
let CONFIG = {};
try { CONFIG = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'app.config.json'), 'utf8')); } catch {}

const DATA = app.getPath('userData');
const PATHS = {
  settings: path.join(DATA, 'settings.json'),
  games: path.join(DATA, 'games'),
  downloads: path.join(DATA, 'downloads'),
  logs: path.join(DATA, 'logs'),
  bundledGame: app.isPackaged ? path.join(process.resourcesPath, 'game') : path.join(APP_ROOT, 'game'),
};

const log = createLogger(PATHS.logs);
const settings = new Settings(PATHS.settings);
const store = new GameStore({ rootDir: PATHS.games, bundledDir: PATHS.bundledGame });

function currentFeedUrl() {
  if (FLAGS.feed) return FLAGS.feed;
  const override = settings.get('updateSource');
  if (override && (override.github || override.feedUrl)) return feedUrlFrom(override);
  return feedUrlFrom(CONFIG);
}

const updater = new UpdateService({
  getFeedUrl: currentFeedUrl,
  appVersion: app.getVersion(),
  fetchImpl: (url, init) => net.fetch(url, init),
  store,
  downloadsDir: PATHS.downloads,
  getAutoDownload: () => settings.get('autoDownload') !== false,
  log: m => log('[updater]', m),
});

/** The build the game window is showing (or will show). Set in openGame(). */
let running = null;
let launcherWin = null;
let gameWin = null;
let quitting = false;

// ── Single instance ───────────────────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = gameWin || launcherWin;
    if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
  });
}

// The game plays music on its first screen; let it start without waiting for a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setAppUserModelId(APP_ID);

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}]);

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────
function lang() { return settings.get('lang') || 'uk'; }

function buildSummary(b) {
  return b && { id: b.id, version: b.version, label: b.label || null, source: b.source, notes: b.notes || '', date: b.date || null, installedAt: b.installedAt || null };
}

function launcherSnapshot() {
  const active = store.resolveActive(settings.get('pinnedBuild'));
  const src = settings.get('updateSource');
  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    lang: lang(),
    settings: settings.all(),
    builds: store.list().map(buildSummary),
    activeId: active ? active.id : null,
    update: updater.getState(),
    updateSource: FLAGS.feed || (src && (src.github || src.feedUrl)) || CONFIG.github || CONFIG.feedUrl || null,
    updateSourceIsDefault: !FLAGS.feed && !(src && (src.github || src.feedUrl)),
    dataDir: DATA,
  };
}

function broadcast(channel, payload) {
  for (const w of [launcherWin, gameWin]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

function isSafeExternal(url) {
  try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
}

function hardenWebContents(wc, { allowNavigateTo }) {
  wc.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (allowNavigateTo(url)) return;
    e.preventDefault();
    if (isSafeExternal(url)) shell.openExternal(url);
  });
}

// ── Game protocol: app://game/ always serves the build in `running` ──────────────────────────
function registerGameProtocol() {
  protocol.handle('app', async req => {
    const u = new URL(req.url);
    if (u.host === 'game' && (u.pathname === '/' || u.pathname === '/index.html') && running) {
      const stream = fs.createReadStream(running.path);
      return new Response(Readable.toWeb(stream), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  });
}

// ── Launcher window ───────────────────────────────────────────────────────────────────────────
function createLauncher() {
  launcherWin = new BrowserWindow({
    width: 1040, height: 640, minWidth: 900, minHeight: 580,
    show: false,
    backgroundColor: '#070d18',
    title: 'Pokemon Battle',
    icon: path.join(APP_ROOT, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0a1120', symbolColor: '#cbd5e1', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'launcher-preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
    },
  });
  hardenWebContents(launcherWin.webContents, { allowNavigateTo: () => false });
  launcherWin.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      launcherWin.webContents.toggleDevTools();
    }
  });
  launcherWin.once('ready-to-show', () => launcherWin.show());
  launcherWin.on('closed', () => {
    launcherWin = null;
    if (!gameWin && !quitting) app.quit();
  });
  launcherWin.loadFile(path.join(__dirname, '..', 'launcher', 'index.html'));
}

// ── Game window ───────────────────────────────────────────────────────────────────────────────
function gameTitle() {
  const v = running && (running.version ? `v${running.version}` : running.label || '');
  return `Бій покемонів${v ? ' · ' + v : ''}`;
}

function saveGameWindowState() {
  if (!gameWin || gameWin.isDestroyed()) return;
  const b = gameWin.getNormalBounds();
  settings.set('gameWindow', { ...b, maximized: gameWin.isMaximized() });
}

function openGame(build) {
  running = build;
  log(`play ${build.id} (${build.version || build.label}) from ${build.path}`);
  settings.set('lastSeenVersion', build.version || settings.get('lastSeenVersion'));
  if (gameWin && !gameWin.isDestroyed()) {
    gameWin.setTitle(gameTitle());
    gameWin.webContents.reloadIgnoringCache();
    return;
  }
  const saved = settings.get('gameWindow');
  gameWin = new BrowserWindow({
    width: saved?.width || 1440, height: saved?.height || 900,
    x: saved?.x, y: saved?.y,
    minWidth: 1024, minHeight: 640,
    show: false,
    fullscreen: !!settings.get('startFullscreen'),
    backgroundColor: '#070d18',
    title: gameTitle(),
    icon: path.join(APP_ROOT, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'game-preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false, // keeps online matches (PeerJS heartbeats, timers) alive while minimised
      spellcheck: false,
    },
  });
  gameWin.setMenuBarVisibility(false);
  const wc = gameWin.webContents;
  hardenWebContents(wc, { allowNavigateTo: url => url.startsWith('app://game/') });

  wc.on('page-title-updated', e => e.preventDefault());
  wc.on('did-finish-load', () => wc.setZoomLevel(settings.get('zoom') || 0));
  wc.on('zoom-changed', (_e, dir) => setZoom(wc, dir === 'in' ? 0.5 : -0.5));
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = input.key.toLowerCase();
    if (input.key === 'F11' || (input.alt && k === 'enter')) { e.preventDefault(); gameWin.setFullScreen(!gameWin.isFullScreen()); }
    else if (input.key === 'Escape' && gameWin.isFullScreen()) gameWin.setFullScreen(false); // the game itself has no keyboard controls
    else if (input.key === 'F12' || (input.control && input.shift && k === 'i')) { e.preventDefault(); wc.toggleDevTools(); }
    else if (input.control && (k === '=' || k === '+')) { e.preventDefault(); setZoom(wc, 0.5); }
    else if (input.control && k === '-') { e.preventDefault(); setZoom(wc, -0.5); }
    else if (input.control && k === '0') { e.preventDefault(); setZoom(wc, null); }
  });
  wc.on('render-process-gone', async (_e, details) => {
    log(`game renderer gone: ${details.reason}`);
    if (details.reason === 'clean-exit' || quitting) return;
    const t = TEXT[lang()];
    const r = await dialog.showMessageBox(gameWin, { type: 'error', message: t.crashed, buttons: [t.reload, t.close], defaultId: 0 });
    if (r.response === 0) wc.reload(); else gameWin.close();
  });
  wc.on('console-message', details => {
    if (details.level === 'error') log('[game console]', `${details.message} (${details.sourceId}:${details.lineNumber})`);
  });

  gameWin.on('enter-full-screen', () => wc.send('game:fullscreen', true));
  gameWin.on('leave-full-screen', () => wc.send('game:fullscreen', false));
  wc.on('did-finish-load', () => { if (gameWin.isFullScreen()) wc.send('game:fullscreen', true); });
  gameWin.once('ready-to-show', () => {
    // Maximised underneath, so leaving fullscreen (F11 / Esc) lands on a full-size window.
    if (saved?.maximized || !saved) gameWin.maximize();
    gameWin.show();
    if (launcherWin && !launcherWin.isDestroyed()) launcherWin.close();
  });
  gameWin.on('close', saveGameWindowState);
  gameWin.on('closed', () => { gameWin = null; running = null; if (!launcherWin) app.quit(); });
  gameWin.loadURL('app://game/index.html');
}

function setZoom(wc, delta) {
  const level = delta == null ? 0 : Math.max(-3, Math.min(3, wc.getZoomLevel() + delta));
  wc.setZoomLevel(level);
  settings.set('zoom', level);
}

// ── Installing a build by hand (drag & drop / file picker / --game=) ─────────────────────────
async function installFromFile(filePath) {
  const buf = await fs.promises.readFile(filePath);
  const { html, innerName } = extractGameHtml(buf);
  const version = detectGameVersion(html, innerName || path.basename(filePath));
  const packageSha256 = await sha256File(filePath);
  const installed = store.install(html, { version, source: 'file', originalName: path.basename(filePath), packageSha256 });
  settings.set('pinnedBuild', installed.id); // you dropped it in, so that's what you want to play
  store.prune([installed.id]);
  log(`installed from file ${filePath} as ${installed.id}`);
  broadcast('launcher:snapshot', launcherSnapshot());
  return buildSummary(installed);
}

/**
 * --game=<file>: play a file without installing it, pinning it or touching the build list.
 * Unpacked into a hidden folder (the store ignores dot-folders) so .zip/.gz work too.
 */
async function prepareCliBuild(filePath) {
  const { html, innerName } = extractGameHtml(await fs.promises.readFile(filePath));
  const dir = path.join(PATHS.games, '.cli');
  await fs.promises.mkdir(dir, { recursive: true });
  const out = path.join(dir, 'game.html');
  await fs.promises.writeFile(out, html);
  const version = detectGameVersion(html, innerName || path.basename(filePath));
  return { id: 'cli', version, label: path.basename(filePath), source: 'file', path: out };
}

// ── Text used by the main process (dialogs). The launcher has its own copy in launcher/i18n.js ─
const TEXT = {
  uk: {
    restartTitle: 'Перезапустити гру?',
    restartBody: 'Якщо зараз іде бій, його буде перервано. Гра відкриється вже в новій версії.',
    restart: 'Перезапустити', later: 'Пізніше',
    crashed: 'Гра несподівано закрилася.', reload: 'Відкрити знову', close: 'Закрити',
    pickTitle: 'Обери файл гри', pickFilter: 'Гра (.html, .zip, .gz)',
    installFailed: 'Не вдалося встановити цей файл',
  },
  en: {
    restartTitle: 'Restart the game?',
    restartBody: 'If a battle is in progress it will be interrupted. The game will reopen on the new version.',
    restart: 'Restart', later: 'Later',
    crashed: 'The game closed unexpectedly.', reload: 'Open again', close: 'Close',
    pickTitle: 'Choose a game file', pickFilter: 'Game (.html, .zip, .gz)',
    installFailed: 'Could not install this file',
  },
};

// ── IPC ───────────────────────────────────────────────────────────────────────────────────────
const SETTABLE = new Set(['lang', 'autoDownload', 'openGameDirectly', 'startFullscreen', 'pinnedBuild']);

function registerIpc() {
  ipcMain.handle('launcher:snapshot', () => launcherSnapshot());

  ipcMain.handle('launcher:play', (_e, { buildId } = {}) => {
    const build = buildId ? store.get(buildId) : store.resolveActive(settings.get('pinnedBuild'));
    if (!build) throw new Error('No game build is installed yet.');
    openGame(build);
    return true;
  });

  ipcMain.handle('launcher:check', () => updater.check({ userInitiated: true }));
  ipcMain.handle('launcher:downloadGame', () => updater.downloadGame());
  ipcMain.handle('launcher:cancelDownload', () => updater.cancelDownload());

  ipcMain.handle('launcher:installLauncherUpdate', () => {
    if (updater.runLauncherInstaller({ relaunch: true })) { quitting = true; setTimeout(() => app.quit(), 150); return true; }
    return false;
  });

  ipcMain.handle('launcher:setSetting', (_e, key, value) => {
    if (!SETTABLE.has(key)) throw new Error(`Setting ${key} cannot be changed from the launcher`);
    settings.set(key, value);
    if (key === 'lang' && gameWin) gameWin.webContents.send('game:lang', value);
    return launcherSnapshot();
  });

  ipcMain.handle('launcher:setUpdateSource', async (_e, input) => {
    const parsed = input ? parseUpdateSource(input) : null;
    settings.set('updateSource', parsed && (parsed.github || parsed.feedUrl) ? parsed : null);
    settings.flush();
    await updater.check({ userInitiated: true });
    return launcherSnapshot();
  });

  ipcMain.handle('launcher:installFile', async (_e, filePath) => {
    try { return { ok: true, build: await installFromFile(filePath) }; }
    catch (err) { log('install from file failed', err); return { ok: false, error: err.message }; }
  });

  ipcMain.handle('launcher:pickFile', async () => {
    const t = TEXT[lang()];
    const r = await dialog.showOpenDialog(launcherWin, {
      title: t.pickTitle, properties: ['openFile'],
      filters: [{ name: t.pickFilter, extensions: ['html', 'htm', 'zip', 'gz'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
    try { return { ok: true, build: await installFromFile(r.filePaths[0]) }; }
    catch (err) { log('install from file failed', err); return { ok: false, error: err.message }; }
  });

  ipcMain.handle('launcher:removeBuild', (_e, id) => {
    store.remove(id);
    if (settings.get('pinnedBuild') === id) settings.set('pinnedBuild', null);
    return launcherSnapshot();
  });

  ipcMain.handle('launcher:openDataFolder', () => shell.openPath(DATA));
  ipcMain.handle('launcher:openLink', (_e, url) => { if (isSafeExternal(url)) shell.openExternal(url); });

  // From the in-game banner.
  ipcMain.handle('game:info', () => ({ lang: lang(), running: buildSummary(running), update: updater.getState(), appVersion: app.getVersion() }));
  ipcMain.handle('game:restartToUpdate', async () => {
    const t = TEXT[lang()];
    const r = await dialog.showMessageBox(gameWin, { type: 'question', title: t.restartTitle, message: t.restartTitle, detail: t.restartBody, buttons: [t.restart, t.later], defaultId: 0, cancelId: 1 });
    if (r.response !== 0) return false;
    const next = store.resolveActive(settings.get('pinnedBuild'));
    if (next) openGame(next);
    return true;
  });
  ipcMain.handle('game:installLauncherUpdate', async () => {
    const t = TEXT[lang()];
    const r = await dialog.showMessageBox(gameWin, { type: 'question', title: t.restartTitle, message: t.restartTitle, detail: t.restartBody, buttons: [t.restart, t.later], defaultId: 0, cancelId: 1 });
    if (r.response !== 0) return false;
    if (updater.runLauncherInstaller({ relaunch: true })) { quitting = true; setTimeout(() => app.quit(), 150); }
    return true;
  });
}

// ── Updater → windows ─────────────────────────────────────────────────────────────────────────
updater.on('state', state => broadcast('update:state', state));
updater.on('game-installed', installed => {
  // A newer official build supersedes an older build the player had pinned (e.g. a rollback).
  const pinned = settings.get('pinnedBuild') && store.get(settings.get('pinnedBuild'));
  if (pinned && compareVersions(installed.version, pinned.version) > 0) settings.set('pinnedBuild', null);
  const active = store.resolveActive(settings.get('pinnedBuild'));
  store.prune([active && active.id, running && running.id, settings.get('pinnedBuild')]);
  broadcast('launcher:snapshot', launcherSnapshot());
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  log(`start v${app.getVersion()} electron ${process.versions.electron} data=${DATA} packaged=${app.isPackaged}`);
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock'].includes(permission));
  });
  registerGameProtocol();
  registerIpc();
  updater.cleanDownloads();
  store.prune([settings.get('pinnedBuild')]);

  if (FLAGS.game) {
    try {
      openGame(await prepareCliBuild(path.resolve(FLAGS.game)));
    } catch (err) {
      dialog.showErrorBox(TEXT[lang()].installFailed, `${FLAGS.game}\n\n${err.message}`);
      app.quit();
      return;
    }
  } else {
    const active = store.resolveActive(settings.get('pinnedBuild'));
    if (settings.get('openGameDirectly') && active) openGame(active);
    else createLauncher();
  }

  updater.check();
  setInterval(() => updater.check(), CHECK_EVERY_MS).unref();
});

app.on('before-quit', () => { quitting = true; saveGameWindowState(); settings.flush(); });

app.on('will-quit', () => {
  // A launcher update that was downloaded but not installed goes in quietly on the way out.
  if (updater.launcherUpdateReady()) updater.runLauncherInstaller({ relaunch: false });
});

app.on('window-all-closed', () => app.quit());

// Lets the end-to-end tests (test/e2e) reach the updater. Never set in normal use.
if (process.env.PKMN_E2E) global.__pkmn = { updater, store, settings, get running() { return running; } };

process.on('uncaughtException', err => log('uncaught', err));
process.on('unhandledRejection', err => log('unhandled rejection', err));
