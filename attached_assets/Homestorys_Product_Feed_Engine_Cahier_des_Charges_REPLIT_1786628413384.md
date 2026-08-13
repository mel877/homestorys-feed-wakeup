# Homestorys Product Feed Engine — Cahier des charges autonome
## Shopify → Google Merchant Center + Meta Catalog — sans Channable — GitHub + Replit

**Version :** 1.1 — Replit-native  
**Date :** 2026-08-13  
**Statut :** Spécification exécutable pour Replit Agent  
**Objectif :** permettre à Replit Agent de concevoir, développer, tester, déployer et documenter en autonomie un moteur de flux produit complet pour Homestorys, sans dépendance à Channable.

**Plateforme cible :** Replit (Project Editor + Agent + Replit Database + App Storage + Publishing).  
**Principe Shopify :** ne pas créer un nouveau store Replit ; le moteur doit se brancher sur le store Homestorys existant. L'intégration Shopify native Replit n'est utilisée que si elle supporte explicitement ce cas et les scopes Admin requis ; sinon custom app Shopify Admin GraphQL.

---

# 0. Rôle de Replit Agent

Tu agis comme un **architecte logiciel senior**, **data engineer e-commerce**, **spécialiste Shopify**, **spécialiste Google Merchant Center / Merchant API**, **spécialiste Meta Catalog**, **spécialiste Replit** et **spécialiste qualité des données produit**.

Tu dois prendre les décisions techniques les plus bénéfiques au projet sans demander au propriétaire du projet de choisir une librairie, une architecture, une structure de données, un mode d'hébergement, une stratégie de synchronisation ou un format de flux.

