// AttendX Service Worker Stub
// Cleanly handles background browser update checks and unregisters legacy service workers on localhost

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.registration.unregister().then(() => {
      return self.clients.matchAll();
    }).then((clients) => {
      // Unregistration complete
    })
  );
});
