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

## Limites connues après la Phase 0 (obsolète : voir la fin du document)
- Safari/WebKit réel, Firefox réel, Android, iPhone : **non testés** ici (le WebKit de Playwright n'expose pas WebCodecs ; Firefox ne se lance pas dans ce sandbox).
- Le limiteur audio est un plafonnement global à -1 dBFS (pas encore un vrai limiteur).
- Pas de ducking, pas de transcription, pas de nettoyage de voix, pas d'EDL (phases 1-4).


---
# Refonte : écran Studio unique (priorité 1) — 2026-10-02

## D8. Interface : UN écran, timeline multipistes
- Remplace les écrans séparés (voix / clips / transitions / sons). Mobile : aperçu 9:16 en haut, timeline en bas, feuilles montantes Sources/Réglages, barre d'actions. Desktop/tablette paysage : Sources | Aperçu | Propriétés + timeline pleine largeur. Même DOM, deux mises en page CSS (`montage/studio.css`).
- Modes **Simple** (par défaut) / **Pro** (champs numériques, Roll). Thème sombre par défaut (choix visuel, thème clair disponible via `?theme=light`).
- Maquette statique : `montage/mockup.html`, captures dans `docs/maquettes/`.

## D9. Données : EDL v1 (`montage/studio/edl.js`)
- Timeline en **images entières à 30 fps** (grille du projet), positions de source en secondes (chaque source a son fps). Pistes fixes V1 V2 T1 A1-A4, clips sans chevauchement par piste. Les fichiers de l'utilisateur sont référencés (id, nom, empreinte, plans, bandes noires), jamais embarqués : l'EDL est lisible par le futur moteur Python.
- Le cadrage 9:16 est une fonction **pure** (`cropWindow`) partagée par l'aperçu et le futur rendu : fixe ou travelling, position décimale (sous-pixel), borné à la zone utile.
- Utilisation des sources suivie **par intervalle** (leçon n°7). Linting non bloquant (`lint.js`) : clip < 1 s / > 3 s, passage réutilisé, plan quasi immobile, plan noir, coupe source dans le clip, trou, hors source.
- Historique : instantanés JSON, plafonné à **500 pas** (« illimité » impossible en stockage navigateur), un geste = un pas, persistant (IndexedDB) avec la timeline.

## D10. Analyse en worker, un seul décodeur lourd à la fois (`analysis.worker.js`)
- Copie du fichier dans l'OPFS **depuis le worker** (`createSyncAccessHandle`) : la voie d'écriture la plus portable (Safari ne fournit pas `createWritable` sur le thread principal — non vérifié sur Safari réel). Repli : fichier gardé en mémoire pour la session avec message.
- Plans : décodage à 8 images/s (histogramme RVB 3×16 bins sur 64×36), seuil 0,4, **affinage à l'image près** sur l'intervalle du saut, fusion des coupes < 0,4 s. **Mesuré** sur un trailer de test à coupes connues : 5/5 coupes retrouvées à ±0 image près (3,0 / 5,5 / 9,0 / 12,5 / 15,0 s).
- Bandes noires : valeur minimale sur 5 images + 2 px (mesuré 23/24 px pour 22 px réels).
- Proxy 720p (540p si ≤ 4 Go ou ≤ 4 cœurs), recadré sur la zone utile, GOP de 0,25 s, sans audio (Mediabunny `Conversion`). Le rendu final retournera toujours aux originaux.
- Limite connue : fondus enchaînés et plans très courts (< 0,4 s) peuvent être mal découpés.

## D11. Lecture : l'audio est le maître, avec filet de sécurité
- Horloge audio (`AudioContext.currentTime`) quand une voix joue ; si elle ne progresse pas pendant 350 ms (constaté en Chrome sans périphérique audio), bascule sur l'horloge système à l'image courante.
- Un flux de décodage par clip (`CanvasSink.canvases`, 4 images d'avance max) et préchargement du clip suivant 0,4 s avant la coupe. Si le décodage décroche, on affiche la dernière image disponible : jamais de décalage audio.

## D12. Défilement : cache d'images basse définition
- Mesuré (Chrome, PC) : décodage exact d'une image au hasard sur proxy ≈ **135 ms** en moyenne (p90 ≈ 180 ms) → trop lent pour être « instantané ». Solution : l'analyse conserve un JPEG 480 px à 4 images/s ; pendant un défilement l'aperçu affiche **cet instantané en ≈ 3 ms** (34 mises à jour pour 40 déplacements rapides), puis l'image exacte arrive ~90 ms après le geste.
- Coût : ~10-20 Ko par image conservée. Au-delà de 10 min de source on passe à 2 images/s.

## D13. Gestes tactiles
- Défilement natif conservé (`touch-action: pan-x pan-y`). **Appui long (280 ms)** = prendre le clip ; à ce moment seulement un `touchmove` non passif bloque le défilement. Poignées d'ajustement : `touch-action: none` et zones de 26 px sur écran tactile. Pincement à deux doigts = zoom (ancré sous les doigts), molette+Ctrl sur PC.
- **Limite de la plateforme (constatée)** : si le doigt se pose pendant l'inertie d'un défilement, Chrome rend les `touchmove` non annulables ; l'appui long ne peut alors pas déplacer le clip. Il faut attendre l'arrêt du défilement.
- **Double-tap = couper** : deux touchers sur le même clip en moins de 320 ms coupent. Constaté en test : deux clics rapprochés coupent bien. Risque de coupe accidentelle en tapant vite deux fois ; annulable.
- Non fait en priorité 1 : balayage pour supprimer (en conflit avec le défilement vertical) → bouton Supprimer/dock en attendant ; lecture au survol des plans (remplacée par la visionneuse à curseur).

## D14. Ce qui est réellement fluide / pas fluide (honnête)
- Mesuré sur PC uniquement : analyse d'un trailer de 18 s ≈ 14 s (plans + vignettes + défilement) puis proxy ≈ 6 s ; lecture proxy sans erreur ; édition < 1 frame d'interface. Pas de mesure sur téléphone.
- **Extrapolation, non mesurée** : un trailer de 2 min peut demander 2 à 3 minutes d'analyse sur PC et nettement plus sur un téléphone moyen (décodage 1080p plusieurs fois plus lent) ; c'est en arrière-plan avec barre de progression.
- Compensations en place : worker, une tâche lourde à la fois, proxy 540p sur appareil modeste, défilement par instantanés, images sautées plutôt que décalage audio.
- **Pas encore fait** : lecture avec plusieurs couches (V2 overlays, sous-titres) — la charge réelle sur téléphone sera connue en priorité 3.

## Limites connues (priorité 1)
- Aucun test sur Safari, Firefox, iPhone, iPad, Android réels (non disponibles ici) ; le WebKit de Playwright n'expose pas WebCodecs.
- Voix : pas encore de transcription ni de nettoyage (priorité 2). Rendu MP4 : pas encore (priorité 5) ; le bouton Exporter télécharge l'EDL.
- Les sources déjà analysées avant l'ajout du cache de défilement n'ont pas d'instantanés (re-importez-les).
