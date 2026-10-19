/* Commetty Book service worker.
   - App files: cache first, refreshed in the background → opens instantly.
   - api/data: network first, last copy kept → app still opens read-only without internet.
   - Screenshots: cached forever once seen (they never change).
   Bump VERSION when you change web files so phones pick up the new version. */
const VERSION = 'v2';
const SHELL = `commetty-shell-${VERSION}`;
const DATA = 'commetty-data';
const FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const path = url.pathname;

  if (path.endsWith('/api/data')) {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(DATA).then((c) => c.put(req, copy)); }
      return res;
    }).catch(async () => {
      const cached = await caches.match(req, { cacheName: DATA });
      if (!cached) throw new Error('offline');
      const headers = new Headers(cached.headers);
      headers.set('X-Offline', '1');
      return new Response(cached.body, { status: 200, headers });
    }));
    return;
  }
  if (path.includes('/api/shots/')) {
    e.respondWith(caches.match(req, { cacheName: DATA }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(DATA).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  if (path.includes('/api/')) return;

  const key = req.mode === 'navigate' ? './' : req;
  e.respondWith(caches.open(SHELL).then(async (cache) => {
    const cached = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(req)
      .then((res) => { if (res.ok) cache.put(key, res.clone()); return res; })
      .catch(() => cached);
    return cached || fresh;
  }));
});
