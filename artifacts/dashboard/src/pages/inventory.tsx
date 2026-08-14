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
    <div className="p-8 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <Boxes className="w-8 h-8 text-primary" /> Inventory Network
          </h1>
          <p className="text-muted-foreground mt-1">Stock distribution across fulfillment locations</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm text-muted-foreground">Tracked Variants</CardTitle>
            <Package className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold font-mono">{totalVariants?.toLocaleString() || '--'}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm text-muted-foreground">In Stock</CardTitle>
            <CheckCircle2 className="w-4 h-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold font-mono text-green-600">{inStockVariants?.toLocaleString() || '--'}</div>
            <p className="text-xs text-muted-foreground mt-1">Variants with {'>'}0 qty</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm text-muted-foreground">Out of Stock</CardTitle>
            <XCircle className="w-4 h-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold font-mono text-destructive">{outOfStockVariants?.toLocaleString() || '--'}</div>
            <p className="text-xs text-muted-foreground mt-1">Variants with 0 qty</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>By Location</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Location</TableHead>
                  <TableHead>ID</TableHead>
                  <TableHead className="text-right">Variants Stored</TableHead>
                  <TableHead className="text-right">Total Units</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byLocation.map(loc => (
                  <TableRow key={loc.shopifyLocationId}>
                    <TableCell className="font-medium flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-muted-foreground" />
                      {loc.locationName}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{loc.shopifyLocationId}</TableCell>
                    <TableCell className="text-right font-mono">{loc.variantCount.toLocaleString()}</TableCell>
                    <TableCell className="text-right font-mono font-medium">{loc.totalUnits.toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>By Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {byAvailability.map(avail => (
                  <div key={avail.availability} className="flex justify-between items-center border-b border-border/50 pb-3 last:border-0 last:pb-0">
                    <StatusBadge status={avail.availability} />
                    <div className="font-mono font-medium">{avail.count.toLocaleString()}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {showroomStock && (
            <Card className="bg-primary/5 border-primary/20">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-primary">
                  <MapPin className="w-5 h-5" />
                  Showroom Highlight
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-lg font-medium mb-1">{showroomStock.locationName}</div>
                <div className="grid grid-cols-2 gap-4 mt-4">
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Variants</div>
                    <div className="font-mono text-xl">{showroomStock.variantCount.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Total Units</div>
                    <div className="font-mono text-xl">{showroomStock.totalUnits.toLocaleString()}</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
