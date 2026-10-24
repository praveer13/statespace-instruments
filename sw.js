// W0-S02 instrument-origin service worker (ARCHITECTURE.md sections 15.4 and 16).
// Adapted from scripts/spikes/W0-S01/site/instruments/sw.js, with one addition: the fill reports, for
// every engine file, the time to the response headers, to the whole body, to the SHA-256 and to the
// cache write, and the byte counts the browser reports (Resource Timing, and the Content-Length header).
// - Engine assets (any path under /b/<build>/engines/) are served only from the engine cache; an
//   uncached engine asset gets 504 and never falls through to the network.
// - The engine cache is filled only on request (after consent), only with bytes whose SHA-256 matches
//   the build manifest, and each entry carries the verified hash in x-ss-sha256.
// - The build shell (host page, scripts, manifest) is precached at install: small, no consent needed.
// Spike code, not product code.

const BUILD = '96137b0f594f';
const SHELL = `ss-shell-${BUILD}`;
const ENGINES = 'ss-engines-v1';
const SHELL_FILES = [
  `/b/${BUILD}/host.html`, `/b/${BUILD}/host.js`, `/b/${BUILD}/worker.mjs`, `/b/${BUILD}/cases.mjs`, `/b/${BUILD}/manifest.json`,
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
  const entry = { path: url.pathname.split('/').slice(-1)[0], from: null, dest: e.request.destination };
  served.push(entry);
  e.respondWith(kind === 'engine' ? fromEngineCache(e, entry) : fromShell(e, entry));
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

const r1 = (v) => Math.round(v * 10) / 10;
const resourceEntry = (href) => {
  try {
    const list = performance.getEntriesByName(href);
    const e = list[list.length - 1];
    return e ? { encoded: e.encodedBodySize, transfer: e.transferSize, decoded: e.decodedBodySize } : null;
  } catch { return null; }
};

async function fill(build) {
  const t0 = performance.now();
  const manifest = await (await fetch(`/b/${build}/manifest.json`, { cache: 'no-store' })).json();
  const cache = await caches.open(ENGINES);
  const result = { instance, filled: 0, skipped: 0, bytes: 0, wire_content_length: 0, rejected: [], files: [], ms: 0 };
  for (const a of manifest.engines.z3.assets) {
    const prior = await cache.match(a.path);
    if (prior && prior.headers.get('x-ss-sha256') === a.sha256) { result.skipped++; continue; }
    const f = { file: a.path.split('/').slice(-1)[0], expected_bytes: a.bytes };
    const t1 = performance.now();
    const res = await fetch(a.path, { cache: 'no-store' });
    const t2 = performance.now();
    const buf = await res.arrayBuffer();
    const t3 = performance.now();
    const got = hex(await crypto.subtle.digest('SHA-256', buf));
    const t4 = performance.now();
    Object.assign(f, {
      status: res.status, content_encoding: res.headers.get('content-encoding'),
      content_length: res.headers.has('content-length') ? Number(res.headers.get('content-length')) : null,
      bytes: buf.byteLength, resource_timing: resourceEntry(new URL(a.path, self.location.href).href),
    });
    if (!res.ok || got !== a.sha256) {
      result.rejected.push({ path: f.file, status: res.status, expected: a.sha256.slice(0, 16), got: got.slice(0, 16) });
      result.files.push(f);
      continue;
    }
    await cache.put(a.path, new Response(buf, {
      status: 200,
      headers: { 'content-type': a.type, 'content-length': String(buf.byteLength), 'x-ss-sha256': got },
    }));
    const t5 = performance.now();
    Object.assign(f, { headers_ms: r1(t2 - t1), body_ms: r1(t3 - t2), hash_ms: r1(t4 - t3), put_ms: r1(t5 - t4), total_ms: r1(t5 - t1) });
    result.files.push(f);
    result.filled++;
    result.bytes += buf.byteLength;
    if (f.content_length) result.wire_content_length += f.content_length;
  }
  result.ms = r1(performance.now() - t0);
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
  // A heartbeat from the host during a long fill (host.js, warm): that it arrives is all it does. Firefox stopped the worker
  // about a minute into a long fill when no other message came; with this heartbeat it did not (decision record, 4.8).
  if (m && m.t === 'beat') return;
  if (!port || !m || (e.origin && e.origin !== self.location.origin)) return;
  let work;
  if (m.t === 'fill') work = fill(String(m.build));
  else if (m.t === 'ping') work = Promise.resolve({ instance, age_ms: Math.round(performance.now()) }); // a new instance id means the worker was stopped and started again
  else if (m.t === 'log') work = Promise.resolve({ instance, served: served.splice(0) });
  else if (m.t === 'evict') work = evict();
  else return;
  e.waitUntil(work.then((r) => port.postMessage(r), (err) => port.postMessage({ error: String(err).slice(0, 300) })));
});
