import React, { useState } from "react";
import { useGetGoogleStatus } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Copy, Check, ExternalLink, FileText, Globe2 } from "lucide-react";
import { format } from "date-fns";

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

export default function Google() {
  const { data: status, isLoading } = useGetGoogleStatus();

  if (isLoading || !status) {
    return (
      <div className="p-8 text-muted-foreground text-[14px]">Loading Google status…</div>
    );
  }

  const { lastGeneratedAt, snapshots, byMarket } = status;

  // Build a base URL prefix for absolute URLs (GMC needs full URLs)
  const baseUrl = typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.host}`
    : "";

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-[24px] font-bold tracking-tight text-foreground">Google Shopping</h1>
          <p className="text-[14px] text-muted-foreground mt-1">
            Feed files hébergés par l'outil — Google Merchant Center vient les fetcher via URL.
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[11px] font-semibold tracking-wider uppercase text-muted-foreground mb-0.5">Dernier export</div>
          <div className="text-[14px] font-medium text-foreground">
            {lastGeneratedAt ? format(new Date(lastGeneratedAt), "dd/MM/yyyy HH:mm") : "—"}
          </div>
        </div>
      </div>

      {/* Setup instructions */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-[13px] font-semibold tracking-tight flex items-center gap-2">
            <Globe2 className="w-4 h-4 text-muted-foreground" />
            Configuration Google Merchant Center
          </CardTitle>
        </CardHeader>
        <CardContent className="text-[13px] text-muted-foreground space-y-2">
          <p>
            Dans Merchant Center, configure chaque pays en mode <strong className="text-foreground">Fetch par URL planifié</strong>.
            Copie l'URL publique du marché correspondant et colle-la dans le champ "URL du fichier de flux".
          </p>
          <p>
            Format : <code className="text-[12px] bg-muted px-1.5 py-0.5 rounded font-mono">{baseUrl}/api/feeds/google/market/[MARCHÉ].tsv</code>
          </p>
          <p className="text-[12px]">
            Les fichiers sont mis à jour à chaque export (bouton "Generate feeds" sur la page Feeds). Planifie le fetch GMC après 02h30 UTC pour avoir les données du sync nocturne.
          </p>
        </CardContent>
      </Card>

      {/* Feed files per market */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-[13px] font-semibold tracking-tight flex items-center gap-2">
            <FileText className="w-4 h-4 text-muted-foreground" />
            Fichiers de flux par marché
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {snapshots.length === 0 ? (
            <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
              Aucun fichier généré. Lance un export depuis la page <strong>Feeds</strong>.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Marché</TableHead>
                  <TableHead>Langue</TableHead>
                  <TableHead className="text-right">Produits</TableHead>
                  <TableHead>Généré le</TableHead>
                  <TableHead>URL publique</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshots.map((s, i) => {
                  const fullUrl = `${baseUrl}${s.publicUrl}`;
                  return (
                    <TableRow key={`${s.marketCode}-${i}`}>
                      <TableCell className="font-mono text-[13px] font-medium">{s.marketCode ?? "—"}</TableCell>
                      <TableCell className="font-mono text-[13px] text-muted-foreground">{s.language ?? "—"}</TableCell>
                      <TableCell className="text-right font-mono text-[13px]">{s.itemCount.toLocaleString()}</TableCell>
                      <TableCell className="text-[13px] text-muted-foreground whitespace-nowrap">
                        {s.generatedAt ? format(new Date(s.generatedAt), "dd/MM HH:mm") : "—"}
                      </TableCell>
                      <TableCell className="max-w-[260px]">
                        <span className="font-mono text-[11px] text-muted-foreground truncate block" title={fullUrl}>
                          {s.publicUrl}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <CopyButton value={fullUrl} />
                          <a
                            href={s.publicUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-[6px] border border-border bg-background hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                            title="Télécharger le fichier TSV"
                          >
                            <ExternalLink className="w-3 h-3" />
                            TSV
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

      {/* Feed items by market */}
      {byMarket.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-[13px] font-semibold tracking-tight">
              Produits en catalogue par marché
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Marché</TableHead>
                  <TableHead className="text-right">Total variantes</TableHead>
                  <TableHead className="text-right">Éligibles</TableHead>
                  <TableHead className="text-right">Taux</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byMarket.map((m) => {
                  const rate = m.totalItems > 0 ? Math.round((m.eligibleItems / m.totalItems) * 100) : 0;
                  return (
                    <TableRow key={m.marketCode}>
                      <TableCell className="font-mono text-[13px] font-medium">{m.marketCode}</TableCell>
                      <TableCell className="text-right font-mono text-[13px]">{m.totalItems.toLocaleString()}</TableCell>
                      <TableCell className="text-right font-mono text-[13px] text-green-700">{m.eligibleItems.toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        <span className={`text-[12px] font-semibold px-2 py-0.5 rounded-full ${
                          rate >= 90 ? "bg-green-50 text-green-700" :
                          rate >= 70 ? "bg-amber-50 text-amber-700" :
                          "bg-red-50 text-red-700"
                        }`}>
                          {rate}%
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
