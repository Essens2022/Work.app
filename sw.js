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

const CACHE_VERSION = 'pt-foglio-v13';
const CORE_ASSETS = ['./', './index.html', './app.js', './manifest.json'];
const STATIC_ASSETS = [
  './icon-192.png',
  './icon-512.png',
  './vendor/jspdf.umd.min.js',
  './vendor/jspdf.plugin.autotable.min.js',
  './vendor/comuni.js',
  './vendor/logo.png'
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
    event.respondWith(
      fetch(event.request)
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

  // Cache-first for static/vendor assets.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});

