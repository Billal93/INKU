// Service worker du Montage, limité au dossier /montage/ (jamais au site principal) :
// 1. ajoute COOP/COEP aux réponses pour obtenir l'isolation cross-origin (SharedArrayBuffer, WASM
//    multi-thread) sur GitHub Pages, qui ne permet pas de définir ces en-têtes (principe de coi-serviceworker, MIT) ;
// 2. met l'application en cache pour un fonctionnement hors ligne (PWA). Les modèles d'IA ne passent
//    pas par ici : ils sont vérifiés et stockés dans l'OPFS par speech/models.js.
// VERSION est réécrit par tools/montage-precache.mjs à chaque changement de fichier : nouvelle version = nouveau cache.
/** @type {string} */
const VERSION = '9a441b2546bd';
const CACHE = 'inku-montage-' + VERSION;
// En développement local, pas de cache (sinon les fichiers modifiés seraient servis périmés), sauf test hors ligne.
const USE_CACHE = VERSION !== 'dev' && (location.hostname !== 'localhost' || new URL(location.href).searchParams.has('cache'));
const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));

/** @param {Response} resp */
function isolate(resp) {
  if (resp.status === 0 || resp.type === 'opaque') return resp;
  const h = new Headers(resp.headers);
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Resource-Policy', 'same-site');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

sw.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    if (USE_CACHE) {
      try {
        const list = await (await fetch('precache.json', { cache: 'no-cache' })).json();
        const c = await caches.open(CACHE);
        await c.addAll(list.files.map((/** @type {string} */ f) => new Request(f, { cache: 'no-cache' })));
      } catch (err) { console.warn('[sw] pré-cache incomplet', err); }
    }
    await sw.skipWaiting();
  })());
});

sw.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('inku-montage-') && k !== CACHE) await caches.delete(k);
    await sw.clients.claim();
  })());
});

sw.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
  const url = new URL(r.url);
  const sameOrigin = url.origin === location.origin;
  e.respondWith((async () => {
    // Cache d'abord pour les fichiers de l'application (même origine, GET), réseau sinon.
    if (sameOrigin && r.method === 'GET' && USE_CACHE) {
      const hit = await caches.match(r, { ignoreSearch: true, cacheName: CACHE });
      if (hit) return isolate(hit);
    }
    try {
      return isolate(await fetch(r));
    } catch (err) {
      const hit = sameOrigin ? await caches.match(r, { ignoreSearch: true }) : null;
      if (hit) return isolate(hit);
      console.error('[sw]', err);
      return Response.error();
    }
  })());
});
