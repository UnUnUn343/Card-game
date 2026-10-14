/*
 * Service worker for the web app. The game page (~33 MB) is served from the cache, so the app opens
 * instantly and works offline. Updates: when the page asks ({type:'check'}), fetch version.json; if
 * the published version is newer than the cached page, download the new page completely, swap it
 * into the cache in one step, then tell the page ({type:'update-ready'}). It compares build hashes too,
 * because a corrected test build and the official build can share the same game version.
 * Only same-origin GETs are handled; PeerJS, analytics and everything else go straight to the network.
 */
'use strict';
// Replaced by scripts/build-web.js with a hash of the whole site. Any change (a new game build, or
// only the phone add-on) changes this file, so the browser installs this service worker anew, and
// its install step below downloads the current page: add-on fixes reach phones without waiting for
// the next game release.
const BUILD = '__BUILD__';
const CACHE = 'pkmn-game-v2';
const SCOPE = self.registration.scope;              // e.g. https://user.github.io/Card-game/
const PAGE = new URL('./', SCOPE).href;
const CORE = ['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', event => {
  // cache:'reload' skips the HTTP cache (GitHub Pages sends max-age=600), so this is the page that
  // matches this BUILD, not one cached a few minutes ago.
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
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
  const { version, build } = await res.json();
  const cache = await caches.open(CACHE);
  const cachedPage = await cache.match(PAGE);
  const cachedVersion = await pageVersion(cachedPage);

  // Different builds may share the same game version (for example, a test v215 and the
  // official v215). The generated BUILD hash covers the whole page and service-worker source.
  const sameBuild = !!build && BUILD === build;
  if (cachedPage && cachedVersion === version && sameBuild)
    return { version: cachedVersion, changed: false };

  // Compatibility with older deployments that did not publish a build hash.
  if (!build && cachedVersion && !newer(version, cachedVersion))
    return { version: cachedVersion, changed: false };

  // Download the full current page before touching the cache; key the request by build, not
  // only game version, so a same-version correction also bypasses the HTTP cache.
  const page = await fetch(PAGE + '?v=' + encodeURIComponent(build || version), { cache: 'no-store' });
  if (!page.ok) return cachedVersion ? { version: cachedVersion, changed: false } : null;
  const blob = await page.blob();
  const got = await pageVersion(new Response(blob));
  if (got !== version) return cachedVersion ? { version: cachedVersion, changed: false } : null;
  await cache.put(PAGE, new Response(blob, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  return { version, changed: true };
}

self.addEventListener('message', event => {
  const d = event.data || {};
  if (d.type !== 'check') return;
  if (!checking) checking = check().catch(() => null).finally(() => { checking = null; });
  event.waitUntil(checking.then(result => {
    if (!result || !d.running || !event.source) return;
    const sameVersionRefresh = !!result.changed && result.version === d.running;
    if (newer(result.version, d.running) || sameVersionRefresh) {
      event.source.postMessage({ type: 'update-ready', version: result.version, force: sameVersionRefresh });
    }
  }));
});
