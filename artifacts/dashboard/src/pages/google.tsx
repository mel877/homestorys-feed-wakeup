import React from "react";
import { useGetGoogleStatus } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Globe2, AlertTriangle, Info, CheckCircle2, Clock } from "lucide-react";
import { format } from "date-fns";

export default function Google() {
  const { data: status, isLoading } = useGetGoogleStatus();

  if (isLoading || !status) {
    return <div className="p-8">Loading Google status...</div>;
  }

  const { lastPushAt, diagnosticsSummary, byMarket, recentDiagnostics } = status;

  return (
    <div className="space-y-[100px]">
      <section className="flex flex-col md:flex-row md:items-center justify-between gap-8 pt-8">
        <div>
          <h1 className="text-[72px] font-normal leading-[1.1] tracking-[-2.16px] text-primary">Google Channel</h1>
          <p className="text-[18px] text-muted-foreground mt-4 max-w-2xl">
            Merchant Center sync status, market distribution, and diagnostics.
          </p>
        </div>
        <div className="text-right shrink-0 bg-white p-4 rounded-[14px] shadow-shade-inset border border-border">
          <div className="mono-label text-muted-foreground uppercase mb-1">Last API Push</div>
          <div className="text-[20px] font-mono text-primary tracking-[-0.2px]">
            {lastPushAt ? format(new Date(lastPushAt), "yyyy-MM-dd HH:mm:ss") : 'Never'}
          </div>
        </div>
      </section>

      <section>
        <h2 className="mono-label text-muted-foreground mb-6 uppercase">Health Overview</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-[10px]">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="mono-label text-muted-foreground uppercase text-sm">Total Issues</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-[48px] leading-[1.15] tracking-[-1.44px] text-primary">
                {diagnosticsSummary.total.toLocaleString()}
              </div>
            </CardContent>
          </Card>
          
          <Card className="md:col-span-2">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="mono-label text-muted-foreground uppercase text-sm">By Severity</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-12 mt-2">
                {diagnosticsSummary.bySeverity.map(sev => {
                  let color = "text-primary";
                  if (sev.severity === "error") color = "text-destructive";
                  if (sev.severity === "warning") color = "text-yellow-600";
                  
                  return (
                    <div key={sev.severity}>
                      <div className={`text-[32px] tracking-[-0.96px] ${color}`}>
                        {sev.count.toLocaleString()}
                      </div>
                      <div className="text-[14px] text-muted-foreground uppercase mono-label mt-1">{sev.severity}</div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      <section>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-[100px]">
          <div className="md:col-span-1">
            <h2 className="mono-label text-muted-foreground mb-6 uppercase">By Market</h2>
            <div className="grid gap-[10px]">
              {byMarket.map(m => (
                <Card key={m.marketCode} className="p-4 flex items-center justify-between bg-white border border-border shadow-none rounded-[14px]">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-[9px] bg-bone flex items-center justify-center font-mono text-[14px] text-primary">
                      {m.marketCode}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[20px] tracking-[-0.2px]">{m.totalItems.toLocaleString()}</div>
                    <div className={`text-[12px] font-mono mt-1 ${m.activeIssues > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {m.activeIssues} issues
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>

          <div className="md:col-span-2">
            <h2 className="mono-label text-muted-foreground mb-6 uppercase">Top Diagnostics</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Severity</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Market</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentDiagnostics.slice(0, 10).map(diag => (
                  <TableRow key={diag.id}>
                    <TableCell>
                      {diag.severity === 'error' ? (
                        <span className="px-2 py-1 bg-red-50 border border-red-200 text-red-700 text-[12px] font-mono rounded-[2px] uppercase">Error</span>
                      ) : (
                        <span className="px-2 py-1 bg-yellow-50 border border-yellow-200 text-yellow-700 text-[12px] font-mono rounded-[2px] uppercase">Warning</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-[12px]">{diag.issueType}</TableCell>
                    <TableCell className="text-[14px] max-w-[300px] truncate" title={diag.message}>{diag.message}</TableCell>
                    <TableCell className="font-mono text-[14px]">{diag.marketCode || '--'}</TableCell>
                  </TableRow>
                ))}
                {recentDiagnostics.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-8">No recent diagnostics found</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </section>
    </div>
  );
}