import React, { useState } from "react";
import { useListDashboardProducts } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Search, ChevronLeft, ChevronRight, SlidersHorizontal } from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";

export default function Products() {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 500);
  const [market, setMarket] = useState("all");
  const [availability, setAvailability] = useState("all");
  
  const limit = 20;

  const { data: productsData, isLoading } = useListDashboardProducts({
    limit,
    offset: page * limit,
    ...(debouncedSearch && { q: debouncedSearch }),
    ...(market !== "all" && { market }),
    ...(availability !== "all" && { availability }),
  });

  return (
    <div className="p-8 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Products</h1>
          <p className="text-muted-foreground mt-1">Search and filter through the master catalog</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-4 items-center bg-card p-4 rounded-lg border">
        <div className="relative flex-1 min-w-[250px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input 
            placeholder="Search handle, SKU, title..." 
            className="pl-9"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          />
        </div>
        
        <Select value={market} onValueChange={(v) => { setMarket(v); setPage(0); }}>
          <SelectTrigger className="w-[150px]">
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
          <SelectTrigger className="w-[150px]">
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

      <div className="border rounded-md bg-card overflow-hidden">
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
                <TableRow key={product.id} className="hover:bg-muted/50 cursor-pointer" onClick={() => window.location.href = `/products/${product.id}`}>
                  <TableCell>
                    <Link href={`/products/${product.id}`} className="font-medium text-primary hover:underline" onClick={e => e.stopPropagation()}>
                      {product.handle}
                    </Link>
                    <div className="text-sm text-muted-foreground truncate max-w-[300px]" title={product.title || ''}>
                      {product.title || '--'}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{product.vendor || '--'}</TableCell>
                  <TableCell className="text-right font-mono">
                    {product.eligibleVariantCount} / {product.variantCount}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={product.availability} />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1 flex-wrap">
                      {product.markets.map(m => (
                        <span key={m} className="px-1.5 py-0.5 bg-secondary text-xs rounded font-mono text-secondary-foreground">
                          {m}
                        </span>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono font-medium">
                    {product.avgQualityScore ? product.avgQualityScore.toFixed(0) : '--'}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between mt-4 text-sm text-muted-foreground">
        <div>
          Showing {page * limit + 1} to {Math.min((page + 1) * limit, productsData?.total || 0)} of {productsData?.total || 0}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>
            <ChevronLeft className="w-4 h-4 mr-1" /> Prev
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={!productsData || (page + 1) * limit >= productsData.total}>
            Next <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      </div>
    </div>
  );
}
