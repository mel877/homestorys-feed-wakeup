import React, { useState } from "react";
import { useListFeedSnapshots, useTriggerSync, getListFeedSnapshotsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, Store, RefreshCw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { StatusBadge } from "@/components/ui/status-badge";

export default function Feeds() {
  const [showroomPollingUntil, setShowroomPollingUntil] = useState<number | null>(null);
  const isShowroomPolling = showroomPollingUntil !== null && Date.now() < showroomPollingUntil;

  const queryParams = { currentOnly: true };
  const { data: feeds } = useListFeedSnapshots(queryParams, {
    query: {
      queryKey: getListFeedSnapshotsQueryKey(queryParams),
      refetchInterval: isShowroomPolling ? 10_000 : false,
    },
  });

  // Showroom snapshots (always fetched, independent of channel filter)
  const showroomQueryParams = { channel: "showroom", currentOnly: true };
  const { data: showroomFeeds, refetch: refetchShowroom } = useListFeedSnapshots(showroomQueryParams, {
    query: {
      queryKey: getListFeedSnapshotsQueryKey(showroomQueryParams),
      refetchInterval: isShowroomPolling ? 10_000 : false,
    },
  });

  const triggerSync = useTriggerSync();
  const { toast } = useToast();

  const handleShowroomExport = () => {
    triggerSync.mutate({ data: { runType: "showroom" } }, {
      onSuccess: () => {
        toast({
          title: "Export showroom démarré",
          description: "Les flux Google et Meta Eupen sont en cours de génération (produits en stock showroom).",
        });
        setShowroomPollingUntil(Date.now() + 15 * 60_000);
        refetchShowroom();
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Impossible de démarrer l'export showroom", description: err.message || "Unknown error" });
      },
    });
  };

  // Derived showroom stats
  const showroomGoogle = showroomFeeds?.find((f) => f.marketCode === "BE_DE");
  const showroomMeta   = showroomFeeds?.find((f) => f.marketCode === "BE_DE_META");

  return (
    <div className="space-y-8">
      <section className="flex flex-col md:flex-row md:items-center justify-between gap-8 pt-8">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-foreground">Feeds</h1>
          <p className="text-[18px] text-muted-foreground mt-4 max-w-2xl">
            Flux standard mis à jour automatiquement chaque nuit. Chaque URL reste fixe pour Google et Meta.
          </p>
        </div>
      </section>

      {/* ── Showroom Eupen section ───────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <Store className="w-5 h-5 text-primary" />
          <h2 className="text-[20px] font-semibold tracking-tight">Flux Showroom Eupen</h2>
        </div>
        <p className="text-[14px] text-muted-foreground max-w-2xl">
          Catalogue filtré sur les produits physiquement disponibles en magasin à Eupen
          (<code className="font-mono text-[13px] bg-muted px-1 rounded">stockEupen &gt; 0</code>).
          À utiliser pour les campagnes Google Shopping et Meta "disponible en magasin".
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Google showroom card */}
          <Card className="border border-border">
            <CardContent className="pt-5 pb-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="mono-label uppercase text-muted-foreground text-[11px]">Google TSV</span>
                {showroomGoogle ? (
                  <StatusBadge status="active" label="Disponible" />
                ) : (
                  <StatusBadge status="inactive" label="Non généré" />
                )}
              </div>
              {showroomGoogle ? (
                <>
                  <div className="text-[28px] font-bold font-mono">{showroomGoogle.itemCount.toLocaleString()}</div>
                  <div className="text-[12px] text-muted-foreground">
                    Généré {formatDistanceToNow(new Date(showroomGoogle.generatedAt))} ago
                  </div>
                  <div className="flex gap-2 pt-1">
                    <a
                      href="/api/feeds/google/showroom/eupen.tsv"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-[13px] text-primary hover:underline"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Télécharger TSV
                    </a>
                  </div>
                </>
              ) : (
                <div className="text-[13px] text-muted-foreground pt-2">
                  Lance un export showroom pour générer ce fichier.
                </div>
              )}
            </CardContent>
          </Card>

          {/* Meta showroom card */}
          <Card className="border border-border">
            <CardContent className="pt-5 pb-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="mono-label uppercase text-muted-foreground text-[11px]">Meta CSV</span>
                {showroomMeta ? (
                  <StatusBadge status="active" label="Disponible" />
                ) : (
                  <StatusBadge status="inactive" label="Non généré" />
                )}
              </div>
              {showroomMeta ? (
                <>
                  <div className="text-[28px] font-bold font-mono">{showroomMeta.itemCount.toLocaleString()}</div>
                  <div className="text-[12px] text-muted-foreground">
                    Généré {formatDistanceToNow(new Date(showroomMeta.generatedAt))} ago
                  </div>
                  <div className="flex gap-2 pt-1">
                    <a
                      href="/api/feeds/meta/showroom/eupen.csv"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-[13px] text-primary hover:underline"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Télécharger CSV
                    </a>
                  </div>
                </>
              ) : (
                <div className="text-[13px] text-muted-foreground pt-2">
                  Lance un export showroom pour générer ce fichier.
                </div>
              )}
            </CardContent>
          </Card>

          {/* Export action card */}
          <Card className="border border-primary/20 bg-primary/5">
            <CardContent className="pt-5 pb-4 flex flex-col justify-between h-full gap-4">
              <div className="space-y-1.5">
                <div className="text-[14px] font-medium">Exporter le showroom</div>
                <div className="text-[13px] text-muted-foreground">
                  Regénère les deux fichiers showroom depuis les données canoniques
                  déjà synchronisées (stock Eupen inclus).
                </div>
              </div>
              <Button
                variant="default"
                className="w-full"
                onClick={handleShowroomExport}
                disabled={triggerSync.isPending}
              >
                {isShowroomPolling ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                    Export en cours…
                  </>
                ) : (
                  <>
                    <Store className="w-4 h-4 mr-2" />
                    Exporter Showroom Eupen
                  </>
                )}
              </Button>
              <div className="space-y-1 pt-1">
                <div className="text-[11px] font-mono text-muted-foreground break-all">
                  /api/feeds/google/showroom/eupen.tsv
                </div>
                <div className="text-[11px] font-mono text-muted-foreground break-all">
                  /api/feeds/meta/showroom/eupen.csv
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ── Standard feeds section ───────────────────────────────────────────── */}
      <section className="space-y-6">
        <div>
          <h2 className="text-[20px] font-semibold tracking-tight">Flux standards</h2>
          <p className="text-[14px] text-muted-foreground mt-1">Une ligne par marché conserve le prix, la devise, la livraison et le lien propres à chaque pays.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[
            { channel: "Google", language: "FR", path: "/api/feeds/google/fr.tsv", marketCode: "LANG_FR" },
            { channel: "Google", language: "DE", path: "/api/feeds/google/de.tsv", marketCode: "LANG_DE" },
            { channel: "Meta", language: "FR", path: "/api/feeds/meta/fr.csv", marketCode: "LANG_FR" },
            { channel: "Meta", language: "DE", path: "/api/feeds/meta/de.csv", marketCode: "LANG_DE" },
          ].map((feed) => {
            const snapshot = feeds?.find((item) => item.channel.toLowerCase() === feed.channel.toLowerCase() && item.marketCode === feed.marketCode);
            return <Card key={`${feed.channel}-${feed.language}`} className="border border-border">
              <CardContent className="pt-5 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="mono-label uppercase text-muted-foreground">{feed.channel} · {feed.language}</span>
                  <StatusBadge status={snapshot ? "active" : "inactive"} label={snapshot ? "Actif" : "En attente"} />
                </div>
                <div className="text-[12px] font-mono text-muted-foreground break-all">{feed.path}</div>
                <div className="flex justify-between items-center text-[13px]">
                  <span>{snapshot ? `${snapshot.itemCount.toLocaleString()} articles · ${formatDistanceToNow(new Date(snapshot.generatedAt))}` : "Sera créé lors du prochain export nocturne"}</span>
                  <a href={feed.path} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1"><Download className="w-3.5 h-3.5" /> Ouvrir</a>
                </div>
              </CardContent>
            </Card>;
          })}
        </div>
      </section>
    </div>
  );
}
