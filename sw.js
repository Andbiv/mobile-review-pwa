// Service worker for Juniper Review PWA.
//
// Strategy: cache-first for the app shell (so the PWA opens offline);
// network-first for navigation requests (so updates land when online);
// passthrough for cross-origin (JSZip CDN handled by browser cache + IDB).
//
// Pack zips and verdict JSONs are NEVER cached here — they live in IndexedDB,
// not Cache Storage. The SW only handles the static shell.

// Bump the version string on every UI change so the SW evicts the old cache
// on activate and forces fresh fetches of HTML/JS/CSS. iOS Safari is sticky
// about cached shells otherwise. (And the BUILD constant in js/build.js
// shows the version in the PWA header so you can verify which is live.)
const SHELL_CACHE = 'juniper-review-shell-v10';
const SHELL = [
  './',
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './js/main.js',
  './js/build.js',
  './js/update.js',
  './js/state.js',
  './js/ortho.js',
  './js/pack-import.js',
  './js/verdict-export.js',
  './js/adds-export.js',
  './js/views/library.js',
  './js/views/map.js',
  './js/views/review.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

// Allow the in-app refresh button to nudge a waiting SW to activate
// immediately rather than waiting for the next cold start.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Cross-origin (JSZip CDN): let the browser handle it.
  if (url.origin !== self.location.origin) return;

  // For HTML navigations, prefer fresh, fall back to cache.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // For everything else in scope, cache-first with network fill.
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(resp => {
      // Opportunistic update — don't crash if cache.put fails.
      const copy = resp.clone();
      caches.open(SHELL_CACHE).then(c => c.put(req, copy)).catch(() => {});
      return resp;
    }))
  );
});
