# Validation des flux Google et Meta en production — 2026-08-28

## Résumé

Domaine vérifié : `https://homestorys-flux.eteamsys.be`  
Déploiement : actif, public, sans redirection vers une URL de preview.

Le serveur applicatif sait ouvrir et streamer les objets courants. Une première
validation du déploiement précédent a montré que l'annonce de leur
`Content-Length` complet faisait interrompre les réponses volumineuses par la
couche Google Frontend : le backend journalisait un début de réponse `200`,
tandis que le client Internet recevait un `500` vide. Les fichiers de quelques
Mo et les flux showroom restaient récupérables intégralement.

La version de développement corrige ce comportement en :

- conservant `Content-Length` pour les fichiers jusqu'à 32 MiB ;
- utilisant un transfert progressif pour les fichiers plus grands ;
- exposant la taille attendue dans `X-Feed-Size` ;
- servant le chemin Google atomique déterministe si la ligne de snapshot
  courant manque temporairement ;
- journalisant request ID, canal, langue/marché, durée, taille, mode de
  génération, statut et type d'erreur ;
- fournissant un état de santé par fichier protégé par session dashboard ;
- rejetant les flux non UTF-8 et les IDs dupliqués pendant la validation.

La version corrigée a ensuite été publiée le 2026-08-28 à la demande de
l'opérateur. Les routes publiques servent désormais les petits fichiers avec
`Cache-Control: public, max-age=300`. Le streaming progressif du nouveau build
est actif côté application, mais un GET Internet complet sur le snapshot
`CH_DE` de 76 Mo reçoit encore un `500` du frontal public. La régénération
complète des snapshots n'a pas été forcée : le garde-fou atomique a détecté une
baisse d'éligibilité de 20,4 % et a conservé les derniers snapshots valides.

## Cause initiale et correction

La correction précédente a remplacé le chargement complet en mémoire par un
stream App Storage épinglé à une génération. L'audit de production a montré un
second problème : annoncer une taille de 64 à 486 Mo au frontal public provoque
un rejet immédiat du corps dynamique. Les logs du 2026-08-28 montrent
`statusCode: 200` côté Express puis `request aborted`; le client reçoit `500`
avec zéro octet.

La correction actuelle conserve l'épinglage de génération et la contre-pression,
mais n'envoie plus `Content-Length` au-delà de 32 MiB. La taille reste observable
via `X-Feed-Size` et dans l'état de santé protégé.

## Inventaire des routes

Toutes les URLs ci-dessous sont anonymes. Le préfixe public final est
`https://homestorys-flux.eteamsys.be`.

### Meta

| Usage | URL | Format | Marché/langue | Taille production | HEAD production |
|---|---|---|---|---:|---:|
| Catalogue plat FR | `/api/feeds/meta/fr.csv` | CSV UTF-8 | fr | 300 405 244 | 200 |
| Catalogue plat DE | `/api/feeds/meta/de.csv` | CSV UTF-8 | de | 486 802 649 | 200 |
| Couche base | `/api/feeds/meta/base.csv` | CSV UTF-8 | commun | 463 433 648 | 200 |
| Couche langue FR | `/api/feeds/meta/lang/fr.csv` | CSV UTF-8 | fr | 64 859 087 | 200 |
| Couche langue DE | `/api/feeds/meta/lang/de.csv` | CSV UTF-8 | de | 110 115 299 | 200 |
| Couche pays BE | `/api/feeds/meta/country/BE.csv` | CSV UTF-8 | BE | 3 979 052 | 200 |
| Couche pays FR | `/api/feeds/meta/country/FR.csv` | CSV UTF-8 | FR | 1 908 541 | 200 |
| Couche pays DE | `/api/feeds/meta/country/DE.csv` | CSV UTF-8 | DE | 1 908 596 | 200 |
| Couche pays AT | `/api/feeds/meta/country/AT.csv` | CSV UTF-8 | AT | 1 908 612 | 200 |
| Couche pays CH | `/api/feeds/meta/country/CH.csv` | CSV UTF-8 | CH | 4 426 230 | 200 |
| Couche pays LU | `/api/feeds/meta/country/LU.csv` | CSV UTF-8 | LU | 2 213 149 | 200 |
| Showroom Eupen | `/api/feeds/meta/showroom/eupen.csv` | CSV UTF-8 | de/BE | 346 | 200 |

