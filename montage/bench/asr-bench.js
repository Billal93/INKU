// Banc d'essai : pour chaque modèle × appareil (WebGPU / WASM), télécharge (vérifié), charge, transcrit le corpus
// et publie les mesures dans window.__bench. Paramètres d'URL : models=a,b  devices=webgpu,wasm  list=<url json>.
import { SpeechClient } from '../speech/client.js';
import { decodeWav } from '../audio/wav.js';

const q = new URLSearchParams(location.search);
const log = (s) => { document.getElementById('log').textContent += s + '\n'; console.log(s); };
const bench = { done: false, error: null, runs: /** @type {any[]} */ ([]) };
/** @type {any} */ (window).__bench = bench;

async function main() {
  if (!crossOriginIsolated) { await new Promise((r) => setTimeout(r, 3000)); if (!crossOriginIsolated) log('ATTENTION : pas isolé'); }
  const list = await (await fetch(q.get('list') || '/bench-data/list.json')).json();
  const items = [];
  for (const it of list.items) {
    const wav = decodeWav(await (await fetch(it.url)).arrayBuffer());
    if (wav.sampleRate !== 16000) throw new Error('corpus attendu en 16 kHz');
    items.push({ ...it, audio: wav.channels[0] });
  }
  const audioSec = items.reduce((a, it) => a + it.audio.length / 16000, 0);
  log(`${items.length} extraits, ${audioSec.toFixed(1)} s d'audio`);
  for (const model of (q.get('models') || 'whisper-small').split(',')) {
    const sc = new SpeechClient();
    try {
      const t0 = performance.now();
      await sc.call('ensure', { model }, (p) => { if (p.loaded === p.total) log(`${model} : ${(p.total / 1048576).toFixed(0)} Mo vérifiés`); });
      const dlMs = performance.now() - t0;
      for (const device of (q.get('devices') || 'webgpu').split(',')) {
        const run = { model, device, dlMs, loadMs: 0, items: /** @type {any[]} */ ([]), audioSec, totalMs: 0, error: null };
        bench.runs.push(run);
        try {
          run.loadMs = (await sc.call('load', { model, device })).ms;
          log(`${model}/${device} chargé en ${(run.loadMs / 1000).toFixed(1)} s`);
          // Échauffement (compilation des shaders) exclu de la mesure.
          await sc.call('transcribe', { audio: items[0].audio.slice(0, 16000 * 3), opt: {} });
          for (const it of items) {
            const r = await sc.call('transcribe', { audio: it.audio, opt: { words: q.has('words') } });
            run.items.push({ id: it.id, hyp: r.text, ms: r.ms, words: r.words });
            run.totalMs += r.ms;
          }
          log(`${model}/${device} : RTF ${(run.totalMs / 1000 / audioSec).toFixed(3)}`);
        } catch (e) { run.error = String(e.message || e); log(`${model}/${device} ERREUR ${run.error}`); }
        await sc.call('unload');
      }
    } catch (e) { bench.runs.push({ model, error: String(e.message || e) }); log(`${model} ERREUR ${e.message}`); }
    sc.terminate();
  }
  bench.done = true;
}
main().catch((e) => { bench.error = String(e && e.message || e); bench.done = true; log('ERREUR ' + bench.error); });
