// W0-S02 instrument host (stands in for https://instruments.<course-domain>/b/<buildId>/host.html).
// Adapted from scripts/spikes/W0-S01/site/instruments/b/BUILD/host.js: the handshake, origin checks,
// consent gate and engine cache follow ARCHITECTURE.md sections 5.3, 5.5, 5.9 and 15.4 with W0-S01's
// amendments (the ancestorOrigins rule, the service worker registered after the handshake); the
// probes of W0-S01 are replaced by measurements for phones: environment, per-file fill timings,
// worker phases and cases, memory, and the storage state a later session finds.
// Where the browser has no service worker or Cache API (an insecure context, for example a phone
// reaching a laptop over the local network), the host says so and warms the HTTP cache instead.
// Spike code, not product code.

const ALLOWED = ["https://statespace.play.naigap.com"]; // an array of origins (a production build holds only the main origin), or "auto"
const MAIN_PORT = '8097';
const BUILD = '96137b0f594f';
const ENGINE = 'z3';
const ENGINE_VERSION = '5.3.1';
const CONSENT_BYTES = 5000000; // OD-6: ask before a first load above 5 MB [D]
const ENGINE_CACHE = 'ss-engines-v1';
const MARKER_KEY = 'w0s02.frame-marker';
const BEAT_MS = 15000; // the fill's heartbeat to the service worker, well under the minute after which Firefox stopped it without one (decision record, 4.8); no other period was tried

// "auto" derives the one allowed parent from this page's own host name: for a laptop on the local network
// and for localhost, where the host name is not known when the site is built. The check is as strict as a
// fixed list: scheme, host and port must all match.
const ALLOWED_PARENTS = Array.isArray(ALLOWED) ? ALLOWED : [`${location.protocol}//${location.hostname}:${MAIN_PORT}`];

const swApi = 'serviceWorker' in navigator;
const cacheApi = typeof caches !== 'undefined';
const now = () => performance.now();
const r1 = (v) => Math.round(v * 10) / 10;

const state = {
  build: BUILD,
  topLevel: window.parent === window,
  secureContext: window.isSecureContext,
  swApi,
  cacheApi,
  controlledAtLoad: swApi ? !!navigator.serviceWorker.controller : false,
  refused: null,
  adopted: false,
  cspViolations: [],
  sw: null,
};
window.__hostState = state;

document.addEventListener('securitypolicyviolation', (e) => {
  let blocked = String(e.blockedURI);
  try { blocked = new URL(e.blockedURI).pathname; } catch { /* a keyword such as eval or inline */ }
  state.cspViolations.push({ directive: e.violatedDirective, blocked: blocked.slice(0, 120) });
});

let resolveControlled;
const controlled = new Promise((r) => { resolveControlled = r; });
let port = null;
let worker = null;
let manifestPromise = null;

if (state.topLevel) {
  state.refused = 'top-level';
  document.getElementById('notice').textContent = 'This page belongs to the statespace course and does nothing on its own.';
} else {
  const first = 'ancestorOrigins' in location && location.ancestorOrigins.length ? location.ancestorOrigins[0] : null;
  if (first && first !== 'null' && !ALLOWED_PARENTS.includes(first)) {
    state.refused = 'ancestor-origin'; // W0-S01 decision: refuse a real origin outside the list; "null" is unknown
  } else {
    window.addEventListener('message', onWindowMessage);
    for (const o of ALLOWED_PARENTS) window.parent.postMessage({ t: 'hello', bus: 1, build: BUILD }, o);
  }
}

async function registerServiceWorker() {
  if (!swApi) { state.sw = { registered: false, error: 'no navigator.serviceWorker' }; resolveControlled(false); return; }
  if (navigator.serviceWorker.controller) resolveControlled(true);
  navigator.serviceWorker.addEventListener('controllerchange', () => resolveControlled(true));
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    state.sw = { registered: true };
    state.swRegisteredAt = r1(now());
    return reg;
  } catch (e) {
    state.sw = { registered: false, error: `${e.name}: ${e.message}`.slice(0, 240) };
    resolveControlled(false);
  }
}

function waitControlled(ms) {
  if (!swApi) return Promise.resolve(false);
  return Promise.race([controlled, new Promise((r) => setTimeout(() => r(!!navigator.serviceWorker.controller), ms))]);
}

