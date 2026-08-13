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
    <div className="p-8 space-y-6 max-w-7xl mx-auto">
      <Link href="/runs" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center">
        <ArrowLeft className="w-4 h-4 mr-1" /> Back to runs
      </Link>

      <div className="flex items-center justify-between border-b pb-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight capitalize">{run.runType} Sync</h1>
            <StatusBadge status={run.status} />
          </div>
          <p className="text-muted-foreground mt-1 font-mono text-sm">{run.id}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-2"><Clock className="w-4 h-4"/> Started</div>
            <div className="font-mono text-sm">{format(new Date(run.startedAt), "yyyy-MM-dd HH:mm:ss")}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-2"><Clock className="w-4 h-4"/> Duration</div>
            <div className="font-mono text-xl">{run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '--'}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-2"><Activity className="w-4 h-4"/> Processed</div>
            <div className="text-xl font-bold">
              {run.recordsChanged?.toLocaleString()} <span className="text-sm font-normal text-muted-foreground">/ {run.recordsRead?.toLocaleString()} read</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-muted-foreground mb-2"><AlertTriangle className="w-4 h-4"/> Issues</div>
            <div className="flex gap-4">
              <div><span className="text-xl font-bold text-destructive">{run.errors || 0}</span> errors</div>
              <div><span className="text-xl font-bold text-yellow-600">{run.warnings || 0}</span> warnings</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {errors && errors.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
            Errors <span className="bg-destructive text-destructive-foreground text-xs px-2 py-0.5 rounded-full">{errors.length}</span>
          </h2>
          <div className="border rounded-md bg-card overflow-hidden">
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
                    <TableCell className="font-medium text-xs font-mono">{err.errorType}</TableCell>
                    <TableCell>
                      {err.entityType} {err.entityId && <span className="text-muted-foreground font-mono text-xs block">{err.entityId}</span>}
                    </TableCell>
                    <TableCell>
                      {err.marketCode ? <span className="px-2 py-1 bg-secondary rounded text-xs font-mono">{err.marketCode}</span> : '--'}
                    </TableCell>
                    <TableCell className="max-w-md">
                      <div className="truncate" title={err.message}>{err.message}</div>
                      {err.details && (
                        <pre className="text-[10px] mt-1 text-muted-foreground bg-muted p-1 rounded overflow-x-auto">
                          {JSON.stringify(err.details)}
                        </pre>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {format(new Date(err.createdAt), "HH:mm:ss")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
