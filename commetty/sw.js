/* Commetty Book service worker: keeps the whole app cached so it opens fully offline,
   even when the local server (or the internet) is not running.
   Bump CACHE when you change any file so phones pick up the new version. */
const CACHE = 'commetty-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'db.js', 'app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

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
  const key = e.request.mode === 'navigate' ? './' : e.request;

  // Cache first (instant + offline), then refresh the cache in the background.
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(e.request)
      .then((res) => { if (res.ok) cache.put(key, res.clone()); return res; })
      .catch(() => cached);
    return cached || fresh;
  }));
});