function onWindowMessage(e) {
  if (port) return; // after the handshake, window messages are ignored unread
  const d = e.data;
  const ok = ALLOWED_PARENTS.includes(e.origin) && e.source === window.parent && d && d.t === 'connect' &&
    d.bus === 1 && d.build === BUILD && e.ports.length === 1;
  if (!ok) return;
  port = e.ports[0];
  state.adopted = true;
  port.onmessage = onPortMessage;
  registerServiceWorker();
  caps().then((c) => port.postMessage({ t: 'ready', engines: [c] }));
}

const fail = (m, code, detail = '') => ({ t: 'error', id: m.id, code, detail: String(detail).slice(0, 500) });

async function onPortMessage(e) {
  const m = e.data;
  if (!m || typeof m.id !== 'string' || typeof m.t !== 'string') return;
  let reply;
  try {
    switch (m.t) {
      case 'caps': reply = { t: 'result', id: m.id, reply: await caps() }; break;
      case 'env': reply = { t: 'result', id: m.id, reply: await env() }; break;
      case 'warm': reply = await warm(m); break;
      case 'run': reply = await consentGate(m); break;
      case 'w': reply = await workerCall(m); break;
      case 'wterm': reply = { t: 'result', id: m.id, reply: terminateWorker() }; break;
      case 'diag': reply = { t: 'result', id: m.id, reply: await diag() }; break;
      case 'marker': reply = { t: 'result', id: m.id, reply: marker(m) }; break;
      case 'persist': reply = { t: 'result', id: m.id, reply: await persist() }; break;
      case 'evict': reply = { t: 'result', id: m.id, reply: await evict() }; break;
      default: reply = fail(m, 'bad-message', `unknown t: ${m.t}`);
    }
  } catch (err) {
    reply = fail(m, 'engine-crashed', (err && (err.stack || err.message)) || err);
  }
  port.postMessage(reply);
}

function manifest() {
  if (!manifestPromise) manifestPromise = fetch('./manifest.json').then((r) => r.json());
  return manifestPromise;
}

async function caps() {
  const m = await manifest();
  const eng = m.engines[ENGINE];
  let cachedCount = 0;
  let cacheError = null;
  if (cacheApi) {
    try {
      const cache = await caches.open(ENGINE_CACHE);
      for (const a of eng.assets) {
        const r = await cache.match(a.path);
        if (r && r.headers.get('x-ss-sha256') === a.sha256) cachedCount++;
      }
    } catch (err) { cacheError = `${err.name}: ${err.message}`.slice(0, 200); }
  } else {
    cacheError = 'no Cache API (insecure context)';
  }
  const cached = cachedCount === eng.assets.length;
  return {
    engine: ENGINE, version: ENGINE_VERSION, cached, cachedCount, assetCount: eng.assets.length,
    firstLoadBytes: eng.wireBytes, firstLoadRawBytes: eng.bytes, needsConsent: !cached && eng.wireBytes > CONSENT_BYTES, cacheError,
  };
}

function swCall(msg, ms = 600000) {
  return new Promise((resolve) => {
    const ctl = swApi && navigator.serviceWorker.controller;
    if (!ctl) { resolve({ error: 'no-controller' }); return; }
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve({ error: 'sw-timeout' }), ms);
    ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
    ctl.postMessage(msg, [ch.port2]);
  });
}

// What the browser reports about this device and this frame. No URLs, hosts or user data.
async function env() {
  const c = navigator.connection;
  let estimate = null;
  let persisted = null;
  try { const s = await navigator.storage.estimate(); estimate = { usage: s.usage, quota: s.quota }; } catch (err) { estimate = `${err.name}`; }
  try { persisted = await navigator.storage.persisted(); } catch (err) { persisted = `${err.name}`; }
  return {
    framed: !state.topLevel,
    secure_context: window.isSecureContext,
    cross_origin_isolated: window.crossOriginIsolated === true,
    sw_api: swApi,
    cache_api: cacheApi,
    hardware_concurrency: navigator.hardwareConcurrency ?? null,
    device_memory_gib: navigator.deviceMemory ?? null,
    connection: c ? { effective_type: c.effectiveType ?? null, downlink_mbps: c.downlink ?? null, rtt_ms: c.rtt ?? null, save_data: c.saveData ?? null } : null,
    performance_memory: typeof performance.memory === 'object' && !!performance.memory,
    storage_estimate: estimate,
    storage_persisted: persisted,
    controlled_at_load: state.controlledAtLoad,
    csp_violations: state.cspViolations,
  };
}

