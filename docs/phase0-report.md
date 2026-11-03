# Phase 0 — rapport de faisabilité (2026-10-02)

Page de test : `montage/phase0.html` (bouton « Charger les fichiers de démo » puis « Lancer le test »).
Scénario : 3 clips de 5 s en 9:16 (dont un travelling doux), sous-titres animés (police vérifiée), transition sur fond noir (retrait de fond + couverture totale), logo + copyright, mixage voix/musique/transition/SFX relatif à la voix, export MP4 15 s à 30 fps. Contrôles après rendu : relecture complète, régularité des timestamps, durées audio/vidéo, lecture par le navigateur.

## Résultats mesurés (ordinateur Windows 11, 12 cœurs, 16 Go, GPU intégré/dédié)

| Navigateur | Niveau | Résolution | Compositeur | AAC | Rendu 15 s | Verdict |
|---|---|---|---|---|---|---|
| Chrome (stable installé) | A | 1080×1920 | WebGL2 | natif | 24 s (×0,62 temps réel) | **GO** |
| Chrome, encodeur logiciel forcé | A | 1080×1920 | WebGL2 | natif | ≈25 s | **GO** |
| Chrome, compositeur canvas 2D | A (dégradé) | 1080×1920 | canvas 2D | natif | ≈18 s | GO (pas d'alpha réel) |
| Chrome, 720×1280 | A | 720×1280 | WebGL2 | natif | ≈17 s | **GO** |
| Edge (installé) | A | 1080×1920 | WebGL2 | natif | 22 s (×0,67) | **GO** |
| Chromium embarqué (sans accél. matérielle) | B | 540×960 | WebGL2 | natif | 40 s (≈2,7× la durée) | GO limite (1080×1920 : garde-fou 3× déclenché) |
| WebKit de Playwright | C | — | — | — | — | **Non évaluable** : `VideoEncoder` absent de ce build |
| Firefox | ? | — | — | — | — | **Non testé** : ne se lance pas dans ce sandbox |
| Safari iPhone / iPad / Mac réels | ? | — | — | — | — | **Non testé** |
| Android (Chrome, Samsung Internet, Firefox) | ? | — | — | — | — | **Non testé** |

Contrôles réussis sur Chrome et Edge : 450/450 images, timestamps réguliers (écart max 0,000 ms), audio 15,019 s vs vidéo 15,000 s (< 1 image), plan A/B masqué pendant la couverture (écart 0,0/255), sous-titres dans les marges de sécurité, fichier relu en 1080×1920, crêtes de chaque couche ≤ -14 dB sous la voix.

## Ce que cela prouve / ne prouve pas
- **Prouvé** : la chaîne complète (décodage → recadrage 9:16 en un seul passage GPU → transition avec retrait de fond → sous-titres → mixage → H.264/AAC MP4 CFR) fonctionne 100 % dans le navigateur, sans serveur, avec isolation cross-origin via service worker sur un hébergement statique.
- **Non prouvé** : tout appareil mobile. Le point critique restant est iOS Safari (mémoire, nombre de décodeurs, arrière-plan) et Android d'entrée de gamme. **Il faut vos mesures** : ouvrez `montage/phase0.html` sur chaque appareil, « Charger les fichiers de démo », « Lancer le test », puis « Copier le rapport ».
- Les temps ci-dessus viennent d'un PC ; un téléphone sera plus lent. Le garde-fou 3× protège contre les blocages, mais le niveau/résolution devront être choisis par un mini-benchmark (autotest).

## Si un appareil est NO-GO (replis gratuits, rien construit sans accord)
1. Résolution réduite automatiquement (720×1280 puis 540×960) — déjà en place.
2. AAC WASM si pas d'AudioEncoder — en place et **exercé** (Chrome avec `AudioEncoder` supprimé : GO, 720×1280, rendu ≈ temps réel ×1,07, AAC valide). Limite : écart audio/vidéo de 40 ms (priming de l'encodeur) > 1 image (33 ms) ; à corriger en phase 4 (liste d'édition MP4 ou rognage du délai d'encodeur). Nécessite une import map (`mediabunny` → `./vendor/mediabunny.min.mjs`) : Safari ≥ 16.4, Chrome ≥ 89, Firefox ≥ 108.
3. Niveau C : ffmpeg.wasm par morceaux (non construit).
4. Niveau D : enregistrement canvas via MediaRecorder (test rapide : OK sur Chrome et Chromium, 0 octet sur Edge → peu fiable) ou export de l'EDL pour rendu sur le PC.
