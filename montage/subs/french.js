// Typographie française pour les sous-titres : majuscules accentuées, ligatures, apostrophes et guillemets
// typographiques, espaces insécables. Fonctions pures (tests/unit/subs.test.mjs).

const NBSP = '\u00a0';       // espace insécable (avant « : », après « « », avant « » »)
const NNBSP = '\u202f';      // espace fine insécable (avant ; ! ?)

/**
 * Majuscules françaises : les accents sont CONSERVÉS (É, À, Ç, Ê…), « œ » → « Œ », « æ » → « Æ », « ß » géré.
 * @param {string} s
 */
export function upperFr(s) {
  return s.normalize('NFC').toLocaleUpperCase('fr-FR');
}

/**
 * Ponctuation française : apostrophe typographique ’, guillemets « », espaces insécables, points de suspension.
 * Idempotent (peut être appliqué plusieurs fois).
 * @param {string} s
 */
export function typoFr(s) {
  let t = s.normalize('NFC')
    .replace(/'/g, '’')
    .replace(/\.\.\./g, '…')
    .replace(/"([^"]*)"/g, '«$1»');
  t = t.replace(/[ \u00a0\u202f]*([;!?])/g, `${NNBSP}$1`)
    .replace(/[ \u00a0\u202f]*:(?!\/\/)/g, `${NBSP}:`)
    .replace(/«[ \u00a0\u202f]*/g, `«${NBSP}`)
    .replace(/[ \u00a0\u202f]*»/g, `${NBSP}»`);
  return t.replace(/^[\u00a0\u202f]+/, '');
}

/** Forme d'un mot pour comparer (minuscules, sans accents ni ponctuation, chiffres gardés). @param {string} w */
export function foldWord(w) {
  return w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9œæ]/g, '')
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae');
}

const UNITS = ['zero', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
const TENS = { vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60 };
/** Nombre écrit en lettres (jusqu'à 99, formes courantes) → valeur, sinon null. Ex. « vingt-cinq » → 25. @param {string} s */
export function wordsToNumber(s) {
  const p = foldWordsKeepDash(s).split(/[-\s]+/).filter((x) => x && x !== 'et');
  if (!p.length) return null;
  let n = 0;
  for (let i = 0; i < p.length; i++) {
    const w = p[i];
    if (w === 'quatre' && /^vingts?$/.test(p[i + 1] || '')) { n += 80; i++; }
    else if (UNITS.includes(w)) n += UNITS.indexOf(w);
    else if (w in TENS) n += TENS[w];
    else if (w === 'quatrevingt' || w === 'quatrevingts') n += 80;
    else if (w === 'cent') n = (n || 1) * 100;
    else if (w === 'mille') n = (n || 1) * 1000;
    else return null;
  }
  return n;
}
function foldWordsKeepDash(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z\s-]/g, ''); }
