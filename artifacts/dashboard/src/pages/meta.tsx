import React from "react";
import { useGetMetaStatus } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Rss, CheckCircle2, Clock, Download } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

export default function Meta() {
  const { data: status, isLoading } = useGetMetaStatus();

  if (isLoading || !status) {
    return <div className="p-8">Loading Meta status...</div>;
  }

  const { lastPushAt, feeds } = status;

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <Rss className="w-8 h-8 text-blue-600" /> Meta Catalogs
          </h1>
          <p className="text-muted-foreground mt-1">Status of language-specific XML feeds</p>
        </div>
        <div className="text-right">
          <div className="text-sm font-medium">Last Global Sync</div>
          <div className="text-sm font-mono text-muted-foreground">
            {lastPushAt ? format(new Date(lastPushAt), "yyyy-MM-dd HH:mm:ss") : 'Never'}
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Active Feeds</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
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
                    <TableCell className="font-mono">
                      <span className="font-bold">{feed.language}</span>
                      {feed.marketCode && <span className="text-muted-foreground"> / {feed.marketCode}</span>}
                    </TableCell>
                    <TableCell className="text-right font-mono font-medium">
                      {feed.itemCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {format(generatedDate, "MMM d, HH:mm")}
                    </TableCell>
                    <TableCell className="text-sm">
                      <span className={isStale ? "text-yellow-600 font-medium flex items-center" : "text-muted-foreground"}>
                        {isStale && <Clock className="w-3 h-3 mr-1"/>}
                        {formatDistanceToNow(generatedDate, { addSuffix: true })}
                      </span>
                    </TableCell>
                    <TableCell>
                      {feed.isCurrent ? (
                        <span className="flex items-center text-green-600 text-sm font-medium"><CheckCircle2 className="w-4 h-4 mr-1"/> Current</span>
                      ) : (
                        <span className="text-muted-foreground text-sm">Archived</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {feed.downloadUrl && (
                        <a href={feed.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground h-8 w-8 text-primary">
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
        </CardContent>
      </Card>
    </div>
  );
}
