// Service worker: la app funciona sin conexión. Sube VERSION al publicar cambios.
const VERSION = 'v3';
const SHELL = `anaquel-shell-${VERSION}`;
const RUNTIME = `anaquel-runtime-${VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/github.js',
  './js/library.js',
  './js/store.js',
  './js/pdfviewer.js',
  './pdfjs/pdf.min.mjs',
  './pdfjs/pdf.worker.min.mjs',
  './fonts/literata-latin-opsz-normal.woff2',
  './fonts/literata-latin-opsz-italic.woff2',
  './fonts/atkinson-hyperlegible-next-latin-400-normal.woff2',
  './fonts/atkinson-hyperlegible-next-latin-600-normal.woff2',
  './icons/icon-192.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('anaquel-') && name !== SHELL && name !== RUNTIME && name !== 'anaquel-pdfs') {
        await caches.delete(name);
      }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // la API de GitHub no pasa por aquí
  if (url.pathname.includes('/__pdf/')) return;

  // Archivos de PDF.js que se cargan bajo demanda (fuentes, cmaps, wasm): primero la caché.
  if (url.pathname.includes('/pdfjs/') || url.pathname.includes('/fonts/')) {
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(RUNTIME)).put(req, res.clone());
      return res;
    })());
    return;
  }

  // Resto de la app: la copia guardada al instante y se actualiza en segundo plano.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) {
      event.waitUntil(network);
      return hit;
    }
    const res = await network;
    if (res) return res;
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  })());
});