// The consent gate (OD-6), as the product would apply it: an uncached engine above the threshold is not fetched
// without consent.
async function consentGate(m) {
  const c = await caps();
  if (!c.cached && c.needsConsent && m.consent !== true) return fail(m, 'consent-required', `${c.firstLoadBytes} bytes`);
  return { t: 'result', id: m.id, reply: { allowed: true, cached: c.cached } };
}

// Fill the engine cache through the service worker; where there is none, read every file once so the HTTP
// cache holds it (the worker's fetches then do not reach the network again within max-age).
async function warm(m) {
  const c = await caps();
  if (c.cached) return { t: 'result', id: m.id, reply: { already_cached: true } };
  if (c.needsConsent && m.consent !== true) return fail(m, 'consent-required', `${c.firstLoadBytes} bytes`);
  const t0 = now();
  if (swApi && cacheApi) {
    if (!(await waitControlled(30000))) return fail(m, 'engine-crashed', 'the service worker does not control the host');
    // 'single': one message starts the whole fill, as ARCHITECTURE.md section 5.9 describes it. 'beat': the same, and the host
    // sends the worker a message every BEAT_MS while the fill runs. A worker that is stopped during the fill never answers, so
    // the instance it reports before and after tells a stop from a slow network.
    const fillMode = m.fill === 'beat' ? 'beat' : 'single';
    const before = await swCall({ t: 'ping' }, 10000);
    const ctl = navigator.serviceWorker.controller;
    const beat = fillMode === 'beat' ? setInterval(() => { try { ctl.postMessage({ t: 'beat' }); } catch { /* the worker is gone */ } }, BEAT_MS) : null;
    const rep = await swCall({ t: 'fill', build: BUILD }, Number(m.fillTimeoutMs) || 600000);
    if (beat) clearInterval(beat);
    const note = { fill_mode: fillMode, sw_instance_before: before.instance ?? null, sw_age_before_ms: before.age_ms ?? null };
    if (rep.error) {
      const after = await swCall({ t: 'ping' }, 10000);
      return { t: 'result', id: m.id, reply: { mode: 'service-worker', ...note, failed: rep.error, host_ms: r1(now() - t0), sw_instance_after: after.instance ?? null, sw_age_after_ms: after.age_ms ?? null } };
    }
    return { t: 'result', id: m.id, reply: { mode: 'service-worker', ...note, host_ms: r1(now() - t0), ...rep } };
  }
  const man = (await manifest()).engines[ENGINE];
  const files = [];
  for (const a of man.assets) {
    const t1 = now();
    const res = await fetch(a.path);
    const t2 = now();
    const buf = await res.arrayBuffer();
    const t3 = now();
    const e = performance.getEntriesByName(new URL(a.path, location.href).href).pop();
    files.push({
      file: a.path.split('/').slice(-1)[0], status: res.status, content_encoding: res.headers.get('content-encoding'),
      content_length: res.headers.has('content-length') ? Number(res.headers.get('content-length')) : null, bytes: buf.byteLength,
      resource_timing: e ? { encoded: e.encodedBodySize, transfer: e.transferSize, decoded: e.decodedBodySize } : null,
      headers_ms: r1(t2 - t1), body_ms: r1(t3 - t2), total_ms: r1(t3 - t1),
    });
  }
  return { t: 'result', id: m.id, reply: { mode: 'http-cache', host_ms: r1(now() - t0), ms: r1(now() - t0), files, filled: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) } };
}

