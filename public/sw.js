const CACHE_NAME = 'watchparty-pwa-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/room.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/favicon.svg',
  '/icons/icon-svg.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Real-time Socket.IO, API endpoints ve YouTube medya isteklerini önbelleğe alma
  if (
    url.pathname.startsWith('/api/') || 
    url.pathname.startsWith('/socket.io/') ||
    url.hostname.includes('youtube') ||
    url.hostname.includes('ytimg') ||
    url.hostname.includes('googlevideo')
  ) {
    return;
  }

  // Network-First with Cache Fallback for smooth offline & fast app reload
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