### Google

| Usage | URL | Format | Marché/langue | Taille production | HEAD production |
|---|---|---|---|---:|---:|
| Agrégé FR | `/api/feeds/google/fr.tsv` | TSV UTF-8 | fr | 219 830 419 | 200 |
| Agrégé DE | `/api/feeds/google/de.tsv` | TSV UTF-8 | de | 381 355 458 | 200 |
| Marché BE_FR | `/api/feeds/google/market/BE_FR.tsv` | TSV UTF-8 | BE/fr | n/a | 404 |
| Marché BE_DE | `/api/feeds/google/market/BE_DE.tsv` | TSV UTF-8 | BE/de | n/a | 404 |
| Marché FR | `/api/feeds/google/market/FR.tsv` | TSV UTF-8 | FR/fr | n/a | 404 |
| Marché DE | `/api/feeds/google/market/DE.tsv` | TSV UTF-8 | DE/de | n/a | 404 |
| Marché AT | `/api/feeds/google/market/AT.tsv` | TSV UTF-8 | AT/de | n/a | 404 |
| Marché CH_DE | `/api/feeds/google/market/CH_DE.tsv` | TSV UTF-8 | CH/de | 76 351 805 | 200 |
| Marché CH_FR | `/api/feeds/google/market/CH_FR.tsv` | TSV UTF-8 | CH/fr | 73 299 307 | 200 |
| Marché LU_DE | `/api/feeds/google/market/LU_DE.tsv` | TSV UTF-8 | LU/de | 76 286 108 | 200 |
| Showroom Eupen | `/api/feeds/google/showroom/eupen.tsv` | TSV UTF-8 | de/BE | 466 | 200 |

Les cinq routes Google en `404` n'ont aucune ligne courante en base de
production. La version corrigée tente le chemin atomique déterministe avant de
conclure à un fichier absent, afin que le dernier objet validé reste servi.

### Routes protégées, hors consommation Google/Meta

| Route | Protection | Usage |
|---|---|---|
| `/api/feeds/google/debug/:file` | secret interne | snapshot de debug |
| `/api/feeds/google/dashboard/:file` | session dashboard | téléchargement opérateur |
| `/api/feeds/snapshots` | session dashboard | liste des snapshots |
| `/api/dashboard/feed-health/files` | session dashboard | santé par fichier |

## Résultats HTTP depuis Internet

- TLS direct, zéro redirection sur toutes les routes testées.
- Aucun cookie, token d'URL ou header d'authentification n'est nécessaire.
- Le frontal ajoute un cookie d'affinité `GAESA`; il n'est pas requis pour une
  requête suivante et ne provient pas de l'authentification dashboard.
- `Content-Type` est correct pour tous les `200` :
  `text/csv; charset=utf-8` ou
  `text/tab-separated-values; charset=utf-8`.
- La version actuellement publiée renvoie
  `Cache-Control: private, max-age=300`. La version de développement impose
  `public, max-age=300` sur les routes publiques et `private, no-store` sur les
  téléchargements dashboard.
- Les quatre User-Agent testés (`curl`, navigateur, `Googlebot/2.1`,
  `facebookexternalhit/1.1`) obtiennent les mêmes statuts, tailles et types.
- Les deux flux showroom ont le même SHA-256 pour les quatre User-Agent.

### GET complets

| Endpoint | Résultat |
|---|---|
| Meta pays BE (3 979 052 octets) | 200, intégral |
| Meta pays CH (4 426 230 octets) | 200, intégral |
| Meta langue FR (64 859 087 octets) | 500, 0 octet |
| Google marché CH_FR (73 299 307 octets) | 500, 0 octet |
| Meta FR/DE/base (300–486 Mo) | 500, 0 octet |
| Google FR/DE (219–381 Mo) | 500, 0 octet |
| Showroom Google (466 octets) | 200, intégral |
| Showroom Meta (346 octets) | 200, intégral |

Le header `Range` est ignoré par le déploiement actuel : un petit fichier est
renvoyé entièrement avec `200`, et un gros fichier échoue de la même façon.

## Validation des contenus récupérables

