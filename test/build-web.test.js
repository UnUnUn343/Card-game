'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build, injectWeb, manifest, APK_NAME } = require('../scripts/build-web');

// Shaped like the real game: doctype, a changelog comment that mentions tags, then the page.
const GAME = `<!DOCTYPE html>
<!--
  v190 — test build. The changelog talks about <head> and </body> and <script> tags.
-->
<html lang="uk">
<head>
<meta charset="UTF-8">
<title>Game</title>
</head>
<body><div id="root"></div>
<script>var s = "</body>";</script>
</body>
</html>
`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-web-'));

test('injects the web-app tags inside the real <head>, not inside the changelog comment', () => {
  const out = injectWeb(GAME, '190', 'console.log(1)');
  const comment = out.slice(0, out.indexOf('-->'));
  assert.ok(!comment.includes('pkmn-version'));
  const head = out.slice(out.indexOf('<head>'), out.indexOf('</head>'));
  assert.match(head, /<meta name="pkmn-version" content="190">/);
  assert.match(head, /<meta name="viewport"/);
  assert.match(head, /<link rel="manifest" href="manifest.webmanifest">/);
});

test('the phone add-on goes before the LAST </body>, and can\'t close its own <script> early', () => {
  const out = injectWeb(GAME, '190', 'var x = "</script>"; ok()');
  const at = out.lastIndexOf('<script>\nvar x');
  assert.ok(at > out.indexOf('var s = "</body>"'));
  assert.ok(at < out.lastIndexOf('</body>'));
  assert.ok(out.includes('var x = "<\\/script>"'));
});

test('build writes the site; version.json carries the game version', () => {
  const dir = tmp();
  const r = build({ gameBuf: Buffer.from(GAME), gameName: 'g.html', out: dir });
  assert.equal(r.version, '190');
  for (const f of ['index.html', 'sw.js', 'version.json', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
    assert.ok(fs.existsSync(path.join(dir, f)), f);
  }
  const v = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8'));
  assert.equal(v.version, '190');
  assert.equal(v.android, undefined);
  assert.equal(manifest().orientation, 'landscape');
});

test('with --apk the site offers the Android app and says which version it is', () => {
  const dir = tmp();
  const apk = path.join(tmp(), 'app-release.apk');
  fs.writeFileSync(apk, 'PK fake apk');
  build({ gameBuf: Buffer.from(GAME), gameName: 'g.html', out: dir, apk, apkVersion: '1.2.0' });
  const v = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8'));
  assert.deepEqual(v.android, { version: '1.2.0', url: APK_NAME, size: 11 });
  assert.equal(fs.readFileSync(path.join(dir, APK_NAME), 'utf8'), 'PK fake apk');
  assert.throws(() => build({ gameBuf: Buffer.from(GAME), gameName: 'g.html', out: tmp(), apk }), /apk-version/);
});

test('the Android app version in android/app/build.gradle is what CI reads', () => {
  const gradle = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'build.gradle'), 'utf8');
  // Same pattern as the sed in .github/workflows/web-app.yml.
  assert.match(gradle, /^def appVersion = '\d+\.\d+\.\d+'$/m);
});
