/* Caches the app shell so Blue Hearts opens instantly and survives a dead
   connection. Messages are never cached -- they only exist in the live socket. */

// Bump this whenever the shell changes; the activate handler deletes every
// cache that does not match, so old copies cannot linger.
const CACHE = 'blue-hearts-v2';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never touch the socket or the config probe -- those must always be live.
  if (e.request.method !== 'GET' ||
      url.origin !== self.location.origin ||
      url.pathname.startsWith('/socket.io/') ||
      url.pathname === '/config') {
    return;
  }

  // Network first, so a deployed update is picked up as soon as it is reachable.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html')))
  );
});
