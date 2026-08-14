import React from "react";
import { useGetMetaStatus } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Rss, CheckCircle2, Clock, Download } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { StatusBadge } from "@/components/ui/status-badge";

export default function Meta() {
  const { data: status, isLoading } = useGetMetaStatus();

  if (isLoading || !status) {
    return <div className="p-8">Loading Meta status...</div>;
  }

  const { lastPushAt, feeds } = status;

  return (
    <div className="space-y-[100px]">
      <section className="flex flex-col md:flex-row md:items-center justify-between gap-8 pt-8">
        <div>
          <h1 className="text-[72px] font-normal leading-[1.1] tracking-[-2.16px] text-primary">Meta Catalogs</h1>
          <p className="text-[18px] text-muted-foreground mt-4 max-w-2xl">
            Language-specific XML feed generation and distribution.
          </p>
        </div>
        <div className="text-right shrink-0 bg-white p-4 rounded-[14px] shadow-shade-inset border border-border">
          <div className="mono-label text-muted-foreground uppercase mb-1">Last Global Sync</div>
          <div className="text-[20px] font-mono text-primary tracking-[-0.2px]">
            {lastPushAt ? format(new Date(lastPushAt), "yyyy-MM-dd HH:mm:ss") : 'Never'}
          </div>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-6">
          <h2 className="mono-label text-muted-foreground uppercase">Active Feeds</h2>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Language / Market</TableHead>
              <TableHead className="text-right">Items</TableHead>
              <TableHead>Generated At</TableHead>
              <TableHead>Freshness</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Link</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {feeds.map((feed, i) => {
              const generatedDate = new Date(feed.generatedAt);
              const isStale = Date.now() - generatedDate.getTime() > 24 * 60 * 60 * 1000;
              
              return (
                <TableRow key={i}>
                  <TableCell className="font-mono text-[14px]">
                    <span className="font-bold">{feed.language}</span>
                    {feed.marketCode && <span className="text-muted-foreground"> / {feed.marketCode}</span>}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[14px] font-medium">
                    {feed.itemCount.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-[14px] text-muted-foreground">
                    {format(generatedDate, "MMM d, HH:mm")}
                  </TableCell>
                  <TableCell className="text-[14px]">
                    <span className={isStale ? "text-yellow-600 font-medium flex items-center" : "text-muted-foreground"}>
                      {isStale && <Clock className="w-3 h-3 mr-1"/>}
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
                  <TableCell className="text-right">
                    {feed.downloadUrl && (
                      <a href={feed.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center rounded-[9px] text-[14px] transition-colors hover:bg-bone hover:text-primary h-8 w-8 text-muted-foreground border border-transparent hover:border-border">
                        <Download className="w-4 h-4" />
                      </a>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {feeds.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">No active feeds found</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}