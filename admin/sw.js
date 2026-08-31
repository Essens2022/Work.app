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
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if ('focus' in clientList[i]) return clientList[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
