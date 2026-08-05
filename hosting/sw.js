// Minimal service worker — exists to satisfy PWA installability and give
// truly static sub-resources a basic offline cache. Deliberately
// conservative: navigation requests (the HTML document itself) are NEVER
// intercepted — a buggy fetch handler on a navigation request can turn
// into a broken "can't load this page" for the whole app. Firestore/Auth
// network calls, fonts, and gstatic SDK scripts are also left untouched
// (cross-origin, and Firestore needs direct passthrough for its realtime
// streaming connections).
//
// js/medical.js is deliberately NOT cache-first — it's actively-developed
// game logic, not a static asset. A cache-first entry here would silently
// pin a player to whatever treatment rules existed the first time they
// loaded the page, with no error and no way to tell — exactly what
// happened during development (a real bug, found live: after deploying an
// update, this SW kept serving the pre-update medical.js from cache
// forever, so new event-logging code never ran, with zero errors thrown).
// Network-first with a cache fallback (for offline use only) fixes it.
const CACHE = 'helios-mobile-v2'
const STATIC = ['manifest.json', 'icons/icon-192.png', 'icons/icon-512.png']
const NETWORK_FIRST = ['js/medical.js']

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.all(STATIC.map(url => c.add(url).catch(() => {}))))
  )
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  )
  self.clients.claim()
})

self.addEventListener('fetch', e => {
  const req = e.request
  const url = new URL(req.url)
  if (req.mode === 'navigate') return // never touch document loads
  if (req.method !== 'GET' || url.origin !== self.location.origin) return
  const matches = list => list.some(p => url.pathname.endsWith('/' + p) || url.pathname === '/' + p)

  if (matches(NETWORK_FIRST)) {
    e.respondWith(
      fetch(req).then(resp => {
        const copy = resp.clone()
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {})
        return resp
      }).catch(() => caches.match(req))
    )
    return
  }
  if (!matches(STATIC)) return
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(resp => {
      const copy = resp.clone()
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {})
      return resp
    }))
  )
})
