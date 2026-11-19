# Pantry — notes pour reprendre le projet

Application d'épicerie familiale. Le propriétaire écrit en français ; l'interface de l'app et le code sont en
anglais (volontairement : neutre pour tout le monde). Ce dépôt est **public** (GitHub Pages) : n'y mettre aucune
donnée personnelle (exports, pages sauvegardées, noms, courriels, adresses).

App en ligne : https://gitofrequirement.github.io/ListMaker/

## Les trois morceaux

| Morceau | Où | Rôle |
|---|---|---|
| App (PWA, un seul fichier) | `index.html`, `sw.js`, `manifest.webmanifest`, icônes | Compter (téléphone), liste, comparer et choisir (ordinateur), organiser |
| Extension Chrome (MV3) | `extension/` | Lit prix, listes et commandes sur walmart.ca et maxi.ca ; remplit les listes des sites |
| Outil ponctuel | `tools/build-data.py` | A servi à construire les données de départ (classeur + export) ; plus utilisé chaque semaine |

- Synchronisation : Firebase (projet `groceryapp-b547d`, config par défaut dans `DEFAULT_CFG`), un seul compte
  partagé par la famille. La base entière est une chaîne JSON dans `users/{uid}/pantry/main`, historique dans la
  sous-collection `history`. Gestion des conflits par transaction (`decide()`).
- **Les prix ne se synchronisent pas** : ils restent dans le navigateur de l'ordinateur qui compare
  (`localStorage` : `pantry_prices`, et `pantry_catalog` pour les produits vus mais non rattachés).
- L'extension tourne sur l'ordinateur **personnel** du propriétaire (pas celui où ce dépôt est édité).
  Elle communique avec l'app par `bridge.js` (postMessage) quand l'app est ouverte dans le même Chrome.

## Routine de la semaine

1. Téléphone, onglet Count : compter ce qui reste par endroit.
2. Ordinateur personnel, Chrome : « Tout lire » sur Walmart > My Items et sur chaque liste Maxi
   ListMaker, ListMaker 2… ; puis dans l'app, Compare > « Import prices from the extension ».
3. Compare : « New week — start over », puis choisir (les choix se synchronisent).
4. Commander avec les liens (paniers Walmart / Maxi en bas de Compare, ou onglet List).

## Modèle de données (DB, v2)

- `areas` : endroits (« Fridge (main) », « Pantry (top) »… — sous-zones entre parenthèses).
- `items` : `{name, aisle, follow, targets{area:n}, match, choice, rule, dealAlert, note, no[]}`.
  Noms au format « Nom, qualificatif » (« Bread, gluten-free »).
  - `follow` : `normal` | `extra` (envie occasionnelle) | `seasonal` | `deal` (seulement en rabais) | `retired`.
  - `match: preferred` = mode « Exactly this one » (seuls les produits ★).
  - `choice` : `cheapest` | `variety` (défaut variety pour Produce, Snacks, yogourt, céréales, jus…).
  - `rule {all, any, none}` : mots qui rattachent automatiquement les produits du catalogue (`applyRules`).
  - `no[]` : produits « look-alike » refusés pour cet article.
- `products` : `{store, id, alt[], name, brand, item, status preferred|ok|new|excluded, url, size, kind}`.
- `counts {area:{item:{n, at, h[]}}}`, `checked`, `extra` (en plus de la liste), `plan` (choix manuels :
  une clé présente = manuel, même vide), `picks` (choix finaux partagés avec List), `free` (choix libres),
  `settings` (`varietyGap`, `dealGap`, `staleDays`, `availDays`), `fixes`.
- Prix : `PRICES[key] = [[date, prix, prixUnitaire, base, prixBarré, source]]`, base = kg | L | ea | roll | 100 tissues.

## Règles de comparaison (et pourquoi)

- Prix unitaire : `unitOf()` / `parseSize()` / `paperSize()`. Formats « Pack of 3 », « Sold in singles »,
  multipacks (« 6 x 93 ml »), oz et fl oz. Papier de toilette par rouleau ordinaire (« 24 Double = 48 »),
  mouchoirs par 100. Un point sans unité reprend la quantité implicite d'un autre point du même produit.
- Prix habituel = médiane sur 6 mois (3 points minimum), en ignorant les points à plus de 3× (taille mal lue).
- Rabais affiché à partir de 5 % ; « On sale now — stock up? » à partir de `dealGap` (20 %).
- Égalité de prix unitaire à 2 % près : le plus bas prix affiché d'abord (`byValue`).
- Un produit pas vu en magasin depuis `availDays` (180 j) n'est jamais proposé (probablement plus vendu) ;
  historique gardé, « Show them » pour le voir.
