/* Workroom service worker: caches the app shell so it opens instantly and installs as a PWA.
   API calls, the live stream and photos always go to the network. */
const CACHE = 'workroom-v1';
const SHELL = ['/', '/styles.css', '/app.js', '/render.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;

  const isPage = e.request.mode === 'navigate';
  // Network first (so updates show up), cache as offline fallback.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(isPage ? '/' : e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(isPage ? '/' : e.request)),
  );
});
