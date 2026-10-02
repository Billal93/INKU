# INKU STUDIO | PRO ULTRA

Outil statique HTML/CSS/JS vanilla, sans build, pour appliquer des copyrights
sur des images manga/anime, extraire des frames de vidéo, faire des collages,
générer des PNG 4K et rédiger des tweets.

- Dépôt : https://github.com/Billal93/INKU (branche `main`)
- Publié sur GitHub Pages : https://billal93.github.io/INKU/ (sous-chemin `/INKU/`)
- Pas de framework, pas de bundler.
- Tout le JS applicatif est dans `index.html`, enveloppé dans un seul listener
  `DOMContentLoaded`, fonctions exposées via `window.x` pour les `onclick=` inline.
- 5 onglets : Appliquer, Vidéo, Collage, Créateur 4K, ✍️ Tweets.
- Logos : `assets/logos.js` (`window.LOGO_DB`, noms en snake_case sans accents)
  + `assets/copyrights/<nom>.png`. Générés depuis un salon Discord par
  `creer_index.py` (token lu depuis l'env, jamais en clair — voir Sécurité).

## Règles de compatibilité (NE PAS régresser)

- JS cible ES2017 max : pas de `?.`, `??`, `replaceAll`, `Array.prototype.at`,
  `structuredClone`, pas de `new DataTransfer()`.
- CSS : pas de `aspect-ratio` nu (fallback `padding-top`), pas de `inset`
  (utiliser top/right/bottom/left), pas de `gap` flex sans fallback marges,
  pas de `:is()`/`:has()`.
- Détection de fonctionnalités (feature detection) plutôt que sniffing
  d'User-Agent pour le comportement. L'UA ne sert qu'à la bannière device et
  aux libellés (ex: "Chrome iOS" vs "Safari").
- Design, couleurs, police (Plus Jakarta Sans), textes en français et le nom
  "INKU STUDIO" ne changent pas.
- **Créateur 4K** : le rendu doit rester pixel-identique (canvas 3840×2160
  transparent, `45px Arial`, blanc, texte `© ` + texte, x=100,
  y=2160-67, baseline bottom, texte vide → "INKU Studio"). Seuls le
  téléchargement, la police de secours (Arial, Helvetica, "Liberation Sans",
  sans-serif) et le nom de fichier assaini peuvent changer.
- **iOS "Enregistrer dans Photos"** : les `blob:` URLs échouent dans la modale
  d'appui long ("pas de connexion"). Garder des dataURL dans `<img src>`, mais
  chargées paresseusement par petits lots, libérées à la fermeture.
- Images sources en 16:9, copyright étiré sur toute l'image : ne pas changer.
- Ne jamais supprimer de fonctionnalité existante (bannière appareil, modale
  iOS, bloc-notes, collage Insta, ZIP des captures...).

## Sécurité

`creer_index.py` contenait un token de bot Discord en clair dans un dépôt
public (exposé depuis le commit initial). Il doit être lu depuis les variables
d'environnement `DISCORD_TOKEN` / `DISCORD_CHANNEL_ID`, jamais committé.
**Le token doit être régénéré sur le portail développeur Discord** — ce correctif
ne protège que l'avenir, pas l'exposition passée.

## Process de travail

- Travail sur la branche `compat-fixes`, jamais de merge direct dans `main`.
- Un commit par phase.
- Si une décision change un comportement visible pour l'utilisateur (parité du
  rendu 4K, gestion du nombre impair d'images en collage, etc.), demander
  avant d'agir plutôt que de deviner.
- L'utilisateur n'est pas développeur : ne poser que des questions de rendu
  visuel/comportement observable, jamais de questions techniques
  d'implémentation.

## Montage vidéo (dossier `montage/`)

Éditeur multipistes 9:16 100 % navigateur (WebCodecs + Mediabunny), page SÉPARÉE du site principal :
`montage/studio.html`. Les règles de compatibilité ES2017/vieux iOS ci-dessus ne s'appliquent PAS à ce dossier
(modules ES, détection de fonctionnalités, message « non compatible » sinon) ; elles continuent de s'appliquer
à `index.html`. Ne jamais mettre de fichier de l'utilisateur (voix, trailers) ni de média protégé dans le dépôt.
- Architecture et décisions : `docs/decisions.md`. Maquettes : `montage/mockup.html`, `docs/maquettes/`.
- Modèle de données : `montage/studio/edl.js` (EDL v1 versionné, temps en images à 30 fps).
- Tests : `node --test tests/montage-unit.mjs` (noyau pur) et `npx playwright test -c playwright.studio.config.js`
  (Chrome/Edge installés, car ils décodent le H.264).
