/*
 * Service worker for the web app. The game page (~33 MB) is served from the cache, so the app opens
 * instantly and works offline. Updates: when the page asks ({type:'check'}), fetch version.json; if
 * the published version is newer than the cached page, download the new page completely, swap it
 * into the cache in one step, then tell the page ({type:'update-ready'}). The next reload runs it.
 * Only same-origin GETs are handled; PeerJS, analytics and everything else go straight to the network.
 */
'use strict';
const CACHE = 'pkmn-game-v1';
const SCOPE = self.registration.scope;              // e.g. https://user.github.io/Card-game/
const PAGE = new URL('./', SCOPE).href;
const CORE = ['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(SCOPE)) return;
  const path = url.pathname;
  if (path.endsWith('/version.json') || path.endsWith('/sw.js')) return; // always from the network
  const isPage = req.mode === 'navigate' || url.href === PAGE || path.endsWith('/index.html');
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(isPage ? PAGE : req, { ignoreSearch: isPage });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') await cache.put(isPage ? PAGE : req, res.clone());
    return res;
  })());
});

function newer(a, b) {
  const p = v => String(v || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; }
  return false;
}

/** The version the game page says it is (<meta name="pkmn-version">), reading only its first bytes. */
async function pageVersion(res) {
  if (!res || !res.body) return null;
  // The meta tag sits just inside <head>, after the game's long changelog comment: read up to 512 KB.
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '', m = null;
  while (text.length < 524288) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    if ((m = text.match(/<meta name="pkmn-version" content="([^"]+)"/))) break;
  }
  reader.cancel().catch(() => {});
  return m ? m[1] : null;
}

let checking = null;
async function check() {
  const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) return null;
  const { version } = await res.json();
  const cache = await caches.open(CACHE);
  const cachedVersion = await pageVersion(await cache.match(PAGE));
  if (cachedVersion && !newer(version, cachedVersion)) return cachedVersion;
  // Download the whole new page before touching the cache: a half-downloaded game must never run.
  const page = await fetch(PAGE + '?v=' + encodeURIComponent(version), { cache: 'no-store' });
  if (!page.ok) return cachedVersion;
  const blob = await page.blob();
  const got = await pageVersion(new Response(blob));
  if (got !== version) return cachedVersion; // CDN still serving the old page; try again next time
  await cache.put(PAGE, new Response(blob, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  return version;
}

self.addEventListener('message', event => {
  const d = event.data || {};
  if (d.type !== 'check') return;
  if (!checking) checking = check().catch(() => null).finally(() => { checking = null; });
  event.waitUntil(checking.then(v => {
    if (v && d.running && newer(v, d.running) && event.source) event.source.postMessage({ type: 'update-ready', version: v });
  }));
});