Les six couches pays Meta ont été téléchargées et parsées avec le module CSV
standard en décodage UTF-8 strict.

| Pays | Lignes | IDs manquants | IDs dupliqués | Prix invalides | Disponibilités invalides | Devise observée |
|---|---:|---:|---:|---:|---:|---|
| BE | 53 989 | 0 | 0 | 0 | 0 | EUR |
| FR | 26 994 | 0 | 0 | 0 | 0 | EUR |
| DE | 26 995 | 0 | 0 | 0 | 0 | EUR |
| AT | 26 995 | 0 | 0 | 0 | 0 | EUR |
| CH | 43 798 | 0 | 0 | 0 | 0 | **EUR** |
| LU | 21 899 | 0 | 0 | 0 | 0 | EUR |

Colonnes vérifiées :
`id, price, sale_price, sale_price_effective_date, availability, shipping`.
Toutes les disponibilités appartiennent aux valeurs Meta acceptées.

Anomalie métier : `config/markets.yaml` configure les marchés suisses en CHF,
mais la couche pays CH publiée contient des prix EUR. Ce point nécessite une
correction dédiée du calcul de prix suisse ; il n'est pas masqué par la
validation syntaxique.

Les deux fichiers showroom sont des fichiers d'en-tête valides en UTF-8, avec
zéro produit. Il n'existe donc aucun ID, prix, disponibilité ou URL produit à
contrôler dans ces snapshots.

Les grandes couches Meta et les TSV Google n'ont pas pu être parsés depuis
Internet, car le `GET` de production est interrompu avant le premier octet. Les
validateurs locaux couvrent les champs obligatoires, URLs HTTPS, formats de
prix, disponibilités, UTF-8 strict et unicité des IDs.

## État des snapshots et fraîcheur

Lecture en production effectuée en lecture seule :

- snapshots Google/Meta courants générés principalement le 2026-08-21 ;
- showroom généré le 2026-08-20 avec zéro produit ;
- plusieurs synchronisations complètes ultérieures ont été marquées en échec
  après redémarrage du processus ;
- des alertes `meta_feed_stale` sont présentes jusqu'au 2026-08-27.

Le nouvel endpoint protégé `/api/dashboard/feed-health/files` expose pour chaque
snapshot courant :

- statut ;
- canal, langue, marché et format ;
- URL publique finale ;
- nombre de produits et date de génération ;
- taille App Storage ;
- validité au moment de la publication ;
- dernière erreur de canal/fichier.

## Tests locaux

Les tests ajoutés couvrent :

- inventaire des routes stables Meta, Google et showroom ;
- accès anonyme, headers et `HEAD` sans lecture du corps ;
- parité curl/navigateur/Googlebot/Meta ;
- `404` fichier absent et `503` stockage indisponible ;
- transfert progressif au-delà de 32 MiB ;
- secours Google vers le dernier chemin courant déterministe ;
- arrêt du stream après déconnexion client ;
- UTF-8 strict et IDs uniques ;
- mapping des snapshots vers les URLs publiques ;
- protection de l'état de santé détaillé.

## Revalidation après publication

La publication corrigée a démarré à `2026-08-28T18:38:43Z` et le processus
applicatif a chargé les 8 marchés et les 4 langues. Les routes de santé
`/api/health` et `/api/healthz` répondent directement en `200`.

La synchronisation de prix déclenchée via le dashboard protégé s'est terminée
avec succès :

- début : `2026-08-28T18:40:16.711Z` ;
- fin : `2026-08-28T19:03:57.549Z` ;
- durée : 1 420 855 ms ;
- variantes lues : 38 399 ;
- écritures de prix marché : 307 192 ;
- erreurs : 0 ;
- avertissements : 0.

La liste de prix Shopify `CH_DE` a chargé 38 399 overrides. Le code publié
utilise cette tarification contextuelle CHF pour `CH_DE` et son alias
linguistique `CH_FR`.

L'export Google et Meta a été déclenché immédiatement après la réussite de la
synchronisation de prix. Les premières générations Google ont donné :

| Marché | Lignes générées | Validation | Publication |
|---|---:|---|---|
| BE_FR | 21 482 | schéma valide | bloquée, baisse de 20,4 % |
| BE_DE | 21 482 | schéma valide | bloquée, baisse de 20,4 % |
| FR | 21 482 | schéma valide | bloquée, baisse de 20,4 % |

