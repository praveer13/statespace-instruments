// W0-S01 instrument host (stands in for https://instruments.<course-domain>/b/<buildId>/host.html).
// Origin checks and the handshake follow ARCHITECTURE.md sections 5.3 and 5.5; consent follows
// section 5.9; the engine cache follows section 15.4. Spike code, not product code: it carries
// extra probes (storage, cookies, document.domain, top navigation) that the product never would.

const ALLOWED_PARENTS = ["https://statespace.play.naigap.com"]; // build-time list; a production build holds only the main origin
const BUILD = '3d82589a539b';
const ENGINE = 'z3';
const ENGINE_VERSION = '5.3.1';
const CONSENT_BYTES = 5000000; // OD-6: ask before a first load above 5 MB [D]
const ENGINE_CACHE = 'ss-engines-v1';
// Top-navigation probe targets, chosen by key and fixed at build time: a message never names a URL.
const TOPNAV_TARGETS = { 'main-origin': new URL('/navigated.html', ALLOWED_PARENTS[0]).href, 'cross-site': '' || null };

const swApi = 'serviceWorker' in navigator;
const state = {
  build: BUILD,
  origin: location.origin,
  topLevel: window.parent === window,
  swApi,
  controlledAtLoad: swApi ? !!navigator.serviceWorker.controller : false,
  ancestorOrigins: 'ancestorOrigins' in location ? Array.from(location.ancestorOrigins) : 'unsupported',
  referrer: document.referrer,
  refused: null,
  adopted: false,
  rejectedWindowMessages: [],
  cspViolations: [],
  sw: null,
  controllerChanges: 0,
};
window.__hostState = state; // read by the harness through Playwright; the parent cannot reach it

document.addEventListener('securitypolicyviolation', (e) => {
  state.cspViolations.push({ directive: e.violatedDirective, blocked: String(e.blockedURI).slice(0, 120) });
});

let resolveControlled;
const controlled = new Promise((r) => { resolveControlled = r; });
let port = null;
let worker = null;
let manifestPromise = null;

if (state.topLevel) {
  state.refused = 'top-level';
  document.getElementById('notice').textContent =
    'This page belongs to the statespace course and does nothing on its own.';
} else if (Array.isArray(state.ancestorOrigins) && state.ancestorOrigins.length > 0 &&
           state.ancestorOrigins[0] !== 'null' && !ALLOWED_PARENTS.includes(state.ancestorOrigins[0])) {
  // Defense in depth where the property exists. A masked entry ("null") is recorded, not refused,
  // so the spike can report how each engine fills it under referrerpolicy="no-referrer".
  state.refused = 'ancestor-origin';
} else {
  window.addEventListener('message', onWindowMessage);
  for (const o of ALLOWED_PARENTS) window.parent.postMessage({ t: 'hello', bus: 1, build: BUILD }, o);
  // The service worker is registered only after a handshake with an allowed parent (below), so a
  // hostile embedder causes no side effect. A registration from an earlier session still controls
  // this page from its first request; controlledAtLoad records that.
}

async function registerServiceWorker() {
  if (!swApi) { state.sw = { registered: false, error: 'no navigator.serviceWorker' }; resolveControlled(false); return; }
  if (navigator.serviceWorker.controller) resolveControlled(true);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    state.controllerChanges++;
    resolveControlled(true);
  });
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    state.sw = { registered: true, scope: reg.scope };
  } catch (e) {
    state.sw = { registered: false, error: `${e.name}: ${e.message}`.slice(0, 240) };
    resolveControlled(false);
  }
}

function waitControlled(ms) {
  return Promise.race([
    controlled,
    new Promise((r) => setTimeout(() => r(swApi && !!navigator.serviceWorker.controller), ms)),
  ]);
}

