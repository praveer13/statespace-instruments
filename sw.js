// W0-S01 instrument-origin service worker (ARCHITECTURE.md sections 15.4 and 16).
// - Engine assets (any path under /b/<build>/engines/) are served only from the engine cache;
//   an uncached engine asset gets 504 and never falls through to the network.
// - The engine cache is filled only on request (after consent), only with bytes whose SHA-256
//   matches the build manifest, and each entry carries the verified hash in x-ss-sha256.
// - The build shell (host page, scripts, manifest) is precached at install: small, no consent needed.

const BUILD = '3d82589a539b';
const SHELL = `ss-shell-${BUILD}`;
const ENGINES = 'ss-engines-v1';
const SHELL_FILES = [
  `/b/${BUILD}/host.html`, `/b/${BUILD}/host.js`, `/b/${BUILD}/worker.mjs`, `/b/${BUILD}/manifest.json`,
  '/diag.html', '/diag.js',
];
const instance = Math.random().toString(36).slice(2, 10); // tells restarts apart in the log
const served = [];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  const kind = url.pathname.includes('/engines/') ? 'engine' : SHELL_FILES.includes(url.pathname) ? 'shell' : null;
  if (!kind) return;
  // The requesting client is resolved only after responding, and only from clientId: awaiting
  // clients.get(resultingClientId) before responding deadlocks a navigation, because that client
  // cannot become execution-ready until the response arrives.
  const entry = { path: url.pathname, from: null, client: e.clientId ? 'pending' : e.request.mode === 'navigate' ? 'navigation' : 'none', dest: e.request.destination };
  served.push(entry);
  e.respondWith(kind === 'engine' ? fromEngineCache(e, entry) : fromShell(e, entry));
  if (e.clientId) {
    e.waitUntil(self.clients.get(e.clientId).then(
      (c) => { entry.client = c ? c.type : 'unresolved'; },
      () => { entry.client = 'unresolved'; }));
  }
});

async function fromEngineCache(e, entry) {
  const hit = await (await caches.open(ENGINES)).match(e.request, { ignoreVary: true });
  entry.from = hit ? 'engine-cache' : 'refused-uncached';
  return hit || new Response('engine asset not cached', { status: 504, headers: { 'content-type': 'text/plain' } });
}

async function fromShell(e, entry) {
  const hit = await caches.match(e.request, { cacheName: SHELL, ignoreVary: true });
  entry.from = hit ? 'shell-cache' : 'network';
  return hit || fetch(e.request);
}

function hex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function fill(build) {
  const t0 = Date.now();
  const manifest = await (await fetch(`/b/${build}/manifest.json`, { cache: 'no-store' })).json();
  const cache = await caches.open(ENGINES);
  const result = { filled: 0, skipped: 0, bytes: 0, rejected: [], ms: 0 };
  const items = [...manifest.engines.z3.assets, ...(manifest.decoys || [])];
  for (const a of items) {
    const prior = await cache.match(a.path);
    if (prior && prior.headers.get('x-ss-sha256') === a.sha256) { result.skipped++; continue; }
    const res = await fetch(a.path, { cache: 'no-store' });
    const buf = await res.arrayBuffer();
    const got = hex(await crypto.subtle.digest('SHA-256', buf));
    if (!res.ok || got !== a.sha256) {
      result.rejected.push({ path: a.path, status: res.status, expected: a.sha256.slice(0, 16), got: got.slice(0, 16) });
      continue;
    }
    await cache.put(a.path, new Response(buf, {
      status: 200,
      headers: { 'content-type': a.type, 'content-length': String(buf.byteLength), 'x-ss-sha256': got },
    }));
    result.filled++;
    result.bytes += buf.byteLength;
  }
  result.ms = Date.now() - t0;
  return result;
}

async function evict() {
  const names = await caches.keys();
  for (const n of names) await caches.delete(n);
  return { deleted: names };
}

self.addEventListener('message', (e) => {
  const port = e.ports && e.ports[0];
  const m = e.data;
  if (!port || !m || (e.origin && e.origin !== self.location.origin)) return;
  let work;
  if (m.t === 'fill') work = fill(String(m.build));
  else if (m.t === 'log') work = Promise.resolve({ instance, served: served.splice(0) });
  else if (m.t === 'evict') work = evict();
  else return;
  e.waitUntil(work.then((r) => port.postMessage(r), (err) => port.postMessage({ error: String(err).slice(0, 300) })));
});
