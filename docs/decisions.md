# Montage vidéo — journal des décisions

Chaque problème rencontré, solutions essayées, solution retenue, limites restantes.
Dernière mise à jour : 2026-10-02 (Phase 0).

## D1. Le Montage est une page séparée, pas un panneau de `index.html`
- **Constat** : `index.html` suit une règle de compatibilité JS ES2017 max / vieux iOS (CLAUDE.md). WebCodecs, modules ES et `await` de haut niveau exigent du moderne.
- **Retenu** : dossier `montage/` (modules ES, détection de fonctionnalités). Le site principal n'est pas modifié. Un navigateur sans WebCodecs voit « non compatible » dans le Montage uniquement.
- **Limite** : l'onglet s'ouvre comme une page (bouton dans la barre), pas comme un panneau interne.

## D2. Bibliothèques (vérifié le 2026-10-02 via npm / documentation)
| Brique | Version | Licence | Rôle |
|---|---|---|---|
| Mediabunny | 1.61.0 (publiée 2026-09-29) | MPL-2.0 | démux/mux MP4, décodage/encodage WebCodecs |
| @mediabunny/aac-encoder | 1.61.0 | MPL-2.0 (encodeur AAC de FFmpeg compilé en WASM) | AAC quand le navigateur n'a pas d'AudioEncoder AAC |
- Hébergées **localement** dans `montage/vendor/` (version figée, fichiers LICENSE joints). MPL-2.0 : on garde les fichiers de licence et on ne modifie pas ces fichiers.
- **À signaler** : l'encodeur AAC embarque du code FFmpeg (LGPL). Usage non modifié et chargé comme fichier séparé : compatible, mais à garder en tête si le dépôt change de statut. Les brevets AAC sont un sujet de droit hors périmètre technique.

## D2b. Import map obligatoire pour l'encodeur AAC WASM
- L'extension importe `mediabunny` par nom nu. Sans import map : erreur de résolution (constatée en test, corrigée). Chaque page du Montage doit déclarer `<script type="importmap">{"imports":{"mediabunny":"./vendor/mediabunny.min.mjs"}}</script>` AVANT ses modules. Les navigateurs sans import map (Safari < 16.4, Chrome < 89) n'ont de toute façon pas un WebCodecs exploitable.

## D3. Isolation cross-origin sur GitHub Pages
- **Problème** : pas d'en-têtes COOP/COEP personnalisables → pas de `SharedArrayBuffer` (nécessaire au WASM multi-thread).
- **Essayé et validé** : service worker maison (`montage/sw.js`, même principe que coi-serviceworker) qui réécrit les en-têtes + `coi-register.js` qui recharge la page UNE fois.
- **Résultat réel (Playwright : Chrome, Edge, Chromium, WebKit de Playwright)** : `crossOriginIsolated === true` après le rechargement ; Phase 0 reste GO sous COEP `require-corp`.
- **Limites** : le service worker n'agit qu'après une première visite (un rechargement automatique) ; ne marche qu'en HTTPS/localhost ; les ressources d'autres origines (ex. modèle Hugging Face) devront envoyer des en-têtes CORS/CORP — à valider en phase 1. Safari/Firefox réels : **non testés**.

## D4. Composition WebGL2 avec repli canvas 2D
- Retrait de fond d'un overlay sans alpha : luminosité → alpha + décontamination de couleur, et **couverture totale forcée opaque** (« alpha calculé depuis la couverture ») pour que ni le clip A ni le clip B ne transparaisse.
- Contrôle automatique : pendant la couverture totale, le rendu final est comparé à la transition seule (écart 0,0/255 mesuré avec WebGL2).
- Le repli canvas 2D (`screen`) ne sait PAS faire d'alpha réel : il est marqué « dégradé » dans l'interface.

## D5. Bandes noires (leçon n°8 du cahier des charges)
- Premier essai : seuil strict sur le max de ligne → bande détectée à 18-20 px au lieu de 22 (artefacts de compression). **Corrigé** : moyenne de ligne ≤ 26 avec plafond de max, valeur minimale observée sur 5 images, + 2 px de marge. Résultat sur le trailer de test : 23 px (réel 22).

## D6. Garde-fou de rendu
- Le rendu s'arrête avec un message si il dépasse 3× la durée attendue. Il s'est **réellement déclenché** sur le Chromium embarqué de Playwright (logiciel pur, 1080×1920). Conséquence de conception : le niveau de résolution devra être choisi par un **mini-benchmark** à l'autotest, pas seulement par `isConfigSupported`.

## D7. Marque et droits (dépôt PUBLIC)
- Clash Display, transitions, overlays, SFX, musiques, logo : **absents de cet ordinateur**, donc non utilisés. Phase 0 : police de substitution Plus Jakarta Sans 800 (licence OFL, déjà dans le dépôt) et fichiers de démo synthétiques (générés par ffmpeg / voix de synthèse Windows).
- Proposition : **pack de marque importé depuis l'appareil** (stocké en local), rien de protégé dans GitHub. À confirmer par l'utilisateur.

## Limites connues après la Phase 0
- Safari/WebKit réel, Firefox réel, Android, iPhone : **non testés** ici (le WebKit de Playwright n'expose pas WebCodecs ; Firefox ne se lance pas dans ce sandbox).
- Le limiteur audio est un plafonnement global à -1 dBFS (pas encore un vrai limiteur).
- Pas de ducking, pas de transcription, pas de nettoyage de voix, pas d'EDL (phases 1-4).
