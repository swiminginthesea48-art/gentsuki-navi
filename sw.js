/* 原付ナビ Service Worker
 *  - アプリ本体: ネット優先 (更新をすぐ反映)、圏外ならキャッシュ
 *  - Leaflet / 地図タイル: キャッシュ優先 (一度見た場所は通信しない)
 *  - ルート検索・住所検索などの API: キャッシュしない
 */
const APP_CACHE = 'gn-app-v1';
const LIB_CACHE = 'gn-lib-v1';
const TILE_CACHE = 'gn-tiles-v1';
const MAX_TILES = 2500; // 約 30〜50MB 目安。超えたら古い順に削除

const APP_FILES = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  const keep = [APP_CACHE, LIB_CACHE, TILE_CACHE];
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

let putCount = 0;
async function trimTiles() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  const extra = keys.length - MAX_TILES;
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}

async function cacheFirst(req, cacheName, isTile) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') {
    await cache.put(req, res.clone());
    if (isTile && ++putCount % 100 === 0) trimTiles();
  }
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(APP_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'tile.openstreetmap.org') e.respondWith(cacheFirst(req, TILE_CACHE, true));
  else if (url.hostname === 'unpkg.com') e.respondWith(cacheFirst(req, LIB_CACHE, false));
  else if (url.origin === self.location.origin) e.respondWith(networkFirst(req));
  // それ以外 (Valhalla / Nominatim / Overpass) はブラウザに任せる
});
