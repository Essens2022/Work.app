// Minimal service worker, just for push notifications on the admin
// panel — requested directly: ION needs to know immediately when a
// driver sends a chat message. This deliberately does NOT do any of
// the caching/offline/update logic the main app's own sw.js handles —
// admin is a plain page ION visits, not an installed app, so none of
// that applies here.

self.addEventListener('push', (event) => {
  var data = { title: 'ADB Smart', body: 'Nuovo messaggio' };
  try { data = event.data.json(); } catch (e) { /* fall back to the generic text above */ }
  event.waitUntil(
    self.registration.showNotification(data.title || 'ADB Smart', {
      body: data.body || '',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      // Requested directly: tapping a notification here used to just
      // open (or focus) the admin panel generically — ION had to go
      // find the new message himself from the home screen. Every
      // notification this admin panel currently gets IS specifically
      // about a new driver message (see the comment on the main app's
      // own sw.js for the equivalent, more general version of this) —
      // read back in notificationclick below to know to open
      // Messaggi directly instead of just the bare home screen.
      data: { type: 'messaggi' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  var notificationType = (event.notification.data && event.notification.data.type) || 'generic';
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
      // param carries the same instruction through to the matching
      // code in admin/index.html's own startup check.
      if (self.clients.openWindow) {
        return self.clients.openWindow('./index.html?notif=' + encodeURIComponent(notificationType));
      }
    })
  );
});
