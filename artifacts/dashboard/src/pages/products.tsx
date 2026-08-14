import React, { useState } from "react";
import { useListDashboardProducts } from "@workspace/api-client-react";
import { Link, useLocation } from "wouter";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";

export default function Products() {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 500);
  const [market, setMarket] = useState("all");
  const [availability, setAvailability] = useState("all");
  const [, navigate] = useLocation();
  
  const limit = 20;

  const { data: productsData, isLoading } = useListDashboardProducts({
    limit,
    offset: page * limit,
    ...(debouncedSearch && { q: debouncedSearch }),
    ...(market !== "all" && { market }),
    ...(availability !== "all" && { availability }),
  });

  return (
    <div className="space-y-[100px]">
      <section className="flex flex-col md:flex-row md:items-center justify-between gap-8 pt-8">
        <div>
          <h1 className="text-[72px] font-normal leading-[1.1] tracking-[-2.16px] text-primary">Master Catalog</h1>
          <p className="text-[18px] text-muted-foreground mt-4 max-w-2xl">
            Search, filter, and inspect products passing through the pipeline.
          </p>
        </div>
      </section>

      <section className="space-y-6">
        <div className="flex flex-wrap gap-4 items-center bg-white p-6 rounded-[14px] shadow-shade-inset border border-border">
          <div className="relative flex-1 min-w-[300px]">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Search handle, SKU, title..." 
              className="pl-10 h-10 bg-bone border-transparent shadow-none"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            />
          </div>
          
          <Select value={market} onValueChange={(v) => { setMarket(v); setPage(0); }}>
            <SelectTrigger className="w-[180px] h-10 bg-bone border-transparent shadow-none rounded-[9px]">
              <SelectValue placeholder="Market" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Markets</SelectItem>
              <SelectItem value="CH">Switzerland (CH)</SelectItem>
              <SelectItem value="DE">Germany (DE)</SelectItem>
              <SelectItem value="AT">Austria (AT)</SelectItem>
              <SelectItem value="FR">France (FR)</SelectItem>
            </SelectContent>
          </Select>

          <Select value={availability} onValueChange={(v) => { setAvailability(v); setPage(0); }}>
            <SelectTrigger className="w-[180px] h-10 bg-bone border-transparent shadow-none rounded-[9px]">
              <SelectValue placeholder="Availability" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Availability</SelectItem>
              <SelectItem value="in_stock">In Stock</SelectItem>
              <SelectItem value="out_of_stock">Out of Stock</SelectItem>
              <SelectItem value="preorder">Preorder</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Handle / Title</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead className="text-right">Variants</TableHead>
              <TableHead>Availability</TableHead>
              <TableHead>Markets</TableHead>
              <TableHead className="text-right">Quality</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">Loading products...</TableCell>
              </TableRow>
            ) : productsData?.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">No products found matching criteria</TableCell>
              </TableRow>
            ) : (
              productsData?.items.map(product => (
                <TableRow key={product.id} className="cursor-pointer" onClick={() => navigate(`/products/${product.id}`)}>
                  <TableCell>
                    <Link href={`/products/${product.id}`} className="text-[16px] text-primary hover:underline underline-offset-4" onClick={e => e.stopPropagation()}>
                      {product.handle}
                    </Link>
                    <div className="text-[14px] text-muted-foreground truncate max-w-[300px] mt-1" title={product.title || ''}>
                      {product.title || '--'}
                    </div>
                  </TableCell>
                  <TableCell className="text-[14px]">{product.vendor || '--'}</TableCell>
                  <TableCell className="text-right font-mono text-[14px]">
                    {product.eligibleVariantCount} / {product.variantCount}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={product.availability} />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2 flex-wrap">
                      {product.markets.map(m => (
                        <span key={m} className="px-2 py-1 bg-bone text-[12px] rounded-[2px] font-mono text-primary">
                          {m}
                        </span>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono font-medium text-[14px]">
                    {product.avgQualityScore ? product.avgQualityScore.toFixed(0) : '--'}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        <div className="flex items-center justify-between text-sm text-muted-foreground mono-label pt-4 border-t border-hairline">
          <div>
            SHOWING {page * limit + 1} TO {Math.min((page + 1) * limit, productsData?.total || 0)} OF {productsData?.total || 0}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" className="mono-label !h-8 !px-3" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>
               Prev
            </Button>
            <Button variant="ghost" size="sm" className="mono-label !h-8 !px-3" onClick={() => setPage(p => p + 1)} disabled={!productsData || (page + 1) * limit >= productsData.total}>
              Next 
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}