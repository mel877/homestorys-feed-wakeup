import React, { useState, useEffect, useRef } from "react";
import { useListSyncRuns, getListSyncRunsQueryKey, useTriggerSync } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Link } from "wouter";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Play, ChevronLeft, ChevronRight, Eye } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";

export default function Runs() {
  const [page, setPage] = useState(0);
  const [runType, setRunType] = useState<string>("all");
  const [pollingUntil, setPollingUntil] = useState<number | null>(null);
  const limit = 20;

  const isPolling = pollingUntil !== null && Date.now() < pollingUntil;
  const pollingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queryParams = { limit, offset: page * limit, ...(runType !== "all" && { runType }) };
  const { data: runsData, isLoading, refetch } = useListSyncRuns(
    queryParams,
    { query: { queryKey: getListSyncRunsQueryKey(queryParams), refetchInterval: isPolling ? 3000 : false } },
  );

  useEffect(() => {
    if (!isPolling) return;
    const hasRunning = runsData?.items.some(r => r.status === "running");
    if (hasRunning) setPollingUntil(null);
  }, [runsData, isPolling]);

  const triggerSync = useTriggerSync();
  const { toast } = useToast();

  const handleManualSync = (type: 'full'|'inventory'|'prices'|'recommendations') => {
    triggerSync.mutate({ data: { runType: type } }, {
      onSuccess: () => {
        toast({ title: "Sync Dispatched", description: `${type} sync is running in the background.` });
        setPollingUntil(Date.now() + 45_000);
        if (pollingTimerRef.current) clearTimeout(pollingTimerRef.current);
        pollingTimerRef.current = setTimeout(() => setPollingUntil(null), 45_000);
        refetch();
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Sync failed", description: err.message || "Unknown error" });
      }
    });
  };

  return (
    <div className="space-y-[100px]">
      <section className="flex flex-col md:flex-row md:items-center justify-between gap-8 pt-8">
        <div>
          <h1 className="text-[72px] font-normal leading-[1.1] tracking-[-2.16px] text-primary">Sync Runs</h1>
          <p className="text-[18px] text-muted-foreground mt-4 max-w-2xl">
            Pipeline history, ingestion logs, and processing tasks.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4 shrink-0">
          <Button variant="outline" size="sm" onClick={() => handleManualSync('inventory')} disabled={triggerSync.isPending}>
            Inventory
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleManualSync('prices')} disabled={triggerSync.isPending}>
            Prices
          </Button>
          <Button variant="default" size="sm" onClick={() => handleManualSync('full')} disabled={triggerSync.isPending}>
            Full Sync
          </Button>
        </div>
      </section>

      <section className="space-y-6">
        <div className="flex flex-wrap gap-4 items-center bg-white p-6 rounded-[14px] shadow-shade-inset border border-border">
          <div className="mono-label text-muted-foreground uppercase mr-4">Filter by</div>
          <Select value={runType} onValueChange={(v) => { setRunType(v); setPage(0); }}>
            <SelectTrigger className="w-[180px] h-10 bg-bone border-transparent shadow-none rounded-[9px]">
              <SelectValue placeholder="Run Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="full">Full Sync</SelectItem>
              <SelectItem value="inventory">Inventory Only</SelectItem>
              <SelectItem value="prices">Prices Only</SelectItem>
              <SelectItem value="recommendations">Recommendations</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead className="text-right">Read</TableHead>
              <TableHead className="text-right">Changed</TableHead>
              <TableHead className="text-right">Errors</TableHead>
              <TableHead className="text-right">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={9} className="h-32 text-center text-muted-foreground">Loading runs...</TableCell>
              </TableRow>
            ) : runsData?.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="h-32 text-center text-muted-foreground">No runs found</TableCell>
              </TableRow>
            ) : (
              runsData?.items.map(run => (
                <TableRow key={run.id} className="cursor-pointer" onClick={() => document.getElementById(`link-${run.id}`)?.click()}>
                  <TableCell className="font-mono text-[12px]">{run.id.substring(0, 8)}</TableCell>
                  <TableCell className="capitalize text-[14px]">{run.runType}</TableCell>
                  <TableCell><StatusBadge status={run.status} /></TableCell>
                  <TableCell className="text-[14px] text-muted-foreground">{format(new Date(run.startedAt), "MMM d, HH:mm:ss")}</TableCell>
                  <TableCell className="font-mono text-[14px]">
                    {run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '--'}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[14px]">{run.recordsRead?.toLocaleString() || 0}</TableCell>
                  <TableCell className="text-right font-mono text-[14px]">{run.recordsChanged?.toLocaleString() || 0}</TableCell>
                  <TableCell className="text-right font-mono text-[14px]">
                    {run.errors ? <span className="text-destructive font-medium">{run.errors}</span> : <span className="text-muted-foreground">0</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link id={`link-${run.id}`} href={`/runs/${run.id}`} className="inline-flex items-center justify-center text-muted-foreground hover:text-primary transition-colors h-8 w-8" onClick={e => e.stopPropagation()}>
                      <Eye className="w-5 h-5" />
                    </Link>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        <div className="flex items-center justify-between text-sm text-muted-foreground mono-label pt-4 border-t border-hairline">
          <div>
            SHOWING {page * limit + 1} TO {Math.min((page + 1) * limit, runsData?.total || 0)} OF {runsData?.total || 0}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" className="mono-label !h-8 !px-3" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>
               Prev
            </Button>
            <Button variant="ghost" size="sm" className="mono-label !h-8 !px-3" onClick={() => setPage(p => p + 1)} disabled={!runsData || (page + 1) * limit >= runsData.total}>
              Next 
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}