// Diagnostic d'une évaluation du nettoyage : pour chaque défaut injecté manqué et chaque mot propre perdu, le
// contexte transcrit, les défauts détectés à proximité et les passages gardés.
// Usage : node tools/bench/diag-voice.mjs [rapport.json]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BENCH = 'C:/Users/cybersecurite/Downloads/INKU-bench';
const file = process.argv.slice(2).find((a) => !a.startsWith('--')) || join(BENCH, 'results', readdirSync(join(BENCH, 'results')).filter((f) => f.startsWith('voice-')).sort().pop());
const R = JSON.parse(readFileSync(file, 'utf8'));
const overlap = (a, b) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
const byType = {};
for (const r of R.raw) {
  const T = JSON.parse(readFileSync(join(BENCH, 'corpus/v1', r.name + '.json'), 'utf8'));
  const cut = new Set(r.proposal.cutWords);
  const kept = r.proposal.kept.map((k) => [k.t0, k.t1]);
  for (const d of T.defects) {
    const removed = (d.t1 - d.t0) - kept.reduce((s, k) => s + overlap([d.t0, d.t1], k), 0);
    const ok = removed >= 0.5 * (d.t1 - d.t0);
    byType[d.type] ||= { n: 0, found: 0 };
    byType[d.type].n++; if (ok) byType[d.type].found++;
    if (ok) continue;
    const ctx = r.words.filter((w) => w.t1 > d.t0 - 1.2 && w.t0 < d.t1 + 1.2).map((w) => (cut.has(r.words.indexOf(w)) ? '~~' : '') + w.w + '@' + w.t0.toFixed(2));
    const near = r.issues.filter((x) => x.t1 > d.t0 - 1 && x.t0 < d.t1 + 1).map((x) => `${x.type}:${x.action}@${x.t0.toFixed(2)}-${x.t1.toFixed(2)}`);
    console.log(`${r.name} MANQUÉ ${d.type} ${d.t0.toFixed(2)}-${d.t1.toFixed(2)}${d.word ? ' (' + d.word + ')' : ''} retiré ${(100 * removed / (d.t1 - d.t0)).toFixed(0)} %`);
    console.log('   mots :', ctx.join(' '));
    console.log('   détecté :', near.join(' ') || '—');
  }
}
// Mots propres perdus : quel défaut ou quelle prise les a coupés ?
const lostBy = {};
for (const r of R.raw) {
  const T = JSON.parse(readFileSync(join(BENCH, 'corpus/v1', r.name + '.json'), 'utf8'));
  const kept = r.proposal.kept.map((k) => [k.t0, k.t1]);
  for (const w of T.words) {
    if (kept.reduce((s, k) => s + overlap([w.t0, w.t1], k), 0) >= 0.5 * (w.t1 - w.t0)) continue;
    const iss = r.issues.find((x) => x.action === 'cut' && x.t0 <= w.t1 && x.t1 >= w.t0);
    const g = r.takes.find((t) => t.members.some((m) => m !== t.best && r.words[r.sentences[m].a].t0 <= w.t1 && r.words[r.sentences[m].b].t1 >= w.t0));
    const why = iss ? iss.type : g ? 'prise non retenue' : 'marge / autre';
    lostBy[why] = (lostBy[why] || 0) + 1;
    if (process.argv.includes('--lost')) console.log(`${r.name} PERDU « ${w.w} » ${w.t0.toFixed(2)} : ${why}${iss ? ' — ' + iss.reason : g ? ' — ' + g.reason.slice(0, 90) : ''}`);
  }
}
console.log('\nMots propres perdus par cause :', JSON.stringify(lostBy));
console.log('\nPar type :', Object.entries(byType).map(([k, v]) => `${k} ${v.found}/${v.n}`).join(' · '));
