// Accès au Montage réservé pendant les essais : mot de passe demandé avant de démarrer la page.
// Simple barrière pour les visiteurs : le site est statique et public, ce n'est PAS une vraie protection (quelqu'un
// qui lit le code peut la contourner, et le mot de passe de test figure dans tests/montage-gate.spec.js). Pas de barrière sur un
// serveur local (développement, tests), sauf avec ?gate dans l'adresse. Pour la retirer : supprimer ce fichier et sa
// balise <script> dans studio.html et autotest.html.
(function () {
  const HASH = '1db4969e2d56fac24003f6371d6ddc49a7590d3d5a14bd7e01a43eea06aec062';
  const KEY = 'inku-montage-gate';
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && !/[?&]gate\b/.test(location.search);
  let known = false;
  try { known = localStorage.getItem(KEY) === HASH; } catch (e) { /* stockage bloqué : on redemande */ }
  if (local || known) { window.__gate = Promise.resolve(); return; }

  const style = document.createElement('style');
  style.textContent = 'html.gated body > *:not(#gate){visibility:hidden}'
    + '#gate{position:fixed;top:0;right:0;bottom:0;left:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;background:#12121a;color:#f4f4f8;font-family:"Plus Jakarta Sans",system-ui,sans-serif}'
    + '#gate form{width:100%;max-width:340px;display:flex;flex-direction:column;gap:12px}'
    + '#gate h1{font-size:1.2rem;margin:0}#gate p{font-size:.85rem;margin:0;color:#a9a9b8}'
    + '#gate input{min-height:48px;font-size:16px;padding:0 12px;border-radius:12px;border:1px solid #3a3a4a;background:#1e1e2a;color:inherit}'
    + '#gate button{min-height:48px;font-size:1rem;font-weight:800;border:0;border-radius:12px;background:#d81b8c;color:#fff}'
    + '#gate .err{color:#ff7a7a;min-height:1.2em}';
  document.head.appendChild(style);
  document.documentElement.classList.add('gated');

  window.__gate = new Promise(function (resolve) {
    function show() {
      const box = document.createElement('div');
      box.id = 'gate';
      box.innerHTML = '<form><h1>Montage (bêta)</h1><p>Accès réservé pendant les essais.</p>'
        + '<input type="password" aria-label="Mot de passe" placeholder="Mot de passe" autocomplete="current-password" autofocus>'
        + '<button type="submit">Entrer</button><p class="err" role="alert"></p></form>';
      document.body.appendChild(box);
      const input = box.querySelector('input'), err = box.querySelector('.err');
      box.querySelector('form').addEventListener('submit', function (e) {
        e.preventDefault();
        crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.value)).then(function (buf) {
          const hex = Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
          if (hex !== HASH) { err.textContent = 'Mot de passe incorrect.'; input.value = ''; input.focus(); return; }
          try { localStorage.setItem(KEY, HASH); } catch (x) { /* redemandé à la prochaine visite */ }
          box.remove(); style.remove();
          document.documentElement.classList.remove('gated');
          resolve();
        });
      });
    }
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  });
})();
