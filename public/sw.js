const CACHE = "automabaca-static-v3";
const PRECACHE = ["/pwa-icon-192.png", "/pwa-icon-512.png", "/pwa-icon-maskable-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("automabaca-static-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Só fontes e ícones, rede primeiro. Os chunks de /_next/static ficam com o
// cache HTTP imutável do Next: guardados aqui, cada release acumularia os seus
// no aparelho sem que nada os apagasse.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const isMutableStatic = url.pathname.startsWith("/fonts/") ||
    url.pathname.startsWith("/sports-icons/") ||
    url.pathname.startsWith("/pwa-icon-");
  if (!isMutableStatic) return;
  event.respondWith(fetch(request).then((response) => {
    if (!response.ok || response.type !== "basic") return response;
    const copy = response.clone();
    event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
    return response;
  }).catch(() => caches.match(request).then((cached) => cached || Response.error())));
});
