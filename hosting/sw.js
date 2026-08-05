// Minimal service worker — exists to satisfy PWA installability and give
// static sub-resources a basic offline cache. Deliberately conservative:
// navigation requests (the HTML document itself) are NEVER intercepted —
// a buggy fetch handler on a navigation request can turn into a broken
// "can't load this page" for the whole app, which is a much worse failure
// than just not caching the HTML. Firestore/Auth network calls, fonts, and
// gstatic SDK scripts are also left untouched (cross-origin, and Firestore
// needs direct passthrough for its realtime streaming connections).
const CACHE = 'helios-mobile-v1'
const SHELL = ['manifest.json', 'js/medical.js', 'icons/icon-192.png', 'icons/icon-512.png']

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.all(SHELL.map(url => c.add(url).catch(() => {}))))
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
  if (!SHELL.some(p => url.pathname.endsWith('/' + p) || url.pathname === '/' + p)) return
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(resp => {
      const copy = resp.clone()
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {})
      return resp
    })).catch(() => caches.match(req))
  )
})
