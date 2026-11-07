/* Service worker: la app funciona sin conexión tras la primera visita */
const VERSION = 'slk-v1';
const SHELL = 'shell-' + VERSION;
const PHOTOS = 'photos-v1';      // las fotos no cambian: se conserva entre versiones
const RUNTIME = 'runtime-v1';    // fuentes, tiempo y cambio de moneda
const CORE = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.startsWith('shell-') && k !== SHELL).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

const isPhoto = u => u.hostname === 'upload.wikimedia.org' || u.hostname === 'commons.wikimedia.org';
const isFont = u => u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com';
const isApi = u => u.hostname === 'api.open-meteo.com' || u.hostname === 'open.er-api.com';

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Página: primero red (para recibir actualizaciones), si no hay, la guardada
  if (req.mode === 'navigate' || (url.origin === location.origin && url.pathname.endsWith('/index.html'))) {
    e.respondWith(
      fetch(req).then(r => { const copy = r.clone(); caches.open(SHELL).then(c => c.put('./index.html', copy)); return r; })
        .catch(() => caches.match('./index.html', {ignoreSearch:true}).then(r => r || caches.match('./')))
    );
    return;
  }
  // Resto de archivos propios: primero caché
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req, {ignoreSearch:true}).then(r => r || fetch(req)));
    return;
  }
  // Fotos y fuentes: primero caché, si no, red y se guarda
  if (isPhoto(url) || isFont(url)) {
    const bucket = isPhoto(url) ? PHOTOS : RUNTIME;
    e.respondWith(
      caches.open(bucket).then(c => c.match(req, {ignoreVary:true}).then(hit => hit || fetch(req).then(r => {
        if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone());
        return r;
      })))
    );
    return;
  }
  // Tiempo y cambio: primero red, si falla, el último dato guardado
  if (isApi(url)) {
    e.respondWith(
      fetch(req).then(r => { const copy = r.clone(); caches.open(RUNTIME).then(c => c.put(req, copy)); return r; })
        .catch(() => caches.open(RUNTIME).then(c => c.match(req)))
    );
  }
});

// La página pide descargar todas las fotos de golpe y recibe el progreso
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type !== 'precache-photos') return;
  const client = e.source;
  e.waitUntil(caches.open(PHOTOS).then(async c => {
    let done = 0, ok = 0;
    const total = d.items.length;
    const step = async it => {
      let got = await c.match(it.primary, {ignoreVary:true}) || (it.fallback && await c.match(it.fallback, {ignoreVary:true}));
      if (!got) {
        try {
          const r = await fetch(it.primary, {mode:'cors'});
          if (r.ok) { await c.put(it.primary, r); got = true; }
        } catch (err) {}
        if (!got && it.fallback) {
          try {
            const r2 = await fetch(it.fallback, {mode:'no-cors'});
            if (r2 && (r2.ok || r2.type === 'opaque')) { await c.put(it.fallback, r2); got = true; }
          } catch (err) {}
        }
      }
      done++; if (got) ok++;
      client && client.postMessage({type:'precache-progress', done, ok, total});
    };
    // de 4 en 4 para no saturar
    const queue = d.items.slice();
    await Promise.all(Array.from({length:4}, async () => { while (queue.length) await step(queue.shift()); }));
  }));
});
