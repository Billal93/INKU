// Enregistre le service worker et recharge UNE fois pour activer l'isolation cross-origin.
(function () {
  if (window.crossOriginIsolated) return;
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  var KEY = 'inku-montage-coi-reload';
  navigator.serviceWorker.register('sw.js', { scope: './' }).then(function (reg) {
    var go = function () {
      if (!window.crossOriginIsolated && !sessionStorage.getItem(KEY)) { sessionStorage.setItem(KEY, '1'); location.reload(); }
    };
    if (reg.active && navigator.serviceWorker.controller) go();
    else navigator.serviceWorker.addEventListener('controllerchange', go);
    if (reg.installing) reg.installing.addEventListener('statechange', function (e) { if (e.target.state === 'activated') go(); });
  }).catch(function (e) { console.warn('[montage] service worker indisponible :', e && e.message); });
})();
