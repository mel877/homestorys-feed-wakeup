import React, { useState } from "react";
import { useListFeedSnapshots, useTriggerSync, getListFeedSnapshotsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Database, Download, CheckCircle2, Store, RefreshCw } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { StatusBadge } from "@/components/ui/status-badge";

export default function Feeds() {
  const [channel, setChannel] = useState("all");
  const [pollingUntil, setPollingUntil] = useState<number | null>(null);
  const [showroomPollingUntil, setShowroomPollingUntil] = useState<number | null>(null);
  const isPolling = pollingUntil !== null && Date.now() < pollingUntil;
  const isShowroomPolling = showroomPollingUntil !== null && Date.now() < showroomPollingUntil;

  const queryParams = { ...(channel !== "all" && { channel }), currentOnly: false };
  const { data: feeds, isLoading, refetch } = useListFeedSnapshots(queryParams, {
    query: {
      queryKey: getListFeedSnapshotsQueryKey(queryParams),
      refetchInterval: (isPolling || isShowroomPolling) ? 10_000 : false,
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

  const handleGenerate = () => {
    triggerSync.mutate({ data: { runType: "export" } }, {
      onSuccess: () => {
        toast({
          title: "Feed generation started",
          description: "Google and Meta feeds are being regenerated. This takes several minutes.",
        });
        setPollingUntil(Date.now() + 30 * 60_000);
        refetch();
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Could not start feed generation", description: err.message || "Unknown error" });
      },
    });
  };

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
            Raw XML/CSV files hosted in Cloud Storage.
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
        <h2 className="text-[20px] font-semibold tracking-tight">Flux standard (Google + Meta)</h2>

        <div className="flex flex-wrap gap-4 items-center justify-between bg-white p-6 rounded-[20px] border border-border">
          <div className="flex items-center gap-4">
            <div className="mono-label text-muted-foreground uppercase mr-2">Filter by</div>
            <Select value={channel} onValueChange={setChannel}>
              <SelectTrigger className="w-[180px] h-10 bg-muted border-transparent shadow-none rounded-[9px]">
                <SelectValue placeholder="Channel" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Channels</SelectItem>
                <SelectItem value="meta">Meta</SelectItem>
                <SelectItem value="google">Google</SelectItem>
                <SelectItem value="showroom">Showroom</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button variant="default" onClick={handleGenerate} disabled={triggerSync.isPending}>
            Generate Feeds
          </Button>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Channel</TableHead>
              <TableHead>Locale</TableHead>
              <TableHead className="text-right">Items</TableHead>
              <TableHead>Generated</TableHead>
              <TableHead>Path</TableHead>
              <TableHead className="text-center">Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center text-muted-foreground mono-label uppercase">Loading feeds...</TableCell>
              </TableRow>
            ) : feeds?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center text-muted-foreground mono-label uppercase">No feeds found</TableCell>
              </TableRow>
            ) : (
              feeds?.map((feed) => (
                <TableRow key={feed.id} className={!feed.isCurrent ? 'opacity-70 bg-muted/30' : ''}>
                  <TableCell className="font-medium capitalize text-[14px]">{feed.channel}</TableCell>
                  <TableCell className="font-mono text-[14px]">
                    {feed.language}{feed.marketCode ? `-${feed.marketCode}` : ''}
                  </TableCell>
                  <TableCell className="font-mono text-[14px] font-medium text-right">{feed.itemCount.toLocaleString()}</TableCell>
                  <TableCell>
                    <div className="text-[14px]">{format(new Date(feed.generatedAt), "MMM d, HH:mm")}</div>
                    <div className="text-[12px] text-muted-foreground">{formatDistanceToNow(new Date(feed.generatedAt))} ago</div>
                  </TableCell>
                  <TableCell className="font-mono text-[12px] max-w-[200px] truncate text-muted-foreground" title={feed.storagePath}>
                    {feed.storagePath.split('/').pop()}
                  </TableCell>
                  <TableCell className="text-center">
                    {feed.isCurrent ? (
                      <StatusBadge status="active" label="Current" />
                    ) : (
                      <StatusBadge status="inactive" label="Archived" />
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {feed.downloadUrl ? (
                      <a href={feed.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center rounded-[9px] text-[14px] transition-colors hover:bg-muted hover:text-primary h-8 w-8 text-muted-foreground border border-transparent hover:border-border">
                        <Download className="w-4 h-4" />
                      </a>
                    ) : (
                      <span className="text-[12px] mono-label text-muted-foreground uppercase">Expired</span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
