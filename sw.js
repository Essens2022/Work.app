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

const CACHE_VERSION = 'pt-foglio-v525';
const CORE_ASSETS = ['./', './index.html', './app.js', './manifest.json', './version.json'];
// REAL BUG, reported directly, TWICE — a first attempt excluded these
// pages from the service worker entirely, reasoning that removing a
// broken safety net was safer than a broken one. That held up fine on
// WiFi, but the problem turned out to persist specifically on mobile
// data ("date mobile, niciodata pe WiFi") — a real, unstable-network
// symptom that exclusion made WORSE, not better: with no caching at
// all, ANY flaky mobile-data hiccup during navigation now had zero
// fallback, guaranteed to surface as a full page failure. Properly
// cached here instead, network-first with a real cache fallback —
// same proven strategy as CORE_ASSETS — so a revisit on a shaky
// connection can actually recover from a cached copy instead of
// failing outright.
const MARKETING_PAGES = [
  './official/', './official/index.html',
  './guida/foglio-viaggi-digitale/', './guida/foglio-viaggi-digitale/index.html',
  './guida/itinerario-consegne/', './guida/itinerario-consegne/index.html',
  './guida/app-per-autisti/', './guida/app-per-autisti/index.html',
  './guida/quanto-guadagna-autotrasportatore/', './guida/quanto-guadagna-autotrasportatore/index.html',
  './guida/scontrini-carburante-autisti/', './guida/scontrini-carburante-autisti/index.html',
  './guida/migliori-app-gratis-autisti/', './guida/migliori-app-gratis-autisti/index.html'
];
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
  // REAL FRAGILITY, found directly while testing this exact change:
  // cache.addAll() is all-or-nothing — if even ONE single URL in the
  // whole list 404s or fails for any reason (a typo, a page renamed
  // without updating this list, a page not deployed yet), the ENTIRE
  // install step fails silently, and NOTHING gets cached at all — not
  // just the one bad entry, every core app file too. Each file is now
  // tried individually instead, with its own failure caught and
  // logged — one missing marketing page can never again take down
  // caching for the whole app.
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => Promise.all(
        CORE_ASSETS.concat(MARKETING_PAGES).concat(STATIC_ASSETS).map((url) =>
          cache.add(url).catch((err) => console.warn('SW install: failed to cache', url, err))
        )
      ))
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
function isMarketingPage(url) {
  return MARKETING_PAGES.some((path) => url.endsWith(path.replace('./', '/')) || url.endsWith(path));
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = event.request.url;
  const isNavigation = event.request.mode === 'navigate';

  if (isNavigation || isCoreAsset(url) || isMarketingPage(url)) {
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

// Real phone push notifications — requested directly, kept entirely
// separate from the in-app "Novità" red-dot indicator (which stays
// unconditional for everyone). A driver only ever gets here if they
// explicitly turned this on from Impostazioni.
self.addEventListener('push', (event) => {
  var data = { title: 'ADB Smart', body: 'Novità disponibile' };
  try { data = event.data.json(); } catch (e) { /* fall back to the generic text above */ }
  event.waitUntil(
    self.registration.showNotification(data.title || 'ADB Smart', {
      body: data.body || '',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      // Requested directly: tapping a notification used to just open
      // (or focus) the app generically, leaving the driver to go find
      // whatever it was about themselves — carried through to the
      // notificationclick handler below, which reads this back to
      // decide where to actually navigate.
      //
      // REAL BUG, reported directly and confirmed: ION tested for
      // real (sent himself a chat message from the admin panel,
      // received the real push notification, tapped it) and it still
      // just opened the app generically — the fallback here was
      // 'generic' (a safe no-op), which is exactly what fired if the
      // real backend payload doesn't actually include a "type" field
      // at all (this app has no access to that Edge Function's own
      // code, deployed separately in Supabase, to confirm one way or
      // the other). The only real push notification this app
      // currently ever sends the driver IS a chat message — checked
      // directly: "Novità" only ever updates an in-app badge dot via
      // a plain fetch, never a push notification of its own — so
      // defaulting to 'chat' instead of 'generic' is correct for
      // every notification this app can currently send, and still
      // leaves room for the backend to specify a different type
      // explicitly later, if a second kind of push ever gets added.
      data: { type: data.type || 'chat' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  var notificationType = (event.notification.data && event.notification.data.type) || 'generic';
  // REAL BUG, reported directly and confirmed: works correctly on
  // Android, but on iOS, tapping the notification always just opened
  // the app generically — this is a well-documented WebKit/iOS
  // limitation, not something specific to this app: iOS Safari's own
  // clients.openWindow(url) ignores whatever URL is actually passed
  // to it and always opens the PWA's fixed start_url instead — so the
  // ?notif=... query param below, which works fine on Chrome/Android,
  // silently gets thrown away on iOS. The postMessage path (used when
  // the app is already open, further below) has its own separate,
  // also-documented iOS unreliability.
  //
  // Fixed with a handoff through the Cache Storage API — unlike
  // IndexedDB (confirmed, directly, to sometimes be entirely
  // UNAVAILABLE to a service worker specifically woken up by a push
  // notification on iOS), the Cache Storage API stays reliably usable
  // in that exact circumstance, and is readable from both the service
  // worker and the page. The notification type is stashed here,
  // before either navigation attempt below — app.js's own startup
  // check reads it back and clears it, working regardless of whether
  // the URL param or postMessage route actually got through on this
  // particular platform.
  event.waitUntil(
    caches.open('adb-notif-handoff').then(function (cache) {
      return cache.put('/pending-notification', new Response(JSON.stringify({ type: notificationType, at: Date.now() })));
    })
  );
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if ('focus' in clientList[i]) {
          // Already open — the page can't re-read a URL param since
          // it isn't reloading, so tell it directly what to do instead.
          clientList[i].postMessage({ type: 'notification-click', notificationType: notificationType });
          return clientList[i].focus();
        }
      }
      // Nothing open yet — a fresh load DOES read the URL, so the
      // param carries the same instruction through app.js's own
      // startup check (see the matching code there).
      if (self.clients.openWindow) {
        return self.clients.openWindow('./index.html?notif=' + encodeURIComponent(notificationType));
      }
    })
  );
});