Le seuil configuré est de 10 %. Chaque blocage conserve donc le dernier
snapshot valide et journalise le marché, le nombre précédent, le nouveau
nombre et le pourcentage de baisse. Aucun webhook d'alerte n'a été envoyé car
`ALERT_WEBHOOK_URL` n'est pas configuré. Le run poursuit les autres marchés en
arrière-plan ; aucune publication partielle n'est forcée.

Les quatre User-Agent testés (curl, navigateur, Googlebot et Meta) ont reçu le
même statut et les mêmes métadonnées. Les URLs ne demandent ni cookie, ni
jeton, ni authentification et ne redirigent pas vers une preview.

Un GET complet post-publication sur
`/api/feeds/google/market/CH_DE.tsv` a encore reçu un statut `500`. Il n'a donc
pas été possible de comparer ses octets à `X-Feed-Size` ni de parser le TSV
depuis Internet. Les petits flux pays Meta restent récupérables intégralement ;
par exemple `/api/feeds/meta/country/CH.csv` répond `200` avec 4 426 230
octets, en CSV UTF-8.

Les téléchargements complets de contrôle post-publication restent suivis par
la tâche dédiée déjà créée pour la prochaine publication valide, notamment :

1. `/api/feeds/meta/base.csv`
2. `/api/feeds/meta/fr.csv`
3. `/api/feeds/google/fr.tsv`
4. `/api/feeds/google/market/BE_FR.tsv`
5. les deux flux showroom

Pour chaque fichier, il faudra comparer le nombre d'octets reçu à
`X-Feed-Size`, parser le fichier complet, et confirmer l'absence de troncature
ou de timeout après qu'un export aura franchi le garde-fou d'éligibilité.

## Analyse différentielle finale BE_FR

La comparaison brute était trompeuse : l'ancien snapshot utilise l'UUID de
variante seul, tandis que le snapshot bloqué du 28 août utilise
`UUID:BE_FR`. Après suppression contrôlée de ce suffixe, les ensembles se
réconcilient ainsi :

| Population | Nombre |
|---|---:|
| IDs ancien snapshot | 26 994 |
| IDs nouveau snapshot | 21 482 |
| IDs identiques après normalisation | 21 442 |
| IDs présents uniquement dans l'ancien | 5 552 |
| IDs présents uniquement dans le nouveau | 40 |
| Baisse nette | 5 512 |

Le détail exact est conservé dans
`docs/feed-diff-be-fr-2026-08-28.csv`.

| Cause | Nombre | % des 5 552 sorties | Légitime/anormal | Action |
|---|---:|---:|---|---|
| Marque exclue par la politique Channable | 5 076 | 91,43 % | Légitime selon `config/exclusions.yaml` | Conserver la règle ; faire valider la baisse par l'opérateur |
| Type produit exclu par la politique Channable | 475 | 8,56 % | Légitime selon `config/exclusions.yaml` | Conserver la règle ; faire valider la baisse par l'opérateur |
| Produit archivé | 1 | 0,02 % | Légitime | Aucune action |
| Variante supprimée ou absente | 0 | 0 % | — | — |
| Ligne marché absente/inéligible | 0 | 0 % | — | — |
| Prix absent, nul ou devise BE_FR incorrecte | 0 | 0 % | — | — |
| Autre cause non expliquée | 0 | 0 % | — | — |

Répartition des exclusions de marque : Fermob 4 163, Brokis 223, Umbrosa
198, Gubi 122, Extremis 111, Ofyr 109, Piffany 104, Thonet 46 et Spotted 1.
Les 475 exclusions restantes sont entièrement expliquées par les types de
produit configurés. Il n'existe donc aucun signal de pagination Shopify
incomplète ni de perte des 38 399 variantes.

Les 40 nouveaux IDs appartiennent à 16 produits Vincent Sheppard déjà présents
dans la base ; ils sont désormais éligibles. Leur cause historique exacte
d'inéligibilité n'est pas récupérable dans l'état courant, car `feed_items` est
mis à jour en place et ne conserve pas l'ancienne raison.

