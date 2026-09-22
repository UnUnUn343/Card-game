'use strict';
/**
 * Runs next to the game page. It never touches the game's code or state: it only adds a small
 * update notice in the corner, inside a shadow root so the game's CSS can't reach it and
 * the game's render() (which rewrites #root wholesale) can't remove it.
 *
 * Sandboxed preloads can't require project files, so the version compare is inlined here.
 */
const { ipcRenderer } = require('electron');

const TEXT = {
  uk: {
    gameReady: v => `Вийшла нова версія гри <b>v${v}</b>. Вона вже завантажена.`,
    restart: 'Перезапустити й оновити',
    downloading: (v, p) => `Завантажується нова версія v${v}… ${p}`,
    launcherReady: v => `Готове оновлення лаунчера <b>${v}</b>. Встановиться саме, коли закриєш гру.`,
    installNow: 'Встановити зараз',
    blocked: v => `Для версії гри v${v} потрібен новіший лаунчер. Він завантажується.`,
    later: 'Пізніше',
  },
  en: {
    gameReady: v => `A new version of the game, <b>v${v}</b>, is out and already downloaded.`,
    restart: 'Restart to update',
    downloading: (v, p) => `Downloading the new version v${v}… ${p}`,
    launcherReady: v => `Launcher update <b>${v}</b> is ready. It installs when you close the game.`,
    installNow: 'Install now',
    blocked: v => `Game v${v} needs a newer launcher. It is downloading.`,
    later: 'Later',
  },
};

function cmp(a, b) {
  const p = v => (String(v || '').replace(/^v/i, '').match(/^\d+(?:\.\d+)*/) || [''])[0].split('.').filter(Boolean).map(Number);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

let info = null;
let host = null;
let root = null;
const dismissed = new Set();

const CSS = `
:host{all:initial}
.toast{position:fixed;right:18px;bottom:18px;z-index:2147483600;max-width:380px;box-sizing:border-box;
  font:13px/1.45 "Segoe UI",system-ui,sans-serif;color:#e2e8f0;background:rgba(12,21,34,.96);
  border:1px solid #6d28d9;border-radius:14px;padding:14px 16px 12px;box-shadow:0 12px 40px rgba(0,0,0,.55),0 0 0 1px rgba(167,139,250,.15);
  animation:in .25s ease-out}
.toast b{color:#c4b5fd}
.row{display:flex;gap:8px;margin-top:10px;justify-content:flex-end}
button{font:600 12px "Segoe UI",system-ui,sans-serif;border-radius:9px;padding:7px 12px;cursor:pointer;border:1px solid #334155;background:#111c2d;color:#cbd5e1}
button.primary{background:linear-gradient(135deg,#7c3aed,#6d28d9);border-color:#8b5cf6;color:#fff}
button:hover{filter:brightness(1.15)}
.x{position:absolute;top:6px;right:8px;border:0;background:none;color:#64748b;font-size:16px;padding:2px 6px}
.pill{padding:8px 14px;border-color:#263548;color:#94a3b8;font-size:12px}
.bar{height:3px;border-radius:2px;background:#1e293b;margin-top:8px;overflow:hidden}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#7c3aed,#a78bfa)}
@keyframes in{from{transform:translateY(12px);opacity:0}to{transform:none;opacity:1}}
@media (prefers-reduced-motion: reduce){.toast{animation:none}}
`;

function ensureHost() {
  if (host && host.isConnected) return;
  host = document.createElement('div');
  host.id = 'pkmn-desktop-updates';
  root = host.attachShadow({ mode: 'open' });
  (document.body || document.documentElement).appendChild(host);
}

function show(html, key) {
  ensureHost();
  root.innerHTML = `<style>${CSS}</style>${html}`;
  const x = root.querySelector('.x');
  if (x) x.onclick = () => { dismissed.add(key); root.innerHTML = ''; };
  return root;
}

function clear() { if (root) root.innerHTML = ''; }

function render(state) {
  if (!info || !state) return;
  const t = TEXT[info.lang] || TEXT.uk;
  const rv = info.running && info.running.version;
  const g = state.game || {};
  const l = state.launcher || {};
  const gv = g.latest && g.latest.version;

  if (g.status === 'ready' && g.justInstalled && (!rv || cmp(g.justInstalled, rv) > 0)) {
    const key = `game-${g.justInstalled}`;
    if (dismissed.has(key)) return clear();
    const r = show(`<div class="toast"><button class="x" title="${t.later}">×</button>${t.gameReady(g.justInstalled)}
      <div class="row"><button class="later">${t.later}</button><button class="primary go">${t.restart}</button></div></div>`, key);
    r.querySelector('.later').onclick = () => { dismissed.add(key); clear(); };
    r.querySelector('.go').onclick = () => ipcRenderer.invoke('game:restartToUpdate');
    return;
  }
  if (g.status === 'downloading' && gv && (!rv || cmp(gv, rv) > 0)) {
    const key = `dl-${gv}`;
    if (dismissed.has(key)) return clear();
    const p = g.progress && g.progress.total ? Math.round((100 * g.progress.received) / g.progress.total) : 0;
    show(`<div class="toast pill"><button class="x">×</button>${t.downloading(gv, p ? p + '%' : '')}<div class="bar"><i style="width:${p}%"></i></div></div>`, key);
    return;
  }
  if (l.status === 'ready' && l.latest) {
    const key = `launcher-${l.latest.version}`;
    if (dismissed.has(key)) return clear();
    const r = show(`<div class="toast"><button class="x">×</button>${t.launcherReady(l.latest.version)}
      <div class="row">${l.canInstall ? `<button class="primary go">${t.installNow}</button>` : ''}</div></div>`, key);
    const go = r.querySelector('.go');
    if (go) go.onclick = () => ipcRenderer.invoke('game:installLauncherUpdate');
    return;
  }
  if (g.status === 'blocked' && gv) {
    const key = `blocked-${gv}`;
    if (dismissed.has(key)) return clear();
    show(`<div class="toast pill"><button class="x">×</button>${t.blocked(gv)}</div>`, key);
    return;
  }
  clear();
}

let lastState = null;
ipcRenderer.on('update:state', (_e, s) => { lastState = s; render(s); });
ipcRenderer.on('game:lang', (_e, lang) => { if (info) { info.lang = lang; render(lastState); } });

window.addEventListener('DOMContentLoaded', async () => {
  info = await ipcRenderer.invoke('game:info');
  lastState = lastState || info.update;
  render(lastState);
});
