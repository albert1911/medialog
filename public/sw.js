// The app's version, shown in Settings → App. Whenever you change any app file, bump VERSION
// (and set RELEASED to today) so installed copies download the new files:
//   new feature / behavior change → next whole number ('23.4' → '24')
//   small UI adjustment            → +.1             ('23' → '23.1' → … → '23.9' → '23.10')
const VERSION = '27.1';
const RELEASED = '2026-10-04';
const CACHE = `medialog-v${VERSION}`;

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
  './js/gallery.js',
  './js/components.js',
  './js/views/library.js',
  './js/views/entry.js',
  './js/views/sources.js',
  './js/views/settings.js',
  './js/views/gallery.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // "reload" skips the browser's HTTP cache, so a new version never stores stale files.
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

// The page asks which version is installed.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'version') event.ports[0]?.postMessage({ version: VERSION, released: RELEASED });
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
