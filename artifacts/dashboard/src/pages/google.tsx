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
    <div className="p-8 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <Globe2 className="w-8 h-8 text-primary" /> Google Merchant Center
          </h1>
          <p className="text-muted-foreground mt-1">Status of feeds pushed via Content API</p>
        </div>
        <div className="text-right">
          <div className="text-sm font-medium">Last Push</div>
          <div className="text-sm font-mono text-muted-foreground">
            {lastPushAt ? format(new Date(lastPushAt), "yyyy-MM-dd HH:mm:ss") : 'Never'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Total Issues</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold font-mono">{diagnosticsSummary.total.toLocaleString()}</div>
          </CardContent>
        </Card>
        
        <Card className="md:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">By Severity</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-6">
              {diagnosticsSummary.bySeverity.map(sev => {
                let color = "text-blue-600";
                let Icon = Info;
                if (sev.severity === "error") { color = "text-destructive"; Icon = AlertTriangle; }
                if (sev.severity === "warning") { color = "text-yellow-600"; Icon = Clock; }
                
                return (
                  <div key={sev.severity} className="flex items-center gap-2">
                    <Icon className={`w-5 h-5 ${color}`} />
                    <div>
                      <div className="text-2xl font-bold font-mono">{sev.count.toLocaleString()}</div>
                      <div className="text-xs text-muted-foreground capitalize">{sev.severity}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="md:col-span-1">
          <CardHeader>
            <CardTitle>By Market</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {byMarket.map(m => (
                <div key={m.marketCode} className="flex justify-between items-center border-b pb-2 last:border-0">
                  <div className="font-mono font-medium px-2 py-1 bg-secondary rounded text-sm">{m.marketCode}</div>
                  <div className="text-right">
                    <div className="text-sm font-mono">{m.totalItems.toLocaleString()} items</div>
                    <div className={`text-xs ${m.activeIssues > 0 ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
                      {m.activeIssues} issues
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Top Diagnostics</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
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
                        <span className="px-2 py-0.5 bg-destructive/10 text-destructive text-xs rounded uppercase font-medium">Error</span>
                      ) : (
                        <span className="px-2 py-0.5 bg-yellow-100 text-yellow-800 text-xs rounded uppercase font-medium">Warning</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{diag.issueType}</TableCell>
                    <TableCell className="text-sm max-w-sm truncate" title={diag.message}>{diag.message}</TableCell>
                    <TableCell className="font-mono text-xs">{diag.marketCode || '--'}</TableCell>
                  </TableRow>
                ))}
                {recentDiagnostics.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-8">No recent diagnostics found</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
