import React, { useState } from "react";
import { useGetMetaStatus } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Rss, Copy, Check, ExternalLink, Clock } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { StatusBadge } from "@/components/ui/status-badge";

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-[6px] border border-border bg-background hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
      title="Copy URL"
    >
      {copied ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Derive the public (unauthenticated) feed URL from snapshot fields. */
function getPublicUrl(language: string, marketCode: string | null | undefined): string {
  if (marketCode === "META_LANGUAGE_FR") {
    return "/api/feeds/meta/lang/fr.csv";
  }
  if (marketCode === "META_LANGUAGE_DE") {
    return "/api/feeds/meta/lang/de.csv";
  }
  if (marketCode === "BASE") {
    return "/api/feeds/meta/base.csv";
  }
  if (language && marketCode && [
    "FR", "BE_FR", "BE_DE", "DE", "AT", "LU_DE", "CH_FR", "CH_DE",
  ].includes(marketCode)) {
    return `/api/feeds/meta/market/${marketCode}.csv`;
  }
  if (marketCode) {
    return `/api/feeds/meta/country/${marketCode}.csv`;
  }
  if (language && language !== "base") {
    return `/api/feeds/meta/lang/${language}.csv`;
  }
  return `/api/feeds/meta/base.csv`;
}

export default function Meta() {
  const { data: status, isLoading } = useGetMetaStatus();

  if (isLoading || !status) {
    return <div className="p-8 text-muted-foreground text-[14px]">Loading Meta status…</div>;
  }

  const { lastPushAt, feeds } = status;
  const baseUrl = typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.host}`
    : "";

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-[24px] font-bold tracking-tight text-foreground">Meta Catalogs</h1>
          <p className="text-[14px] text-muted-foreground mt-1">
            Feed files hébergés par l'outil — Meta fetche ces URLs sur un planning.
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] font-semibold tracking-wider uppercase text-muted-foreground mb-0.5">Dernier export</div>
          <div className="text-[14px] font-medium text-foreground">
            {lastPushAt ? format(new Date(lastPushAt), "dd/MM/yyyy HH:mm") : "—"}
          </div>
        </div>
      </div>

      {/* Setup instructions */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-[13px] font-semibold tracking-tight flex items-center gap-2">
            <Rss className="w-4 h-4 text-muted-foreground" />
            Configuration Meta Commerce Manager
          </CardTitle>
        </CardHeader>
        <CardContent className="text-[13px] text-muted-foreground space-y-2">
          <p>
            Dans Commerce Manager, configure chaque catalogue en mode <strong className="text-foreground">URL planifiée</strong>.
            Copie l'URL publique du flux correspondant et colle-la dans le champ "URL du fichier de données".
          </p>
          <p className="text-[12px]">
            Les fichiers sont mis à jour à chaque export. Planifie le fetch Meta après 03h00 UTC pour avoir les données du sync nocturne.
          </p>
        </CardContent>
      </Card>

      {/* Feed files table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-[13px] font-semibold tracking-tight">Fichiers de flux actifs</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {feeds.length === 0 ? (
            <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
              Aucun flux généré. Lance un export depuis la page <strong>Feeds</strong>.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Flux</TableHead>
                  <TableHead className="text-right">Produits</TableHead>
                  <TableHead>Généré</TableHead>
                  <TableHead>Fraîcheur</TableHead>
                  <TableHead>Statut</TableHead>
                  <TableHead>URL publique</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {feeds.map((feed, i) => {
                  const generatedDate = new Date(feed.generatedAt);
                  const isStale = Date.now() - generatedDate.getTime() > 24 * 60 * 60 * 1000;
                  const publicPath = getPublicUrl(feed.language, feed.marketCode);
                  const fullUrl = `${baseUrl}${publicPath}`;

                  return (
                    <TableRow key={i}>
                      <TableCell>
                        <span className="font-mono font-semibold text-[13px]">{feed.language}</span>
                        {feed.marketCode && (
                          <span className="text-muted-foreground font-mono text-[13px]"> / {feed.marketCode}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[13px] font-medium">
                        {feed.itemCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-[13px] text-muted-foreground whitespace-nowrap">
                        {format(generatedDate, "dd/MM HH:mm")}
                      </TableCell>
                      <TableCell>
                        <span className={`text-[13px] flex items-center gap-1 ${isStale ? "text-amber-600 font-medium" : "text-muted-foreground"}`}>
                          {isStale && <Clock className="w-3 h-3" />}
                          {formatDistanceToNow(generatedDate, { addSuffix: true })}
                        </span>
                      </TableCell>
                      <TableCell>
                        {feed.isCurrent ? (
                          <StatusBadge status="active" label="Current" />
                        ) : (
                          <StatusBadge status="inactive" label="Archived" />
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-muted-foreground hidden lg:block max-w-[180px] truncate" title={publicPath}>
                            {publicPath}
                          </span>
                          <CopyButton value={fullUrl} />
                          <a
                            href={publicPath}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-[6px] border border-border bg-background hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                            title="Télécharger le fichier CSV"
                          >
                            <ExternalLink className="w-3 h-3" />
                            CSV
                          </a>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
