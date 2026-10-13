/* Generated build values are inserted by scripts/build-ios-pwa.mjs. */
const BUILD_VERSION = "28053cb10930ba050a78";
const PRECACHE_URLS = ["./apple-touch-icon.png","./assets/ios-9ah8LwwS.js","./assets/ios-CrRbI8eD.css","./assets/pdf-CYiZnmCO.js","./icon-192.png","./icon-512.png","./icon-maskable-512.png","./icon.svg","./index.html","./manifest.webmanifest"];
const scopeUrl = new URL(self.registration.scope);
const CACHE_PREFIX = `myscan-ios-shell:${scopeUrl.pathname}:`;
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_VERSION}`;
const shellUrl = new URL('./index.html', scopeUrl).href;
const assetUrls = PRECACHE_URLS.map((path) => new URL(path, scopeUrl).href);
const assetPaths = new Set(assetUrls.map((url) => new URL(url).pathname));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      // One batch: a failed download must never advertise an offline-ready shell.
      await cache.addAll(assetUrls.map((url) => new Request(url, { cache: 'reload' })));
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
  // Updates wait until the app receives an explicit update action.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    // The first loaded page needs a controller before offline dynamic imports.
    // Claiming changes its controller; it does not reload or replace the UI.
    await self.clients.claim();
  })());
  // Updates still wait for SKIP_WAITING, and only the app chooses when to reload.
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (event.data?.type !== 'GET_CACHE_STATUS') return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const entries = await Promise.all(assetUrls.map((url) => cache.match(url)));
    const reply = {
      type: 'CACHE_STATUS',
      ready: assetUrls.length > 0 && entries.every(Boolean),
      version: CACHE_NAME,
      assets: assetUrls.length,
    };
    if (event.ports[0]) event.ports[0].postMessage(reply);
    else event.source?.postMessage(reply);
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== scopeUrl.origin || !url.pathname.startsWith(scopeUrl.pathname)) return;

  if (request.mode === 'navigate'
      && (url.pathname === scopeUrl.pathname || url.pathname === new URL(shellUrl).pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match(shellUrl)) || fetch(request);
    })());
    return;
  }
  if (!assetPaths.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const assetUrl = new URL(url.pathname, scopeUrl.origin).href;
    return (await cache.match(assetUrl)) || fetch(request);
  })());
});
