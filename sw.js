// Power Trasporti - Foglio Viaggi - Service Worker
//
// Strategy:
//  - Core app files (index.html, app.js, manifest.json) use NETWORK-FIRST:
//    when the phone has internet, it always fetches the latest version from
//    GitHub Pages and updates the cache, so future updates show up right
//    away. If there's no internet, it falls back to the last cached copy,
//    so the app keeps working fully offline.
//  - Large, rarely-changing files (jsPDF, the comuni database, icons, logo)
//    stay CACHE-FIRST, so they don't get re-downloaded on every load.

const CACHE_VERSION = 'pt-foglio-v283';
const CORE_ASSETS = ['./', './index.html', './app.js', './manifest.json', './version.json'];
const STATIC_ASSETS = [
  './icon-192.png',
  './icon-512.png',
  './vendor/jspdf.umd.min.js',
  './vendor/jspdf.plugin.autotable.min.js',
  './vendor/comuni.js',
  './vendor/logo.png',
  './vendor/maplibre-gl.js',
  './vendor/maplibre-gl.css',
  './splash-hero.jpg',
  './wheel-splash.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(CORE_ASSETS.concat(STATIC_ASSETS)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isCoreAsset(url) {
  return CORE_ASSETS.some((path) => url.endsWith(path.replace('./', '/')) || url.endsWith(path));
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = event.request.url;
  const isNavigation = event.request.mode === 'navigate';

  if (isNavigation || isCoreAsset(url)) {
    // Network-first: always try to get the latest app code when online.
    // { cache: 'no-store' } here is deliberate and important — without
    // it, this fetch() can still be satisfied by the BROWSER's own HTTP
    // cache (a layer completely separate from this service worker's own
    // Cache API storage), depending on cache-control headers from the
    // server. That could quietly serve a stale copy of app.js even
    // though this code "looks" network-first — no-store forces a truly
    // fresh network round-trip every time, when online.
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for static/vendor assets — now also covers MapLibre's
  // own cross-origin resources (OpenFreeMap's style JSON, sprite,
  // glyphs, vector tiles; Esri's satellite tiles for the map's
  // satellite toggle). These were being silently EXCLUDED from caching
  // entirely before: cross-origin responses come back with
  // response.type === 'cors' (or 'opaque' for a no-cors request),
  // never 'basic' — 'basic' is reserved for same-origin responses
  // only. The old check here only ever accepted 'basic', so every
  // single one of these was being re-downloaded from scratch on every
  // single visit to Navigatore, with zero caching benefit across
  // sessions — a real, meaningful contributor to slow map loading.
  // 'opaque' responses are deliberately left out — the browser gives
  // no way to read their actual HTTP status for an opaque response
  // (a no-cors cross-origin request), so there's no way to confirm a
  // response.status === 200 check against one; caching a possible
  // error response as if it succeeded would be worse than not caching
  // it. Both the OpenFreeMap and Esri tile servers respond with proper
  // CORS headers already (confirmed — MapLibre requires this to read
  // tile pixel data at all), so requests to them come back as 'cors',
  // not 'opaque', in practice.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && (response.type === 'basic' || response.type === 'cors')) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});

