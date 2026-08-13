import React from "react";
import { 
  useGetDashboardOverview, 
  useTriggerSync 
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { AlertCircle, ArrowRight, Package, Percent, Activity, RefreshCw } from "lucide-react";
import { format } from "date-fns";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";

export default function Overview() {
  const { data: overview, isLoading, refetch } = useGetDashboardOverview();
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

  if (isLoading || !overview) {
    return <div className="p-8">Loading overview...</div>;
  }

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground mt-1">System health and metrics</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => handleManualSync('inventory')} disabled={triggerSync.isPending}>
            <RefreshCw className="w-4 h-4 mr-2" /> Sync Inventory
          </Button>
          <Button variant="default" size="sm" onClick={() => handleManualSync('full')} disabled={triggerSync.isPending}>
            <RefreshCw className="w-4 h-4 mr-2" /> Full Sync
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Products</CardTitle>
            <Package className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono">{overview.totalProducts.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Across {overview.totalVariants.toLocaleString()} variants
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Eligible Variants</CardTitle>
            <Percent className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono">{overview.eligibleVariants.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {Math.round((overview.eligibleVariants / overview.totalVariants) * 100)}% of total catalog
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Avg Quality Score</CardTitle>
            <Activity className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono text-primary">
              {overview.feedHealth.avgDataQualityScore?.toFixed(1) || '--'}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {overview.feedHealth.variantsBelow70.toLocaleString()} variants below 70
            </p>
          </CardContent>
        </Card>
      </div>

      {overview.activeAlerts.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-xl font-semibold tracking-tight">Active Alerts</h2>
          <div className="grid grid-cols-1 gap-4">
            {overview.activeAlerts.map((alert, i) => (
              <div key={i} className={`p-4 rounded-lg border flex gap-3 items-start ${
                alert.severity === 'high' ? 'bg-destructive/10 border-destructive/20 text-destructive-foreground' : 'bg-warning/10 border-warning/20'
              }`}>
                <AlertCircle className={`w-5 h-5 ${alert.severity === 'high' ? 'text-destructive' : 'text-yellow-600'}`} />
                <div>
                  <h4 className="font-semibold text-sm">{alert.type}</h4>
                  <p className="text-sm mt-1">{alert.message} {alert.count && `(${alert.count} instances)`}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>By Market</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {overview.byMarket.map(m => (
                <div key={m.marketCode} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium px-2 py-1 bg-secondary rounded">{m.marketCode}</span>
                  </div>
                  <div className="text-sm text-right">
                    <div className="font-mono">{m.eligibleVariants.toLocaleString()} / {m.totalVariants.toLocaleString()}</div>
                    <div className="text-muted-foreground text-xs">eligible</div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Recent Sync Runs</CardTitle>
            <Link href="/runs" className="text-sm text-primary flex items-center hover:underline">
              View all <ArrowRight className="w-4 h-4 ml-1" />
            </Link>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {overview.recentRuns.slice(0, 5).map(run => (
                <Link key={run.id} href={`/runs/${run.id}`} className="flex items-center justify-between group p-2 hover:bg-muted/50 rounded-md transition-colors -mx-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm capitalize">{run.runType}</span>
                      <StatusBadge status={run.status} />
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {format(new Date(run.startedAt), "MMM d, HH:mm")}
                    </div>
                  </div>
                  <div className="text-right text-sm">
                    <div className="font-mono text-muted-foreground">{run.recordsChanged} changed</div>
                    {run.errors ? <div className="text-destructive font-medium">{run.errors} errors</div> : null}
                  </div>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
      
      <div className="text-xs text-muted-foreground font-mono bg-muted p-4 rounded-lg flex flex-wrap gap-4">
        <div>Last Full Sync: {overview.feedHealth.lastFullSync ? format(new Date(overview.feedHealth.lastFullSync), "yyyy-MM-dd HH:mm:ss") : 'Never'}</div>
        <div>Last Google Push: {overview.feedHealth.lastGooglePush ? format(new Date(overview.feedHealth.lastGooglePush), "yyyy-MM-dd HH:mm:ss") : 'Never'}</div>
        <div>Last Meta Push: {overview.feedHealth.lastMetaPush ? format(new Date(overview.feedHealth.lastMetaPush), "yyyy-MM-dd HH:mm:ss") : 'Never'}</div>
      </div>
    </div>
  );
}
