import React, { useState } from "react";
import { useListImageAnalysis } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Image as ImageIcon } from "lucide-react";
import { Link } from "wouter";

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
    <div className="p-8 space-y-6 max-w-[1600px] mx-auto">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Image Pipeline</h1>
          <p className="text-muted-foreground mt-1">Review automated image classifications</p>
        </div>
        <div className="flex items-center gap-4 bg-card p-2 rounded-lg border">
          <Select value={classified} onValueChange={(v) => { setClassified(v); setPage(0); }}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Images</SelectItem>
              <SelectItem value="true">Classified</SelectItem>
              <SelectItem value="false">Unclassified</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="h-64 flex items-center justify-center text-muted-foreground">Loading images...</div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {data?.items.map(img => (
              <Card key={img.id} className="overflow-hidden hover:border-primary transition-colors group">
                <div className="aspect-square bg-muted/30 relative flex items-center justify-center p-4">
                  {img.url ? (
                    <img src={img.url} alt="Product" className="max-w-full max-h-full object-contain mix-blend-multiply transition-transform group-hover:scale-105" loading="lazy" />
                  ) : (
                    <ImageIcon className="w-8 h-8 text-muted-foreground/30" />
                  )}
                  {img.imageType && (
                    <div className="absolute top-2 right-2 bg-black/70 text-white px-2 py-0.5 text-[10px] font-mono rounded font-medium shadow-sm">
                      {img.imageType}
                    </div>
                  )}
                  <Link href={`/products/${img.productId}`} className="absolute bottom-2 left-2 right-2 truncate bg-white/90 backdrop-blur-sm px-2 py-1 text-[10px] font-mono rounded text-center opacity-0 group-hover:opacity-100 transition-opacity text-foreground hover:text-primary hover:underline">
                    {img.productHandle || img.productId}
                  </Link>
                </div>
                <CardContent className="p-3 text-xs space-y-1.5 bg-card border-t">
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">White Bg</span>
                    <div className="flex items-center gap-1.5">
                      <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className={`h-full ${img.whiteBgScore && img.whiteBgScore > 0.9 ? 'bg-green-500' : 'bg-primary'}`} style={{ width: `${(img.whiteBgScore || 0) * 100}%` }} />
                      </div>
                      <span className="font-mono w-8 text-right">{img.whiteBgScore ? img.whiteBgScore.toFixed(2) : '--'}</span>
                    </div>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Solid Bg</span>
                    <div className="flex items-center gap-1.5">
                      <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-primary/70" style={{ width: `${(img.solidBgScore || 0) * 100}%` }} />
                      </div>
                      <span className="font-mono w-8 text-right">{img.solidBgScore ? img.solidBgScore.toFixed(2) : '--'}</span>
                    </div>
                  </div>
                  {img.selectionReason && (
                    <div className="pt-1 mt-1 border-t border-border/50 text-[10px] text-muted-foreground line-clamp-1" title={img.selectionReason}>
                      {img.selectionReason}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
          
          {data?.items.length === 0 && (
            <div className="h-64 flex items-center justify-center text-muted-foreground border border-dashed rounded-lg bg-card/50">
              No images found
            </div>
          )}

          <div className="flex items-center justify-between mt-6 text-sm text-muted-foreground">
            <div>
              Showing {page * limit + 1} to {Math.min((page + 1) * limit, data?.total || 0)} of {data?.total || 0}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>
                <ChevronLeft className="w-4 h-4 mr-1" /> Prev
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={!data || (page + 1) * limit >= data.total}>
                Next <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
