import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const scope = 'https://example.test/myscan/ios/';
const precache = ['./index.html', './assets/app-123.js', './manifest.webmanifest'];
const source = (await readFile(new URL('../public/ios-assets/sw.js', import.meta.url), 'utf8'))
  .replace("/*__CACHE_NAME__*/ 'myscan-ios-development'", '"verified-build"')
  .replace('/*__PRECACHE__*/ []', JSON.stringify(precache));
const cacheName = 'myscan-ios-shell:/myscan/ios/:verified-build';

function worker({ failInstall = false } = {}) {
  const handlers = new Map();
  const cacheStore = new Map();
  const metrics = { skipped: 0, claimed: 0, network: 0 };
  const caches = {
    async open(name) {
      if (!cacheStore.has(name)) cacheStore.set(name, new Map());
      const entries = cacheStore.get(name);
      return {
        async addAll(requests) {
          for (const request of requests) {
            assert.equal(request.cache, 'reload');
            entries.set(request.url, new Response(request.url.endsWith('index.html') ? '<html>offline</html>' : 'asset'));
            if (failInstall) throw new Error('Network interrupted');
          }
        },
        async match(url) { return entries.get(typeof url === 'string' ? url : url.url)?.clone(); },
      };
    },
    async keys() { return [...cacheStore.keys()]; },
    async delete(name) { return cacheStore.delete(name); },
  };
  const self = {
    registration: { scope },
    addEventListener(type, handler) { handlers.set(type, handler); },
    async skipWaiting() { metrics.skipped += 1; },
    clients: { async claim() { metrics.claimed += 1; } },
  };
  vm.runInNewContext(source, {
    self, caches, URL, Request, Response,
    async fetch() { metrics.network += 1; throw new Error('Device is offline'); },
  });
  async function dispatch(type, data = {}) {
    const pending = [];
    const event = {
      ...data,
      waitUntil(promise) { pending.push(promise); },
      respondWith(promise) { event.response = promise; },
    };
    handlers.get(type)?.(event);
    await Promise.all(pending);
    return event;
  }
  return { dispatch, caches, metrics };
}

test('first iPhone session gets a controller and complete offline shell without skipping waiting', async () => {
  const app = worker();
  let status;
  const ports = [{ postMessage(value) { status = value; } }];
  await app.dispatch('message', { data: { type: 'GET_CACHE_STATUS' }, ports });
  assert.equal(status.ready, false);
  await app.dispatch('install');
  await app.dispatch('activate');
  assert.equal(app.metrics.claimed, 1);
  await app.dispatch('message', { data: { type: 'GET_CACHE_STATUS' }, ports });
  assert.equal(status.ready, true);
  assert.equal(status.assets, 3);
  assert.equal(app.metrics.skipped, 0);
  const navigation = await app.dispatch('fetch', { request: { method: 'GET', mode: 'navigate', url: scope } });
  assert.equal(await (await navigation.response).text(), '<html>offline</html>');
  const asset = await app.dispatch('fetch', { request: new Request(`${scope}assets/app-123.js`) });
  assert.equal(await (await asset.response).text(), 'asset');
  assert.equal(app.metrics.network, 0);
});

test('interrupted installation removes its partial cache and cannot report offline-ready', async () => {
  const app = worker({ failInstall: true });
  await assert.rejects(app.dispatch('install'), /Network interrupted/);
  assert.deepEqual(await app.caches.keys(), []);
  assert.equal(app.metrics.claimed, 0);
  let status;
  await app.dispatch('message', {
    data: { type: 'GET_CACHE_STATUS' },
    ports: [{ postMessage(value) { status = value; } }],
  });
  assert.equal(status.ready, false);
});

test('updates need explicit skip-waiting consent while activation claims clients and cleans only its scope', async () => {
  const app = worker();
  const preserved = ['user-images', 'myscan-ios-shell:/other/ios/:old-build', 'third-party-app'];
  for (const name of preserved) await app.caches.open(name);
  await app.caches.open('myscan-ios-shell:/myscan/ios/:old-build');
  await app.dispatch('install');
  assert.equal(app.metrics.skipped, 0);
  assert.equal(app.metrics.claimed, 0);
  await app.dispatch('activate');
  assert.deepEqual((await app.caches.keys()).sort(), [...preserved, cacheName].sort());
  assert.equal(app.metrics.skipped, 0);
  assert.equal(app.metrics.claimed, 1);
  await app.dispatch('message', { data: { type: 'SKIP_WAITING' } });
  assert.equal(app.metrics.skipped, 1);
  assert.equal(app.metrics.claimed, 1);
});

test('service worker leaves other sites, downloads, document data and non-GET requests alone', async () => {
  const app = worker();
  await app.dispatch('install');
  const requests = [
    { method: 'GET', mode: 'navigate', url: 'https://example.test/myscan/' },
    { method: 'GET', mode: 'navigate', url: `${scope}document.pdf` },
    { method: 'GET', mode: 'cors', url: `${scope}scan.jpg` },
    { method: 'GET', mode: 'cors', url: 'https://other.test/myscan/ios/assets/app-123.js' },
    { method: 'POST', mode: 'cors', url: `${scope}assets/app-123.js` },
  ];
  for (const request of requests) {
    const event = await app.dispatch('fetch', { request });
    assert.equal(event.response, undefined, request.url);
  }
  assert.equal(app.metrics.network, 0);
});