function onWindowMessage(e) {
  if (port) {
    // After the handshake, window messages are ignored unread; only the origin is noted.
    state.rejectedWindowMessages.push({ origin: e.origin, reason: 'already-adopted', ports: e.ports.length });
    return;
  }
  const d = e.data;
  const reasons = [];
  if (!ALLOWED_PARENTS.includes(e.origin)) reasons.push('origin');
  if (e.source !== window.parent) reasons.push('source');
  if (!d || d.t !== 'connect' || d.bus !== 1) reasons.push('shape');
  else if (d.build !== BUILD) reasons.push('build');
  if (e.ports.length !== 1) reasons.push('ports');
  if (reasons.length) {
    state.rejectedWindowMessages.push({ origin: e.origin, reason: reasons.join('+'), ports: e.ports.length });
    return;
  }
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
      case 'warm': reply = await warm(m); break;
      case 'peek': reply = { t: 'result', id: m.id, reply: await peek() }; break;
      case 'run': reply = await run(m); break;
      case 'probe': reply = { t: 'result', id: m.id, reply: await probe(String(m.token || '')) }; break;
      case 'diag': reply = { t: 'result', id: m.id, reply: await diag() }; break;
      case 'evict': reply = { t: 'result', id: m.id, reply: await evict() }; break;
      case 'domainprobe': reply = { t: 'result', id: m.id, reply: domainProbe() }; break;
      case 'topnav': reply = { t: 'result', id: m.id, reply: topnav(Number(m.delayMs) || 0, String(m.target)) }; break;
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
  try {
    const cache = await caches.open(ENGINE_CACHE);
    for (const a of eng.assets) {
      const r = await cache.match(a.path);
      if (r && r.headers.get('x-ss-sha256') === a.sha256) cachedCount++;
    }
  } catch (err) {
    cacheError = `${err.name}: ${err.message}`.slice(0, 200);
  }
  const cached = cachedCount === eng.assets.length;
  return {
    engine: ENGINE, version: ENGINE_VERSION, cached, cachedCount, assetCount: eng.assets.length,
    firstLoadBytes: eng.bytes, needsConsent: !cached && eng.bytes > CONSENT_BYTES, cacheError,
  };
}

function swCall(msg, ms = 180000) {
  return new Promise((resolve) => {
    const ctl = swApi && navigator.serviceWorker.controller;
    if (!ctl) { resolve({ error: 'no-controller' }); return; }
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve({ error: 'sw-timeout' }), ms);
    ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
    ctl.postMessage(msg, [ch.port2]);
  });
}

// Before the cache is filled, an engine asset must come back as the worker's 504, never from the network.
async function peek() {
  const controlledNow = await waitControlled(20000);
  const a = (await manifest()).engines[ENGINE].assets[0];
  const res = await fetch(a.path, { cache: 'no-store' });
  return { controlled: controlledNow, path: a.path, status: res.status, fromEngineCache: !!res.headers.get('x-ss-sha256') };
}

async function warm(m) {
  const c = await caps();
  if (c.cached) return { t: 'result', id: m.id, reply: { alreadyCached: true } };
  if (c.needsConsent && m.consent !== true) return fail(m, 'consent-required', `${c.firstLoadBytes} bytes`);
  if (!(await waitControlled(20000))) return fail(m, 'engine-crashed', 'the service worker does not control the host');
  return { t: 'result', id: m.id, reply: await swCall({ t: 'fill', build: BUILD }) };
}

async function run(m) {
  const req = m.req || {};
  if (req.engine !== ENGINE) return fail(m, 'unknown-engine', req.engine);
  if (req.version !== ENGINE_VERSION) return fail(m, 'version-mismatch', req.version);
  // The supervisor starts an engine only once the service worker controls the page (section 15.4).
  if (!(await waitControlled(20000))) return fail(m, 'engine-crashed', 'the service worker does not control the host');
  let c = await caps();
  if (!c.cached) {
    if (c.needsConsent && m.consent !== true) return fail(m, 'consent-required', `${c.firstLoadBytes} bytes`);
    const w = await warm({ id: m.id, consent: m.consent });
    if (w.t === 'error') return w;
    c = await caps();
    if (!c.cached) return fail(m, 'engine-crashed', 'engine cache fill incomplete');
  }
  const budget = req.budget || {};
  const t0 = performance.now();
  const out = await workerCall({ t: 'run', rlimit: budget.rlimit }, budget.wallMs || 120000);
  if (out.error) return { ...fail(m, out.error, out.detail), fetchLog: out.fetchLog || null };
  return {
    t: 'result', id: m.id,
    reply: {
      verdict: out.verdict, witness: out.witness,
      stats: { ...out.stats, hostMs: Math.round(performance.now() - t0) },
      provenance: { engine: ENGINE, version: ENGINE_VERSION, build: BUILD, budget },
      line: out.line, witnessOk: out.witnessOk, fetchLog: out.fetchLog,
    },
  };
}

function workerCall(msg, wallMs) {
  return new Promise((resolve) => {
    if (!worker) worker = new Worker('./worker.mjs', { type: 'module' });
    const w = worker;
    const timer = setTimeout(() => {
      w.terminate(); worker = null;
      resolve({ error: 'terminated', detail: `wall-clock watchdog at ${wallMs} ms` });
    }, wallMs);
    w.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
    w.onerror = (e) => {
      clearTimeout(timer); e.preventDefault(); w.terminate(); worker = null;
      resolve({ error: 'engine-crashed', detail: String(e.message || 'worker error') });
    };
    w.postMessage(msg);
  });
}

