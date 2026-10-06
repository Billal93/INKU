# Checklist de test manuel — INKU STUDIO

À tester sur l'URL GitHub Pages après déploiement de la branche `compat-fixes`
(ou en local via `python -m http.server` depuis le dossier du projet).

Coche au fur et à mesure. Pour chaque bug trouvé, note l'appareil + navigateur
exact (ex: "iPhone 11, iOS 15.4, Safari").

## Appareils à couvrir

- [ ] iPhone ancien (iOS 12-14 si possible, sinon le plus ancien dispo), Safari
- [ ] iPhone récent, Safari
- [ ] iPhone récent, Chrome
- [ ] iPad (toutes générations dispo), Safari — vérifier surtout la **bannière
      device** : doit afficher "iPad détecté", pas "Desktop"/"Mac"
- [ ] Android (le plus ancien dispo, idéalement Android 7-9), Chrome
- [ ] Android récent, Chrome
- [ ] Android, Firefox ou Samsung Internet si possible
- [ ] PC Windows, Chrome
- [ ] PC Windows, Edge
- [ ] PC Windows, Firefox
- [ ] Mac, Safari (si disponible)

## Général (tous appareils)

- [ ] La page charge sans erreur, le dégradé du titre "ULTRA" est visible
- [ ] Les 5 onglets changent correctement au toucher/clic
- [ ] Pas de zoom involontaire quand on touche un champ de texte (recherche,
      texte 4K, tweets)