Le changement d'ID est en revanche anormal pour un flux par marché : il
recréerait toutes les offres côté Merchant Center. La correction locale
conserve désormais l'UUID historique dans chaque flux marché. Le suffixe marché
reste limité aux flux agrégés par langue, où il est nécessaire pour éviter des
IDs dupliqués entre pays.

## Correction locale du HTTP 500 des gros flux

Le transfert progressif seul ne suffit pas : le frontal public interrompt les
réponses dynamiques de plus de 32 MiB, même lorsque le backend stream
correctement depuis App Storage. La correction locale ajoute un dérivé gzip
streamé pour chaque gros snapshot validé :

- le TSV/CSV brut, son hash et son manifeste restent inchangés ;
- le gzip est créé après le garde-fou mais avant le remplacement du pointeur
  courant ;
- une erreur de compression conserve donc l'ancien snapshot valide ;
- la route sert le gzip avec `Content-Encoding: gzip`, une longueur compressée
  connue, `X-Feed-Size` pour la taille brute et `X-Feed-Compressed-Size` ;
- le stream GCS est lu avec `decompress: false` pour éviter un double décodage.

Un backfill limité aux snapshots courants a créé 15 dérivés gzip. Aucune version
bloquée et aucun manifeste courant n'ont été modifiés. Toutes les représentations
compressées mesurées restent sous 32 MiB ; par exemple :

| Flux | Taille brute | Taille gzip |
|---|---:|---:|
| Google CH_DE | 76 351 805 | 2 370 304 |
| Google agrégé DE | 381 355 458 | 26 357 201 |
| Meta base | 463 433 648 | 9 885 963 |
| Meta DE | 486 802 649 | 28 579 298 |

### GET complets via le domaine externe de développement

| Endpoint | HTTP | Octets bruts après décodage | Octets transférés | Durée | Parsing |
|---|---:|---:|---:|---:|---|
| Google `CH_DE` | 200 | 76 351 805 | 2 370 304 | 0,93 s | 21 899 lignes, 21 899 IDs uniques |
| Meta base | 200 | 463 433 648 | 9 885 963 | 2,42 s | 175 192 lignes, 175 192 IDs uniques |
| Meta DE | 200 | 486 802 649 | 28 579 298 | 3,72 s | 132 661 lignes, 132 661 IDs uniques |

Les URLs et images contrôlées sont absolues en HTTPS, les disponibilités sont
valides et aucun ID vide ou dupliqué n'a été détecté. Curl, navigateur,
Googlebot et `facebookexternalhit` reçoivent tous `200` et exactement
2 370 304 octets transférés pour `CH_DE`.

### Limites de la validation actuelle

Le domaine de production utilise encore l'ancien build. Au dernier contrôle,
les trois GET suivants renvoient toujours `500` avec zéro octet et sans
redirection :

- `/api/feeds/google/market/CH_DE.tsv` ;
- `/api/feeds/meta/base.csv` ;
- `/api/feeds/meta/de.csv`.

Une nouvelle publication manuelle de l'application est donc nécessaire avant
de pouvoir reproduire les preuves ci-dessus sur
`https://homestorys-flux.eteamsys.be`.

Enfin, les données de production ne permettent pas de confirmer le CHF :
`market_variants` contient actuellement 38 399 lignes `CH_DE` et 38 399 lignes
`CH_FR` en EUR, dont 4 172 prix nuls par marché. Le snapshot Google `CH_DE`
courant contient lui aussi 21 899 prix EUR. Aucun flux suisse ne doit donc être
publié ni déclaré sûr avant correction et nouvelle synchronisation des prix
suisses. Le seuil de 10 % n'a pas été modifié et aucun snapshot bloqué n'a été
forcé.

## État de publication sûre au 28 août 2026

| Groupe | État |
|---|---|
| Flux non suisses actuellement courants | Derniers snapshots valides conservés ; gros GET production à revalider après publication du build |
| Nouveau Google BE_FR/BE_DE/FR | Schéma valide mais publication bloquée à juste titre par la baisse de 20,4 % ; validation opérateur requise |
| Google/Meta Suisse | Non publiable : prix de production encore en EUR |
| Flux showroom | Publiables techniquement, mais snapshots courants vides |