const CACHE_NAME = 'shogi-match-v7';
const ASSETS = [
  './',
  './index.html',
  './index.css',
  './js/app.js',
  './js/storage.js',
  './js/matching.js',
  './js/ui.js',
  './js/pdf.js',
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
  // SupabaseやAPIへのリクエストはネットワークのみとする
  if (event.request.url.includes('supabase.co')) {
    return;
  }

  // リソースの取得戦略：Network First (失敗したらキャッシュを返す)
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // ネットワークから取得成功したらキャッシュを更新しておく
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // オフライン等で失敗した場合はキャッシュを返す
        return caches.match(event.request).then((cached) => {
          if (cached) {
            return cached;
          }
          // キャッシュもなく、ナビゲーションリクエスト（URL直叩き）ならindex.htmlを返す
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
      })
  );
});
