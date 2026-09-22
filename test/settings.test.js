'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings, SETTINGS_VERSION } = require('../src/main/settings');

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-set-')), 'settings.json');

test('new installs start the game fullscreen', () => {
  const s = new Settings(file());
  assert.equal(s.get('startFullscreen'), true);
  assert.equal(s.get('settingsVersion'), SETTINGS_VERSION);
});

test('settings saved by launcher 1.0.0/1.0.1 get fullscreen switched on once, other choices kept', () => {
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ lang: 'en', autoDownload: false, startFullscreen: false, zoom: 1 }));
  const s = new Settings(f);
  assert.equal(s.get('startFullscreen'), true);
  assert.equal(s.get('lang'), 'en');
  assert.equal(s.get('autoDownload'), false);
  assert.equal(s.get('zoom'), 1);
  s.flush();
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).settingsVersion, SETTINGS_VERSION);
});

test('after the migration, a player who turns fullscreen off keeps it off', () => {
  const f = file();
  const s = new Settings(f);
  s.set('startFullscreen', false);
  s.flush();
  assert.equal(new Settings(f).get('startFullscreen'), false);
});
