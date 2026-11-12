const CACHE = 'clinic-shell-v1';
const ASSETS = [
  '/', '/index.html', '/styles.css', '/app.js',
  '/db.js', '/sync.js', '/conflict.js', '/seed.json', '/manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});