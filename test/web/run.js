#!/usr/bin/env node
'use strict';
/**
 * Web app on emulated phones (mobile Chromium, touch). Builds the site from a game file, serves it
 * like GitHub Pages does (Cache-Control: max-age=600), then checks:
 *   fit-to-screen in landscape, rotate prompt in portrait, long-press energy conversion, tap to
 *   preview a card, music pausing in the background, offline start, the "new version" update flow,
 *   and the Android app's "new app version" notice.
 *   GAME=path/to/game.html node test/web/run.js      (default: game/game.html)
 * Screenshots → test-results/web/. Analytics requests are blocked.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright-core');
const { build } = require('../../scripts/build-web');

const ROOT = path.join(__dirname, '..', '..');
const GAME = process.env.GAME || path.join(ROOT, 'game', 'game.html');
const OUT = path.join(ROOT, 'test-results', 'web');
const CHROME = fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
function serve(dir) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname).replace(/^\/Card-game\//, '/');
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(dir, p);
    if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'max-age=600' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

function bumpVersion(html, v) {
  return html.replace(/<!--\s*\n\s*v\d+(\.\d+)? —/, m => m.replace(/v\d+(\.\d+)?/, `v${v}`));
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-web-'));
  const gameHtml = fs.readFileSync(GAME, 'utf8');
  const { version: v1 } = build({ gameBuf: Buffer.from(gameHtml), gameName: path.basename(GAME), out: site });
  const srv = await serve(site);
  const base = `http://127.0.0.1:${srv.address().port}/Card-game/`;
  const browser = await chromium.launch({ executablePath: CHROME });
  const phone = (w, h) => browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
  const prep = async p => {
    await p.route('**/script.google.com/**', r => r.abort());
    p.on('pageerror', e => { console.log('    pageerror:', e.message); fails++; });
  };
  const ready = p => p.waitForFunction(() => document.getElementById('root')?.children.length > 0, null, { timeout: 90000 });
  const noCoach = p => p.evaluate(() => { try { localStorage.setItem('pkmn_coach_seen', JSON.stringify({ regulation: 1, mode: 1, teamselect: 1, battle: 1 })); localStorage.setItem('pkmn_install_hint', '1'); } catch {} });
  const startLocal = (p, vsBot = true) => p.evaluate(vsBot => {
    MP.mode = 'local'; MP.phase = 'ingame'; S.regGate = null; S.reg = currentRegulation(); S.mode = 'casual'; S.botEnabled = [false, vsBot];
    const k = Object.keys(allTeams()); startGame(k[0], k[1], 0);
  }, vsBot);
  const fits = p => p.evaluate(() => ({ vp: document.querySelector('meta[name=viewport]').content, iw: innerWidth, ih: innerHeight,
    sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight }));

  try {
    // ── Landscape phones: the board fits ───────────────────────────────────────────────────────
    for (const [name, w, h] of [['iphone-14', 844, 390], ['pixel-8', 915, 412], ['small-android', 740, 360], ['tablet', 1180, 820]]) {
      console.log(`landscape ${name} ${w}×${h}`);
      const ctx = await phone(w, h);
      const p = await ctx.newPage(); await prep(p);
      await p.goto(base); await ready(p); await noCoach(p);
      await startLocal(p); await sleep(1500);
      const f = await fits(p);
      ok(f.sw <= f.iw + 2 && f.sh <= f.ih + 40, `whole board visible: layout ${f.iw}×${f.ih}, content ${f.sw}×${f.sh} (${f.vp})`);
      await p.screenshot({ path: path.join(OUT, `landscape-${name}.png`) });
      await ctx.close();
    }

    // ── Online battle (both active cards stacked in one panel) fits too ────────────────────────
    console.log('online battle on a landscape phone');
    {
      const ctx = await phone(844, 390);
      const p = await ctx.newPage(); await prep(p);
      await p.goto(base); await ready(p); await noCoach(p);
      const cards = () => p.evaluate(() => [...document.querySelectorAll('.mc-wrap')].filter(e => e.getBoundingClientRect().height > 190).map(e => {
        const r = e.getBoundingClientRect(); let c = e.parentElement; while (c && getComputedStyle(c).overflow !== 'hidden') c = c.parentElement;
        const cr = c ? c.getBoundingClientRect() : { top: 0, bottom: innerHeight };
        return r.top >= cr.top - 1 && r.bottom <= cr.bottom + 1 && r.bottom <= innerHeight + 1;
      }));
      await p.evaluate(() => { MP.mode = 'host'; MP.myIdx = 0; MP.phase = 'ingame'; MP.conn = { open: true, send() {} }; S.regGate = null; S.reg = currentRegulation(); S.mode = 'casual'; S.botEnabled = [false, false]; const k = Object.keys(allTeams()); startGame(k[0], k[1], 0); render(); });
      await sleep(3000);
      const online = await cards(); const fOn = await fits(p);
      ok(online.length === 2 && online.every(Boolean), `both active cards fully visible (${JSON.stringify(online)}, layout ${fOn.iw}×${fOn.ih})`);
      ok(fOn.sh <= fOn.ih + 2 && fOn.sw <= fOn.iw + 2, 'and nothing to scroll');
      await p.screenshot({ path: path.join(OUT, 'landscape-online-battle.png') });
      // Back to a local battle: the extra height is dropped again (the local board uses 804).
      await p.evaluate(() => { MP.mode = 'local'; MP.conn = null; const k = Object.keys(allTeams()); startGame(k[0], k[1], 0); render(); });
      await sleep(2000);
      const fLoc = await fits(p);
      ok(fLoc.ih < 900, `local battle goes back to the normal fit (layout height ${fLoc.ih})`);
      await ctx.close();
    }

    // ── Portrait: menus fine, battle asks to rotate ────────────────────────────────────────────
    console.log('portrait 390×844');
    {
      const ctx = await phone(390, 844);
      const p = await ctx.newPage(); await prep(p);
      await p.goto(base); await ready(p); await noCoach(p); await sleep(600);
      const rotOnMenu = await p.evaluate(() => !!document.getElementById('pkmn-web-ui')?.shadowRoot.querySelector('.rot'));
      ok(!rotOnMenu, 'main menu: no rotate prompt (menus work upright)');
      await p.screenshot({ path: path.join(OUT, 'portrait-menu.png') });
      await startLocal(p); await sleep(900);
      const rot = await p.evaluate(() => !!document.getElementById('pkmn-web-ui')?.shadowRoot.querySelector('.rot'));
      ok(rot, 'battle: asks to turn the phone sideways');
      await p.screenshot({ path: path.join(OUT, 'portrait-battle-rotate.png') });
      await ctx.close();
    }

    // ── Long-press converts energy (the game's right-click) ────────────────────────────────────
    console.log('long-press energy conversion');
    {
      const ctx = await phone(844, 390);
      const p = await ctx.newPage(); await prep(p);
      await p.goto(base); await ready(p); await noCoach(p);
      await startLocal(p, true); await sleep(1200);
      // Give P1 some ready fire energy the way the game stores it, then find that cell on screen.
      await p.evaluate(() => { S.pl[0].energy.fire = 2; render(); });
      await sleep(200);
      const cell = await p.evaluate(() => {
        const el = [...document.querySelectorAll('[oncontextmenu*="onEnRClick"]')].find(e => /'fire',0\)/.test(e.getAttribute('oncontextmenu')));
        if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      ok(!!cell, 'found the player\'s fire energy cell');
      if (cell) {
        const cdp = await ctx.newCDPSession(p);
        const logBefore = await p.evaluate(() => S.log.length);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cell.x, y: cell.y }] });
        await sleep(650);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await sleep(300);
        const r = await p.evaluate(n => ({ from: S.convFrom, pIdx: S.convPIdx, picked: S.log.slice(0, S.log.length - n).filter(e => /Обрано/.test(e.t || e)).length, fire: S.pl[0].energy.fire }), logBefore);
        ok(r.from === 'fire' && r.pIdx === 0, `long-press picked fire as the conversion source (convFrom=${r.from})`);
        ok(r.picked === 1, `handled once, not twice (${r.picked} log line)`);
        ok(r.fire === 2, 'the long-press did not also count as a tap (no energy collected/spent)');
        await p.screenshot({ path: path.join(OUT, 'long-press-convert.png') });
        // A normal tap right after still works: it picks the destination and converts.
        const water = await p.evaluate(() => {
          const el = [...document.querySelectorAll('[onclick*="onEnClick"]')].find(e => /'water',0\)/.test(e.getAttribute('onclick')));
          if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        ok(!!water, 'found the water energy cell (conversion target)');
        if (water) {
          const before = await p.evaluate(() => ({ ...S.pl[0].energy }));
          await p.touchscreen.tap(water.x, water.y);
          await sleep(400);
          const after = await p.evaluate(() => ({ e: { ...S.pl[0].energy }, from: S.convFrom }));
          ok(after.from === null && after.e.fire < before.fire, `a quick tap then converts fire → water (fire ${before.fire}→${after.e.fire}, water ${before.water || 0}→${after.e.water || 0})`);
        }
      }

      // Tap a card → big preview; tap anywhere else → it closes.
      const card = await p.evaluate(() => { const r = document.querySelector('.mc-wrap').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await p.touchscreen.tap(card.x, card.y);
      await sleep(400);
      const shown = await p.evaluate(() => { const t = document.getElementById('_artTip'); return t ? t.style.opacity : null; });
      ok(shown === '1', `tapping a card opens its big preview (opacity ${shown})`);
      await p.screenshot({ path: path.join(OUT, 'tap-preview.png') });
      const logBox = await p.evaluate(() => { const r = document.querySelector('.scrolllog').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await p.touchscreen.tap(logBox.x, logBox.y);
      await sleep(300);
      const hidden = await p.evaluate(() => document.getElementById('_artTip').style.opacity);
      ok(hidden === '0', `tapping elsewhere closes it (opacity ${hidden})`);

      // Banner text is scaled back up to a readable size on the scaled-down page.
      const k = await p.evaluate(() => +getComputedStyle(document.getElementById('pkmn-web-ui')).getPropertyValue('--k'));
      ok(k > 1.8 && k < 2.4, `phone banners are scaled up to stay readable (×${k})`);

      // Music pauses in the background and stays paused even when the game re-renders.
      const music = await p.evaluate(async () => {
        const a = { paused: false, volume: 1, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } };
        _loopAudio.__test = a;
        const setHidden = h => { Object.defineProperty(document, 'hidden', { value: h, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); };
        // The real play() on an empty <audio> never settles (it waits for a source); the no-op resolves at once.
        const tryPlay = () => Promise.race([document.createElement('audio').play().then(() => 'no-op', () => 'real'), new Promise(r => setTimeout(() => r('real'), 400))]);
        setHidden(true);
        const pausedHidden = a.paused, whileHidden = await tryPlay();
        setHidden(false);
        const resumed = !a.paused, afterwards = await tryPlay();
        delete _loopAudio.__test; delete document.hidden;
        return { pausedHidden, whileHidden, resumed, afterwards };
      });
      ok(music.pausedHidden && music.whileHidden === 'no-op' && music.resumed && music.afterwards === 'real',
        `music pauses in the background, can't be restarted there, and resumes after (${JSON.stringify(music)})`);
      await ctx.close();
    }

    // ── Offline + updates ──────────────────────────────────────────────────────────────────────
    console.log('offline start and update');
    {
      const ctx = await phone(844, 390);
      const p = await ctx.newPage(); await prep(p);
      await p.goto(base); await ready(p); await noCoach(p);
      await p.evaluate(() => navigator.serviceWorker.ready);
      await p.waitForFunction(async () => !!(await caches.match(location.href.replace(/[?#].*$/, ''))), null, { timeout: 60000, polling: 500 });
      await ctx.setOffline(true);
      await p.reload(); await ready(p);
      ok((await p.evaluate(() => document.querySelector('meta[name=pkmn-version]').content)) === v1, `opens offline from the cache (v${v1})`);
      await ctx.setOffline(false);
      // Publish a newer version on the "site" (CDN cache headers still say 10 minutes).
      const v2 = String(Number(v1) + 1);
      const next = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-web2-'));
      build({ gameBuf: Buffer.from(bumpVersion(gameHtml, v2)), gameName: 'g.html', out: next });
      for (const f of ['index.html', 'version.json']) fs.copyFileSync(path.join(next, f), path.join(site, f));
      await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // app comes back to the foreground
      await p.waitForFunction(v => (document.getElementById('pkmn-web-ui')?.shadowRoot.textContent || '').includes('v' + v), v2, { timeout: 90000, polling: 500 });
      ok(true, `"new version v${v2}" banner appears once it has fully downloaded`);
      await p.screenshot({ path: path.join(OUT, 'update-banner.png') });
      await p.evaluate(() => { const b = [...document.getElementById('pkmn-web-ui').shadowRoot.querySelectorAll('button')].find(x => /Оновити/.test(x.textContent)); b.click(); });
      await p.waitForLoadState('load'); await ready(p);
      ok((await p.evaluate(() => document.querySelector('meta[name=pkmn-version]').content)) === v2, `after "Оновити" the app runs v${v2}`);
      await ctx.close();
    }

    // ── Android app shell: offers its own update when version.json lists a newer APK ────────────
    console.log('android app: new app version');
    {
      const cur = JSON.parse(fs.readFileSync(path.join(site, 'version.json'), 'utf8'));
      fs.writeFileSync(path.join(site, 'pokemon-battle.apk'), 'not really an apk');
      fs.writeFileSync(path.join(site, 'version.json'), JSON.stringify({ ...cur, android: { version: '1.0.1', url: 'pokemon-battle.apk' } }));
      const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, acceptDownloads: true,
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36 PkmnAndroid/1.0.0' });
      const p = await ctx.newPage(); await prep(p);
      await p.goto(base); await ready(p);
      await p.waitForFunction(() => (document.getElementById('pkmn-web-ui')?.shadowRoot.textContent || '').includes('1.0.1'), null, { timeout: 30000, polling: 500 });
      ok(true, 'app 1.0.0 is told that app 1.0.1 is out');
      await p.screenshot({ path: path.join(OUT, 'android-app-update.png') });
      const apkReq = p.waitForRequest(r => r.url().endsWith('/pokemon-battle.apk'), { timeout: 10000 }).then(() => true, () => false);
      await p.evaluate(() => [...document.getElementById('pkmn-web-ui').shadowRoot.querySelectorAll('button')].find(x => /Завантажити/.test(x.textContent)).click());
      ok(await apkReq, '"Завантажити" opens the APK link');
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
  console.log(fails ? `\n${fails} WEB CHECK(S) FAILED` : '\nALL WEB CHECKS PASSED');
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