Tu peux demander uniquement :
1. un secret/API credential réellement manquant ;
2. un identifiant externe introuvable automatiquement ;
3. une information business impossible à déduire sans inventer une donnée (ex. tarif réel de livraison si aucune source ne l'expose) ;
4. une action d'autorisation humaine imposée par Google, Meta, Shopify ou Replit.

Tu ne dois pas demander :
- quel langage utiliser ;
- quel framework utiliser ;
- quelle base de données utiliser ;
- s'il faut utiliser API ou fichier lorsque la documentation permet de choisir ;
- comment organiser les dossiers ;
- quelle stratégie de cache choisir ;
- comment structurer les tests ;
- quelle convention de nommage employer ;
- quel scheduler employer ;
- quelle méthode de déploiement Replit employer.

Tu choisis ces éléments toi-même, en privilégiant :
- simplicité ;
- robustesse ;
- coûts maîtrisés ;
- observabilité ;
- possibilité de rollback ;
- compatibilité Replit ;
- maintenabilité ;
- conformité aux API officielles ;
- minimisation des données dupliquées.

---

# 1. Contexte business

## 1.1 Entreprise

**Homestorys** est une enseigne de mobilier, décoration et lifestyle premium / luxe.

Positionnement :
- mobilier haut de gamme ;
- design élégant et contemporain ;
- matériaux qualitatifs ;
- grandes marques belges et internationales ;
- conseil ;
- livraison premium ;
- montage ;
- showroom physique à Eupen ;
- modèles d'exposition ;
- outlet ;
- promotions saisonnières ;
- produits indoor et outdoor.

Le moteur doit préserver un positionnement premium : aucune règle ne doit transformer automatiquement les titres produits en annonces « discount », « cheap », « promo agressive », etc.

## 1.2 E-commerce

Plateforme source : **Shopify**.

Shopify est la **source de vérité** pour :
- produits ;
- variantes ;
- prix ;
- compare-at prices ;
- disponibilités ;
- stocks ;
- collections ;
- marques/vendors ;
- images ;
- contenus localisés ;
- marchés ;
- devises ;
- URLs ;
- metafields ;
- locations ;
- informations de vente lorsque les scopes le permettent.

## 1.3 Channable

Le système actuel utilise Channable.

**Le nouveau système doit supprimer toute dépendance runtime à Channable.**

Channable peut uniquement servir de **référence de migration** :
- exports actuels ;
- captures de règles ;
- mappings ;
- historiques de flux ;
- structure des données envoyées aux plateformes.

Aucun code final ne doit :
- appeler une API Channable ;
- dépendre d'un export Channable ;
- attendre un fichier Channable pour fonctionner ;
- reproduire inutilement une architecture « un flux = un pays ».

---

# 2. Objectifs métier

Le nouveau système doit :

1. remplacer Channable ;
2. construire les données directement à partir de Shopify ;
3. centraliser les règles produit ;
4. réduire drastiquement la duplication par pays ;
5. organiser la logique autour de **masters linguistiques + overrides marché** ;
6. alimenter Google Merchant Center ;
7. alimenter Meta Catalog ;
8. gérer plusieurs pays partageant la même langue ;
9. gérer prix et disponibilité spécifiques par marché ;
10. gérer promotions et soldes automatiquement ;
11. identifier automatiquement les produits soldés ;
12. permettre l'identification des best-sellers ;
13. gérer outlet et modèles d'exposition ;
14. améliorer la sélection des images ;
15. ne pas privilégier les images sans contexte pour Meta quand une meilleure mise en situation existe ;
16. préserver les packshots conformes utiles pour Google ;
17. exploiter le stock du showroom d'Eupen ;
18. générer les données nécessaires au Local Inventory Google ;
19. exposer collecte/disponibilité en magasin ;
20. supporter recommandations de produits similaires ;
21. supporter produits complémentaires ;
22. proposer un mécanisme « Vous aimerez aussi » ;
23. gérer correctement les produits temporairement indisponibles ;
24. gérer les produits définitivement arrêtés ;
25. produire des données produit riches et complètes ;
26. détecter automatiquement les erreurs de flux ;
27. mettre à jour régulièrement prix, stock, promotions et contenus ;
28. offrir un dashboard technique de santé des flux ;
29. permettre un rollback ;
30. fonctionner intégralement sur GitHub + Replit.

---

# 3. Architecture conceptuelle cible

```text
SHOPIFY
│
├── Products
├── Variants
├── Collections
├── Vendors / Brands
├── Metafields
├── Translations / Locales
├── Shopify Markets
├── Market contextual pricing
├── Images / Media
├── Inventory Items
├── Inventory Levels
├── Locations
└── Orders / sales signals si autorisés
        │
        ▼
EXTRACTION LAYER
        │
        ▼
CANONICAL PRODUCT MODEL
        │
        ├── normalization
        ├── enrichment
        ├── promotion engine
        ├── image ranking
        ├── stock engine
        ├── category mapping
        ├── product quality
        ├── bestseller scoring
        └── recommendation engine
        │
        ▼
LANGUAGE LAYER
│
├── MASTER_FR
├── MASTER_DE
├── MASTER_EN
└── MASTER_IT
        │
        ▼
MARKET OVERRIDES
│
├── BE_FR
├── BE_DE
├── FR
├── DE
├── AT
└── extensible
        │
        ├──────────────────────────┐
        ▼                          ▼
GOOGLE EXPORTER               META EXPORTER
        │                          │
Merchant API                  Catalog feed/API
Products                      localized data
Local inventory               scheduled refresh
Diagnostics
        │                          │
        └──────────────┬───────────┘
                       ▼
               FEED HEALTH / LOGS
```

Le principe fondamental est : **une règle métier n'existe qu'une seule fois**.

---

# 4. Choix technologiques par défaut

Replit Agent doit vérifier les documentations officielles au moment de l'implémentation et peut ajuster un choix si une contrainte nouvelle le justifie.

Choix recommandé par défaut :

- **Langage : TypeScript**
- **Runtime : Node.js LTS supporté par Replit**
- **Framework : Next.js App Router** si cela simplifie API + dashboard ; sinon backend TypeScript minimal compatible avec Replit Publishing.
- **Package manager : pnpm**
- **Validation : Zod**
- **DB : Replit Database PostgreSQL** (Production Database pour la production)
- **ORM : Drizzle ORM** ou alternative PostgreSQL plus adaptée si la documentation actuelle le justifie
- **Object storage : Replit App Storage** via le SDK officiel `@replit/object-storage`
- **Déploiement web/API : Reserved VM par défaut** pour garantir un endpoint Shopify toujours disponible et permettre un worker de fond continu ; Autoscale uniquement si l'architecture finale n'exige aucun worker continu.
- **Scheduler : scheduler persistant dans le worker Reserved VM par défaut**, avec locks/checkpoints en PostgreSQL ; utiliser Replit Scheduled Deployments pour les tâches périodiques indépendantes uniquement si la configuration Replit courante permet de les exploiter proprement sans fragiliser le déploiement principal.
- **Observabilité : Replit deployment logs + tables de run + dashboard de santé**
- **Secrets : Replit Secrets / deployment secrets**
- **Tests : Vitest**
- **Lint : ESLint**
- **Formatting : Prettier**
- **CI : GitHub Actions**
- **Deployment : Replit Publishing**
- **Source control : GitHub + Git intégré Replit**

Si une technologie est dépréciée ou n'est plus la meilleure option :
1. consulter la documentation officielle actuelle ;
2. sélectionner l'alternative la plus sûre ;
3. documenter la décision dans `docs/adr/` ;
4. continuer sans demander de décision au propriétaire.

---

# 5. Contraintes Replit

Le projet doit être conçu **pour Replit**, pas seulement rendu compatible a posteriori.

## 5.1 Type de déploiement

Architecture de production par défaut :

- **Reserved VM** pour l'application web/API, le dashboard, la réception des webhooks Shopify et le worker de fond ;
- le worker Reserved VM assure par défaut les réconciliations périodiques via un scheduler applicatif robuste avec locks PostgreSQL ;
- **Scheduled Deployments** peuvent être utilisés pour certains jobs périodiques indépendants si Replit Agent vérifie que cette configuration coexiste proprement avec le déploiement principal ; sinon ne pas créer une seconde architecture inutile ;
- **Autoscale** peut remplacer Reserved VM uniquement si Replit Agent démontre que tous les traitements asynchrones sont externalisés de manière fiable et qu'aucun worker continu n'est requis.

Ne pas dégrader le produit pour respecter un plan gratuit. Choisir la taille de machine et le type de publication adaptés à la charge réelle.

## 5.2 Tâches longues et synchronisations

Ne jamais supposer qu'un seul processus doit synchroniser tout le catalogue en mémoire ou en une seule transaction.

Pour les synchronisations volumineuses :
- batcher ;
- paginer ;
- utiliser cursors/checkpoints ;
- rendre les opérations idempotentes ;
- persister la progression en PostgreSQL ;
- séparer extraction, transformation et publication quand nécessaire ;
- respecter les rate limits Shopify / Google / Meta ;
- reprendre après erreur ;
- configurer explicitement le timeout des Scheduled Deployments lorsque la tâche est planifiée ;
- si une tâche devient continue ou trop longue pour un Scheduled Deployment, la déplacer vers le worker Reserved VM au lieu de forcer le scheduler.

## 5.3 Webhooks Shopify

Le endpoint Shopify doit répondre rapidement.

Traitement recommandé :
1. vérifier la signature HMAC ;
2. enregistrer l'événement dans `webhook_events` ;
3. répondre HTTP 2xx rapidement ;
4. traiter l'événement de façon idempotente via worker ;
5. conserver retry, statut et erreur en DB.

Ne pas dépendre d'une mémoire de processus pour garantir la livraison.

## 5.4 Stockage et persistance

Ne jamais conserver les états critiques uniquement dans le filesystem du déploiement Replit. Le filesystem publié doit être considéré comme non durable entre publications/instances.

Persistences :
- **Replit Database PostgreSQL** : catalogue canonique, sync state, checksums, historique, diagnostics, recommandations, queue logique et événements webhook ;
- **Replit App Storage** : snapshots de feeds, manifests, archives et fichiers servis aux plateformes ;
- **Replit Secrets / deployment secrets** : credentials et secrets.

Les fichiers générés temporairement peuvent utiliser `/tmp` ou le filesystem local uniquement comme espace de travail éphémère avant upload vers App Storage.

## 5.5 Environnements

Prévoir au minimum :
- Development dans l'éditeur Replit ;
- Preview / dry-run ;
- Production publiée.

La Production Database doit être séparée des données de développement lorsque Replit le permet. Les écritures Google/Meta production restent désactivées en preview.

---

# 6. GitHub

Repository propre avec :
- `main` = production ;
- feature branches pendant développement ;
- CI obligatoire.

CI :
- typecheck ;
- lint ;
- unit tests ;
- integration tests offline ;
- schema validation ;
- feed fixture validation.

Aucun secret dans Git.

---

# 7. Arborescence cible

```text
homestorys-feed-engine/
├── app/ ou src/server/
├── src/
│   ├── config/
│   ├── shopify/
│   ├── canonical/
│   ├── normalization/
│   ├── enrichment/
│   ├── promotions/
│   ├── inventory/
│   ├── images/
│   ├── localization/
│   ├── markets/
│   ├── categories/
│   ├── recommendations/
│   ├── validation/
│   ├── exporters/
│   │   ├── google/
│   │   └── meta/
│   ├── google/
│   ├── meta/
│   ├── jobs/
│   ├── webhooks/
│   ├── observability/
│   └── lib/
├── config/
│   ├── markets.yaml
│   ├── languages.yaml
│   ├── stores.yaml
│   ├── shipping.yaml
│   ├── returns.yaml
│   ├── categories.yaml
│   ├── complementary.yaml
│   ├── labels.yaml
│   ├── recommendations.yaml
│   └── feed-policy.yaml
├── schemas/
│   ├── canonical-product.schema.json
│   ├── google-product.schema.json
│   └── meta-product.schema.json
├── tests/
│   ├── fixtures/
│   ├── unit/
│   ├── integration/
│   └── regression/
├── scripts/
│   ├── audit-shopify.ts
│   ├── audit-old-feeds.ts
│   ├── bootstrap-db.ts
│   ├── compare-feeds.ts
│   └── backfill.ts
├── docs/
│   ├── architecture.md
│   ├── setup.md
│   ├── api-access.md
│   ├── google-merchant.md
│   ├── meta-catalog.md
│   ├── data-model.md
│   ├── synchronization.md
│   ├── image-policy.md
│   ├── recommendation-policy.md
│   ├── migration.md
│   ├── operations.md
│   ├── troubleshooting.md
│   └── adr/
├── public/
├── .env.example
├── .replit
├── replit.md
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

---

# 8. APIs de base à prévoir dès le setup

## 8.1 Shopify

### Politique Replit / Shopify

Replit dispose d'une intégration Shopify native. Cependant, la documentation Replit actuelle indique que cette intégration **provisionne un nouveau development store Shopify lié à l'application Replit**. Elle ne doit donc pas être supposée capable de connecter directement le store Homestorys existant avec tous les scopes Admin nécessaires à ce moteur de flux.

Pour Homestorys :
1. auditer d'abord si une connexion Replit officielle peut accéder **au store existant** et fournir exactement les scopes Admin requis sans migration de store ;
2. si oui, l'utiliser pour réduire la gestion manuelle des credentials ;
3. sinon — comportement attendu par défaut pour un store existant — créer/utiliser une **custom app Shopify** avec Admin GraphQL API ;
4. ne jamais créer un nouveau store Shopify Replit comme remplacement du store Homestorys ;
5. Shopify reste la source de vérité.

Créer/utiliser une **custom app Shopify** avec Admin GraphQL API lorsque l'intégration Replit native ne couvre pas le store existant et les scopes requis.

Utiliser la dernière version stable supportée au moment du développement et **la pinner explicitement**.

Scopes minimaux à auditer :

```text
read_products
read_inventory
read_locations
read_markets
read_translations
read_locales
read_publications
```

Pour bestseller scoring si nécessaire :

```text
read_orders
```

`read_all_orders` uniquement si réellement indispensable et autorisé.

Aucun `write_products` par défaut.

Variables :

```env
SHOPIFY_SHOP_DOMAIN=
SHOPIFY_ADMIN_ACCESS_TOKEN=
SHOPIFY_API_VERSION=
SHOPIFY_WEBHOOK_SECRET=
```

Au bootstrap :
- vérifier les scopes ;
- ne logger que leurs noms ;
- ne jamais logger token ou secret.

## 8.2 Google Merchant Center

Utiliser la **Merchant API actuelle**, pas une ancienne API dépréciée.

Prévoir :
- authentification Google ;
- Merchant Account ID ;
- Data Sources ;
- product insert/update/delete ;
- diagnostics ;
- inventaire local ;
- dry-run.

```env
GOOGLE_MERCHANT_ACCOUNT_ID=
GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=
GOOGLE_DRY_RUN=true
```

Si une méthode d'auth sécurisée supportée nativement par Replit est meilleure qu'une clé statique, la choisir et la documenter.

## 8.3 Meta

Prévoir :
- Meta Business ;
- Catalog ID ;
- token système ou méthode recommandée ;
- feed / Feed API ;
- localized catalog.

```env
META_CATALOG_ID=
META_ACCESS_TOKEN=
META_BUSINESS_ID=
META_DRY_RUN=true
```

## 8.4 Replit

Les credentials Replit Database sont fournis par l'environnement Replit. Ne pas hardcoder une chaîne de connexion si Replit la fournit automatiquement.

```env
DATABASE_URL=
APP_STORAGE_BUCKET_ID=
APP_BASE_URL=
INTERNAL_API_SECRET=
APP_ENV=development
```

`APP_STORAGE_BUCKET_ID` peut être omis si le SDK officiel Replit utilise automatiquement le bucket par défaut associé à l'application.

Les secrets doivent être ajoutés dans **Replit Secrets** et, pour la production, vérifiés dans les **deployment secrets**. Aucun secret ne doit être commité dans Git.

---

# 9. Données à fournir à Replit Agent

Créer :

```text
/input/
```

Structure souhaitée :

```text
/input/
├── business-rules.md
├── shipping/
│   └── shipping-rules.xlsx
├── returns/
│   └── return-rules.xlsx
├── categories/
│   └── category-mapping.xlsx
└── channable-reference/
    ├── google-fr.csv
    ├── google-de.csv
    ├── google-be.csv
    ├── meta-fr.csv
    ├── meta-de.csv
    ├── rules/
    └── screenshots/
```

Les données Channable sont uniquement une baseline de migration.

Si certains fichiers manquent :
- compenser via API si possible ;
- produire `docs/data-gaps.md` ;
- ne rien inventer.

---

# 10. Modèle produit canonique

Chaque **variante vendable** devient une entité canonique.

```ts
type CanonicalProduct = {
  id: string
  productId: string
  variantId: string
  itemGroupId: string

  sku: string | null
  gtin: string | null
  mpn: string | null
  identifierExists: boolean

  brand: string
  vendor: string | null

  language: 'fr' | 'de' | 'en' | 'it'
  market: string

  title: string
  description: string
  productType: string | null
  collections: string[]

  googleProductCategory: string | null
  metaProductCategory: string | null

  material: string[]
  color: string[]
  style: string[]
  room: string[]
  indoorOutdoor: 'indoor' | 'outdoor' | 'both' | null

  price: Money
  compareAtPrice: Money | null
  salePrice: Money | null

  isOnSale: boolean
  discountPercentage: number | null
  discountBucket: string

  isOutlet: boolean
  isExhibitionModel: boolean
  isBestseller: boolean
  isNew: boolean

  availability: string
  stockTotal: number | null
  stockOnline: number | null
  stockEupen: number | null
  pickupEupen: boolean

  primaryImage: ImageAsset | null
  lifestyleImage: ImageAsset | null
  additionalImages: ImageAsset[]

  productUrl: string

  shippingClass: string | null
  returnClass: string | null

  relatedProductIds: string[]
  complementaryProductIds: string[]

  customLabels: Record<string, string>

  sourceUpdatedAt: string
  generatedAt: string
}
```

---

# 11. Règle absolue : ne jamais inventer

Interdit :
- GTIN fictif ;
- MPN fictif ;
- matériau sans source ;
- couleur déduite de manière incertaine ;
- prix transformé ;
- faux stock ;
- délai de livraison inventé ;
- politique de retour inventée ;
- fausse promotion ;
- bestseller non justifié ;
- exclusivité non sourcée.

Si une donnée manque :
1. laisser vide si possible ;
2. exclure si obligatoire ;
3. produire un diagnostic ;
4. recommander un metafield.

---

# 12. Metafields Shopify

Auditer avant création.

Namespace recommandé :

```text
feed
```

Candidats :

```text
feed.bestseller
feed.outlet
feed.exhibition_model
feed.exhibition_store

feed.material
feed.style
feed.room
feed.indoor_outdoor

feed.shipping_class
feed.return_class

feed.google_product_category
feed.meta_product_category

feed.lifestyle_image_override
feed.primary_image_override

feed.discontinued
```

Ne pas dupliquer une donnée déjà fiable.

---

# 13. Langues / marchés

Masters :

```text
FR
DE
EN
IT
```

Marchés initiaux :

```yaml
BE_FR:
  country: BE
  language: fr
  currency: EUR

BE_DE:
  country: BE
  language: de
  currency: EUR

FR:
  country: FR
  language: fr
  currency: EUR

DE:
  country: DE
  language: de
  currency: EUR

AT:
  country: AT
  language: de
  currency: EUR
```

Le contenu allemand vient une fois de `MASTER_DE`.

DE / AT / BE_DE n'appliquent que :
- prix ;
- devise ;
- URL ;
- livraison ;
- retour ;
- disponibilité ;
- contraintes locales.

---

# 14. Prix par marché

Shopify Markets est source de vérité.

Pour chaque variante + marché :
- prix effectif ;
- compare-at effectif si disponible ;
- devise ;
- URL cohérente ;
- disponibilité.

Interdit :
- conversion FX maison arbitraire ;
- prix Google différent de Shopify ;
- application d'un prix d'un marché à un autre.

---

# 15. Promotions / soldes

```text
IF compare_at_price > price
THEN is_on_sale = true
```

```text
discount_percentage =
((compare_at_price - price) / compare_at_price) * 100
```

Buckets :

```text
none
1_10
11_20
21_30
31_50
51_70
70_plus
```

Mise à jour automatique dès modification Shopify.

Ne pas injecter automatiquement « Summer Sales », « -15 % », « -70 % » dans les titres standards.

---

# 16. Outlet

```text
is_outlet = feed.outlet == true
```

Si le metafield n'existe pas :
- utiliser collection/tag uniquement s'il est fiable ;
- sinon créer un data gap.

---

# 17. Modèles d'exposition

Données :

```text
is_exhibition_model
exhibition_store
stock_eupen
```

Les modèles d'exposition doivent être segmentables pour :
- Outlet ;
- Showroom ;
- Eupen ;
- retrait magasin.

Ne jamais modifier leur condition produit sans source.

---

# 18. Best-sellers

Priorité :
1. `feed.bestseller` ;
2. scoring ventes ;
3. aucune qualification.

Scoring si données disponibles :

```text
score =
sales_30d * 0.55
+ sales_60d * 0.20
+ revenue_normalized * 0.15
+ stock_health * 0.10
```

Normaliser par catégorie.

Classes :

```text
bestseller
high
medium
low
```

Recalcul quotidien.

---

# 19. Images

## Objectif Meta

Privilégier une image en situation quand elle montre clairement le bon produit.

## Objectif Google

Conserver une image principale fidèle et conforme ; exploiter les images additionnelles et lifestyle.

## Analyse déterministe

Utiliser `sharp` ou meilleure alternative Node/Replit actuelle.

Calculer :
- width ;
- height ;
- aspect ratio ;
- alpha ratio ;
- white background score ;
- solid background score ;
- edge density ;
- variance ;
- resolution score ;
- URL hash.

Classer :

```text
lifestyle
packshot_white
packshot_solid
packshot_transparent
detail
invalid
unknown
```

Meta priority :
1. override Shopify ;
2. lifestyle ;
3. contextuel ;
4. packshot ;
5. exclusion si aucune image valide.

Google priority :
1. image produit claire ;
2. override explicite ;
3. packshot haute qualité ;
4. lifestyle si conforme.

Ne jamais :
- générer une image IA ;
- éditer automatiquement une image Shopify ;
- ajouter du texte promotionnel ;
- choisir une image ne montrant pas clairement le produit.

---

# 20. Inventaire

Récupérer par variante/location.

```text
stock_total
stock_online
stock_eupen
availability_online
availability_eupen
pickup_eupen
```

Règles :

```text
stock > 0 -> in_stock
stock == 0 AND sell_when_out_of_stock -> backorder
stock == 0 AND not sell_when_out_of_stock -> out_of_stock
```

---

# 21. Showroom Eupen

Config :

```yaml
stores:
  eupen:
    shopify_location_id: REQUIRED_FROM_API_OR_ENV
    google_store_code: REQUIRED
    name: Homestorys Eupen
```

Adresse :

```text
Industriestraße 38
4700 Eupen
Belgium
```

Détecter automatiquement la location Shopify Eupen.

Ne jamais deviner le Google Store Code.

---

# 22. Google Local Inventory

Objectifs :
- disponibilité en magasin ;
- quantité ;
- prix local si pertinent ;
- retrait/collecte.

Utiliser la méthode officielle actuelle la plus adaptée :
- Merchant Inventories sub-API quand possible ;
- file input si requis par la fonctionnalité.

Isoler :
- primary product sync ;
- local inventory sync.

---

# 23. Produits indisponibles

États :

```text
in_stock
low_stock
backorder
out_of_stock
discontinued
```

Temporairement indisponible :
- conserver PDP ;
- envoyer `out_of_stock` ;
- ne pas rediriger Google vers une catégorie.

Discontinued :
- retirer des feeds Ads ;
- conserver historique ;
- proposer alternatives/storefront replacement.

Le besoin « renvoyer vers catégorie si produit disparu » s'applique au storefront **après retrait des feeds Ads**, jamais comme faux lien produit Google/Meta.

---

# 24. « Vous aimerez aussi »

Recommendation engine :

```text
same product type       +30
same brand              +20
same collection         +20
same style              +10
same material           +10
similar price           +10
```

Filtres :
- pas le produit courant ;
- pas discontinued ;
- préférer in stock ;
- marché valide ;
- langue valide.

Prix :
```text
±20 %
```

Si insuffisant :
- ±30 % ;
- ±40 % maximum par défaut.

Top N :
```text
8
```

---

# 25. Produits complémentaires

```yaml
sofa:
  - coffee_table
  - rug
  - side_table
  - lighting

dining_table:
  - dining_chair
  - pendant_light
  - sideboard

coffee_table:
  - sofa
  - rug
  - side_table

bed:
  - bedside_table
  - lighting
  - rug

outdoor_sofa:
  - outdoor_coffee_table
  - outdoor_side_table
  - outdoor_lighting
```

Priorité :
1. recommandations manuelles Shopify ;
2. mapping business ;
3. scoring automatique.

---

# 26. Endpoint recommandations

```text
GET /api/recommendations/:productId?market=BE_DE&limit=8
```

Réponse :

```json
{
  "productId": "...",
  "related": [],
  "complementary": []
}
```

Destinations :
- PDP Shopify ;
- modules « Vous aimerez aussi » ;
- landing pages ;
- outils internes.

Ne pas inventer un attribut Google/Meta non supporté.

---

# 27. Catégorisation

Pipeline :

```text
Shopify product_type
Shopify collections
metafield category
→ canonical category
→ Google product category
→ Meta product category
```

Priorité :
1. mapping explicite ;
2. collection ;
3. product type ;
4. fallback ;
5. diagnostic.

Pas de taxonomie générée par LLM à chaque sync.

---

# 28. Titres Google / Meta

Le feed n'est pas une publicité.

Structure possible :

```text
Brand + Product Name + Product Type + Key Variant
```

Exemple :

```text
Ethnicraft Bok Dining Table Oak 200 cm
```

Éviter tout title stuffing promotionnel.

Utiliser :
- marque ;
- type ;
- couleur/matière fiables ;
- variante utile.

---

# 29. Descriptions

Source :
- description Shopify localisée.

Nettoyer :
- scripts ;
- HTML indésirable ;
- whitespace ;
- contenu non produit.

Ne pas générer automatiquement de nouvelle prose marketing en production.

---

# 30. Google Merchant Center

## Stratégie

Préférer **Merchant API** pour :
- product upsert ;
- update ;
- delete ;
- diagnostics.

Toujours générer un snapshot :

```text
google-{language}-{market}.tsv
```

dans Replit App Storage.

## Champs principaux

Implémenter selon la spécification officielle actuelle, notamment :

```text
id
title
description
link
image_link
additional_image_link
lifestyle_image_link
availability
availability_date
price
sale_price
sale_price_effective_date
brand
gtin
mpn
identifier_exists
condition
google_product_category
product_type
item_group_id
color
material
size
shipping
shipping_weight
product_highlight
product_detail
custom_label_0
custom_label_1
custom_label_2
custom_label_3
custom_label_4
```

Ne pas remplir un champ douteux.

---

# 31. Google Custom Labels

`custom_label_0 = lifecycle`

```text
outlet
sale
new
evergreen
```

Priorité :
```text
outlet > sale > new > evergreen
```

`custom_label_1 = performance`

```text
bestseller
high
medium
low
unknown
```

`custom_label_2 = price_band`

```text
0_500
500_1000
1000_2500
2500_5000
5000_plus
```

`custom_label_3 = discount`

```text
none
1_10
11_20
21_30
31_50
51_70
70_plus
```

`custom_label_4 = inventory`

```text
online
showroom
online_and_showroom
made_to_order
backorder
out_of_stock
```

---

# 32. Google diagnostics

Récupérer automatiquement les diagnostics accessibles.

Afficher :
- refus ;
- price mismatch ;
- availability mismatch ;
- GTIN ;
- image ;
- landing page ;
- policy issue.

Aucune correction automatique risquée des policy issues.

---

# 33. Meta Catalog

Architecture recherchée :

```text
BASE CATALOG
+
LANGUAGE DATA
+
COUNTRY/MARKET OVERRIDES
```

Éviter un catalogue complet dupliqué par pays si localized catalog répond au besoin.

Mode initial recommandé :
- CSV/TSV pré-générés ;
- Replit App Storage ;
- scheduled fetch Meta.

Si Meta Feed API devient objectivement supérieure, Replit Agent peut la choisir et documenter l'ADR.

Snapshots potentiels :

```text
meta-base.csv
meta-language-fr.csv
meta-language-de.csv
meta-country-be.csv
meta-country-de.csv
meta-country-at.csv
meta-country-fr.csv
```

Adapter exactement au format officiel courant.

---

# 34. URLs de feed

Ne pas générer le feed à la volée lors d'un fetch Meta.

Pré-générer dans Replit App Storage.

Exemples :

```text
/feeds/meta/base.csv
/feeds/meta/lang/de.csv
/feeds/meta/lang/fr.csv
/feeds/google/debug/DE.tsv
```

---

# 35. Synchronisation

Full sync :
- nightly.

Prices :
- every 2 hours.

Inventory :
- hourly.

Images :
- seulement si URL/hash/rule version change.

Recommendations :
- nightly.

Webhooks :
- delta quasi temps réel ;
- cron = réconciliation de sécurité.

---

# 36. Shopify Webhooks

Supporter topics officiels actuels équivalents à :
- product create/update/delete ;
- inventory changes ;
- collections si utile.

Traitement :
1. signature ;
2. réponse HTTP rapide ;
3. queue/workflow ;
4. job asynchrone ;
5. idempotence.

---

# 37. Base de données

Tables conceptuelles :

```text
products
variants
market_variants
images
inventory_levels
feed_items
recommendations
sync_runs
sync_errors
channel_diagnostics
feed_snapshots
webhook_events
config_versions
```

Tous les états doivent être rebuildables depuis Shopify + config.

---

# 38. Idempotence / checksums

Chaque sync est relançable sans doublon.

Clés stables :
- Shopify Product GID ;
- Variant GID ;
- channel offer ID ;
- market code.

Calculer checksums pour éviter les updates inutiles.

---

# 39. Rate limits

Implémenter :
- cursors ;
- pagination ;
- throttle ;
- retry exponentiel ;
- jitter ;
- error table / DLQ ;
- respect Shopify GraphQL cost ;
- respect Google/Meta quotas.

---

# 40. Shopify Bulk Operations

Évaluer Bulk Operations pour full sync.

Si bénéfique :
- bulk pour catalogue complet ;
- GraphQL normal pour deltas.

Documenter choix dans ADR.

---

# 41. Feed Health

KPIs :

```text
total_products
total_variants
eligible_variants
excluded_variants
by_language
by_market
by_brand
by_category
in_stock
out_of_stock
backorder
showroom_stock
sale
outlet
exhibition
bestseller
missing_gtin
missing_sku
missing_brand
missing_category
missing_image
missing_lifestyle_image
invalid_url
invalid_image
invalid_price
invalid_sale_price
missing_shipping
missing_return_policy
missing_translation
google_errors
meta_errors
```

---

# 42. Dashboard interne

Pages :

```text
/dashboard
/dashboard/runs
/dashboard/products
/dashboard/google
/dashboard/meta
/dashboard/images
/dashboard/inventory
/dashboard/data-quality
```

Fonctions :
- dernier sync ;
- erreurs ;
- recherche SKU ;
- inspecter source Shopify ;
- inspecter canonical ;
- inspecter payload Google ;
- inspecter payload Meta ;
- voir image ranking ;
- voir recommandations ;
- relancer sync produit ;
- relancer feed ;
- télécharger snapshot.

Sécuriser l'accès.

---

# 43. Alerting

Déclencheurs :
- full sync failed ;
- chute >5 % produits ;
- >2 % prix invalides ;
- feed Meta non régénéré ;
- stock non rafraîchi ;
- auth failure ;
- diagnostics Merchant critiques.

Par défaut :
- dashboard ;
- logs ;
- webhook configurable.

---

# 44. Data Quality Score

Score 0..100.

Pondération de départ :

```text
identity 20
pricing 15
inventory 15
images 15
classification 10
content 10
identifiers 10
shipping 5
```

---

# 45. Exclusion reasons

```text
MISSING_PRICE
INVALID_PRICE
NO_VALID_IMAGE
DISCONTINUED
UNPUBLISHED
INVALID_MARKET
MISSING_REQUIRED_TRANSLATION
MISSING_REQUIRED_IDENTIFIER
POLICY_EXCLUSION
```

Chaque exclusion doit avoir :
- reason ;
- timestamp ;
- channel ;
- market.

---

# 46. Enrichissement premium

Enrichir uniquement avec données factuelles :
- marque ;
- matière ;
- collection ;
- type ;
- dimensions ;
- couleur ;
- style ;
- indoor/outdoor.

Pas d'adjectifs marketing automatiques.

---

# 47. Shipping

Classes :

```text
standard
bulky
premium_delivery
made_to_order
pickup_only
```

`config/shipping.yaml` par pays.

Préférer configuration compte Google lorsque plus propre ; override produit uniquement si nécessaire.

Ne pas inventer les tarifs.

---

# 48. Retours

Classes :

```text
standard
made_to_order
exhibition
customized
```

Source :
- règles business fournies ;
- config existante auditée.

Ne pas inventer de politique légale.

---

# 49. Scalabilité

Architecture cible minimale :
- 25 000 variantes ;
- 4 langues ;
- 10 marchés.

Sans changement d'architecture.

---

# 50. Sécurité

Obligatoire :
- secrets Replit uniquement ;
- aucune clé Git ;
- webhook signature ;
- dashboard authentifié ;
- logs sans secrets ;
- pas de PII client dans les feeds.

Si orders utilisés :
- agréger uniquement métriques produit ;
- ne pas stocker email/nom/adresse client.

---

# 51. Tests unitaires obligatoires

Couvrir au minimum :
1. prix standard ;
2. prix soldé ;
3. compare-at invalide ;
4. discount 15 % ;
5. discount >70 % ;
6. multi-market ;
7. in stock ;
8. backorder ;
9. OOS ;
10. discontinued ;
11. showroom only ;
12. online + showroom ;
13. image blanche ;
14. image transparente ;
15. lifestyle ;
16. fallback image ;
17. GTIN absent ;
18. variantes ;
19. custom labels ;
20. related scoring ;
21. complementary scoring ;
22. market/language ;
23. shipping class ;
24. Google mapping ;
25. Meta mapping.

---

# 52. Fixtures

```text
normal_product.json
sale_product.json
outlet_product.json
exhibition_product.json
bestseller_product.json
out_of_stock.json
backorder.json
multi_variant.json
multi_market.json
missing_gtin.json
no_lifestyle_image.json
outdoor_product.json
```

---

# 53. Regression versus Channable

Si baseline disponible :
- matcher par ID/SKU ;
- comparer price ;
- sale price ;
- availability ;
- title ;
- URL ;
- image ;
- GTIN ;
- brand ;
- item count.

Créer :

```text
reports/migration-comparison.md
```

---

# 54. Migration

Phase A :
- Channable reste actif ;
- nouveau système lit Shopify ;
- snapshots uniquement.

Phase B :
- Google test source ;
- Meta test catalog/feed.

Phase C :
- comparaison automatique.

Phase D :
- cutover si critères passés.

Phase E :
- observation puis fin de Channable.

Le code ne supprime jamais le compte Channable.

---

# 55. Critères automatiques de cutover

Tous doivent être vrais :

```text
0 critical schema errors
0 known price mismatch
0 known currency mismatch
0 broken product URLs
0 invalid primary image for eligible products
< 0.5 % unexplained item-count difference
100 % eligible items mapped to valid language/market
Google test data source accepted
Meta test feed/catalog accepted
```

Si échec :
- ne pas basculer ;
- corriger ;
- retester.

Ne demander intervention humaine que si une plateforme impose une autorisation/clic admin.

---

# 56. Rollback

Conserver :
- ancien feed ;
- dernier snapshot valide ;
- dernière config ;
- ancienne data source.

Incident :
1. stopper nouveaux syncs ;
2. restaurer snapshot ;
3. réactiver ancienne source si nécessaire.

---

# 57. Déploiement Replit

Replit Agent doit :
1. créer ou importer le repository dans Replit ;
2. conserver GitHub comme source de versionnement ;
3. configurer Replit Secrets ;
4. ajouter/configurer Replit Database PostgreSQL ;
5. ajouter/configurer Replit App Storage ;
6. appliquer les migrations DB ;
7. configurer le déploiement web/API en **Reserved VM** par défaut ;
8. configurer le worker et son scheduler persistant ; utiliser des Scheduled Deployments séparés uniquement si Replit Agent vérifie qu'ils sont pertinents et compatibles avec l'architecture de publication retenue ;
9. configurer les endpoints publics et internes ;
10. configurer Shopify webhooks vers l'URL de production Replit ;
11. vérifier les deployment secrets ;
12. tester production en dry-run avant toute écriture Google/Meta.

Si Agent démontre qu'un déploiement Autoscale est objectivement plus adapté et qu'aucun worker continu n'est nécessaire, il peut choisir Autoscale et documenter ce choix dans `docs/adr/`.

Si une ressource ne peut pas être créée directement par Agent :
- fournir l'action Replit exacte à effectuer ;
- indiquer le nom du secret/identifiant attendu ;
- continuer automatiquement tout ce qui n'est pas bloqué.

---

# 58. Scheduled Deployments / worker

Schedules cibles :
- inventory: hourly ;
- pricing: every 2 hours ;
- full: nightly ;
- recommendations: nightly.

Exécuter ces tâches via le scheduler du worker Reserved VM par défaut. Replit Agent peut utiliser **Replit Scheduled Deployments** pour des tâches indépendantes qui se terminent après exécution, seulement après avoir vérifié la configuration de publication disponible au moment de l'implémentation.

Chaque tâche planifiée, quelle que soit la méthode retenue, doit avoir :
- une commande Run explicite ;
- un timeout explicite ;
- ses deployment secrets ;
- logs et statut de run ;
- idempotence ;
- reprise/checkpoint si nécessaire.

Les tâches continues, consommateurs de queue et traitements webhook différés doivent utiliser le worker du **Reserved VM**, jamais un Scheduled Deployment.

Replit Agent doit vérifier les limites et coûts actuels de Replit au moment de l'implémentation et documenter tout ajustement de fréquence ou d'architecture.

---

# 59. API internes

```text
POST /api/internal/sync/full
POST /api/internal/sync/inventory
POST /api/internal/sync/prices
POST /api/internal/sync/product/:variantId
POST /api/webhooks/shopify
GET /api/health
GET /api/feed-health
GET /api/products/:id/debug
GET /api/recommendations/:productId
```

Sécuriser les routes sensibles.

---

# 60. Observabilité run

Chaque run :

```text
run_id
type
started_at
finished_at
status
records_read
records_changed
records_created
records_deleted
errors
warnings
api_calls
duration
```

---

# 61. Audit log

Conserver :
- config changes ;
- code version ;
- API version ;
- snapshot hash ;
- run ID.

---

# 62. Configuration versionnée

Les règles business importantes doivent être :
- code testable ;
- ou config YAML Git.

Pas de règles opaques non versionnées.

---

# 63. Documentation à produire

```text
docs/architecture.md
docs/setup.md
docs/api-access.md
docs/data-model.md
docs/shopify.md
docs/google-merchant.md
docs/meta-catalog.md
docs/synchronization.md
docs/images.md
docs/recommendations.md
docs/migration.md
docs/deployment-replit.md
docs/operations.md
docs/troubleshooting.md
```

---

# 64. README

Inclure :
- objectif ;
- architecture ;
- quick start ;
- env vars ;
- commandes ;
- tests ;
- deploy ;
- sync manuel ;
- troubleshooting.

---

# 65. Scripts attendus

```text
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm audit:shopify
pnpm sync:full
pnpm sync:inventory
pnpm sync:prices
pnpm sync:google
pnpm sync:meta
pnpm feed:validate
pnpm feed:compare
```

---

# 66. Dry-run

Par défaut :

```env
GOOGLE_DRY_RUN=true
META_DRY_RUN=true
```

Le système doit générer les payloads/snapshots sans écrire.

---

# 67. Configuration dynamique

Ne pas hardcoder :
- markets ;
- feed labels ;
- store code ;
- shipping rates ;
- country list ;
- language list ;
- price bands ;
- discount bands ;
- category mappings.

---

# 68. API version governance

Centraliser :
- Shopify API version ;
- Google Merchant API version ;
- Meta Graph API version.

Pinner les versions explicites.

Créer documentation/alerte avant fin de support.

---

# 69. Documentation officielle à consulter

Replit Agent doit vérifier les docs officielles actuelles avant implémentation.

## Shopify
- https://shopify.dev/docs/api/admin-graphql
- https://shopify.dev/docs/api/usage/access-scopes
- https://shopify.dev/docs/api/usage/bulk-operations/queries
- https://shopify.dev/docs/apps/build/webhooks

## Google Merchant
- https://developers.google.com/merchant/api
- https://developers.google.com/merchant/api/guides/data-sources/overview
- https://developers.google.com/merchant/api/guides/inventories/overview
- Product Data Specification officielle

## Meta
- https://developers.facebook.com/documentation/ads-commerce/catalog/
- https://developers.facebook.com/documentation/ads-commerce/catalog/guides/feed-api
- localized catalogs documentation

## Replit
- https://docs.replit.com/learn/projects-and-artifacts/replit-deployments
- https://docs.replit.com/cloud-services/deployments/reserved-vm-deployments
- https://docs.replit.com/cloud-services/deployments/autoscale-deployments
- https://docs.replit.com/cloud-services/deployments/scheduled-deployments
- https://docs.replit.com/features/data-and-storage/sql-database
- https://docs.replit.com/features/data-and-storage/object-storage
- https://docs.replit.com/features/data-and-storage/object-storage-javascript-sdk
- https://docs.replit.com/features/integrations/shopify
- https://docs.replit.com/core-concepts/project-editor/app-setup/secrets
- https://docs.replit.com/features/workspace-tools/git-interface
- https://docs.replit.com/getting-started/quickstarts/import-from-github
- https://docs.replit.com/learn/projects-and-artifacts/version-control

Si une URL a migré, utiliser la nouvelle doc officielle.

---

# 70. Première exécution de Replit Agent

1. créer repository ;
2. initialiser TypeScript/Replit ;
3. créer `.env.example` ;
4. créer dossiers ;
5. créer config ;
6. implémenter auth Shopify ;
7. vérifier scopes/version ;
8. découvrir markets/locales/locations/metafields ;
9. écrire audit ;
10. implémenter canonical model ;
11. sync Shopify ;
12. enrichissement ;
13. tests ;
14. Google exporter/integration ;
15. Meta exporter/integration ;
16. Scheduled Deployments / worker Replit ;
17. App Storage snapshots ;
18. monitoring ;
19. dashboard ;
20. Preview ;
21. migration parallèle ;
22. validation ;
23. Production.

**Ne pas s'arrêter après l'audit.**

Se bloquer uniquement si un secret, identifiant ou tarif business obligatoire manque réellement.

---

# 71. Mode autonome

Cycle obligatoire :

```text
DISCOVER
→ DECIDE
→ DOCUMENT
→ IMPLEMENT
→ TEST
→ VALIDATE
→ DEPLOY
→ MONITOR
```

Ne pas faire :

```text
DISCOVER
→ ASK USER WHICH LIBRARY
```

---

# 72. Gestion des données manquantes

Créer matrice :

```text
field
source
status
required_google
required_meta
fallback
action
```

---

# 73. UX debug par produit

Afficher :
- Shopify source ;
- canonical ;
- FR/DE/localized ;
- market override ;
- Google payload ;
- Meta payload ;
- exclusion reason ;
- image ranking ;
- recommandations ;
- stock par location.

Objectif : remplacer la lisibilité opérationnelle de Channable par un outil plus précis.

---

# 74. Image Debug UI

Miniatures + :
- white score ;
- solid background score ;
- alpha ;
- context/lifestyle classification ;
- selected type ;
- selection reason.

---

# 75. Overrides manuels

Overrides uniquement via :
- Shopify metafields ;
- config Git versionnée.

Pas d'override caché en DB sans source.

---

# 76. Anti-duplication

Interdit :

```text
DE title rule
AT title rule
BE_DE title rule
```

Correct :

```text
DE title rule
+
market overrides
```

---

# 77. Cohérence landing page

Pour Google :
- URL bonne langue/marché ;
- produit identique ;
- prix/devise cohérents ;
- disponibilité cohérente.

Surveiller Merchant diagnostics.

---

# 78. Variantes

ID stable par variante.

`item_group_id` relie les variantes.

Utiliser image variante si pertinente.

---

# 79. GTIN

Valider :
- format ;
- longueur ;
- checksum si applicable.

Ne jamais inventer.

---

# 80. Product highlights

Uniquement faits structurés.

Exemples :
- Solid oak
- Indoor use
- 200 cm width

Pas de slogans.

---

# 81. Dimensions

Normaliser :
- width ;
- depth ;
- height ;
- unit.

Conserver précision et unité source.

---

# 82. Indoor / Outdoor

Classer :
```text
indoor
outdoor
both
```

Utiliser pour segmentation et recommandations.

---

# 83. Marques

Utiliser vendor/mapping.

Alias map :

```yaml
vetsak:
  canonical: vetsak
Ethnicraft:
  canonical: Ethnicraft
```

Respecter le branding officiel.

---

# 84. Meta Product Sets

Préparer données pour :
- Sale ;
- Outlet ;
- Exhibition ;
- Bestseller ;
- Indoor ;
- Outdoor ;
- Brand ;
- Price band.

---

# 85. Google Ads segmentation

Custom labels doivent permettre :
- bestsellers ;
- soldes ;
- outlet ;
- showroom ;
- high AOV ;
- stock local ;
- marque.

---

# 86. Prix modèle d'exposition

Si prix spécifique :
- uniquement variante/SKU réel ;
- jamais appliquer prix expo au produit neuf.

Si nécessaire, recommander variante dédiée Shopify.

---

# 87. Multi-country shipping

Même langue ≠ même logistique.

Master langue partage contenu uniquement.

---

# 88. Fail-safe prix

Si :
- price <= 0 ;
- currency absente ;
- sale > original ;
- contextual price manquant ;

alors :
- exclure uniquement l'offre/marché concerné ;
- critical log ;
- ne pas casser les autres marchés.

---

# 89. Fail-safe stock

Si inventory API échoue :
- ne jamais passer arbitrairement tout en stock ;
- conserver dernier état connu pendant TTL court ;
- alerter ;
- éviter faux stock.

---

# 90. Fail-safe feed

Ne publier un nouveau snapshot que si :
- validation globale OK ;
- chute item count sous seuil ;
- format valide.

Sinon garder le dernier snapshot sain.

---

# 91. Atomic publication

Versionner dans Replit App Storage :

```text
feeds/meta/de/2026-08-13T090000Z.csv
```

Changer `current` uniquement après validation.

---

# 92. Feed manifest

```json
{
  "version": "...",
  "generatedAt": "...",
  "itemCount": 0,
  "sha256": "...",
  "sourceRunId": "..."
}
```

---

# 93. Data freshness

Dashboard :
- Shopify last read ;
- stock last sync ;
- price last sync ;
- Google last push ;
- Meta last publish.

---

# 94. Monitoring channels

Google :
- diagnostics ;
- item issues ;
- account issues si accessible.

Meta :
- feed upload/fetch status ;
- errors ;
- warnings.

---

# 95. Environnements

- local ;
- preview ;
- production.

Preview :
- dry-run ;
- pas d'écriture Google/Meta prod ;
- DB isolée ou namespace isolé.

---

# 96. Production safeguards

Écriture seulement si :

```env
APP_ENV=production
GOOGLE_DRY_RUN=false
META_DRY_RUN=false
```

---

# 97. Bootstrap

Créer :

```text
pnpm bootstrap
```

Il :
- teste DB ;
- teste Shopify ;
- découvre locations ;
- découvre markets ;
- prépare config ;
- exécute sample sync ;
- ne touche pas Google/Meta.

---

# 98. Résultat final attendu

```text
Shopify update
→ changement détecté
→ canonical product update
→ language transformation
→ market override
→ validation
→ Google update
→ Meta feed regenerate
→ App Storage publish
→ diagnostics
```

Sans Channable.

---

# 99. Livrable fonctionnel minimum

Le projet n'est pas terminé tant que :
- Shopify sync fonctionne ;
- variantes normalisées ;
- DE/AT/BE-DE et FR/BE-FR gérés ;
- prix contextualisés ;
- promotions automatiques ;
- image selection ;
- stocks ;
- Eupen ;
- Google output valide ;
- Meta output valide ;
- Replit scheduling ;
- dashboard ;
- tests ;
- logs ;
- snapshots ;
- documentation.

---

# 100. Definition of Done

Le projet est DONE si :

1. Channable n'est plus nécessaire au runtime.
2. Shopify est source de vérité.
3. Les règles ne sont pas dupliquées par pays.
4. Google reçoit des données à jour.
5. Meta reçoit des données à jour.
6. Stocks fiables.
7. Prix fiables.
8. Promotions automatiques.
9. Images adaptées au canal.
10. Stock Eupen exploitable.
11. Moteur observable.
12. Audit produit par produit.
13. Une erreur ne détruit pas un feed sain.
14. Déployé Replit.
15. Versionné GitHub.
16. Secrets hors Git.
17. Tests passent.
18. Documentation complète.

---

# 101. Rappel critique

Le but n'est pas de recoder Channable.

Le but est de construire un **Product Feed Engine Homestorys** :

```text
SHOPIFY
→ CANONICAL PRODUCT DATA
→ LANGUAGE
→ MARKET
→ CHANNEL
```

Les règles sont déterministes, versionnées, testées et observables.

Google et Meta sont des **sorties** du même modèle produit.

---

# 102. Instruction finale à Replit Agent

Commence immédiatement par :

1. créer le repository ;
2. initialiser le projet TypeScript/Replit ;
3. créer `.env.example` ;
4. créer l'arborescence ;
5. implémenter la couche config ;
6. implémenter Shopify auth ;
7. auditer Shopify ;
8. découvrir markets/locales/locations/metafields ;
9. écrire les résultats d'audit ;
10. construire le canonical model ;
11. construire syncs et enrichissements ;
12. créer tests ;
13. créer Google integration ;
14. créer Meta integration ;
15. configurer Replit Reserved VM + Scheduled Deployments/worker ;
16. configurer Replit App Storage snapshots ;
17. ajouter monitoring ;
18. créer dashboard ;
19. déployer Preview ;
20. exécuter migration parallèle ;
21. valider automatiquement ;
22. déployer Production.

**Ne me demande pas de choisir la stack, les bibliothèques, le schéma DB, les conventions ou la stratégie d'intégration. Prends la meilleure décision technique fondée sur les documentations officielles actuelles, documente-la, teste-la et continue.**

Si un secret ou identifiant externe manque, indique exactement :
- son nom ;
- où le créer ;
- le scope minimum ;
- le secret / la variable Replit dans laquelle l'ajouter ;
- comment vérifier qu'il fonctionne.

Puis reprends automatiquement le développement dès qu'il est disponible.
