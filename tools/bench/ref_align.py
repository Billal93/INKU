"""Alignement de RÉFÉRENCE (outil de développement, PC uniquement, hors application) des phrases FLEURS fr :
modèle CTC wav2vec2 français (jonatasgrosman/wav2vec2-large-xlsr-53-french, Apache-2.0) en float32 sur CPU,
alignement forcé de Viterbi sur les caractères. Sert à construire le corpus d'évaluation (tools/bench/build_corpus.mjs) :
emplacement des mots pour injecter bégaiements, reprises et silences, et vérité terrain des attaques de mots.

Usage : venv/Scripts/python tools/bench/ref_align.py <INKU-bench>
Sortie : <INKU-bench>/fleurs/align.json  { id: { text, words: [{w, start, end, score}] } }
"""
import json, re, sys, unicodedata
from pathlib import Path
import numpy as np
import soundfile as sf
import torch
from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

# Copie locale (téléchargée par curl à la révision figée 7c79e105a6525d38e1e69f640b974b4a679723cc) de
# jonatasgrosman/wav2vec2-large-xlsr-53-french : le téléchargement Xet de huggingface_hub restait bloqué.
bench = Path(sys.argv[1] if len(sys.argv) > 1 else "C:/Users/cybersecurite/Downloads/INKU-bench")
MODEL = str(bench / "models/w2v-fr")

proc = Wav2Vec2Processor.from_pretrained(MODEL)
model = Wav2Vec2ForCTC.from_pretrained(MODEL).eval()
torch.set_num_threads(4)
vocab = proc.tokenizer.get_vocab()
blank = proc.tokenizer.pad_token_id
sep = vocab.get("|")


def norm_words(text):
    t = unicodedata.normalize("NFC", text).lower().replace("’", "'")
    t = re.sub(r"[^\w' ]+", " ", t)
    return [w for w in t.split() if w]


def viterbi(logp, tokens):
    """Alignement forcé CTC : renvoie pour chaque jeton (index de trame début, fin)."""
    T, S = logp.shape[0], 2 * len(tokens) + 1
    ext = [blank if s % 2 == 0 else tokens[s // 2] for s in range(S)]
    NEG = -1e30
    dp = np.full((T, S), NEG, dtype=np.float64)
    bp = np.zeros((T, S), dtype=np.int8)
    dp[0, 0] = logp[0, ext[0]]
    if S > 1:
        dp[0, 1] = logp[0, ext[1]]
    ext_a = np.array(ext)
    skip_ok = np.zeros(S, dtype=bool)
    skip_ok[2:] = (ext_a[2:] != blank) & (ext_a[2:] != ext_a[:-2])
    emis = logp[:, ext_a]                      # [T, S]
    for t in range(1, T):                      # boucle vectorisée sur les états
        p = dp[t - 1]
        c0 = p
        c1 = np.concatenate(([NEG], p[:-1]))
        c2 = np.where(skip_ok, np.concatenate(([NEG, NEG], p[:-2])), NEG)
        stack = np.stack([c0, c1, c2])
        arg = np.argmax(stack, axis=0)
        dp[t] = stack[arg, np.arange(S)] + emis[t]
        bp[t] = arg
    s = S - 1 if dp[T - 1, S - 1] >= dp[T - 1, S - 2] else S - 2
    path = []
    for t in range(T - 1, -1, -1):
        path.append(s)
        s -= int(bp[t, s])
    path.reverse()
    spans = {}
    for t, s in enumerate(path):
        if s % 2 == 1:
            k = s // 2
            a, b = spans.get(k, (t, t))
            spans[k] = (min(a, t), max(b, t))
    return spans, path


rows = [l.split("\t") for l in (bench / "fleurs/dev.tsv").read_text(encoding="utf8").strip().split("\n")]
out = {}
for i, r in enumerate(rows):
    wid = r[1].replace(".wav", "")
    words = norm_words(r[2])
    if any(re.search(r"\d", w) for w in words):
        continue  # les chiffres ne sont pas dans le vocabulaire du modèle : phrase exclue
    chars, owner = [], []
    for k, w in enumerate(words):
        if k:
            chars.append(sep); owner.append(-1)
        for c in w:
            if c not in vocab:
                continue
            chars.append(vocab[c]); owner.append(k)
    audio, sr = sf.read(bench / "fleurs/dev" / r[1], dtype="float32")
    assert sr == 16000
    with torch.inference_mode():
        x = proc(audio, sampling_rate=16000, return_tensors="pt").input_values
        logp = torch.log_softmax(model(x).logits[0], dim=-1).numpy()
    spans, path = viterbi(logp, chars)
    stride = audio.shape[0] / 16000 / logp.shape[0]
    wl = []
    for k, w in enumerate(words):
        ks = [j for j, o in enumerate(owner) if o == k and j in spans]
        if not ks:
            continue
        a = spans[ks[0]][0]; b = spans[ks[-1]][1] + 1
        score = float(np.mean([logp[t, chars[j]] for j in ks for t in range(spans[j][0], spans[j][1] + 1)]))
        wl.append({"w": w, "start": round(a * stride, 3), "end": round(b * stride, 3), "score": round(score, 3)})
    out[wid] = {"text": r[2], "gender": r[6].strip(), "dur": round(len(audio) / 16000, 3), "stride": stride, "words": wl}
    if i % 20 == 0:
        print(i, len(rows), wid, len(wl), flush=True)

(bench / "fleurs/align.json").write_text(json.dumps(out, ensure_ascii=False, indent=0), encoding="utf8")
print("phrases alignées :", len(out))
