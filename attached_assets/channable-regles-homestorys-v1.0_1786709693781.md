# Cahier des règles Channable — Flux Google Shopping (Homestorys)

**Version :** 1.0
**Date :** 14/08/2026
**Projet Channable :** Homestorys / Homestorys FR (ID projet : 177508)
**Objectif :** consolider l'ensemble des règles de transformation de flux définies dans Channable (import, exclusion, mapping Google Fields) afin de servir de spécification de référence pour la reproduction/automatisation de cette logique dans le projet Replit.

## Convention de lecture

- `Si` = condition. Un bloc `↳ Ou` indenté sous un `Si` forme un groupe logique **OR** avec la condition du dessus.
- Un bloc `Et` séparé représente une condition additionnelle en **AND** avec le groupe précédent.
- Les noms entre backticks (`` `champ` ``) sont les noms exacts des champs du flux Channable.
- ⚠️ signale un point non confirmé, une capture partielle, ou un élément à valider avec Quentin avant implémentation.

---

## 1. Règles d'import
*(onglet Installation > Règles d'import — projet Homestorys FR)*

### 1.1 Matières
- **Si** `material` est vide
- **Alors** : `material` ← copier la valeur de `matieres`

### 1.2 calendrier
- **Si** `handle` contient "calendrier"
- **Alors** : exclure tous les champs (produit totalement exclu dès l'import)

---

## 2. Règles d'exclusion
*(module "Exclusion" — projet Homestorys FR)*

### 2.1 Limiter le nombre d'images à 10
- **Si** `additional_image_link` n'est pas vide
- **Alors** : `additional_image_link` ← couper la liste `additional_image_link`, du **1er** (premier) au **10e** (dixième) élément
- **Effet** : tronque la liste d'images additionnelles à 10 maximum

### 2.2 Clean variant
- **Si** `image_link` contient "TEXTURES"
- **Alors** : exclure tous les champs

### 2.3 test image 1
- ⚠️ Règle présente dans la liste mais contenu non capturé — à vérifier directement dans Channable

### 2.4 produits de soins
- **Si** `product_type` contient "produits de soins"
  - **↳ Ou** `product_type` contient "Produits de soins"
- **Alors** : exclure tous les champs
- *(double condition pour couvrir la variation de casse)*

### 2.5 calendrier de l'avent
- **Si** `title` contient "Calendrier de l'Avent"
- **Alors** : exclure tous les champs

### 2.6 produit expo
- **Si** `title` contient "expo"
- **Alors** : exclure tous les champs

### 2.7 produit > 10.000€
- **Si** `price` est supérieur à 10000
- **Alors** : exclure tous les champs

### 2.8 livre
- **Si** `title` contient "livre"
- **Alors** : exclure tous les champs

---

## 3. Règles Google Fields
*(mapping flux Google Shopping — projet Homestorys FR)*

### 3.1 Geschlecht (genre)
- **Si** `meta_mmgoogleshopping_gender` est vide
- **Alors** : placer la valeur **"Unisex"**

### 3.2 Altersgruppe (tranche d'âge)
- **Si** `meta_mmgoogleshopping_age_group` est vide
- **Alors** : placer la valeur **"Adult"**

### 3.3 Beschreibung zu kurz (description trop courte)
- **Si** la longueur de `description` ne dépasse pas 500 caractères
- **Alors** : `description` ← combiner `description` + le texte fixe suivant :

  > "Avec Homestorys partez dans un voyage passionnant avec nos 9 Homestorys pour découvrir les meilleures idées d'aménagement et de style de vie à la Belge sur les thèmes suivants : le plaisir, famille et traditions, loisirs et voyages, expériences dans la nature et paradis du jardin, design et une nouvelle forme de luxe."

### 3.4 Masssystem EU (système de taille)
- **Si** `meta_mmgoogleshopping_size_system` est vide
- **Alors** : placer la valeur **"EU"**

### 3.5 Größen Typ (type de taille)
- **Si** `meta_mmgoogleshopping_size_type` est vide
- **Alors** : placer la valeur **"Normal"**

### 3.6 Millimetres (unité de mesure)
- **Si** `unit_measure` est vide
- **Alors** : `unit_measure` ← combiner la valeur du champ `taille` + suffixe **"mm"**

### 3.7 EK Preis (prix d'achat calculé)
- **Si** `cost_per_item` est vide
- **Alors** : `cost_per_item` ← calculer : `price_france` ÷ 2

### 3.8 unit_pricing_base_measure
- **Si** `unit_pricing_base_measure` est vide
- **Alors** : placer la valeur **"1 item"**

### 3.9 Inventors quantity (quantité en stock)
- **Si** `inventory_quantity` est inférieur à 1
- **Alors** : placer la valeur **"2"**

### 3.10 Availability (disponibilité) ⚠️ capture partielle
- (condition initiale probablement non capturée — écran tronqué en haut)
  - **↳ Ou** `meta_global_availability` contient "en stock"
  - **↳ Ou** `meta_global_availability` contient "6 à 8 semaines"
  - **↳ Ou** `meta_global_availability` contient "4 à 6 semaines"
  - **↳ Ou** `meta_global_availability` contient "Rupture de stock"
  - **↳ Ou** `availability` est vide
- **Alors** : `meta_global_availability` ← placer la valeur **"in_stock"**
- ⚠️ **À clarifier** : cette section fait correspondre "Rupture de stock" vers "in_stock", ce qui semble contre-intuitif. Il existe probablement une ou plusieurs sections supplémentaires (non visibles dans les captures) gérant le mapping vers `out_of_stock`/`preorder`/`backorder`.

### 3.11 Kondition Neuware (état = neuf)
- **Si** `meta_mmgoogleshopping_condition` est vide
  - **↳ Ou** `meta_mmgoogleshopping_condition` contient "remis à neuf"
  - **↳ Ou** `condition` est vide
- **Et** `tags` ne contient pas "Outlet"
- **Alors** : `meta_mmgoogleshopping_condition` ← placer la valeur **"new"**

### 3.12 Kondition outlet (état = occasion/outlet)
- **Si** `meta_mmgoogleshopping_condition` est vide
  - **↳ Ou** `meta_mmgoogleshopping_condition` contient "remis à neuf"
- **Et** `tags` contient "outlet"
  - **↳ Ou** `tags` contient "ASGOODASNEW"
- **Alors** : `meta_mmgoogleshopping_condition` ← placer la valeur **"used"**

### 3.13 Fehlende MPN/EAN (identifiant manquant)
- **Si** `meta_custom_google_mpn` est vide
  - **↳ Ou** `meta_mmgoogleshopping_custom_product` contient "false"
- **Alors** : `meta_mmgoogleshopping_custom_product` ← placer la valeur **"no"**

### 3.14 Verfügbar EAN/MPN (identifiant disponible)
- **Si** `meta_mmgoogleshopping_custom_product` contient "true"
  - **↳ Ou** `meta_mmgoogleshopping_custom_product` contient "True"
- **Alors** : `meta_mmgoogleshopping_custom_product` ← placer la valeur **"yes"**

### 3.15 Langify bilder
- **Si** `title` contient "langify"
- **Alors** : exclure tous les champs

### 3.16 Règles visibles dans la liste mais non détaillées
Contenu non capturé — à documenter directement depuis Channable si nécessaire pour Replit :
- Soldes label FR *(désactivée au moment de la capture)*
- Soldes label *(désactivée)*
- Stock Label *(désactivée)*
- Outdoor

---

## 4. Périmètre distinct : contexte "eteamsys"

⚠️ Ces règles apparaissent sous un contexte intitulé **"eteamsys"** (et non "Homestorys FR"). À clarifier : template partagé au niveau agence, ou flux d'un autre client ?

### 4.1 Limiter le nombre d'images à 10
- Identique à la règle **2.1** (Si `additional_image_link` n'est pas vide → couper liste du 1er au 10e élément)

### 4.2 Clean variant
- **Si** `image_link` contient "TEXTURES"
- **Alors** : exclure tous les champs
- Identique à la règle **2.2**

### 4.3 clean link
- ⚠️ Règle visible dans la liste mais contenu non capturé

---

## 5. Points à clarifier avant implémentation dans Replit

1. **Availability (3.10)** — confirmer la logique complète : condition initiale tronquée + traitement réel de "Rupture de stock" (mapping actuel vers `in_stock` à revérifier).
2. **Règles non détaillées** — "test image 1", "Outdoor", "clean link", "Soldes label FR/label", "Stock Label" : captures manquantes.
3. **Statut du périmètre "eteamsys" (section 4)** — s'agit-il d'un template partagé au niveau agence appliqué à plusieurs flux, ou d'un projet client distinct ?
4. **Ordre d'exécution** — dans Channable, l'ordre des règles dans le panneau de gauche correspond-il à l'ordre réel d'application (priorité) ? Important pour une réplication fidèle du comportement dans Replit (ex. l'ordre entre "Kondition Neuware" et "Kondition outlet", ou entre les règles d'exclusion successives).
5. **Portée des règles "exclure tous les champs"** — confirmer si cela signifie "exclusion du produit entier du flux" (le plus probable) plutôt qu'une simple suppression de valeurs de champs.
