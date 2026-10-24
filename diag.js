// W0-S01: opened top-level on the instrument origin, this page reports what the origin's
// first-party storage holds. Compared with what the framed host saw, it shows whether the
// browser keys the framed origin's storage separately (storage partitioning). Spike only.
'use strict';

async function report() {
  const out = { origin: location.origin };
  out.cacheNames = await caches.keys();
  out.engineCacheEntries = out.cacheNames.includes('ss-engines-v1')
    ? (await (await caches.open('ss-engines-v1')).keys()).length : 0;
  if ('serviceWorker' in navigator) {
    out.controlled = !!navigator.serviceWorker.controller;
    out.registrations = (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope);
  } else {
    out.controlled = false;
    out.registrations = 'no navigator.serviceWorker';
  }
  return out;
}

window.__diag = report().catch((err) => ({ error: `${err.name}: ${err.message}` }));