async function probe(token) {
  const attempt = (f) => {
    try { const v = f(); return { threw: null, value: v == null ? String(v) : String(v).slice(0, 60) }; }
    catch (err) { return { threw: err.name }; }
  };
  const r = {};
  r.parentLocalStorage = attempt(() => window.parent.localStorage.getItem('ss-evidence-marker'));
  r.parentDocumentCookie = attempt(() => window.parent.document.cookie);
  r.parentIndexedDB = attempt(() => typeof window.parent.indexedDB.open);
  r.ownLocalStorageHasToken = (localStorage.getItem('ss-evidence-marker') || '').includes(token);
  r.ownSessionStorageHasToken = (sessionStorage.getItem('ss-evidence-marker') || '').includes(token);
  // Listing only: opening the parent's database name here would create one on this origin.
  r.idbDatabases = typeof indexedDB.databases === 'function'
    ? (await indexedDB.databases()).map((d) => d.name) : 'unsupported';
  r.cacheNames = await caches.keys();
  r.mainShellCacheVisible = r.cacheNames.includes('main-shell');
  const cookies = document.cookie;
  r.cookieNames = cookies ? cookies.split('; ').map((s) => s.split('=')[0]) : [];
  r.hostOnlyCookieVisible = cookies.includes(`ss_host=${token}`);
  r.domainCookieVisible = cookies.includes(`ss_domain=${token}`);
  r.worker = await workerCall({ t: 'probe' }, 30000);
  return r;
}

function domainProbe() {
  // Can the instrument origin relax document.domain on its own and reach the parent? It must not.
  const parentHost = new URL(ALLOWED_PARENTS[0]).hostname;
  const r = { before: document.domain };
  if (!location.hostname.endsWith(`.${parentHost}`)) { r.attempt = 'not-applicable'; return r; }
  try { document.domain = parentHost; r.attempt = 'no-throw'; } catch (err) { r.attempt = err.name; }
  r.after = document.domain;
  try { r.parentDocumentAfter = typeof window.parent.document.cookie; } catch (err) { r.parentDocumentAfter = err.name; }
  return r;
}

const activation = () => (navigator.userActivation
  ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive }
  : 'unsupported');

function topnav(delayMs, key) {
  // Can the frame navigate the top-level page on its own? The attempt waits delayMs, past the
  // transient-activation window, so a harness evaluate on the parent cannot lend it a gesture.
  const target = TOPNAV_TARGETS[key];
  if (!target) return { scheduled: false, reason: `no target for ${key}` };
  state.topnav = { target: key, scheduledFor: delayMs, frameActivationAtRequest: activation() };
  setTimeout(() => {
    state.topnav.frameActivationAtAttempt = activation();
    try { window.top.location.href = target; state.topnav.threw = null; }
    catch (err) { state.topnav.threw = err.name; state.topnav.message = String(err.message).slice(0, 160); }
  }, delayMs);
  return { scheduled: true, delayMs, frameActivationAtRequest: state.topnav.frameActivationAtRequest };
}

async function diag() {
  const reg = swApi ? await navigator.serviceWorker.getRegistration('/') : null;
  const cacheSummary = {};
  for (const n of await caches.keys()) {
    const c = await caches.open(n);
    const keys = await c.keys();
    let bytes = 0;
    for (const k of keys) {
      const res = await c.match(k);
      bytes += Number(res.headers.get('content-length') || 0);
    }
    cacheSummary[n] = { entries: keys.length, bytes };
  }
  let estimate = null;
  let persisted = null;
  try { const e = await navigator.storage.estimate(); estimate = { usage: e.usage, quota: e.quota }; } catch (err) { estimate = err.name; }
  try { persisted = await navigator.storage.persisted(); } catch (err) { persisted = err.name; }
  const swLog = swApi && navigator.serviceWorker.controller ? await swCall({ t: 'log' }, 10000) : null;
  return {
    ...state,
    controlledNow: swApi ? !!navigator.serviceWorker.controller : false,
    registration: reg ? { scope: reg.scope, active: reg.active ? reg.active.state : null, waiting: !!reg.waiting, installing: !!reg.installing } : null,
    caches: cacheSummary, estimate, persisted, swLog,
  };
}

async function evict() {
  const sw = swApi && navigator.serviceWorker.controller ? await swCall({ t: 'evict' }) : { error: 'no-controller' };
  let unregistered = null;
  try {
    const reg = swApi ? await navigator.serviceWorker.getRegistration('/') : null;
    unregistered = reg ? await reg.unregister() : 'no-registration';
  } catch (err) { unregistered = err.name; }
  return { sw, unregistered, cacheNamesAfter: await caches.keys() };
}
