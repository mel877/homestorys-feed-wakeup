import React from "react";
import { useGetInventoryBreakdown } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Boxes, Package, MapPin, CheckCircle2, XCircle } from "lucide-react";
import { StatusBadge } from "@/components/ui/status-badge";

export default function Inventory() {
  const { data, isLoading } = useGetInventoryBreakdown();

  if (isLoading || !data) {
    return <div className="p-8">Loading inventory data...</div>;
  }

  const { byLocation, byAvailability, showroomStock, totalVariants, inStockVariants, outOfStockVariants } = data;

  return (
    <div className="space-y-8">
      <section className="flex flex-col md:flex-row md:items-center justify-between gap-8 pt-8">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-foreground">Inventory</h1>
          <p className="text-[18px] text-muted-foreground mt-4 max-w-2xl">
            Stock distribution across fulfillment locations.
          </p>
        </div>
      </section>

      <section>
        <h2 className="mono-label text-muted-foreground mb-6 uppercase">Network Health</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-[10px]">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="mono-label text-muted-foreground uppercase text-sm">Tracked Variants</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-[28px] font-semibold tracking-tight leading-none text-foreground">
                {totalVariants?.toLocaleString() || '--'}
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="mono-label text-muted-foreground uppercase text-sm">In Stock</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-[28px] font-semibold tracking-tight leading-none text-green-600">
                {inStockVariants?.toLocaleString() || '--'}
              </div>
              <p className="text-[14px] text-muted-foreground mt-2">Variants with {'>'}0 qty</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="mono-label text-muted-foreground uppercase text-sm">Out of Stock</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-[28px] font-semibold tracking-tight leading-none text-destructive">
                {outOfStockVariants?.toLocaleString() || '--'}
              </div>
              <p className="text-[14px] text-muted-foreground mt-2">Variants with 0 qty</p>
            </CardContent>
          </Card>
        </div>
      </section>

      <section>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <div className="flex items-center justify-between mb-6">
              <h2 className="mono-label text-muted-foreground uppercase">By Location</h2>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Location</TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead className="text-right">Variants</TableHead>
                  <TableHead className="text-right">Total Units</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byLocation.map(loc => (
                  <TableRow key={loc.shopifyLocationId}>
                    <TableCell className="text-[14px]">{loc.locationName}</TableCell>
                    <TableCell className="font-mono text-[12px] text-muted-foreground">{loc.shopifyLocationId.substring(loc.shopifyLocationId.length - 12)}</TableCell>
                    <TableCell className="text-right font-mono text-[14px]">{loc.variantCount.toLocaleString()}</TableCell>
                    <TableCell className="text-right font-mono font-medium text-[14px]">{loc.totalUnits.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="space-y-8">
            <div>
              <div className="flex items-center justify-between mb-6">
                <h2 className="mono-label text-muted-foreground uppercase">By Status</h2>
              </div>
              <div className="grid gap-[10px]">
                {byAvailability.map(avail => (
                  <Card key={avail.availability} className="p-4 flex items-center justify-between bg-white border border-border shadow-none rounded-[20px]">
                    <StatusBadge status={avail.availability} />
                    <div className="font-mono text-[20px] tracking-[-0.2px] text-primary">{avail.count.toLocaleString()}</div>
                  </Card>
                ))}
              </div>
            </div>

            {showroomStock && (
              <div>
                <div className="flex items-center justify-between mb-6">
                  <h2 className="mono-label text-muted-foreground uppercase text-primary">Showroom Highlight</h2>
                </div>
                <Card className="bg-muted border-transparent shadow-none p-6">
                  <div className="text-[24px] tracking-[-0.24px] text-primary mb-6">{showroomStock.locationName}</div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="mono-label text-muted-foreground mb-1 uppercase">Variants</div>
                      <div className="font-mono text-[24px] tracking-[-0.24px] text-primary">{showroomStock.variantCount.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="mono-label text-muted-foreground mb-1 uppercase">Total Units</div>
                      <div className="font-mono text-[24px] tracking-[-0.24px] text-primary">{showroomStock.totalUnits.toLocaleString()}</div>
                    </div>
                  </div>
                </Card>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}