// The worker, with the supervisor's watchdog: on expiry the worker is terminated and the next call starts a fresh one.
function workerCall(m) {
  const wallMs = Number(m.wallMs) || 120000;
  return new Promise((resolve) => {
    const spawned = !worker;
    const t0 = now();
    if (!worker) worker = new Worker('./worker.mjs', { type: 'module' });
    const w = worker;
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      w.terminate(); worker = null;
      resolve({ t: 'error', id: m.id, code: 'terminated', detail: `wall-clock watchdog at ${wallMs} ms`, host_call_ms: r1(now() - t0), spawned });
    }, wallMs);
    w.onmessage = (e) => {
      if (e.data.id !== id) return;
      clearTimeout(timer);
      const { id: _drop, ...rest } = e.data;
      resolve({ t: 'result', id: m.id, reply: { ...rest, host_call_ms: r1(now() - t0), spawned } });
    };
    w.onerror = (e) => {
      clearTimeout(timer); e.preventDefault(); w.terminate(); worker = null;
      resolve({ t: 'error', id: m.id, code: 'engine-crashed', detail: String(e.message || 'worker error'), host_call_ms: r1(now() - t0), spawned });
    };
    w.postMessage({ ...m.msg, id });
  });
}

function terminateWorker() {
  const t0 = now();
  const had = !!worker;
  if (worker) { worker.terminate(); worker = null; }
  return { had_worker: had, terminate_call_ms: r1(now() - t0) };
}

// The marker this frame leaves in its own script-written storage, to compare with the cache in a later session.
function marker(m) {
  try {
    if (m.action === 'write') {
      const prior = localStorage.getItem(MARKER_KEY);
      const rec = prior ? JSON.parse(prior) : { first_written_at: new Date().toISOString(), build: BUILD };
      rec.last_written_at = new Date().toISOString();
      localStorage.setItem(MARKER_KEY, JSON.stringify(rec));
      return { written: true, ...rec };
    }
    const prior = localStorage.getItem(MARKER_KEY);
    return prior ? { present: true, ...JSON.parse(prior) } : { present: false };
  } catch (err) { return { error: `${err.name}` }; }
}

async function persist() {
  try {
    const before = await navigator.storage.persisted();
    const granted = await navigator.storage.persist();
    return { before, granted, after: await navigator.storage.persisted() };
  } catch (err) { return { error: `${err.name}: ${String(err.message).slice(0, 120)}` }; }
}

async function diag() {
  const reg = swApi ? await navigator.serviceWorker.getRegistration('/') : null;
  const cacheSummary = {};
  if (cacheApi) {
    for (const n of await caches.keys()) {
      const c = await caches.open(n);
      const keys = await c.keys();
      let bytes = 0;
      for (const k of keys) { const res = await c.match(k); bytes += Number(res.headers.get('content-length') || 0); }
      cacheSummary[n.replace(/ss-shell-.+/, 'ss-shell-<build>')] = { entries: keys.length, bytes };
    }
  }
  let estimate = null;
  let persisted = null;
  try { const e = await navigator.storage.estimate(); estimate = { usage: e.usage, quota: e.quota }; } catch (err) { estimate = err.name; }
  try { persisted = await navigator.storage.persisted(); } catch (err) { persisted = err.name; }
  const swLog = swApi && navigator.serviceWorker.controller ? await swCall({ t: 'log' }, 10000) : null;
  return {
    controlled_at_load: state.controlledAtLoad,
    controlled_now: swApi ? !!navigator.serviceWorker.controller : false,
    registration: reg ? { active: reg.active ? reg.active.state : null, waiting: !!reg.waiting, installing: !!reg.installing } : null,
    caches: cacheSummary, storage_estimate: estimate, storage_persisted: persisted,
    sw_log: swLog && swLog.served ? { instance: swLog.instance, served: swLog.served } : swLog,
    csp_violations: state.cspViolations, marker: marker({ action: 'read' }),
  };
}

async function evict() {
  if (worker) { worker.terminate(); worker = null; }
  const sw = swApi && navigator.serviceWorker.controller ? await swCall({ t: 'evict' }, 30000) : { error: 'no-controller' };
  let unregistered = null;
  try {
    const reg = swApi ? await navigator.serviceWorker.getRegistration('/') : null;
    unregistered = reg ? await reg.unregister() : 'no-registration';
  } catch (err) { unregistered = err.name; }
  let markerCleared = null;
  try { localStorage.removeItem(MARKER_KEY); markerCleared = true; } catch (err) { markerCleared = err.name; }
  return { sw, unregistered, cache_names_after: cacheApi ? await caches.keys() : [], marker_cleared: markerCleared };
}
