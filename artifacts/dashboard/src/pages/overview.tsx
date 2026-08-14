import React, { useState, useEffect, useRef } from "react";
import { 
  useGetDashboardOverview,
  getGetDashboardOverviewQueryKey,
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
  const [pollingUntil, setPollingUntil] = useState<number | null>(null);
  const isPolling = pollingUntil !== null && Date.now() < pollingUntil;
  const pollingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: overview, isLoading, refetch } = useGetDashboardOverview(
    { query: { queryKey: getGetDashboardOverviewQueryKey(), refetchInterval: isPolling ? 4000 : false } },
  );

  useEffect(() => {
    if (!isPolling) return;
    const hasRunning = overview?.recentRuns?.some((r: { status: string }) => r.status === "running");
    if (hasRunning) setPollingUntil(null);
  }, [overview, isPolling]);

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

  if (isLoading || !overview) {
    return <div className="p-8 text-[14px] text-muted-foreground">Loading overview...</div>;
  }

  return (
    <div className="space-y-[32px] pt-8">
      <section className="flex flex-col md:flex-row md:items-center justify-between gap-8">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-foreground">Control Center</h1>
          <p className="text-[14px] text-muted-foreground mt-2">
            Monitor sync operations, inventory health, and channel distribution.
          </p>
        </div>
        <div className="flex gap-3 shrink-0">
          <Button variant="outline" onClick={() => handleManualSync('inventory')} disabled={triggerSync.isPending}>
            Sync Inventory
          </Button>
          <Button variant="default" onClick={() => handleManualSync('full')} disabled={triggerSync.isPending}>
            Full Sync
          </Button>
        </div>
      </section>

      <section>
        <h2 className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase mb-4">System Health</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card className="rounded-[24px]">
            <CardHeader className="flex flex-row items-center justify-between pb-2 p-5">
              <CardTitle className="text-[11px] font-semibold tracking-tight uppercase text-muted-foreground">Total Products</CardTitle>
              <div className="w-8 h-8 rounded-[10px] bg-[#f5f5f5] flex items-center justify-center">
                <Package className="w-4 h-4 text-foreground" />
              </div>
            </CardHeader>
            <CardContent className="p-5 pt-0">
              <div className="text-[28px] font-semibold tracking-tight leading-none text-foreground">
                {overview.totalProducts.toLocaleString()}
              </div>
              <p className="text-[13px] text-muted-foreground mt-2 font-medium">
                Across {overview.totalVariants.toLocaleString()} variants
              </p>
            </CardContent>
          </Card>
          
          <Card className="rounded-[24px]">
            <CardHeader className="flex flex-row items-center justify-between pb-2 p-5">
              <CardTitle className="text-[11px] font-semibold tracking-tight uppercase text-muted-foreground">Eligible</CardTitle>
              <div className="w-8 h-8 rounded-[10px] bg-[#f5f5f5] flex items-center justify-center">
                <Percent className="w-4 h-4 text-foreground" />
              </div>
            </CardHeader>
            <CardContent className="p-5 pt-0">
              <div className="text-[28px] font-semibold tracking-tight leading-none text-foreground">
                {Math.round((overview.eligibleVariants / Math.max(overview.totalVariants, 1)) * 100)}%
              </div>
              <p className="text-[13px] text-muted-foreground mt-2 font-medium">
                {overview.eligibleVariants.toLocaleString()} ready for channels
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-[24px]">
            <CardHeader className="flex flex-row items-center justify-between pb-2 p-5">
              <CardTitle className="text-[11px] font-semibold tracking-tight uppercase text-muted-foreground">System Status</CardTitle>
              <div className="w-8 h-8 rounded-[10px] bg-[#f5f5f5] flex items-center justify-center">
                <Activity className="w-4 h-4 text-foreground" />
              </div>
            </CardHeader>
            <CardContent className="p-5 pt-0">
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 mt-1">
                  <div className={`w-2 h-2 rounded-full ${overview.activeAlerts.length === 0 ? 'bg-[hsl(142,71%,45%)]' : 'bg-[#e7000b]'}`} />
                  <span className="text-[28px] font-semibold tracking-tight leading-none text-foreground">
                    {overview.activeAlerts.length === 0 ? "Healthy" : "Degraded"}
                  </span>
                </div>
                {overview.activeAlerts.length > 0 && (
                  <div className="text-[13px] text-[#e7000b] flex items-center gap-1.5 font-medium">
                    <AlertCircle className="w-3.5 h-3.5" /> {overview.activeAlerts.length} active alerts
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      <section>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">Markets</h2>
            </div>
            <div className="grid gap-3">
              {overview.byMarket.map((m) => (
                <Card key={m.marketCode} className="p-5 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-[12px] bg-[#f5f5f5] flex items-center justify-center text-[12px] font-semibold tracking-widest uppercase text-foreground">
                      {m.marketCode.substring(0, 2)}
                    </div>
                    <div>
                      <div className="text-[16px] font-medium text-foreground">{m.marketCode}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[20px] font-semibold tracking-tight leading-none text-foreground mb-1">{m.eligibleVariants.toLocaleString()}</div>
                    <div className="text-muted-foreground text-[12px]">eligible of {m.totalVariants.toLocaleString()}</div>
                  </div>
                </Card>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">Recent Syncs</h2>
              <Link href="/runs" className="text-[13px] text-foreground font-medium hover:underline underline-offset-4">
                View all history
              </Link>
            </div>
            <div className="grid gap-3">
              {overview.recentRuns.slice(0, 4).map(run => (
                <Link key={run.id} href={`/runs/${run.id}`} className="block group">
                  <Card className="p-5 flex items-center justify-between group-hover:border-[#0a0a0a] transition-colors cursor-pointer">
                    <div>
                      <div className="flex items-center gap-3">
                        <span className="text-[16px] font-medium text-foreground capitalize">{run.runType}</span>
                        <StatusBadge status={run.status} />
                      </div>
                      <div className="text-[13px] text-muted-foreground mt-1">
                        {format(new Date(run.startedAt), "MMM d, HH:mm")}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[20px] font-semibold tracking-tight leading-none text-foreground mb-1">{run.recordsChanged}</div>
                      <div className="text-[12px] text-muted-foreground">records</div>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>
      
      <section className="border-t border-border pt-6 pb-8">
        <div className="flex flex-wrap gap-8 text-[11px] font-semibold tracking-widest uppercase text-muted-foreground">
          <div>LAST FULL SYNC: <span className="text-foreground">{overview.feedHealth.lastFullSync ? format(new Date(overview.feedHealth.lastFullSync), "yyyy-MM-dd HH:mm") : 'NEVER'}</span></div>
          <div>LAST GOOGLE PUSH: <span className="text-foreground">{overview.feedHealth.lastGooglePush ? format(new Date(overview.feedHealth.lastGooglePush), "yyyy-MM-dd HH:mm") : 'NEVER'}</span></div>
          <div>LAST META PUSH: <span className="text-foreground">{overview.feedHealth.lastMetaPush ? format(new Date(overview.feedHealth.lastMetaPush), "yyyy-MM-dd HH:mm") : 'NEVER'}</span></div>
        </div>
      </section>
    </div>
  );
}