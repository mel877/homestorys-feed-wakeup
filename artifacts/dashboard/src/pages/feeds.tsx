import React, { useState } from "react";
import { useListFeedSnapshots, useTriggerSync, getListFeedSnapshotsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Database, Download, CheckCircle2, Clock, RefreshCw } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { StatusBadge } from "@/components/ui/status-badge";

export default function Feeds() {
  const [channel, setChannel] = useState("all");
  const [pollingUntil, setPollingUntil] = useState<number | null>(null);
  const isPolling = pollingUntil !== null && Date.now() < pollingUntil;

  const queryParams = { ...(channel !== "all" && { channel }), currentOnly: false };
  const { data: feeds, isLoading, refetch } = useListFeedSnapshots(queryParams, {
    query: {
      queryKey: getListFeedSnapshotsQueryKey(queryParams),
      refetchInterval: isPolling ? 10_000 : false,
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

      <section className="space-y-6">
        <div className="flex flex-wrap gap-4 items-center justify-between bg-white p-6 rounded-[20px]  border border-border">
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