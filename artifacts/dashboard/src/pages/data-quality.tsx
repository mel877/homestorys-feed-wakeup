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
    <div className="space-y-8">
      <section className="flex flex-col md:flex-row md:items-center justify-between gap-8 pt-8">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-foreground">Data Quality</h1>
          <p className="text-[18px] text-muted-foreground mt-4 max-w-2xl">
            Algorithmic scoring of product content and imagery.
          </p>
        </div>
      </section>

      <section className="space-y-6">
        <div className="flex flex-wrap gap-4 items-center bg-white p-6 rounded-[20px]  border border-border">
          <div className="mono-label text-muted-foreground uppercase mr-4">Filter by</div>
          <Select value={market} onValueChange={setMarket}>
            <SelectTrigger className="w-[180px] h-10 bg-muted border-transparent shadow-none rounded-[9px]">
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
            <SelectTrigger className="w-[180px] h-10 bg-muted border-transparent shadow-none rounded-[9px]">
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

        {isLoading || !data ? (
          <div className="h-64 flex items-center justify-center text-muted-foreground mono-label uppercase">Loading report...</div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-[10px]">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="mono-label text-muted-foreground uppercase text-sm">Average Score</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-[28px] font-semibold tracking-tight leading-none text-foreground">
                    {data.avgScore !== null ? data.avgScore.toFixed(1) : '--'}
                  </div>
                </CardContent>
              </Card>
              
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="mono-label text-muted-foreground uppercase text-sm">Scored Variants</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-[28px] font-semibold tracking-tight leading-none text-foreground">
                    {data.totalVariants.toLocaleString()}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="mono-label text-muted-foreground uppercase text-sm text-destructive flex items-center gap-2">
                    Below Threshold
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-[28px] font-semibold tracking-tight leading-none text-destructive">
                    {data.variantsBelowThreshold.toLocaleString()}
                  </div>
                  <p className="text-[14px] text-muted-foreground mt-2">Needs attention</p>
                </CardContent>
              </Card>
            </div>

            <Card className="bg-muted border-transparent shadow-none p-8">
              <CardHeader className="px-0 pt-0">
                <CardTitle className="mono-label text-muted-foreground uppercase">Score Distribution</CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0">
                <div className="h-[300px] w-full mt-6">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.distribution} margin={{ top: 20, right: 30, left: 0, bottom: 0 }}>
                      <XAxis dataKey="label" fontSize={14} fontFamily="var(--font-mono)" tickLine={false} axisLine={false} tick={{ fill: 'hsl(var(--muted-foreground))' }} dy={10} />
                      <YAxis fontSize={14} fontFamily="var(--font-mono)" tickLine={false} axisLine={false} tick={{ fill: 'hsl(var(--muted-foreground))' }} dx={-10} />
                      <Tooltip 
                        cursor={{ fill: 'rgba(0,0,0,0.02)' }}
                        contentStyle={{ borderRadius: '9px', border: '1px solid hsl(var(--border))', boxShadow: '0px 1px 4px 0px rgba(19, 19, 21, 0.12)', fontFamily: 'var(--font-mono)', fontSize: '14px' }}
                      />
                      <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                        {data.distribution.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.maxScore <= Number(threshold) ? 'hsl(var(--destructive))' : '#855cf7'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <div>
              <div className="flex items-center justify-between mb-6">
                <h2 className="mono-label text-muted-foreground uppercase">Low Quality Items (Top 50)</h2>
              </div>
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
                        <Link href={`/products/${p.productId}`} className="text-[16px] font-medium text-primary hover:underline underline-offset-4">
                          {p.handle}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-[14px] text-muted-foreground">
                        {p.variantId.substring(p.variantId.length - 12)}
                      </TableCell>
                      <TableCell className="font-mono text-[14px]">
                        {p.marketCode}-{p.language}
                      </TableCell>
                      <TableCell className="text-right font-mono font-medium text-[14px] text-destructive">
                        {p.score}
                      </TableCell>
                      <TableCell className="text-[14px] max-w-[400px] truncate text-muted-foreground" title={p.exclusionReason || ''}>
                        {p.exclusionReason || 'Low score'}
                      </TableCell>
                    </TableRow>
                  ))}
                  {data.lowQualityProducts.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground py-8 mono-label uppercase">
                        No items found below score threshold
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}