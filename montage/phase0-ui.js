import { runPhase0 } from './phase0.js';
import { detectCapabilities } from './lib/caps.js';

const $ = (id) => document.getElementById(id);
const files = { trailer: null, transition: null, voice: null };
const logEl = $('log');
const log = (m) => { logEl.textContent += m + '\n'; logEl.scrollTop = logEl.scrollHeight; console.log('[phase0]', m); };

for (const [id, key] of [['fTrailer', 'trailer'], ['fTrans', 'transition'], ['fVoice', 'voice']]) {
  $(id).addEventListener('change', (e) => { files[key] = e.target.files[0] || null; });
}

async function loadDemo() {
  $('btnDemo').disabled = true;
  $('demoState').textContent = 'Téléchargement des fichiers de démo…';
  try {
    const get = async (name, type) => {
      const r = await fetch('demo/' + name);
      if (!r.ok) throw new Error(name + ' : HTTP ' + r.status);
      return new File([await r.blob()], name, { type });
    };
    files.trailer = await get('p0-trailer.mp4', 'video/mp4');
    files.transition = await get('p0-transition.mp4', 'video/mp4');
    files.voice = await get('p0-voice.wav', 'audio/wav');
    $('demoState').textContent = 'Fichiers de démo chargés ✔ (trailer, transition, voix)';
  } catch (e) {
    $('demoState').textContent = 'Échec du chargement de la démo : ' + e.message;
  }
  $('btnDemo').disabled = false;
}
$('btnDemo').addEventListener('click', loadDemo);

function show(R) {
  $('resultCard').hidden = false;
  const cls = (R.verdict || '').startsWith('GO') ? 'ok' : 'ko';
  $('verdict').innerHTML = '<span class="' + cls + '">' + R.verdict + '</span>';
  const tb = $('checks').querySelector('tbody');
  tb.innerHTML = '';
  for (const c of R.checks) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="' + (c.ok ? 'ok' : 'ko') + '">' + (c.ok ? '✔' : '✘') + '</td><td></td><td></td>';
    tr.children[1].textContent = c.name; tr.children[2].textContent = c.detail;
    tb.appendChild(tr);
  }
  if (R.blobUrl) { $('player').hidden = false; $('player').src = R.blobUrl; }
  const copy = JSON.parse(JSON.stringify(R, (k, v) => (k === 'blob' || k === 'blobUrl' ? undefined : v)));
  copy.userAgent = navigator.userAgent;
  $('json').value = JSON.stringify(copy, null, 2);
  window.__phase0Report = copy;
  window.__phase0Blob = R.blob || null;
}

$('btnCaps').addEventListener('click', async () => {
  logEl.textContent = '';
  const caps = await detectCapabilities();
  $('resultCard').hidden = false;
  $('verdict').textContent = 'Niveau détecté : ' + caps.level;
  $('checks').querySelector('tbody').innerHTML = '';
  $('json').value = JSON.stringify({ caps, userAgent: navigator.userAgent }, null, 2);
  log(JSON.stringify(caps, null, 2));
});

async function run() {
  if (!files.trailer || !files.transition) { $('status').textContent = 'Il faut au minimum un trailer et une transition (ou chargez la démo).'; return; }
  logEl.textContent = '';
  $('btnRun').disabled = true; $('bar').style.width = '0';
  $('status').textContent = 'Test en cours…';
  try {
    const R = await runPhase0({
      trailer: files.trailer, transition: files.transition, voice: files.voice,
      resolution: $('selRes').value, hardware: $('selHw').value, compositor: $('selComp').value,
    }, log, (p, label) => { $('bar').style.width = Math.round(p * 100) + '%'; $('status').textContent = label; });
    $('bar').style.width = '100%';
    $('status').textContent = R.verdict;
    show(R);
  } catch (e) {
    console.error(e);
    log('ERREUR : ' + e.message);
    $('status').textContent = 'Échec : ' + e.message;
    window.__phase0Report = { verdict: 'ERREUR', error: e.message, stack: String(e.stack || '') };
  }
  $('btnRun').disabled = false;
  window.__phase0Done = true;
}
$('btnRun').addEventListener('click', run);

$('btnCopy').addEventListener('click', async () => {
  $('json').select();
  try { await navigator.clipboard.writeText($('json').value); $('status').textContent = 'Rapport copié ✔'; }
  catch (e) { document.execCommand('copy'); $('status').textContent = 'Rapport sélectionné : copiez-le manuellement si besoin.'; }
});
$('btnDl').addEventListener('click', () => {
  if (!window.__phase0Blob) return;
  const a = document.createElement('a'); a.href = URL.createObjectURL(window.__phase0Blob); a.download = 'inku-montage-phase0.mp4';
  document.body.appendChild(a); a.click(); a.remove();
});

// Mode automatique pour les tests (?auto=1[&res=720x1280][&comp=canvas2d])
const q = new URLSearchParams(location.search);
if (q.get('auto') === '1') {
  if (q.get('res')) $('selRes').value = q.get('res');
  if (q.get('comp')) $('selComp').value = q.get('comp');
  if (q.get('hw')) $('selHw').value = q.get('hw');
  loadDemo().then(run);
}
