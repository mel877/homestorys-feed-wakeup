import React, { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { StatusBadge } from "@/components/ui/status-badge";
import { useListImageAnalysis, useGetDashboardOverview, getGetDashboardOverviewQueryKey } from "@workspace/api-client-react";
import { ChevronLeft, ChevronRight, Image as ImageIcon, CheckCircle2, XCircle, AlertCircle } from "lucide-react";

export default function Images() {
  const [page, setPage] = useState(0);
  const [classified, setClassified] = useState<string>("all");
  const limit = 24;

  const { data, isLoading } = useListImageAnalysis({
    limit,
    offset: page * limit,
    ...(classified === "true" ? { classified: true } : classified === "false" ? { classified: false } : {})
  });

  const { data: overview } = useGetDashboardOverview(
    { query: { queryKey: getGetDashboardOverviewQueryKey() } },
  );

  const totalImages = overview?.feedHealth?.totalImages ?? 0;
  const classifiedImages = overview?.feedHealth?.classifiedImages ?? 0;
  const imageHealth = overview?.feedHealth as unknown as {
    productsWithImages?: number;
    productsWithoutImages?: number;
  } | undefined;
  const productsWithImages = imageHealth?.productsWithImages ?? 0;
  const productsWithoutImages = imageHealth?.productsWithoutImages ?? 0;
  const totalProducts = overview?.totalProducts ?? 0;
  const coveragePct = totalProducts > 0 ? Math.round((productsWithImages / totalProducts) * 100) : 0;
  const classifiedPct = totalImages > 0 ? Math.round((classifiedImages / totalImages) * 100) : 0;

  return (
    <div className="space-y-8">
      <section className="flex flex-col md:flex-row md:items-center justify-between gap-8 pt-8">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-foreground">Image Pipeline</h1>
          <p className="text-[18px] text-muted-foreground mt-4 max-w-2xl">
            Review automated visual classification and quality scoring.
          </p>
        </div>
      </section>

      {/* Coverage stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white rounded-[20px] border border-border p-6 flex items-center gap-4">
          <ImageIcon className="w-8 h-8 text-primary/60 shrink-0" />
          <div>
            <div className="text-2xl font-bold">{totalImages.toLocaleString()}</div>
            <div className="mono-label text-muted-foreground uppercase text-[11px] mt-1">Total images</div>
          </div>
        </div>

        <div className="bg-white rounded-[20px] border border-border p-6">
          <div className="flex items-center gap-4">
            <CheckCircle2 className="w-8 h-8 text-green-500 shrink-0" />
            <div>
              <div className="text-2xl font-bold">
                {classifiedImages.toLocaleString()}
                <span className="text-sm font-normal text-muted-foreground ml-1">({classifiedPct}%)</span>
              </div>
              <div className="mono-label text-muted-foreground uppercase text-[11px] mt-1">Classified</div>
            </div>
          </div>
          <div className="mt-3 h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-green-500 transition-all" style={{ width: `${classifiedPct}%` }} />
          </div>
        </div>

        <div className="bg-white rounded-[20px] border border-border p-6">
          <div className="flex items-center gap-4">
            <CheckCircle2 className="w-8 h-8 text-primary/60 shrink-0" />
            <div>
              <div className="text-2xl font-bold">
                {productsWithImages.toLocaleString()}
                <span className="text-sm font-normal text-muted-foreground ml-1">({coveragePct}%)</span>
              </div>
              <div className="mono-label text-muted-foreground uppercase text-[11px] mt-1">Products with images</div>
            </div>
          </div>
          <div className="mt-3 h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${coveragePct}%` }} />
          </div>
        </div>

        <div className={`bg-white rounded-[20px] border p-6 flex items-center gap-4 ${productsWithoutImages > 0 ? "border-destructive/40" : "border-border"}`}>
          {productsWithoutImages > 0
            ? <AlertCircle className="w-8 h-8 text-destructive shrink-0" />
            : <XCircle className="w-8 h-8 text-muted-foreground/40 shrink-0" />
          }
          <div>
            <div className={`text-2xl font-bold ${productsWithoutImages > 0 ? "text-destructive" : ""}`}>
              {productsWithoutImages.toLocaleString()}
            </div>
            <div className="mono-label text-muted-foreground uppercase text-[11px] mt-1">Without images</div>
          </div>
        </div>
      </div>

      <section className="space-y-6">
        <div className="flex flex-wrap gap-4 items-center bg-white p-6 rounded-[20px] border border-border">
          <div className="mono-label text-muted-foreground uppercase mr-4">Filter by</div>
          <Select value={classified} onValueChange={(v) => { setClassified(v); setPage(0); }}>
            <SelectTrigger className="w-[180px] h-10 bg-muted border-transparent shadow-none rounded-[9px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Images</SelectItem>
              <SelectItem value="true">Classified</SelectItem>
              <SelectItem value="false">Unclassified</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-muted-foreground mono-label uppercase">Loading images...</div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-[10px]">
              {data?.items.map(img => (
                <Card key={img.id} className="overflow-hidden border-border bg-white p-0 transition-colors hover:border-primary group">
                  <div className="aspect-square bg-muted flex items-center justify-center relative p-4">
                    {img.url ? (
                      <img src={img.url} alt="Product" className="max-w-full max-h-full object-contain mix-blend-multiply" loading="lazy" />
                    ) : (
                      <ImageIcon className="w-10 h-10 text-muted-foreground/30" />
                    )}
                    {img.imageType && (
                      <div className="absolute top-2 right-2 bg-white/90 backdrop-blur-sm px-2 py-1 rounded-[2px] font-mono text-[12px] font-medium">
                        {img.imageType}
                      </div>
                    )}
                  </div>
                  <CardContent className="p-4 bg-white border-t border-border">
                    <Link href={`/products/${img.productId}`} className="block truncate text-[14px] font-medium text-primary hover:underline underline-offset-4 mb-3">
                      {img.productHandle || img.productId}
                    </Link>

                    <div className="space-y-2 text-[12px] mono-label">
                      <div className="flex justify-between items-center text-muted-foreground">
                        <span>WHITE BG</span>
                        <span className={`w-8 text-right font-medium ${img.whiteBgScore && img.whiteBgScore > 0.9 ? 'text-green-600' : 'text-primary'}`}>
                          {img.whiteBgScore ? img.whiteBgScore.toFixed(2) : '--'}
                        </span>
                      </div>
                      <div className="flex justify-between items-center text-muted-foreground">
                        <span>SOLID BG</span>
                        <span className="w-8 text-right text-primary font-medium">
                          {img.solidBgScore ? img.solidBgScore.toFixed(2) : '--'}
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {data?.items.length === 0 && (
              <div className="h-64 flex items-center justify-center text-muted-foreground border border-dashed border-border rounded-[20px] bg-muted mono-label uppercase">
                No images found
              </div>
            )}

            <div className="flex items-center justify-between text-sm text-muted-foreground mono-label pt-4 border-t border-border">
              <div>
                SHOWING {page * limit + 1} TO {Math.min((page + 1) * limit, data?.total || 0)} OF {data?.total || 0}
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" className="mono-label !h-8 !px-3" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>
                  Prev
                </Button>
                <Button variant="ghost" size="sm" className="mono-label !h-8 !px-3" onClick={() => setPage(p => p + 1)} disabled={!data || (page + 1) * limit >= data.total}>
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
