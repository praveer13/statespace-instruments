// Retires the W0-S02 spike service worker (scope /). The instrument host no longer uses a service worker; engine
// files are fetched, SHA-256-checked and cached by the engine workers themselves (apps/instruments/src/workers/shared).
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('ss-shell-')) await caches.delete(k)
    await self.registration.unregister()
  })())
})
