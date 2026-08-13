import React, { useState } from "react";
import { useListSyncRuns, useTriggerSync } from "@workspace/api-client-react";
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
  const limit = 20;

  const { data: runsData, isLoading, refetch } = useListSyncRuns({
    limit,
    offset: page * limit,
    ...(runType !== "all" && { runType }),
  });

  const triggerSync = useTriggerSync();
  const { toast } = useToast();

  const handleManualSync = (type: 'full'|'inventory'|'prices'|'recommendations') => {
    triggerSync.mutate({ data: { runType: type } }, {
      onSuccess: () => {
        toast({ title: "Sync Started", description: `Triggered ${type} sync.` });
        refetch();
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Sync failed", description: err.error || "Unknown error" });
      }
    });
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Sync Runs</h1>
          <p className="text-muted-foreground mt-1">History of data ingestion and processing</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => handleManualSync('prices')} disabled={triggerSync.isPending}>
            <Play className="w-4 h-4 mr-2" /> Prices
          </Button>
          <Button variant="outline" onClick={() => handleManualSync('inventory')} disabled={triggerSync.isPending}>
            <Play className="w-4 h-4 mr-2" /> Inventory
          </Button>
          <Button variant="default" onClick={() => handleManualSync('full')} disabled={triggerSync.isPending}>
            <Play className="w-4 h-4 mr-2" /> Full Sync
          </Button>
        </div>
      </div>

      <Card className="p-4 border-b-0 rounded-b-none">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Type:</span>
            <Select value={runType} onValueChange={(v) => { setRunType(v); setPage(0); }}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="full">Full</SelectItem>
                <SelectItem value="inventory">Inventory</SelectItem>
                <SelectItem value="prices">Prices</SelectItem>
                <SelectItem value="recommendations">Recommendations</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </Card>

      <div className="border rounded-t-none rounded-b-lg overflow-hidden bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Run ID</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead className="text-right">Read</TableHead>
              <TableHead className="text-right">Changed</TableHead>
              <TableHead className="text-right">Errors</TableHead>
              <TableHead></TableHead>
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
                <TableRow key={run.id} className="hover:bg-muted/50">
                  <TableCell className="font-mono text-xs">{run.id.substring(0, 8)}</TableCell>
                  <TableCell className="capitalize">{run.runType}</TableCell>
                  <TableCell><StatusBadge status={run.status} /></TableCell>
                  <TableCell className="text-sm">{format(new Date(run.startedAt), "MMM d, HH:mm:ss")}</TableCell>
                  <TableCell className="font-mono text-sm">
                    {run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '--'}
                  </TableCell>
                  <TableCell className="text-right font-mono">{run.recordsRead?.toLocaleString() || 0}</TableCell>
                  <TableCell className="text-right font-mono">{run.recordsChanged?.toLocaleString() || 0}</TableCell>
                  <TableCell className="text-right font-mono">
                    {run.errors ? <span className="text-destructive font-medium">{run.errors}</span> : <span className="text-muted-foreground">0</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link href={`/runs/${run.id}`} className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 hover:bg-accent hover:text-accent-foreground h-8 w-8">
                      <Eye className="w-4 h-4" />
                    </Link>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between mt-4 text-sm text-muted-foreground">
        <div>
          Showing {page * limit + 1} to Math.min((page + 1) * limit, runsData?.total || 0) of {runsData?.total || 0}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>
            <ChevronLeft className="w-4 h-4 mr-1" /> Prev
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={!runsData || (page + 1) * limit >= runsData.total}>
            Next <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      </div>
    </div>
  );
}
