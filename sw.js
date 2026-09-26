const CACHE_NAME = 'expense-pwa-shell-v3-projects-filters-export';

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // درخواست‌های Apps Script و هر Origin خارجی عمداً Cache نمی‌شوند.
  if (url.origin !== self.location.origin) return;

  // برای Navigation ابتدا نسخه آنلاین را می‌گیریم؛ اگر اینترنت نبود index.html آفلاین باز می‌شود.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            event.waitUntil(
              caches.open(CACHE_NAME)
                .then(cache => cache.put('./index.html', copy))
            );
          }
          return response;
        })
        .catch(async () => {
          return (await caches.match('./index.html')) || (await caches.match('./'));
        })
    );
    return;
  }

  // فایل‌های Static: Cache-first + بروزرسانی در پس‌زمینه.
  event.respondWith(
    caches.match(request).then(cached => {
      const networkUpdate = fetch(request)
        .then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            event.waitUntil(
              caches.open(CACHE_NAME)
                .then(cache => cache.put(request, copy))
            );
          }
          return response;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(networkUpdate);
        return cached;
      }

      return networkUpdate.then(response => {
        if (response) return response;
        return new Response('Offline', {
          status: 503,
          statusText: 'Offline'
        });
      });
    })
  );
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
