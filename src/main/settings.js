'use strict';
/** Launcher settings, stored as settings.json in the app's data folder. */
const fs = require('fs');
const path = require('path');

// Bump when a default changes in a way existing installs should pick up once (see migrate()).
const SETTINGS_VERSION = 2;

const DEFAULTS = Object.freeze({
  lang: null,               // 'uk' | 'en'; null = pick from the system language on first run
  autoDownload: true,       // fetch new game builds as soon as they're published
  openGameDirectly: false,  // skip the launcher screen and go straight into the game
  startFullscreen: true,    // v2: games open fullscreen (F11 / Esc to leave)
  pinnedBuild: null,        // build id the player chose in Settings; null = always newest
  updateSource: null,       // overrides app.config.json: { github } or { feedUrl }
  zoom: 0,                  // Chromium zoom level for the game window (Ctrl +/-)
  gameWindow: null,         // { x, y, width, height, maximized }
  lastSeenVersion: null,    // to show "updated to vX" once after an update
  settingsVersion: SETTINGS_VERSION,
});

class Settings {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    this._timer = null;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const k of Object.keys(DEFAULTS)) if (k in saved) this.data[k] = saved[k];
      this.migrate(saved.settingsVersion || 1);
    } catch { /* first run or unreadable: defaults */ }
  }

  /** One-time changes for settings saved by older launchers. Each step runs once, then the version is recorded. */
  migrate(from) {
    if (from >= SETTINGS_VERSION) return;
    // v1 → v2: fullscreen became the default. 1.0.0/1.0.1 saved startFullscreen:false for everyone
    // without anyone choosing it, so switch it on once; after this, the player's own choice sticks.
    if (from < 2) this.data.startFullscreen = true;
    this.data.settingsVersion = SETTINGS_VERSION;
    this._scheduleSave();
  }

  get(key) { return this.data[key]; }

  all() { return { ...this.data }; }

  set(key, value) {
    if (!(key in DEFAULTS)) throw new Error(`Unknown setting: ${key}`);
    this.data[key] = value;
    this._scheduleSave();
  }

  _scheduleSave() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('settings: save failed', e);
    }
  }
}

module.exports = { Settings, DEFAULTS, SETTINGS_VERSION };
