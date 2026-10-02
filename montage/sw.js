// Service worker du Montage : ajoute COOP/COEP aux réponses pour obtenir l'isolation cross-origin
// (SharedArrayBuffer, WASM multi-thread) sur un hébergement qui ne permet pas de définir ces en-têtes
// (GitHub Pages). Même principe que coi-serviceworker (MIT). Le cache hors-ligne sera ajouté en phase 1.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const r = event.request;
  if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
  event.respondWith(
    fetch(r).then((resp) => {
      if (resp.status === 0) return resp;
      const h = new Headers(resp.headers);
      h.set('Cross-Origin-Embedder-Policy', 'require-corp');
      h.set('Cross-Origin-Opener-Policy', 'same-origin');
      h.set('Cross-Origin-Resource-Policy', 'same-site');
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
    }).catch((err) => { console.error('[sw]', err); return Response.error(); })
  );
});
