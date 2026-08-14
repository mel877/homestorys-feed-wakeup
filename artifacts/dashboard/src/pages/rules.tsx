import React, { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import {
  CheckCircle2,
  PlusCircle,
  AlertCircle,
  HelpCircle,
  XCircle,
  Info,
  ShieldCheck,
} from "lucide-react";

// ── Rule data model ───────────────────────────────────────────────────────────

type RuleStatus =
  | "active"         // existed before, fully implemented
  | "new"            // implemented this session
  | "partial"        // partially covered
  | "clarification"  // spec unclear / ⚠️ in Channable doc
  | "skip";          // intentionally not implemented (Channable workaround)

interface ChannelRule {
  id: string;
  title: string;
  condition: string;
  action: string;
  status: RuleStatus;
  note?: string;
}

type Section = "import" | "exclusion" | "fields" | "open";

const RULES: Record<Section, ChannelRule[]> = {
  import: [
    {
      id: "1.1",
      title: "Matières fallback",
      condition: "`material` est vide",
      action: "`material` ← copier la valeur de `matieres`",
      status: "skip",
      note: "Le champ `matieres` n'existe pas dans le flux Shopify. Le champ `material` est alimenté via les métafields de variant (metafieldMaterial).",
    },
    {
      id: "1.2",
      title: "Exclusion calendrier (handle)",
      condition: "`handle` contient \"calendrier\"",
      action: "Exclure le produit entier",
      status: "new",
      note: "Implémenté dans le canonical builder — vérification sur product.handle et content.title.",
    },
  ],
  exclusion: [
    {
      id: "2.1",
      title: "Limiter les images additionnelles à 10",
      condition: "`additional_image_link` non vide",
      action: "Tronquer la liste à 10 éléments maximum",
      status: "new",
      note: "Implémenté dans selectGoogleImages() — `.slice(0, 10)` sur le tableau additional.",
    },
    {
      id: "2.2",
      title: "Clean variant TEXTURES",
      condition: "`image_link` contient \"TEXTURES\"",
      action: "Exclure tous les champs",
      status: "new",
      note: "Géré par isExcludedFeedImage() — le keyword `textures` (insensible à la casse) filtre ces images. Si l'image primaire est filtrée, le produit reçoit NO_VALID_IMAGE.",
    },
    {
      id: "2.3",
      title: "test image 1",
      condition: "—",
      action: "Contenu non capturé dans Channable",
      status: "clarification",
      note: "Règle présente dans la liste Channable mais sans détail. À vérifier directement dans le compte Channable.",
    },
    {
      id: "2.4",
      title: "Produits de soins",
      condition: "`product_type` contient \"produits de soins\" (insensible à la casse)",
      action: "Exclure le produit entier",
      status: "new",
      note: "Implémenté dans le canonical builder — vérification sur product.productType.",
    },
    {
      id: "2.5",
      title: "Calendrier de l'Avent",
      condition: "`title` contient \"Calendrier de l'Avent\"",
      action: "Exclure le produit entier",
      status: "new",
      note: "Couvert par la vérification title.includes(\"calendrier\") dans le canonical builder.",
    },
    {
      id: "2.6",
      title: "Produit expo",
      condition: "`title` contient \"expo\"",
      action: "Exclure le produit entier",
      status: "new",
      note: "Implémenté dans le canonical builder.",
    },
    {
      id: "2.7",
      title: "Prix > 10 000 €",
      condition: "`price` > 10 000",
      action: "Exclure le produit entier",
      status: "new",
      note: "Implémenté dans le canonical builder après resolvePricing — parseFloat(priceAmount) > 10_000 → return null.",
    },
    {
      id: "2.8",
      title: "Livres",
      condition: "`title` contient \"livre\"",
      action: "Exclure le produit entier",
      status: "new",
      note: "Implémenté dans le canonical builder.",
    },
  ],
  fields: [
    {
      id: "3.1",
      title: "Geschlecht (genre)",
      condition: "`gender` est vide",
      action: "Placer la valeur \"Unisex\"",
      status: "new",
      note: "Ajouté dans mapToGoogleRow — gender: \"Unisex\" en valeur par défaut.",
    },
    {
      id: "3.2",
      title: "Altersgruppe (tranche d'âge)",
      condition: "`age_group` est vide",
      action: "Placer la valeur \"Adult\"",
      status: "new",
      note: "Ajouté dans mapToGoogleRow — age_group: \"Adult\" en valeur par défaut.",
    },
    {
      id: "3.3",
      title: "Description trop courte",
      condition: "Longueur de `description` ≤ 500 caractères",
      action: "Ajouter le texte de marque Homestorys en suffixe",
      status: "new",
      note: "Implémenté via buildDescription() dans le mapper. Texte : « Avec Homestorys partez dans un voyage passionnant… »",
    },
    {
      id: "3.4",
      title: "Masssystem EU (système de taille)",
      condition: "`size_system` est vide",
      action: "Placer la valeur \"EU\"",
      status: "new",
      note: "Ajouté dans mapToGoogleRow — size_system: \"EU\" en valeur par défaut.",
    },
    {
      id: "3.5",
      title: "Größen Typ (type de taille)",
      condition: "`size_type` est vide",
      action: "Placer la valeur \"Normal\"",
      status: "new",
      note: "Ajouté dans mapToGoogleRow — size_type: \"Normal\" en valeur par défaut.",
    },
    {
      id: "3.6",
      title: "Millimetres (unité de mesure)",
      condition: "`unit_measure` est vide",
      action: "`unit_measure` ← valeur de `taille` + suffixe \"mm\"",
      status: "clarification",
      note: "Le champ `taille` n'est pas présent dans les données Shopify actuelles. Besoin de vérifier quelle métafield correspond.",
    },
    {
      id: "3.7",
      title: "EK Preis (prix d'achat estimé)",
      condition: "`cost_per_item` est vide",
      action: "`cost_per_item` ← `price_france` ÷ 2",
      status: "skip",
      note: "Workaround Channable pour estimer le coût. Le champ cost_per_item n'est pas utilisé dans le flux Google actuel. À implémenter si GMC le requiert.",
    },
    {
      id: "3.8",
      title: "unit_pricing_base_measure",
      condition: "`unit_pricing_base_measure` est vide",
      action: "Placer la valeur \"1 item\"",
      status: "new",
      note: "Ajouté dans mapToGoogleRow — unit_pricing_base_measure: \"1 item\" en valeur par défaut.",
    },
    {
      id: "3.9",
      title: "Inventory quantity hack",
      condition: "`inventory_quantity` < 1",
      action: "Forcer la valeur à \"2\"",
      status: "skip",
      note: "Workaround Channable pour forcer l'affichage dans GMC. Non reproduit : le mapper gère la disponibilité via le champ `availability` (in_stock / out_of_stock / backorder) qui est dérivé des niveaux d'inventaire Shopify.",
    },
    {
      id: "3.10",
      title: "Availability",
      condition: "meta_global_availability contient certaines valeurs (capture partielle)",
      action: "Mapper vers in_stock / out_of_stock / backorder",
      status: "partial",
      note: "Le mapper implémente in_stock, out_of_stock, backorder via mapAvailability(). La condition exacte de Channable n'a pas pu être entièrement capturée (écran tronqué). Le mapping « Rupture de stock → in_stock » semble contre-intuitif — à clarifier.",
    },
    {
      id: "3.11",
      title: "Kondition Neuware (état = neuf)",
      condition: "`condition` vide OU \"remis à neuf\", ET `tags` ne contient pas \"Outlet\"",
      action: "`condition` ← \"new\"",
      status: "active",
      note: "Géré via resolveCondition() dans le mapper — condition = \"new\" par défaut.",
    },
    {
      id: "3.12",
      title: "Kondition outlet (état = occasion)",
      condition: "`condition` vide OU \"remis à neuf\", ET `tags` contient \"outlet\" OU \"ASGOODASNEW\"",
      action: "`condition` ← \"used\"",
      status: "new",
      note: "Implémenté dans resolveCondition() — vérifie canonical.isOutlet et canonical.tags.",
    },
    {
      id: "3.13",
      title: "Fehlende MPN/EAN (identifiant manquant)",
      condition: "`meta_custom_google_mpn` est vide",
      action: "`identifier_exists` ← \"no\"",
      status: "active",
      note: "Géré via identifierExists dans le canonical builder (validateGtin + validateMpn).",
    },
    {
      id: "3.14",
      title: "Verfügbar EAN/MPN (identifiant disponible)",
      condition: "`identifier_exists` contient \"true\"",
      action: "`identifier_exists` ← \"yes\"",
      status: "active",
      note: "Géré via identifierExists — canonical.identifierExists ? \"yes\" : \"no\".",
    },
    {
      id: "3.15",
      title: "Langify bilder",
      condition: "`title` contient \"langify\"",
      action: "Exclure le produit entier",
      status: "new",
      note: "Implémenté dans le canonical builder.",
    },
    {
      id: "3.16a",
      title: "Soldes label FR",
      condition: "—",
      action: "Règle désactivée dans Channable au moment de la capture",
      status: "clarification",
      note: "Contenu non capturé. Activer si les soldes saisonnières doivent être signalées dans le flux.",
    },
    {
      id: "3.16b",
      title: "Stock Label",
      condition: "—",
      action: "Règle désactivée dans Channable au moment de la capture",
      status: "clarification",
    },
    {
      id: "3.16c",
      title: "Outdoor",
      condition: "—",
      action: "Contenu non capturé — règle active dans Channable",
      status: "clarification",
      note: "Probablement un custom label ou un filtrage de catégorie outdoor. À documenter depuis Channable.",
    },
  ],
  open: [
    {
      id: "Q1",
      title: "Availability — logique complète",
      condition: "Règle 3.10",
      action: "Confirmer le mapping complet, notamment « Rupture de stock → in_stock » qui semble contre-intuitif",
      status: "clarification",
    },
    {
      id: "Q2",
      title: "Règles non détaillées",
      condition: "Règles 2.3, 3.16a-c",
      action: "Capturer le contenu depuis Channable : test image 1, Outdoor, Soldes label FR/label, Stock Label, clean link",
      status: "clarification",
    },
    {
      id: "Q3",
      title: "Périmètre eteamsys (section 4)",
      condition: "Section 4 du cahier des règles",
      action: "Confirmer si ces règles sont un template agence partagé ou un projet client distinct",
      status: "clarification",
    },
    {
      id: "Q4",
      title: "Ordre d'exécution des règles",
      condition: "Toutes règles",
      action: "Confirmer si l'ordre dans le panneau Channable correspond à la priorité réelle d'application",
      status: "clarification",
    },
    {
      id: "Q5",
      title: "Portée de « exclure tous les champs »",
      condition: "Règles 1.2, 2.2, 2.4–2.8, 3.15",
      action: "Confirmer que cela signifie exclusion totale du produit du flux (et non suppression de valeurs)",
      status: "active",
      note: "Interprété comme exclusion totale dans le builder (return null).",
    },
  ],
};

// ── Status helpers ────────────────────────────────────────────────────────────

function statusConfig(status: RuleStatus) {
  switch (status) {
    case "active":
      return {
        label: "Actif",
        icon: CheckCircle2,
        className: "bg-green-50 text-green-700 border-green-200",
        iconClass: "text-green-600",
      };
    case "new":
      return {
        label: "Ajouté",
        icon: PlusCircle,
        className: "bg-blue-50 text-blue-700 border-blue-200",
        iconClass: "text-blue-600",
      };
    case "partial":
      return {
        label: "Partiel",
        icon: AlertCircle,
        className: "bg-amber-50 text-amber-700 border-amber-200",
        iconClass: "text-amber-600",
      };
    case "clarification":
      return {
        label: "À clarifier",
        icon: HelpCircle,
        className: "bg-orange-50 text-orange-700 border-orange-200",
        iconClass: "text-orange-600",
      };
    case "skip":
      return {
        label: "Non applicable",
        icon: XCircle,
        className: "bg-muted text-muted-foreground border-border",
        iconClass: "text-muted-foreground",
      };
  }
}

// ── Stat helpers ──────────────────────────────────────────────────────────────

function countAll(section?: Section) {
  const sections: Section[] = section ? [section] : ["import", "exclusion", "fields", "open"];
  return sections.flatMap((s) => RULES[s]);
}

function stat(status: RuleStatus, section?: Section) {
  return countAll(section).filter((r) => r.status === status).length;
}

// ── Rule card ─────────────────────────────────────────────────────────────────

function RuleCard({ rule }: { rule: ChannelRule }) {
  const cfg = statusConfig(rule.status);
  const Icon = cfg.icon;

  return (
    <Card className="p-4 flex gap-4 border rounded-[20px] shadow-none">
      <div className="shrink-0 w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
        <Icon className={`w-4 h-4 ${cfg.iconClass}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="text-[11px] font-semibold font-mono text-muted-foreground">
            §{rule.id}
          </span>
          <span className="text-[13px] font-semibold text-foreground">{rule.title}</span>
          <Badge
            variant="outline"
            className={`text-[10px] font-semibold px-2 py-0 h-5 border ${cfg.className}`}
          >
            {cfg.label}
          </Badge>
        </div>
        <div className="space-y-0.5 mt-1.5">
          <p className="text-[12px] text-muted-foreground">
            <span className="font-medium text-foreground">Si </span>
            {rule.condition}
          </p>
          <p className="text-[12px] text-muted-foreground">
            <span className="font-medium text-foreground">Alors </span>
            {rule.action}
          </p>
        </div>
        {rule.note && (
          <div className="mt-2 flex gap-1.5 items-start">
            <Info className="w-3 h-3 text-muted-foreground shrink-0 mt-0.5" />
            <p className="text-[11px] text-muted-foreground leading-relaxed">{rule.note}</p>
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Section stats bar ─────────────────────────────────────────────────────────

function SectionStats({ section }: { section: Section }) {
  const rules = RULES[section];
  const counts = {
    active: rules.filter((r) => r.status === "active").length,
    new: rules.filter((r) => r.status === "new").length,
    partial: rules.filter((r) => r.status === "partial").length,
    clarification: rules.filter((r) => r.status === "clarification").length,
    skip: rules.filter((r) => r.status === "skip").length,
  };

  const allPills: [string, string, number][] = [
    ["Actif", "text-green-700 bg-green-50 border-green-200", counts.active],
    ["Ajouté", "text-blue-700 bg-blue-50 border-blue-200", counts.new],
    ["Partiel", "text-amber-700 bg-amber-50 border-amber-200", counts.partial],
    ["À clarifier", "text-orange-700 bg-orange-50 border-orange-200", counts.clarification],
    ["Non applicable", "text-muted-foreground bg-muted border-border", counts.skip],
  ];
  const pills = allPills.filter(([, , n]) => n > 0);

  return (
    <div className="flex gap-2 flex-wrap mb-4">
      {pills.map(([label, cls, n]) => (
        <span
          key={label}
          className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${cls}`}
        >
          {n} {label}
        </span>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Rules() {
  const totalRules = countAll().length;
  const implemented = stat("active") + stat("new");
  const pct = Math.round((implemented / totalRules) * 100);

  return (
    <div className="space-y-8 py-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight leading-none mb-2">
            Channel Rules
          </h1>
          <p className="text-[13px] text-muted-foreground">
            Cahier des règles Channable v1.0 — migré dans le Feed Engine
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-[28px] font-bold leading-none">{pct}%</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {implemented}/{totalRules} règles implémentées
            </div>
          </div>
          <div className="w-10 h-10 rounded-xl bg-[#0a0a0a] flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-white" />
          </div>
        </div>
      </div>

      {/* Global legend */}
      <div className="flex gap-2 flex-wrap">
        {(
          [
            ["Actif", "text-green-700 bg-green-50 border-green-200", stat("active")],
            ["Ajouté cette session", "text-blue-700 bg-blue-50 border-blue-200", stat("new")],
            ["Partiel", "text-amber-700 bg-amber-50 border-amber-200", stat("partial")],
            ["À clarifier", "text-orange-700 bg-orange-50 border-orange-200", stat("clarification")],
            ["Non applicable", "text-muted-foreground bg-muted border-border", stat("skip")],
          ] as [string, string, number][]
        ).map(([label, cls, n]) => (
          <span key={label} className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${cls}`}>
            {n} {label}
          </span>
        ))}
      </div>

      {/* Tabs */}
      <Tabs defaultValue="exclusion">
        <TabsList className="h-9">
          <TabsTrigger value="import" className="text-[12px]">Import ({RULES.import.length})</TabsTrigger>
          <TabsTrigger value="exclusion" className="text-[12px]">Exclusion ({RULES.exclusion.length})</TabsTrigger>
          <TabsTrigger value="fields" className="text-[12px]">Google Fields ({RULES.fields.length})</TabsTrigger>
          <TabsTrigger value="open" className="text-[12px]">Points ouverts ({RULES.open.length})</TabsTrigger>
        </TabsList>

        {(["import", "exclusion", "fields", "open"] as Section[]).map((section) => (
          <TabsContent key={section} value={section} className="mt-6 space-y-3">
            <SectionStats section={section} />
            {RULES[section].map((rule) => (
              <RuleCard key={rule.id} rule={rule} />
            ))}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
