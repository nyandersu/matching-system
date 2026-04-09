const CACHE_NAME = 'shogi-match-v1';
const ASSETS = [
  './',
  './index.html',
  './index.css',
  './js/app.js',
  './js/storage.js',
  './js/matching.js',
  './js/ui.js',
  './js/pdf.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Supabaseや他のAPIリクエストはキャッシュせずにネットワークを優先する（オフライン時はエラーになるがLocalStorageで対応）
  if (event.request.url.includes('supabase.co')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request);
    }).catch(() => {
      // ネットワークもキャッシュもない場合はindex.htmlを返す（SPAフォールバックのような挙動）
      if (event.request.mode === 'navigate') {
        return caches.match('./index.html');
      }
    })
  );
});
