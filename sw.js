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

const CACHE_VERSION = 'pt-foglio-v73';
const CORE_ASSETS = ['./', './index.html', './app.js', './manifest.json', './version.json'];
const STATIC_ASSETS = [
  './icon-192.png',
  './icon-512.png',
  './vendor/jspdf.umd.min.js',
  './vendor/jspdf.plugin.autotable.min.js',
  './vendor/comuni.js',
  './vendor/logo.png',
  './splash-hero.jpg',
  './wheel-splash.png',
  './splash/splash_iphone_se1_640x1136.png',
  './splash/splash_iphone_678_se23_750x1334.png',
  './splash/splash_iphone_678plus_1242x2208.png',
  './splash/splash_iphone_x_xs_11pro_12mini_13mini_1125x2436.png',
  './splash/splash_iphone_xr_11_828x1792.png',
  './splash/splash_iphone_xsmax_11promax_1242x2688.png',
  './splash/splash_iphone_12_13_14_1170x2532.png',
  './splash/splash_iphone_12_13_promax_14plus_1284x2778.png',
  './splash/splash_iphone_14pro_15_16_1179x2556.png',
  './splash/splash_iphone_14promax_15plus_15promax_16plus_1290x2796.png',
  './splash/splash_iphone_16pro_1206x2622.png',
  './splash/splash_iphone_16promax_1320x2868.png'
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

