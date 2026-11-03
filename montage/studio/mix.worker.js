// Worker de mixage : le calcul (sonie, ducking, limiteur true peak) ne bloque jamais l'interface.
// Les PCM des sons sont envoyés une seule fois (« put ») puis gardés ici, par identifiant.
import { mixdown } from '../audio/mix.js';

/** @type {Map<string, Float32Array[]>} */
const pcm = new Map();

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.op === 'put') { pcm.set(m.key, m.channels); self.postMessage({ id: m.id, ok: true }); return; }
    if (m.op === 'has') { self.postMessage({ id: m.id, ok: true, has: m.keys.filter((k) => pcm.has(k)) }); return; }
    if (m.op === 'mix') {
      const t0 = performance.now();
      const items = m.items.map((it) => ({ ...it, channels: pcm.get(it.pcmKey) })).filter((it) => it.channels);
      const r = mixdown(items, m.duration, m.opt);
      self.postMessage({ id: m.id, ok: true, channels: r.channels, report: r.report, ms: Math.round(performance.now() - t0) }, /** @type {any} */ (r.channels.map((c) => c.buffer)));
    }
  } catch (err) { self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) }); }
};