- [ ] La page ne scrolle jamais horizontalement
- [ ] Le texte du toast (messages en bas de l'écran) ne déborde jamais de
      l'écran, même avec un message long
- [ ] Sur petit écran, l'en-tête (logo + titre + bannière + nav) ne prend pas
      toute la hauteur visible

## Onglet Appliquer

- [ ] Sélectionner des images (bouton ET glisser-déposer sur PC)
- [ ] Rechercher un copyright avec et sans accent (ex: "pokemon" et "pokémon")
      doivent trouver le même résultat
- [ ] Importer un copyright personnalisé (PNG/WEBP) fonctionne sur mobile
- [ ] "Appliquer les Copyrights" traite toutes les images, aperçu visible
- [ ] Si une image est volontairement cassée/corrompue dans le lot, les autres
      se traitent quand même (message d'erreur clair pour celle en échec)
- [ ] "Réinitialiser" vide tout (images, recherche, aperçu)
- [ ] "Tout Télécharger" : sur mobile, la feuille de partage native s'ouvre
      (ou la modale "Enregistrer dans Photos" sur iOS ancien) ; sur PC, le
      téléchargement démarre dans le dossier Téléchargements

## Onglet Vidéo

- [ ] Sélectionner une vidéo MP4 (bouton ET glisser-déposer)
- [ ] Un fichier MOV/HEVC non supporté affiche un message d'erreur clair (pas
      de blocage silencieux)
- [ ] Changer l'intervalle (0.5s à 60s) avant de démarrer
- [ ] "Démarrer l'extraction" : les captures apparaissent au fur et à mesure,
      la progression (%, nombre d'images, mémoire estimée) avance
- [ ] "Arrêter" stoppe bien l'extraction immédiatement
- [ ] Télécharger une capture individuelle
- [ ] "ZIP Complet" fonctionne sur PC ET sur iOS (pas de blocage popup)
- [ ] Sur une vidéo longue avec un petit intervalle, vérifier que ça ne plante
      pas le navigateur (plafond de sécurité à 600 captures)

## Onglet Collage

- [ ] Ajouter plusieurs images (bouton ET glisser-déposer)
- [ ] Réorganiser par glisser-déposer **sans que ça bloque le scroll de la
      page sur mobile** (point important à vérifier au doigt)
- [ ] Le bouton "supprimer" (x) sur chaque image est visible au toucher sans
      avoir besoin de survoler (il ne doit plus être cliquable-seulement-au-survol)
- [ ] "Collage Classique" télécharge une image 2 colonnes correcte
- [ ] "Collage Insta" génère les paires, télécharger une paire individuelle
      PUIS réorganiser les paires PUIS re-télécharger : le nom de fichier doit
      suivre la nouvelle position
- [ ] Avec un nombre impair d'images, vérifier le comportement de la dernière
      paire (actuellement : elle ne contient qu'une image — à confirmer si
      c'est le résultat voulu)
- [ ] "Tout effacer" vide bien tout

## Onglet Créateur 4K

- [ ] Taper un texte et appuyer sur Entrée (pas besoin de cliquer le bouton)
- [ ] Le PNG généré fait bien 3840x2160
- [ ] Texte avec caractères spéciaux (ex: `Test / 4K : "spécial"`) : le
      téléchargement fonctionne, nom de fichier sans caractères bizarres
- [ ] Texte vide → le fichier contient "© INKU Studio"

## Onglet Tweets

- [ ] Compteur de caractères : un lien (URL) compte 23 caractères peu importe
      sa longueur réelle
- [ ] Compteur : du texte avec des emojis ou des caractères japonais compte
      plus vite (double) que du texte simple
- [ ] "Copier" fonctionne (vérifier en collant ailleurs). Si la copie
      automatique échoue sur un vieux navigateur, un champ de texte
      sélectionné doit apparaître pour copier manuellement
- [ ] Le Bloc-notes garde son contenu après avoir rechargé la page
- [ ] Champ de saisie ne déclenche pas de zoom sur iOS au focus

## Cas particuliers / régression

- [ ] Recharger la page sur un onglet autre que "Appliquer" : revient bien sur
      "Appliquer" par défaut (comportement normal, pas de bug)
- [ ] Mode sombre du téléphone/navigateur : le site reste lisible (pas de
      design sombre prévu, donc doit rester sur fond clair)
- [ ] Rotation d'écran (portrait/paysage) sur mobile ne casse rien

## Montage vidéo (`montage/studio.html`) — priorité 1

Sur chaque appareil (iPhone, iPad, Android, PC), idéalement avec 2-3 vrais trailers + une voix :

- [ ] Le Studio s'ouvre ; sinon un message clair « navigateur non compatible » (et le reste d'INKU fonctionne)
- [ ] Importer plusieurs vidéos + un audio d'un coup : barres de progression par source, l'interface reste fluide
- [ ] Les plans détectés correspondent aux vraies coupes du trailer ; les bandes noires sont bien retirées (aperçu sans bande)
- [ ] « + » ajoute un plan à la tête de lecture ; un plan déjà utilisé est marqué « utilisé » et alerté
- [ ] Défilement (glisser sur la règle) : l'image suit immédiatement, puis devient nette
- [ ] Lecture : fluide ? (noter le modèle de l'appareil) ; la voix en A1 reste synchrone avec l'image
- [ ] **Mobile** : appui long sur un clip puis glisser = déplacer ; glisser vite = faire défiler ; pincer = zoom ; double-tap = couper
- [ ] Ajuster un clip par ses poignées (zones larges au doigt) ; annuler / rétablir
- [ ] Fermer l'onglet puis rouvrir : projet, sources et historique d'annulation sont intacts
- [ ] Glisser sur l'aperçu pour déplacer le cadrage 9:16 ; l'alerte « plan immobile » apparaît sur un plan fixe
- [ ] Noter : durée d'analyse d'un trailer de ~2 min, chauffe, batterie, éventuel plantage

## Montage vidéo — à tester sur votre iPhone (iOS 26+, Safari)

Adresse : `https://billal93.github.io/INKU/montage/studio.html`. Si la pull request n'est pas encore fusionnée,
elle n'est pas en ligne : le code complet est dans la pull request. Rien n'a encore été testé sur iPhone : tout ce qui
suit a été mesuré sur un PC (Chrome) et doit être confirmé sur l'appareil.

### 1. Autotest (5 minutes) — à faire en premier
Studio → bouton « Réglages » → « Autotest de cet appareil ». Cochez « Inclure la transcription » (458 Mo
téléchargés une seule fois, en Wi-Fi), touchez « Lancer l'autotest », puis « Copier le rapport » et collez-le dans la
conversation. Étapes et résultats sur le PC de référence :

| Étape | Ce qui est mesuré | PC (Chrome) |
|---|---|---|
| Compatibilité | WebCodecs, H.264/AAC (débit max), WebGPU, mémoire, stockage, partage | AAC 192 kb/s max |
| Rendu | 150 images 1080×1920 avec sous-titres, même moteur que l'export, déterminisme | 0,7 ms/image, identique |
| Encodage | 5 s H.264 + AAC puis relecture (images, timestamps, durées) | 4,2 s, 150 images, 0 écart |
| Overlay | transition synthétique : couverture totale, image de coupe, retrait de fond | 10–16, coupe 13, exact |
| Mixage | 60 s de voix + musique + 20 SFX : temps, crête, plafond SFX | 1,7 s, −1,3 dBTP, −14 dB |
| Transcription | vitesse et précision sur un extrait de référence | 16 s / min d'audio |

### 2. Parcours complet avec vos fichiers (20 à 30 minutes)
Cochez au fur et à mesure et notez le modèle d'iPhone.
- [ ] **Sources** : importez 1 à 3 trailers, votre voix brute et votre miniature (image). L'analyse avance sans
      bloquer l'écran ; les plans correspondent aux coupes ; les bandes noires sont retirées.
- [ ] **Voix** (barre du bas) : « Analyser comme voix », vérifiez les prises (★), les mots coupés, « Appliquer à la
      timeline » ; la vérification automatique s'affiche (✓ attendu).
- [ ] **Pack de marque** (onglet Habillage → « Ajouter au pack ») : police, transitions, ouverture, abonne-toi, logo,
      sons click/pop, musique — ou votre ZIP de pack. Chaque élément affiche ses images, son fond (noir / vert /
      alpha) et sa couverture totale. Si un retrait de fond est mauvais, changez-le dans la liste.
- [ ] **Plans** : touchez l'outil baguette de la timeline (« Remplir ») pour un premier jet calé sur les mots, puis
      remplacez les plans qui ne vont pas (alerte « Autre plan » en un geste) ; cadrage 9:16 en glissant sur l'aperçu.
- [ ] **Habillage** : « Poser à 0 » (ouverture), une transition sur un emplacement proposé (« Voir » : à l'image de
      coupe, l'écran doit être entièrement couvert), « Poser sur abonne », logo, copyright, « Poser les click / pop »,
      « Musique de fond », puis « Mesurer le mixage » (crêtes par rapport à la voix).
- [ ] **Fin** : « Proposer 3 climax », choisissez-en un (ou tapez le départ, ex. 0:35), « Poser la fin ». Vérifiez le
      fond flou, que le son du trailer ne coupe pas, la miniature, et la durée totale dans la cible.
- [ ] **Alertes** (Réglages) : lisez-les, essayez une correction en un geste.
- [ ] **Lecture** : fluide ? son synchronisé ? (le son joué est exactement celui de l'export).
- [ ] **Rendu** (bouton Exporter) : d'abord « Aperçu rapide 540×960 », puis « Final 1080×1920 ». Notez la durée,
      la chauffe et la batterie. L'écran doit rester allumé. À la fin, toutes les lignes des contrôles doivent être ✓ ;
      « Partager / galerie » doit proposer « Enregistrer la vidéo ». Ouvrez la vidéo dans Photos.
- [ ] **Robustesse** : pendant un rendu, passez dans une autre appli 10 s puis revenez (le rendu peut être suspendu :
      noter ce qui se passe) ; fermez l'onglet puis rouvrez (le projet doit être intact) ; « Exporter le projet (EDL) »
      puis « Importer un projet » : les sources sont reconnues.
- [ ] **Hors ligne** : Safari → Partager → « Sur l'écran d'accueil », ouvrez l'icône, mode Avion : le Studio démarre.

### 3. Ce qui est fait, mesuré, ou non testé
- **Mesuré sur PC (Chrome)** : nettoyage de la voix (D18-D19), sous-titres (D19), habillage et mixage (D20), fin de
  vidéo, remplissage, linting (D21), rendu et contrôles (D22) — voir `docs/decisions.md`.
- **Vérifié dans la documentation seulement** : WebCodecs, OPFS, Wake Lock et Web Share dans Safari 26 (D15).
- **Non testé sur iPhone** : tout ; en particulier la vitesse de rendu 1080p, la mémoire avec de longs trailers,
  l'écriture du MP4 dans le stockage privé (si Safari ne le permet pas, le rendu se fait en mémoire), la suspension du
  rendu en arrière-plan, le partage vers Photos.
- **Non testé avec vos vrais fichiers** : retrait de fond de vos overlays, proposition de climax sur de vrais trailers
  (les pondérations sont réglées sur des données synthétiques).

### Voir les erreurs d'un iPhone depuis un Mac (Safari Web Inspector)
1. iPhone : Réglages → Apps → Safari → Avancé → activer « Inspecteur web ».
2. Mac : Safari → Réglages → Avancés → cocher « Afficher les fonctionnalités pour les développeurs web ».
3. Reliez l'iPhone au Mac par câble (la première fois, touchez « Se fier à cet ordinateur »).
4. Mac : menu Développement → nom de l'iPhone → la page « INKU Studio | Montage » (ou « Autotest »).
5. Onglet Console : copiez les lignes rouges. Onglet Chronologies : enregistrez pendant une analyse pour voir le
   temps et la mémoire. Pour une application installée sur l'écran d'accueil, elle apparaît aussi dans ce menu.
