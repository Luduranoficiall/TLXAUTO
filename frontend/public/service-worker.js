/*
  Service Worker mínimo (cache simples).
  Observação: em DEV pode atrapalhar atualizações por cache.
  Se isso acontecer, limpe o SW no navegador (Application > Service Workers).
*/

const CACHE_NAME = 'tlxauto-cache-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)

  // Nunca cachear API
  if (url.pathname.startsWith('/api/')) return

  // Só GET
  if (req.method !== 'GET') return

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      const cached = await cache.match(req)
      if (cached) return cached

      const res = await fetch(req)
      // Cacheia apenas respostas OK e do mesmo origin
      if (res.ok && url.origin === self.location.origin) {
        cache.put(req, res.clone())
      }
      return res
    })(),
  )
})
