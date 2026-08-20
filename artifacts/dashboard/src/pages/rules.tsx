import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Rule = { title: string; detail: string };

const GROUPS: Array<{ title: string; accent: string; rules: Rule[] }> = [
  {
    title: "Règles communes",
    accent: "bg-slate-100 text-slate-700",
    rules: [
      { title: "Produits actifs et commandables", detail: "Seuls les produits Shopify actifs et éligibles au marché sont inclus." },
      { title: "Images propres", detail: "Les textures, matériaux, échantillons et plans techniques sont retirés sans exclure un produit qui possède une image valide." },
      { title: "Prix réels par marché", detail: "Aucun prix, devise ou livraison n’est inventé ni recopié depuis un autre pays." },
    ],
  },
  {
    title: "Google",
    accent: "bg-blue-50 text-blue-700",
    rules: [
      { title: "URLs stables", detail: "Un TSV FR et un TSV DE sont publiés de façon atomique pour le prélèvement Merchant Center." },
      { title: "Disponibilité standard", detail: "Chaque produit commandable est envoyé comme « in stock » ; le flux showroom reste séparé." },
    ],
  },
  {
    title: "Meta",
    accent: "bg-indigo-50 text-indigo-700",
    rules: [
      { title: "Catalogues plats", detail: "Un CSV FR et un CSV DE contiennent les informations produit, prix, disponibilité et livraison." },
      { title: "Livraison pays", detail: "Les tarifs Meta configurés sont appliqués selon le pays de chaque ligne." },
    ],
  },
  {
    title: "FR",
    accent: "bg-rose-50 text-rose-700",
    rules: [
      { title: "Marchés inclus", detail: "France, Belgique francophone et Suisse francophone. La Suisse FR utilise le prix CHF du marché suisse réel." },
      { title: "Contenu et liens", detail: "Titres, descriptions et URLs proviennent de la storefront française." },
    ],
  },
  {
    title: "DE",
    accent: "bg-amber-50 text-amber-700",
    rules: [
      { title: "Marchés inclus", detail: "Allemagne, Autriche, Belgique germanophone, Suisse germanophone et Luxembourg." },
      { title: "Contenu et liens", detail: "Titres, descriptions et URLs suivent la storefront allemande de chaque marché." },
    ],
  },
];

export default function Rules() {
  return (
    <div className="space-y-8 pt-8">
      <section>
        <h1 className="text-[28px] font-bold tracking-tight">Règles de flux</h1>
        <p className="text-[16px] text-muted-foreground mt-3 max-w-3xl">
          Les règles opérationnelles actuellement appliquées aux flux Google et Meta, regroupées par portée.
        </p>
      </section>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {GROUPS.map((group) => (
          <Card key={group.title} className="border border-border shadow-none">
            <CardContent className="p-5 space-y-4">
              <Badge variant="outline" className={`border-0 ${group.accent}`}>{group.title}</Badge>
              <div className="space-y-4">
                {group.rules.map((rule) => (
                  <div key={rule.title} className="border-l-2 border-border pl-3">
                    <h2 className="text-[14px] font-semibold">{rule.title}</h2>
                    <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">{rule.detail}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}