// Bump VERSION whenever you change files in SHELL so clients pick up a fresh cache.
const VERSION = 'v9';
const CACHE = `medialog-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/util.js',
  './js/pwa.js',
  './js/autobackup.js',
  './js/sync.js',
  './js/components.js',
  './js/views/library.js',
  './js/views/entry.js',
  './js/views/sources.js',
  './js/views/settings.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('medialog-') && k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

// Stale-while-revalidate for same-origin GETs: answer from cache instantly (works offline),
// refresh the cache in the background so the next launch gets the latest files.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const key = request.mode === 'navigate' ? './index.html' : request;
      const cached = await cache.match(key, { ignoreSearch: true });

      const network = fetch(request)
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      return (await network) ?? new Response('Offline', { status: 503, statusText: 'Offline' });
    })(),
  );
});
