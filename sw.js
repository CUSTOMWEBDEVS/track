// sw.js — TrackTheDrops PWA cache
const CACHE = 'ttd-cache-v5';
const CORE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(CORE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => k!==CACHE ? caches.delete(k) : null))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // pass cross-origin (e.g. fonts)
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(resp => {
      if (resp && resp.ok) caches.open(CACHE).then(c => c.put(req, resp.clone()));
      return resp;
    }).catch(() => caches.match('./index.html')))
  );
});
