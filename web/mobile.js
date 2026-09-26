/*
 * Web / phone add-on for the game. scripts/build-web.js injects this into the game's HTML for the
 * web app (GitHub Pages) and the Android app. The game file itself is never changed, so the same
 * build keeps working on PC exactly as before.
 *
 *   everywhere : offline cache + update check (service worker), "new version" banner
 *   touch      : landscape fit-to-screen, rotate prompt, long-press = right-click,
 *                no double-tap zoom / text callouts, install hint
 *
 * It reads the game's globals (S, MP, render) but never changes game state.
 */
(function () {
  'use strict';
  var VERSION = (document.querySelector('meta[name="pkmn-version"]') || {}).content || '';
  var touch = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || ('ontouchstart' in window);
  var standalone = (window.matchMedia && matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches) || navigator.standalone === true;
  var ua = navigator.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document);
  // The Android app (android/) adds "PkmnAndroid/<its version>" to the WebView's user agent.
  var appVersion = (ua.match(/PkmnAndroid\/([\d.]+)/) || [])[1] || '';

  // ── small UI helper: one shadow-DOM host so the game's CSS and render() can't touch it ──────────
  var host = document.createElement('div');
  host.id = 'pkmn-web-ui';
  var ui = host.attachShadow({ mode: 'open' });
  // Sizes are in em off --k: on a phone the page is laid out PC-sized and scaled down, so the
  // banner is scaled back up by the same factor to stay finger-sized (see fit()).
  ui.innerHTML = '<style>' +
    ':host{all:initial}' +
    '.toast{position:fixed;left:50%;bottom:1em;transform:translateX(-50%);z-index:2147483600;width:max-content;max-width:min(92vw,46em);box-sizing:border-box;' +
    'font:calc(14px * var(--k, 1))/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e2e8f0;background:rgba(12,21,34,.97);border:1px solid #6d28d9;' +
    'border-radius:1em;padding:.85em 1em;box-shadow:0 12px 40px rgba(0,0,0,.6);display:flex;gap:.85em;align-items:center}' +
    '.toast>div{flex:1 1 auto}.toast b{color:#c4b5fd}.toast button{font:600 .93em system-ui,sans-serif;border-radius:.75em;padding:.7em 1.1em;border:1px solid #334155;background:#111c2d;color:#cbd5e1;white-space:nowrap}' +
    '.toast button.go{background:linear-gradient(135deg,#7c3aed,#6d28d9);border-color:#8b5cf6;color:#fff}' +
    '.rot{position:fixed;inset:0;z-index:2147483500;background:#070d18;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;' +
    'font:16px/1.4 system-ui,sans-serif;color:#cbd5e1;text-align:center;padding:24px;box-sizing:border-box}' +
    '.rot .ph{width:64px;height:104px;border:4px solid #a78bfa;border-radius:14px;animation:turn 1.8s ease-in-out infinite}' +
    '.rot small{color:#64748b}.rot button{margin-top:6px;font:14px system-ui,sans-serif;background:none;border:1px solid #334155;color:#94a3b8;border-radius:10px;padding:8px 14px}' +
    '@keyframes turn{0%,20%{transform:rotate(0)}55%,100%{transform:rotate(-90deg)}}' +
    '</style><div id="rot"></div><div id="toast"></div>';
  function mount() { if (!host.isConnected) (document.body || document.documentElement).appendChild(host); }
  var $ = function (id) { return ui.getElementById(id); };
  function toast(html, buttons, key) {
    mount();
    var el = $('toast');
    el.innerHTML = '<div class="toast" data-key="' + (key || '') + '"><div>' + html + '</div></div>';
    var box = el.firstChild;
    (buttons || []).forEach(function (b) {
      var btn = document.createElement('button');
      btn.textContent = b.label; if (b.primary) btn.className = 'go';
      btn.onclick = function () { el.innerHTML = ''; b.run && b.run(); };
      box.appendChild(btn);
    });
  }

  // ── offline + updates (all devices) ──────────────────────────────────────────────────────────
  function inBattle() { try { return S.phase === 'battle'; } catch (e) { return false; } }
  function newer(a, b) {
    var x = String(a || '').replace(/^v/i, '').split('.'), y = String(b || '').replace(/^v/i, '').split('.');
    for (var i = 0; i < Math.max(x.length, y.length); i++) { var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0); if (d) return d > 0; }
    return false;
  }
  function offerUpdate(v) {
    var show = function () {
      toast('Вийшла нова версія гри <b>v' + v + '</b>, вона вже завантажена.', [
        { label: 'Пізніше' },
        { label: 'Оновити', primary: true, run: function () {
          if (inBattle() && !confirm('Поточний бій буде перервано. Оновити зараз?')) return;
          location.reload();
        } },
      ], 'update');
    };
    show();
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      var ask = function () { if (reg.active) reg.active.postMessage({ type: 'check', running: VERSION }); };
      navigator.serviceWorker.addEventListener('message', function (e) {
        var d = e.data || {};
        if (d.type === 'update-ready' && d.version && d.version !== VERSION) offerUpdate(d.version);
      });
      navigator.serviceWorker.ready.then(ask);
      setInterval(ask, 30 * 60 * 1000);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) ask(); });
    }).catch(function () { /* no offline mode; the game still runs */ });
  }

  // ── Android app: the game updates by itself (above); the app shell rarely changes, but when it
  //    does, version.json says so and we offer the new APK (the app opens it in the browser). ─────
  if (appVersion) {
    var apkChecked = 0;
    var checkApk = function () {
      if (Date.now() - apkChecked < 6 * 3600 * 1000) return;
      apkChecked = Date.now();
      fetch('version.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
        var a = j && j.android;
        if (!a || !a.url || !newer(a.version, appVersion)) return;
        try { var sn = JSON.parse(localStorage.getItem('pkmn_apk_snooze') || 'null'); if (sn && sn.v === a.version && Date.now() < sn.until) return; } catch (e) {}
        toast('Вийшла нова версія застосунку <b>' + a.version + '</b>. Встанови її поверх цієї: ігри й налаштування збережуться.', [
          { label: 'Пізніше', run: function () { try { localStorage.setItem('pkmn_apk_snooze', JSON.stringify({ v: a.version, until: Date.now() + 2 * 86400000 })); } catch (e) {} } },
          { label: 'Завантажити', primary: true, run: function () { location.href = new URL(a.url, location.href).href; } },
        ], 'apk');
      }).catch(function () {});
    };
    setTimeout(checkApk, 8000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) checkApk(); });
  }

  if (!touch) return; // everything below is for phones and tablets

  // ── no double-tap zoom, no long-press text callouts / selection ──────────────────────────────
  var st = document.createElement('style');
  st.textContent = 'html,body{touch-action:manipulation;-webkit-text-size-adjust:100%;text-size-adjust:100%}' +
    'body,body *{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}' +
    'input,textarea{-webkit-user-select:text;user-select:text}';
  document.head.appendChild(st);

  // ── fit to screen ────────────────────────────────────────────────────────────────────────────
  // The game is laid out for a PC screen. In landscape we tell the browser to lay the page out
  // FIT_H px tall (width follows the screen's shape) and scale that to the screen, so the whole
  // board is visible without scrolling. Pinch-zoom still works for reading a card up close.
  // The local battle screen needs ~801 px of height; a little more avoids a 1-px scroll. Screens
  // that need more (the online battle stacks both active cards in one panel) get it through
  // extraH, measured on the page itself: see refit().
  var FIT_H = 804, MIN_W = 1180, MAX_W = 3400, MAX_EXTRA = 900, extraH = 0;
  var vp = document.querySelector('meta[name="viewport"]');
  if (!vp) { vp = document.createElement('meta'); vp.name = 'viewport'; document.head.appendChild(vp); }
  var lastVp = '';
  function landscape() { return window.matchMedia ? matchMedia('(orientation: landscape)').matches : innerWidth > innerHeight; }
  function typing() {
    var a = document.activeElement;
    return !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !/^(button|checkbox|radio|range|file|submit|reset|color)$/i.test(a.type)));
  }
  function fit() {
    // The on-screen keyboard shrinks the viewport: re-fitting then would rescale the page under
    // the player's fingers mid-typing. Wait until the field loses focus.
    if (typing()) return;
    var content;
    if (landscape()) {
      var sw = Math.max(screen.width, screen.height), sh = Math.min(screen.width, screen.height);
      var aspect = (window.visualViewport ? visualViewport.width / visualViewport.height : sw / sh) || sw / sh;
      if (!isFinite(aspect) || aspect < 1) aspect = sw / sh;
      var w = Math.round(Math.min(MAX_W, Math.max(MIN_W, (FIT_H + extraH) * aspect)));
      content = 'width=' + w + ', viewport-fit=cover';
      host.style.setProperty('--k', String(Math.max(1, Math.min(3, w / sw)).toFixed(3)));
    } else {
      content = 'width=device-width, initial-scale=1, viewport-fit=cover';
      host.style.setProperty('--k', '1');
    }
    if (content !== lastVp) { lastVp = content; vp.setAttribute('content', content); window.scrollTo(0, 0); }
  }
  fit();
  // Panels that clip their content (overflow:hidden) and are too short for it mean the layout
  // height is too small for this screen: the online battle's middle panel, for one, holds BOTH
  // active cards and its height is whatever is left of 100vh, so at 804 px the player's own card
  // was cut in half. Grow the layout height by the missing amount (the page then scales down a
  // little more), and start over whenever the screen changes (menu / local battle / online battle).
  var screenKey = '';
  function currentScreen() { try { return (MP.mode === 'local' ? 'local' : 'online') + ':' + MP.phase + ':' + S.phase; } catch (e) { return ''; } }
  function clippedBy() {
    var worst = 0, els = document.querySelectorAll('#root .panel');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], cs = getComputedStyle(el);
      if (cs.overflowY !== 'hidden' && cs.overflow !== 'hidden') continue;
      var d = el.scrollHeight - el.clientHeight;
      if (d > worst) worst = d;
    }
    return worst;
  }
  function refit() {
    if (!landscape() || typing()) return;
    var k = currentScreen();
    if (k !== screenKey) { screenKey = k; if (extraH) { extraH = 0; fit(); } }
    var d = clippedBy();
    if (d > 4 && extraH < MAX_EXTRA) { extraH = Math.min(MAX_EXTRA, extraH + d + 12); fit(); }
  }
  setInterval(refit, 400);
  window.addEventListener('orientationchange', function () { setTimeout(fit, 250); });
  window.addEventListener('resize', function () { clearTimeout(fit._t); fit._t = setTimeout(fit, 150); });
  document.addEventListener('focusout', function () { clearTimeout(fit._t); fit._t = setTimeout(fit, 400); });

  // ── music stops while the app is in the background (a phone isn't a PC with other windows) ──
  // The game restarts its music from render() whenever it finds it paused, and timers keep
  // rendering in the background, so pausing alone isn't enough: play() is a no-op while hidden.
  var realPlay = HTMLMediaElement.prototype.play, pausedByUs = [];
  document.addEventListener('visibilitychange', function () {
    var loops = {}; try { loops = _loopAudio || {}; } catch (e) {} // the game's looping sounds
    if (document.hidden) {
      HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      pausedByUs = [];
      Object.keys(loops).forEach(function (k) { var a = loops[k]; if (a && !a.paused) { a.pause(); pausedByUs.push(a); } });
    } else {
      HTMLMediaElement.prototype.play = realPlay;
      pausedByUs.forEach(function (a) { if (a.paused && a.volume > 0) a.play().catch(function () {}); });
      pausedByUs = [];
    }
  });

  // ── rotate prompt: menus work upright, the board needs landscape ─────────────────────────────
  var rotDismissed = false;
  function needsLandscape() { try { return MP.phase === 'ingame' || S.phase === 'battle'; } catch (e) { return false; } }
  function syncRotate() {
    mount();
    var show = !landscape() && needsLandscape() && !rotDismissed;
    var el = $('rot');
    if (show && !el.firstChild) {
      el.innerHTML = '<div class="rot"><div class="ph"></div><div>Поверни телефон горизонтально,<br>щоб бачити все поле бою</div>' +
        '<small>Вимкни блокування повороту, якщо екран не повертається</small><button>Продовжити так</button></div>';
      el.querySelector('button').onclick = function () { rotDismissed = true; el.innerHTML = ''; };
    } else if (!show && el.firstChild) el.innerHTML = '';
  }
  setInterval(syncRotate, 400);
  window.addEventListener('orientationchange', function () { rotDismissed = false; setTimeout(syncRotate, 300); });

  // ── long-press = right-click (the game converts energy with a right-click) ────────────────────
  // Card previews open on hover. A tap counts as hover, but nothing ever "un-hovers" on a phone,
  // so a touch anywhere outside a card closes the open preview.
  function closePreviews(target) {
    if (target && target.closest && target.closest('.mc-wrap,[onmouseenter*="Preview"],[onmouseenter*="ArtTip"]')) return;
    try { if (typeof hideArtTip === 'function') hideArtTip(); } catch (x) {}
    try { if (typeof hideCardPreview === 'function') hideCardPreview(); } catch (x) {}
  }

  // The game re-renders right after handling it, so the finger ends up over a NEW element and the
  // lift can arrive as a click on it (which, for energy, would cancel what the long-press just did).
  // So after a long-press the next click is swallowed, until the next touch begins.
  var LP_MS = 450, LP_MOVE = 12, lp = null, lpFiredAt = 0, eatClick = false;
  function cancelLp() { if (lp) { clearTimeout(lp.timer); lp = null; } }
  function endLp(e) { if (lp && lp.fired && e.cancelable) e.preventDefault(); cancelLp(); }
  document.addEventListener('touchstart', function (e) {
    cancelLp();
    eatClick = false;
    closePreviews(e.target);
    if (e.touches.length !== 1) return;
    var el = e.target && e.target.closest && e.target.closest('[oncontextmenu]');
    if (!el) return;
    var t = e.touches[0];
    // The touch keeps targeting this node even after render() detaches it, and a detached node's
    // events never reach document: listen on the node itself too.
    try { e.target.addEventListener('touchend', endLp, { once: true, passive: false }); } catch (x) {}
    lp = { el: el, x: t.clientX, y: t.clientY, timer: setTimeout(function () {
      if (!lp) return;
      lpFiredAt = Date.now();
      lp.fired = true;
      eatClick = true;
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: lp.x, clientY: lp.y }));
      if (navigator.vibrate) try { navigator.vibrate(12); } catch (x) {}
    }, LP_MS) };
  }, { passive: true, capture: true });
  document.addEventListener('touchmove', function (e) {
    if (!lp) return;
    var t = e.touches[0];
    if (Math.abs(t.clientX - lp.x) > LP_MOVE || Math.abs(t.clientY - lp.y) > LP_MOVE) cancelLp();
  }, { passive: true, capture: true });
  document.addEventListener('touchend', endLp, { passive: false, capture: true });
  document.addEventListener('touchcancel', cancelLp, { capture: true });
  document.addEventListener('click', function (e) {
    if (!eatClick) return;
    eatClick = false;
    if (Date.now() - lpFiredAt > 10000) return; // stale (e.g. a mouse on a touch laptop)
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  }, { capture: true });
  // Android also fires its own contextmenu on a long press: don't let it run the handler twice.
  document.addEventListener('contextmenu', function (e) {
    if (e.isTrusted && Date.now() - lpFiredAt < 1500) { e.preventDefault(); e.stopPropagation(); }
  }, { capture: true });

  // ── install hint (once, on the main menu, only in a browser tab) ─────────────────────────────
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredPrompt = e; });
  function onMenu() { try { return MP.phase === 'lobby' && !S.regGate; } catch (e) { return false; } }
  var hinted = false;
  try { hinted = !!localStorage.getItem('pkmn_install_hint'); } catch (e) {}
  if (!standalone && !hinted && !appVersion) {
    setTimeout(function () {
      if (!onMenu()) return;
      try { localStorage.setItem('pkmn_install_hint', '1'); } catch (e) {}
      if (deferredPrompt) {
        toast('Встанови гру на телефон: іконка на екрані, повний екран, працює без інтернету.', [
          { label: 'Не зараз' },
          { label: 'Встановити', primary: true, run: function () { deferredPrompt.prompt(); } },
        ], 'install');
      } else if (isIOS) {
        toast('Щоб грати як у застосунку: натисни <b>Поділитися</b> ⬆︎ і <b>На початковий екран</b>.', [{ label: 'Зрозуміло' }], 'install');
      }
    }, 2500);
  }
})();
