/*
 * Работа без интернета.
 * Файлы приложения: сначала из кэша, в фоне обновляются (новая версия видна при следующем открытии).
 * Базовые уровни (levels/): сначала из сети, чтобы новые уровни учителя появлялись сразу.
 */

const CACHE = 'hanzi-v1';

const APP_FILES = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/errors.js',
  'js/parser.js',
  'js/share.js',
  'js/speech.js',
  'js/storage.js',
  'js/xlsx.js',
  'icons/favicon.svg',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'levels/index.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;

  const isLevel = url.pathname.includes('/levels/');
  event.respondWith(isLevel ? networkFirst(request) : cacheFirst(event, request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (e) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(event, request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const update = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(update);
    return cached;
  }
  const response = await update;
  if (response) return response;
  if (request.mode === 'navigate') {
    const page = await cache.match('index.html');
    if (page) return page;
  }
  return Response.error();
}
