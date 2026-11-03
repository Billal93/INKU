// Alignement forcé CTC (Viterbi) : étant donné les log-probabilités d'un modèle CTC par trame et la suite de
// jetons attendue (caractères ou phonèmes), trouve le chemin le plus probable et la trame de début/fin de
// chaque jeton. Fonction pure, O(T × S), testée dans tests/unit/ctc-align.test.mjs.

/**
 * @param {Float32Array} logp log-probabilités [T × V] (ligne = trame)
 * @param {number} T nombre de trames @param {number} V taille du vocabulaire
 * @param {number[]} tokens jetons attendus (sans blanc)
 * @param {number} blank index du blanc CTC
 * @returns {{ spans: ([number, number] | null)[], score: number, tokenScores: number[] } | null}
 *   spans[k] = [trame de début, trame de fin] du jeton k ; null si l'alignement est impossible (T trop court)
 */
export function ctcForcedAlign(logp, T, V, tokens, blank) {
  const S = 2 * tokens.length + 1;
  const ext = new Int32Array(S);
  for (let s = 0; s < S; s++) ext[s] = s % 2 === 0 ? blank : tokens[(s - 1) >> 1];
  // Nombre minimal de trames : un jeton par trame + un blanc entre deux jetons identiques.
  let need = tokens.length;
  for (let k = 1; k < tokens.length; k++) if (tokens[k] === tokens[k - 1]) need++;
  if (T < need) return null;
  const NEG = -1e30;
  let prev = new Float64Array(S).fill(NEG), cur = new Float64Array(S);
  const back = new Uint8Array(T * S);    // 0 : reste, 1 : depuis s−1, 2 : depuis s−2
  prev[0] = logp[ext[0]];
  if (S > 1) prev[1] = logp[ext[1]];
  for (let t = 1; t < T; t++) {
    const row = t * V;
    // Fenêtre des états atteignables (accélère et évite les chemins impossibles).
    const sMin = Math.max(0, S - 2 * (T - t) - 1), sMax = Math.min(S - 1, 2 * t + 1);
    cur.fill(NEG);
    for (let s = sMin; s <= sMax; s++) {
      let best = prev[s], arg = 0;
      if (s >= 1 && prev[s - 1] > best) { best = prev[s - 1]; arg = 1; }
      if (s >= 2 && ext[s] !== blank && ext[s] !== ext[s - 2] && prev[s - 2] > best) { best = prev[s - 2]; arg = 2; }
      if (best <= NEG / 2) continue;
      cur[s] = best + logp[row + ext[s]];
      back[t * S + s] = arg;
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  let s = S - 1;
  if (S > 1 && prev[S - 2] > prev[S - 1]) s = S - 2;
  const score = prev[s];
  if (score <= NEG / 2) return null;
  const spans = /** @type {([number, number] | null)[]} */ (new Array(tokens.length).fill(null));
  const sums = new Float64Array(tokens.length), counts = new Uint32Array(tokens.length);
  for (let t = T - 1; t >= 0; t--) {
    if (s % 2 === 1) {
      const k = (s - 1) >> 1;
      const sp = spans[k];
      if (sp) sp[0] = t; else spans[k] = [t, t];
      sums[k] += logp[t * V + ext[s]]; counts[k]++;
    }
    s -= back[t * S + s];
  }
  const tokenScores = Array.from(sums, (v, k) => (counts[k] ? v / counts[k] : NEG));
  return { spans, score, tokenScores };
}

/** log_softmax en place sur des logits [T × V]. @param {Float32Array} x @param {number} T @param {number} V */
export function logSoftmaxRows(x, T, V) {
  for (let t = 0; t < T; t++) {
    const o = t * V;
    let m = -Infinity;
    for (let v = 0; v < V; v++) if (x[o + v] > m) m = x[o + v];
    let z = 0;
    for (let v = 0; v < V; v++) z += Math.exp(x[o + v] - m);
    const lz = m + Math.log(z);
    for (let v = 0; v < V; v++) x[o + v] -= lz;
  }
  return x;
}
