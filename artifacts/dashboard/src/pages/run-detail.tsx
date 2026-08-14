import React from "react";
import { useGetSyncRun } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { StatusBadge } from "@/components/ui/status-badge";
import { ArrowLeft, Clock, Activity, AlertTriangle } from "lucide-react";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function RunDetail() {
  const params = useParams();
  const id = params.id as string;
  const { data: runDetail, isLoading } = useGetSyncRun(id, { query: { enabled: !!id, queryKey: ['sync-run', id] } });

  if (isLoading) {
    return <div className="p-8">Loading run details...</div>;
  }

  if (!runDetail) {
    return <div className="p-8 text-destructive">Run not found</div>;
  }

  const { run, errors } = runDetail;

  return (
    <div className="space-y-8">
      <section className="pt-8">
        <Link href="/runs" className="mono-label text-muted-foreground hover:text-primary inline-flex items-center uppercase mb-6">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to runs
        </Link>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-8">
          <div>
            <div className="flex items-center gap-4">
              <h1 className="text-[28px] font-bold tracking-tight text-foreground capitalize">{run.runType} Sync</h1>
            </div>
            <p className="mono-label text-muted-foreground mt-4">
              RUN ID: {run.id} <span className="mx-2">•</span> <StatusBadge status={run.status} className="ml-2" />
            </p>
          </div>
        </div>
      </section>

      <section>
        <h2 className="mono-label text-muted-foreground mb-6 uppercase">Execution Metrics</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-[10px]">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="mono-label text-muted-foreground uppercase text-sm">Started</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="font-mono text-[24px] tracking-[-0.24px] text-primary mt-2">
                {format(new Date(run.startedAt), "HH:mm:ss")}
              </div>
              <p className="text-[14px] text-muted-foreground mt-1">
                {format(new Date(run.startedAt), "MMM d, yyyy")}
              </p>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="mono-label text-muted-foreground uppercase text-sm">Duration</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="font-mono text-[24px] tracking-[-0.24px] text-primary mt-2">
                {run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '--'}
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="mono-label text-muted-foreground uppercase text-sm">Processed</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-[24px] tracking-[-0.24px] text-primary mt-2">
                {run.recordsChanged?.toLocaleString()}
              </div>
              <p className="text-[14px] text-muted-foreground mt-1">
                of {run.recordsRead?.toLocaleString()} read
              </p>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="mono-label text-muted-foreground uppercase text-sm">Issues</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-6 mt-2">
                <div>
                  <div className="text-[24px] tracking-[-0.24px] text-destructive">{run.errors || 0}</div>
                  <div className="text-[14px] text-muted-foreground">errors</div>
                </div>
                <div>
                  <div className="text-[24px] tracking-[-0.24px] text-yellow-600">{run.warnings || 0}</div>
                  <div className="text-[14px] text-muted-foreground">warnings</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {errors && errors.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-6">
            <h2 className="mono-label text-muted-foreground uppercase">Diagnostics Log</h2>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Market</TableHead>
                <TableHead>Message</TableHead>
                <TableHead>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {errors.map(err => (
                <TableRow key={err.id}>
                  <TableCell className="font-medium text-[12px] font-mono">{err.errorType}</TableCell>
                  <TableCell>
                    {err.entityType} {err.entityId && <span className="text-muted-foreground font-mono text-[12px] block mt-1">{err.entityId}</span>}
                  </TableCell>
                  <TableCell>
                    {err.marketCode ? <span className="px-2 py-1 bg-muted text-primary rounded-[2px] text-[12px] font-mono">{err.marketCode}</span> : '--'}
                  </TableCell>
                  <TableCell className="max-w-[400px]">
                    <div className="truncate text-[14px]" title={err.message}>{err.message}</div>
                    {err.details && (
                      <pre className="text-[12px] mt-2 text-muted-foreground bg-muted p-3 rounded-[9px] overflow-x-auto font-mono">
                        {JSON.stringify(err.details, null, 2)}
                      </pre>
                    )}
                  </TableCell>
                  <TableCell className="text-[14px] text-muted-foreground whitespace-nowrap">
                    {format(new Date(err.createdAt), "HH:mm:ss")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </div>
  );
}