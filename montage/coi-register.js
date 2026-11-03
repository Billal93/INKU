// Enregistre le service worker du Montage et recharge UNE fois pour activer l'isolation cross-origin.
// Le SW et sa portée sont résolus par rapport à CE script (montage/), quelle que soit la page qui l'inclut
// (studio.html, bench/*.html) : la portée reste toujours /montage/, jamais le site principal.
(function () {
  if (window.crossOriginIsolated) return;
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  var KEY = 'inku-montage-coi-reload';
  var here = /** @type {HTMLScriptElement} */ (document.currentScript).src;
  var swUrl = new URL(/[?&]offline-test/.test(location.search) ? 'sw.js?cache=1' : 'sw.js', here).href;
  navigator.serviceWorker.register(swUrl, { scope: new URL('./', here).href }).then(function (reg) {
    var go = function () {
      if (!window.crossOriginIsolated && !sessionStorage.getItem(KEY)) { sessionStorage.setItem(KEY, '1'); location.reload(); }
    };
    if (reg.active && navigator.serviceWorker.controller) go();
    else navigator.serviceWorker.addEventListener('controllerchange', go);
    if (reg.installing) reg.installing.addEventListener('statechange', function (e) { if (/** @type {ServiceWorker} */ (e.target).state === 'activated') go(); });
  }).catch(function (e) { console.warn('[montage] service worker indisponible :', e && e.message); });
})();
