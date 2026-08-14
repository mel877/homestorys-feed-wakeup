import React, { useState } from "react";
import { useListImageAnalysis } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Image as ImageIcon } from "lucide-react";
import { Link } from "wouter";
import { StatusBadge } from "@/components/ui/status-badge";

export default function Images() {
  const [page, setPage] = useState(0);
  const [classified, setClassified] = useState<string>("all");
  const limit = 24;

  const { data, isLoading } = useListImageAnalysis({
    limit,
    offset: page * limit,
    ...(classified === "true" ? { classified: true } : classified === "false" ? { classified: false } : {})
  });

  return (
    <div className="space-y-[100px]">
      <section className="flex flex-col md:flex-row md:items-center justify-between gap-8 pt-8">
        <div>
          <h1 className="text-[72px] font-normal leading-[1.1] tracking-[-2.16px] text-primary">Image Pipeline</h1>
          <p className="text-[18px] text-muted-foreground mt-4 max-w-2xl">
            Review automated visual classification and quality scoring.
          </p>
        </div>
      </section>

      <section className="space-y-6">
        <div className="flex flex-wrap gap-4 items-center bg-white p-6 rounded-[14px] shadow-shade-inset border border-border">
          <div className="mono-label text-muted-foreground uppercase mr-4">Filter by</div>
          <Select value={classified} onValueChange={(v) => { setClassified(v); setPage(0); }}>
            <SelectTrigger className="w-[180px] h-10 bg-bone border-transparent shadow-none rounded-[9px]">
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
                <Card key={img.id} className="overflow-hidden border-border bg-white shadow-shade-inset p-0 transition-colors hover:border-primary group">
                  <div className="aspect-square bg-bone flex items-center justify-center relative p-4">
                    {img.url ? (
                      <img src={img.url} alt="Product" className="max-w-full max-h-full object-contain mix-blend-multiply" loading="lazy" />
                    ) : (
                      <ImageIcon className="w-10 h-10 text-muted-foreground/30" />
                    )}
                    {img.imageType && (
                      <div className="absolute top-2 right-2 bg-white/90 backdrop-blur-sm px-2 py-1 rounded-[2px] font-mono text-[12px] font-medium shadow-shade-subtle">
                        {img.imageType}
                      </div>
                    )}
                  </div>
                  <CardContent className="p-4 bg-white border-t border-hairline">
                    <Link href={`/products/${img.productId}`} className="block truncate text-[14px] font-medium text-primary hover:underline underline-offset-4 mb-3">
                      {img.productHandle || img.productId}
                    </Link>
                    
                    <div className="space-y-2 text-[12px] mono-label">
                      <div className="flex justify-between items-center text-muted-foreground">
                        <span>WHITE BG</span>
                        <div className="flex items-center gap-2">
                          <span className={`w-8 text-right font-medium ${img.whiteBgScore && img.whiteBgScore > 0.9 ? 'text-green-600' : 'text-primary'}`}>
                            {img.whiteBgScore ? img.whiteBgScore.toFixed(2) : '--'}
                          </span>
                        </div>
                      </div>
                      <div className="flex justify-between items-center text-muted-foreground">
                        <span>SOLID BG</span>
                        <div className="flex items-center gap-2">
                          <span className="w-8 text-right text-primary font-medium">
                            {img.solidBgScore ? img.solidBgScore.toFixed(2) : '--'}
                          </span>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
            
            {data?.items.length === 0 && (
              <div className="h-64 flex items-center justify-center text-muted-foreground border border-dashed border-hairline rounded-[14px] bg-bone mono-label uppercase">
                No images found
              </div>
            )}

            <div className="flex items-center justify-between text-sm text-muted-foreground mono-label pt-4 border-t border-hairline">
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