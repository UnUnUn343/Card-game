#!/usr/bin/env node
'use strict';
/**
 * Builds the web app (GitHub Pages site, also what the Android app shows) from a game build:
 *   node scripts/build-web.js --game <file.html|.zip|.html.gz> [--out web-dist] [--apk app.apk --apk-version 1.0.0]
 *
 * web-dist/
 *   index.html               the game, with the phone add-on (web/mobile.js) and web-app tags injected
 *   sw.js                    offline cache + update check (web/sw.js)
 *   version.json             {"version": "187", "android": {...}}: what the service worker (game) and the
 *                            Android app (its own shell) compare against
 *   pokemon-battle.apk       the Android app, when --apk is given
 *   manifest.webmanifest     name, icons, fullscreen + landscape when installed
 *   icon-*.png, apple-touch-icon.png
 * The game file itself isn't modified on disk; the PC app keeps using the original.
 */
const fs = require('fs');
const path = require('path');
const { extractGameHtml } = require('../src/shared/gamePackage');
const { detectGameVersion, normalizeVersion } = require('../src/shared/versioning');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; }

function headTags(version) {
  return [
    `<meta name="pkmn-version" content="${version}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<title>Бій покемонів</title>',
    '<meta name="theme-color" content="#0a1120">',
    '<link rel="manifest" href="manifest.webmanifest">',
    '<link rel="icon" type="image/png" href="icon-192.png">',
    '<link rel="apple-touch-icon" href="apple-touch-icon.png">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
    '<meta name="apple-mobile-web-app-title" content="Покемони">',
  ].join('\n');
}

/** Game HTML → web page. Pure string surgery at two well-defined spots; everything else untouched. */
function injectWeb(html, version, mobileJs) {
  const afterComment = html.startsWith('<!DOCTYPE') || html.startsWith('<!doctype') ? Math.max(0, html.indexOf('-->')) : 0;
  const headRe = /<head(\s[^>]*)?>/ig;
  headRe.lastIndex = afterComment;
  const head = headRe.exec(html);
  if (!head) throw new Error('No <head> found in the game file');
  const at = head.index + head[0].length;
  let out = html.slice(0, at) + '\n' + headTags(version) + '\n' + html.slice(at);
  const body = out.lastIndexOf('</body>');
  if (body < 0) throw new Error('No </body> found in the game file');
  // "</script" inside the inlined code would end the tag early; the add-on has none, but be safe.
  const js = mobileJs.replace(/<\/script/gi, '<\\/script');
  out = out.slice(0, body) + `<script>\n${js}\n</script>\n` + out.slice(body);
  return out;
}

function manifest() {
  return {
    name: 'Бій покемонів',
    short_name: 'Покемони',
    description: 'Карткові бої з друзями',
    lang: 'uk',
    start_url: './',
    scope: './',
    display: 'fullscreen',
    display_override: ['fullscreen', 'standalone'],
    orientation: 'landscape',
    background_color: '#070d18',
    theme_color: '#0a1120',
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

/** PNG icons from build/icon.svg. Home-screen icons get the background edge to edge (no corners). */
function icons(outDir) {
  const { Resvg } = require('@resvg/resvg-js');
  const svg = fs.readFileSync(path.join(ROOT, 'build', 'icon.svg'), 'utf8');
  // Full-bleed variant: the rounded plate becomes the whole square; the emblem shrinks into the
  // safe zone (80% for Android's maskable crop, 90% for iOS which only rounds the corners).
  const fullBleed = scale => svg
    .replace(/<rect x="16" y="16" width="480" height="480" rx="112" fill="url\(#bg\)"\/>/, '<rect width="512" height="512" fill="url(#bg)"/>')
    .replace(/<rect x="16" y="16" width="480" height="480" rx="112" fill="none"[^>]*\/>/, '')
    .replace(/(<circle cx="256" cy="256" r="200")/, `<g transform="translate(256 256) scale(${scale}) translate(-256 -256)">$1`)
    .replace(/<\/svg>\s*$/, '</g></svg>');
  const png = (s, size) => new Resvg(s, { fitTo: { mode: 'width', value: size } }).render().asPng();
  fs.writeFileSync(path.join(outDir, 'icon-192.png'), png(svg, 192));
  fs.writeFileSync(path.join(outDir, 'icon-512.png'), png(svg, 512));
  fs.writeFileSync(path.join(outDir, 'icon-maskable-512.png'), png(fullBleed(0.8), 512));
  fs.writeFileSync(path.join(outDir, 'apple-touch-icon.png'), png(fullBleed(0.9), 180));
}

const APK_NAME = 'pokemon-battle.apk';

function build({ gameBuf, gameName, out, apk, apkVersion }) {
  const { html: htmlBuf, innerName } = extractGameHtml(gameBuf);
  const html = htmlBuf.toString('utf8');
  const version = detectGameVersion(html, innerName || gameName);
  if (!version) throw new Error('Cannot tell the game version from the file');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const page = injectWeb(html, version, fs.readFileSync(path.join(WEB, 'mobile.js'), 'utf8'));
  fs.writeFileSync(path.join(out, 'index.html'), page);
  // The site's build id: changes whenever anything served changes (page or service worker code).
  const swSrc = fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8');
  const build = require('crypto').createHash('sha256').update(page).update(swSrc).digest('hex').slice(0, 12);
  fs.writeFileSync(path.join(out, 'sw.js'), swSrc.replace("'__BUILD__'", `'${build}'`));
  const info = { version, build, built: new Date().toISOString() };
  if (apk) {
    if (!apkVersion) throw new Error('--apk needs --apk-version');
    fs.copyFileSync(apk, path.join(out, APK_NAME));
    info.android = { version: String(apkVersion), url: APK_NAME, size: fs.statSync(apk).size };
  }
  fs.writeFileSync(path.join(out, 'version.json'), JSON.stringify(info) + '\n');
  fs.writeFileSync(path.join(out, 'manifest.webmanifest'), JSON.stringify(manifest(), null, 2) + '\n');
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  icons(out);
  return { version, build, out };
}

if (require.main === module) {
  const game = arg('game');
  if (!game) { console.error('usage: node scripts/build-web.js --game <file> [--out web-dist]'); process.exit(2); }
  const apk = arg('apk');
  const r = build({ gameBuf: fs.readFileSync(game), gameName: path.basename(game), out: path.resolve(arg('out', path.join(ROOT, 'web-dist'))),
    apk: apk ? path.resolve(apk) : null, apkVersion: arg('apk-version') });
  console.log(`web app for game v${r.version}${apk ? ` + Android app ${arg('apk-version')}` : ''} → ${r.out}`);
}

module.exports = { build, injectWeb, manifest, normalizeVersion, APK_NAME };