- Toujours au moins une option par épicerie et au moins 2 options ; à défaut, des « look-alikes » du catalogue
  (`lookalikes()`) à confirmer ✓ / ✕.
- Variety : le moins cher de chaque SORTE (lexique `FLAVOURS`, sinon champ `kind`, sinon mots distinctifs).
- Un choix manuel ignore les produits déplacés vers un autre article (`manualOf`) — sinon ils restent coincés
  dans List (bogue des Tasti Taters).
- Corrections de données ponctuelles et synchronisées : objet `FIXES` (chacune s'exécute une fois, sur le
  premier appareil qui charge l'app). Pour une nouvelle correction de données, ajouter une entrée datée.

## Pièges connus

- **Maxi : une liste contient 100 produits au maximum** et un ajout dans une liste pleine échoue sans
  message. L'extension traite « ListMaker », « ListMaker 2 », « ListMaker 3 »… comme une seule liste et ajoute
  dans la première qui a de la place (listes pleines notées 14 jours). Les favoris PC Express n'ont pas cette
  limite (185 produits) mais le propriétaire préfère garder les listes ListMaker.
- Maxi affiche les noms de listes en MAJUSCULES : comparer sans tenir compte de la casse.
- Le menu « Add to List » est un interrupteur : ne cliquer que sur une entrée `--without-product`
  (sinon on RETIRE le produit). Le menu se referme après un ajout : relire le groupe à neuf.
- Une page de liste Maxi s'intitule « Shopping List Details | Maxi » (pas le nom de la liste).
- Liens produits : n'utiliser un lien que s'il contient le code du produit (`purl()`), à cause des tuiles
  sponsorisées Walmart (`wapcrs/track`) et des liens de tuiles voisines chez Maxi.
- Page d'accueil Maxi : l'extension n'y fait rien (elle faisait planter la page).
- Faux amis : « Whole Kernel Corn 750 g » = maïs surgelé, pas en conserve ; « oz » = poids, « fl oz » = volume.
- Régimes : certains membres sans produits laitiers, d'autres sans gluten. Les règles d'articles en tiennent
  compte (ex. lait non sucré = avoine certifiée sans gluten seulement ; tomates en conserve = sans sel ajouté).

## Tester avec de vraies données

Les exports du propriétaire sont dans `_archive/` (ignoré par git) : `pantry-backup-AAAA-MM-JJ.json`
(« Save backup file » de l'app, avec les prix) et `pantry-export-AAAA-MM-JJ.json` (export de l'extension).
Pages Maxi/Walmart sauvegardées : `Exemple de pages/` (ignoré aussi).

1. Servir le dossier : `python -m http.server 8767` (ou la config `pantry-app` de `.claude/launch.json`).
2. Dans la page, désinscrire le service worker et vider `localStorage`, puis :
   `window.confirm=()=>true; applyImport(<backup>); importExtension(<export>); applyFixes(); applyRules(null,{exclude:false});`
3. Vérifier, puis **vider `localStorage`** (ne pas laisser de données de test).

Pour l'extension, il n'y a pas de Chrome avec l'extension ici : tester les fonctions extraites de
`content.js` / `parsers.js` sur une page sauvegardée chargée dans la page de test.

## Publier

- Ce dossier est un clone du dépôt `GitOfRequirement/ListMaker` (compte GitHub **personnel**, courriel
  noreply, nom d'utilisateur dans l'URL du remote — un compte de travail existe aussi sur la machine, ne pas
  le mélanger). Ne publier (`git push`) que quand le propriétaire dit « envoie ».
- Chaque changement de l'app : incrémenter le cache dans `sw.js` (`pantry-vN`) et mettre à jour `GUIDE.txt`.
- Chaque changement de l'extension : incrémenter `version` dans `extension/manifest.json` et mettre à jour
  `extension/LISEZMOI.txt`. Le propriétaire installe l'extension à la main sur son ordinateur personnel.

## Idées en attente

- Thème visuel : 5 maquettes proposées (Forêt, Garde-manger de nuit, Prune et agrumes, Charbon et tomate,
  Verre de mer), pas encore choisies. Le propriétaire aime les thèmes sombres.
- Pas d'orientation commerciale : le propriétaire ne veut pas transformer le projet en produit.
