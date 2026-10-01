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
