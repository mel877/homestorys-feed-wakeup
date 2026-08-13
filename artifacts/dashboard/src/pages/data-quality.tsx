import React, { useState } from "react";
import { useGetDataQuality } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { Database, AlertCircle } from "lucide-react";
import { Link } from "wouter";

export default function DataQuality() {
  const [threshold, setThreshold] = useState("70");
  const [market, setMarket] = useState("all");

  const { data, isLoading } = useGetDataQuality({
    threshold: Number(threshold),
    ...(market !== "all" && { market }),
    limit: 50
  });

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <Database className="w-8 h-8 text-primary" /> Data Quality
          </h1>
          <p className="text-muted-foreground mt-1">Algorithmic scoring of product content and imagery</p>
        </div>
        <div className="flex items-center gap-4 bg-card p-2 rounded-lg border">
          <Select value={market} onValueChange={setMarket}>
            <SelectTrigger className="w-[120px]">
              <SelectValue placeholder="Market" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Markets</SelectItem>
              <SelectItem value="CH">CH</SelectItem>
              <SelectItem value="DE">DE</SelectItem>
              <SelectItem value="AT">AT</SelectItem>
              <SelectItem value="FR">FR</SelectItem>
            </SelectContent>
          </Select>
          <Select value={threshold} onValueChange={setThreshold}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Threshold" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="60">Score ≤ 60</SelectItem>
              <SelectItem value="70">Score ≤ 70</SelectItem>
              <SelectItem value="80">Score ≤ 80</SelectItem>
              <SelectItem value="90">Score ≤ 90</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading || !data ? (
        <div className="h-64 flex items-center justify-center text-muted-foreground">Loading report...</div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">Average Score</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-4xl font-bold font-mono">
                  {data.avgScore !== null ? data.avgScore.toFixed(1) : '--'}
                </div>
              </CardContent>
            </Card>
            
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">Scored Variants</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-4xl font-bold font-mono">{data.totalVariants.toLocaleString()}</div>
              </CardContent>
            </Card>

            <Card className="bg-destructive/5 border-destructive/20">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-destructive flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" /> Below Threshold
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-4xl font-bold font-mono text-destructive">{data.variantsBelowThreshold.toLocaleString()}</div>
                <p className="text-xs text-muted-foreground mt-1">Needs attention</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Score Distribution</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.distribution} margin={{ top: 20, right: 30, left: 0, bottom: 0 }}>
                    <XAxis dataKey="label" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis fontSize={12} tickLine={false} axisLine={false} />
                    <Tooltip 
                      cursor={{ fill: 'transparent' }}
                      contentStyle={{ borderRadius: '8px', border: '1px solid hsl(var(--border))', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                    />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                      {data.distribution.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.maxScore <= Number(threshold) ? 'hsl(var(--destructive))' : 'hsl(var(--primary))'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Low Quality Items (Top 50)</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Handle</TableHead>
                    <TableHead>Variant ID</TableHead>
                    <TableHead>Market/Lang</TableHead>
                    <TableHead className="text-right">Score</TableHead>
                    <TableHead>Primary Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.lowQualityProducts.map((p, i) => (
                    <TableRow key={`${p.variantId}-${p.marketCode}-${i}`}>
                      <TableCell>
                        <Link href={`/products/${p.productId}`} className="font-medium text-primary hover:underline">
                          {p.handle}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {p.variantId.substring(p.variantId.length - 12)}
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {p.marketCode}-{p.language}
                      </TableCell>
                      <TableCell className="text-right font-mono font-medium text-destructive">
                        {p.score}
                      </TableCell>
                      <TableCell className="text-sm max-w-md truncate text-muted-foreground" title={p.exclusionReason || ''}>
                        {p.exclusionReason || 'Low score'}
                      </TableCell>
                    </TableRow>
                  ))}
                  {data.lowQualityProducts.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                        No items found below score threshold
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
