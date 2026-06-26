// v14 — self-destruct: clear all caches and unregister
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.registration.unregister())
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // pass through — don't cache anything
  e.respondWith(fetch(e.request));
});
