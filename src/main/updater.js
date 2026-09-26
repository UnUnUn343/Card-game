'use strict';
/**
 * UpdateService: checks the release feed, downloads new game builds and new launcher installers.
 *
 * It knows nothing about windows or Electron UI. main.js wires it up and forwards its 'state'
 * events to the launcher and the game window. Everything it touches the outside world with
 * (fetch, the build store, where to download to) is passed in, which is what makes it testable
 * with a plain local HTTP server (see test/updater.test.js).
 */
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { parseManifest } = require('../shared/manifest');
const { extractGameHtml } = require('../shared/gamePackage');
const { isNewer, compareVersions } = require('../shared/versioning');
const { download } = require('./downloader');

const CHECK_TIMEOUT_MS = 15000;

function fileNameFromUrl(url, fallback) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return name.replace(/[^\w.\-]/g, '_') || fallback;
  } catch { return fallback; }
}

function publicEntry(e) {
  return e ? { version: e.version, notes: e.notes, date: e.date, size: e.size, url: e.url, minLauncher: e.minLauncher || null, history: e.history || [] } : null;
}

class UpdateService extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => string|null} o.getFeedUrl      where latest.json lives (null = updates not set up)
   * @param {string} o.appVersion                 this launcher's version
   * @param {Function} o.fetchImpl                fetch-compatible function
   * @param {import('./gameStore').GameStore} o.store
   * @param {string} o.downloadsDir
   * @param {() => boolean} o.getAutoDownload
   * @param {string} [o.platform]                 process.platform; installers only run on win32
   * @param {(msg: string) => void} [o.log]
   */
  constructor(o) {
    super();
    this.o = { platform: process.platform, log: () => {}, ...o };
    this.manifest = null;
    this._checkPromise = null;
    this._abort = null;
    this._launcherInstallStarted = false;
    this.state = {
      feedConfigured: !!o.getFeedUrl(),
      checking: false,
      lastCheck: null,
      error: null,
      feedEmpty: false,
      game: { status: 'idle', latest: null, progress: null, error: null },
      launcher: { status: 'idle', latest: null, progress: null, error: null, canInstall: this.o.platform === 'win32' },
    };
  }

  getState() { return JSON.parse(JSON.stringify(this.state)); }

  _set(patch) {
    for (const [k, v] of Object.entries(patch)) {
      this.state[k] = v && typeof v === 'object' && !Array.isArray(v) && this.state[k] && typeof this.state[k] === 'object'
        ? { ...this.state[k], ...v }
        : v;
    }
    this.emit('state', this.getState());
  }

  /** Checks the feed. Concurrent calls share one check. Never throws; errors land in state.error. */
  check({ userInitiated = false } = {}) {
    if (this._checkPromise) return this._checkPromise;
    this._checkPromise = this._check(userInitiated).finally(() => { this._checkPromise = null; });
    return this._checkPromise;
  }

  async _check(userInitiated) {
    const url = this.o.getFeedUrl();
    this._set({ feedConfigured: !!url });
    if (!url) return this.getState();
    this._set({ checking: true, error: null });
    try {
      const res = await this.o.fetchImpl(url, { cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      if (res.status === 404) {
        // No release published yet, or the newest release is still being prepared by CI.
        this.manifest = null;
        this._set({ checking: false, lastCheck: new Date().toISOString(), feedEmpty: true, game: { status: 'up-to-date', latest: null } });
        return this.getState();
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = parseManifest(await res.json(), url);
      this.manifest = manifest;
      this._set({ checking: false, lastCheck: new Date().toISOString(), feedEmpty: false });
      this.o.log(`feed: game=${manifest.game && manifest.game.version} launcher=${manifest.launcher && manifest.launcher.version}`);
      await Promise.all([this._evaluateLauncher(userInitiated), this._evaluateGame(userInitiated)]);
    } catch (err) {
      const msg = err && err.name === 'TimeoutError' ? 'timeout' : (err && err.message) || String(err);
      this.o.log(`check failed: ${msg}`);
      this._set({ checking: false, lastCheck: new Date().toISOString(), error: msg });
    }
    return this.getState();
  }

  /** Is the game entry in the feed something we should fetch? */
  gameUpdateNeeded() {
    const m = this.manifest && this.manifest.game;
    if (!m) return false;
    const newest = this.o.store.newestVersion();
    if (!newest || isNewer(m.version, newest)) return true;
    if (compareVersions(m.version, newest) === 0) {
      // Same number, but what we have is a hand-installed test build: replace it with the real release.
      const same = this.o.store.findByVersion(m.version);
      const hasOfficial = same.some(e => e.source === 'download' || e.source === 'bundled');
      const matchesPublished = same.some(e => m.sha256 && e.packageSha256 === m.sha256);
      return !hasOfficial && !matchesPublished;
    }
    return false;
  }

  async _evaluateGame(userInitiated) {
    const m = this.manifest && this.manifest.game;
    if (!m || !this.gameUpdateNeeded()) {
      if (!['downloading'].includes(this.state.game.status)) {
        this._set({ game: { status: this.state.game.status === 'ready' ? 'ready' : 'up-to-date', latest: publicEntry(m), error: null } });
      }
      return;
    }
    if (m.minLauncher && isNewer(m.minLauncher, this.o.appVersion)) {
      this._set({ game: { status: 'blocked', latest: publicEntry(m), error: null } });
      return;
    }
    if (this.state.game.status === 'downloading') return;
    this._set({ game: { status: 'available', latest: publicEntry(m), error: null } });
    if (this.o.getAutoDownload() || userInitiated) await this.downloadGame();
  }

  async _evaluateLauncher(userInitiated) {
    const m = this.manifest && this.manifest.launcher;
    if (!m || !isNewer(m.version, this.o.appVersion)) {
      this._set({ launcher: { status: 'up-to-date', latest: publicEntry(m), error: null } });
      return;
    }
    if (['downloading', 'ready'].includes(this.state.launcher.status) && this.state.launcher.latest && this.state.launcher.latest.version === m.version) return;
    this._set({ launcher: { status: 'available', latest: publicEntry(m), error: null } });
    if (this.state.launcher.canInstall && (this.o.getAutoDownload() || userInitiated)) await this.downloadLauncher();
  }

  /** Downloads + installs the game build named in the feed. */
  async downloadGame() {
    const m = this.manifest && this.manifest.game;
    if (!m || this.state.game.status === 'downloading') return;
    const abort = new AbortController();
    this._abort = abort;
    this._set({ game: { status: 'downloading', progress: { received: 0, total: m.size || 0 }, error: null } });
    const dest = path.join(this.o.downloadsDir, fileNameFromUrl(m.url, `game-${m.version}.bin`));
    try {
      const got = await download(m.url, dest, {
        fetchImpl: this.o.fetchImpl,
        signal: abort.signal,
        expectedSha256: m.sha256,
        expectedSize: m.size,
        onProgress: p => this._set({ game: { progress: p } }),
      });
      const buf = await fs.promises.readFile(got.path);
      const { html } = extractGameHtml(buf);
      const installed = this.o.store.install(html, {
        version: m.version, source: 'download', notes: m.notes, date: m.date,
        originalName: path.basename(dest), packageSha256: got.sha256,
      });
      await fs.promises.rm(got.path, { force: true });
      this.o.log(`installed game ${installed.version}`);
      this._set({ game: { status: 'ready', progress: null, justInstalled: installed.version } });
      this.emit('game-installed', installed);
    } catch (err) {
      const cancelled = abort.signal.aborted;
      this.o.log(`game download ${cancelled ? 'cancelled' : 'failed'}: ${err.message}`);
      this._set({ game: { status: cancelled ? 'available' : 'error', progress: null, error: cancelled ? null : err.message } });
    } finally {
      if (this._abort === abort) this._abort = null;
    }
  }

  cancelDownload() { if (this._abort) this._abort.abort(); }

  async downloadLauncher() {
    const m = this.manifest && this.manifest.launcher;
    if (!m || this.state.launcher.status === 'downloading') return;
    this._set({ launcher: { status: 'downloading', progress: { received: 0, total: m.size || 0 }, error: null } });
    const dest = path.join(this.o.downloadsDir, fileNameFromUrl(m.url, `launcher-setup-${m.version}.exe`));
    try {
      await download(m.url, dest, {
        fetchImpl: this.o.fetchImpl,
        expectedSha256: m.sha256,
        expectedSize: m.size,
        onProgress: p => this._set({ launcher: { progress: p } }),
      });
      this.installerPath = dest;
      this.o.log(`launcher ${m.version} installer downloaded`);
      this._set({ launcher: { status: 'ready', progress: null } });
      this.emit('launcher-ready', { version: m.version });
    } catch (err) {
      this.o.log(`launcher download failed: ${err.message}`);
      this._set({ launcher: { status: 'error', progress: null, error: err.message } });
    }
  }

  launcherUpdateReady() { return this.state.launcher.status === 'ready' && !!this.installerPath && !this._launcherInstallStarted; }

  /**
   * Runs the downloaded installer. The installer is electron-builder's one-click NSIS: `/S` is
   * silent, `--updated` makes it wait for this app to exit, `--force-run` starts the new version
   * when it's done. The caller must quit the app right after this returns true.
   */
  runLauncherInstaller({ relaunch }) {
    if (!this.launcherUpdateReady() || this.o.platform !== 'win32') return false;
    const args = ['/S', '--updated'];
    if (relaunch) args.push('--force-run');
    this.o.log(`running installer ${this.installerPath} ${args.join(' ')}`);
    const child = spawn(this.installerPath, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', e => this.o.log(`installer failed to start: ${e.message}`));
    child.unref();
    this._launcherInstallStarted = true;
    return true;
  }

  /** Removes leftovers in the downloads folder that aren't the pending launcher installer. */
  cleanDownloads() {
    try {
      for (const f of fs.readdirSync(this.o.downloadsDir)) {
        const p = path.join(this.o.downloadsDir, f);
        if (p !== this.installerPath) fs.rmSync(p, { force: true, recursive: true });
      }
    } catch {}
  }
}

module.exports = { UpdateService };
