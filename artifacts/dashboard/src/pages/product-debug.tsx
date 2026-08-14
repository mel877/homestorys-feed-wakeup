import React from "react";
import { useGetDashboardProduct } from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { StatusBadge } from "@/components/ui/status-badge";
import { ArrowLeft, CheckCircle2, XCircle, Info, ExternalLink, Image as ImageIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format } from "date-fns";

export default function ProductDebug() {
  const params = useParams();
  const id = params.id as string;
  const { data: debug, isLoading } = useGetDashboardProduct(id, { query: { enabled: !!id, queryKey: ['product', id] } });

  if (isLoading) {
    return <div className="p-8 text-[14px] text-muted-foreground">Loading product details...</div>;
  }

  if (!debug) {
    return <div className="p-8 text-destructive text-[14px]">Product not found</div>;
  }

  const { product, variants, translations, marketVariants, images, inventory, feedItems, recommendations } = debug;

  return (
    <div className="space-y-[32px] pt-8">
      <section>
        <Link href="/products" className="text-[13px] font-medium text-muted-foreground hover:text-foreground inline-flex items-center mb-6 transition-colors">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to products
        </Link>
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-8">
          <div>
            <div className="flex items-center gap-4">
              <h1 className="text-[28px] font-bold tracking-tight text-foreground">{product.handle}</h1>
              <StatusBadge status={product.status} />
            </div>
            <p className="text-[14px] text-muted-foreground mt-2 font-medium">
              {product.vendor || 'No vendor'} <span className="mx-2">•</span> {product.productType || 'No type'}
            </p>
            <div className="flex gap-2 mt-4 flex-wrap">
              {product.tags?.map(t => (
                <span key={t} className="px-2.5 py-1 bg-muted text-foreground text-[12px] rounded-[18px] font-medium border border-border">
                  {t}
                </span>
              ))}
            </div>
          </div>
          <div className="text-right text-[12px] text-muted-foreground font-mono bg-card p-4 rounded-[14px] border border-border shrink-0 shadow-sm">
            <div className="mb-1 text-foreground">ID: {product.id}</div>
            <div className="mb-1">GID: {product.shopifyGid}</div>
            <div>CREATED: {product.createdAt ? format(new Date(product.createdAt), "yyyy-MM-dd HH:mm") : '--'}</div>
          </div>
        </div>
      </section>

      <section className="bg-card border border-border shadow-card rounded-[20px] overflow-hidden">
        <Tabs defaultValue="variants" className="w-full">
          <div className="px-6 pt-2 bg-[#fafafa] border-b border-border">
            <TabsList className="w-full justify-start overflow-x-auto h-auto border-none">
              <TabsTrigger value="variants">Variants ({variants.length})</TabsTrigger>
              <TabsTrigger value="markets">Markets ({marketVariants.length})</TabsTrigger>
              <TabsTrigger value="content">Content ({translations.length})</TabsTrigger>
              <TabsTrigger value="images">Images ({images.length})</TabsTrigger>
              <TabsTrigger value="inventory">Inventory ({inventory.length})</TabsTrigger>
              <TabsTrigger value="feeds">Feeds ({feedItems.length})</TabsTrigger>
              <TabsTrigger value="recs">Recs ({recommendations.length})</TabsTrigger>
            </TabsList>
          </div>

          <div className="p-6">
            <TabsContent value="variants" className="mt-0">
              <Table className="border-none shadow-none bg-transparent">
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>GTIN</TableHead>
                    <TableHead>Weight</TableHead>
                    <TableHead>Lifecycle</TableHead>
                    <TableHead>Google Cat</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {variants.map(v => (
                    <TableRow key={v.id}>
                      <TableCell className="font-mono text-[13px]">{v.sku || '--'}</TableCell>
                      <TableCell className="text-[13px] font-medium">{v.title || '--'}</TableCell>
                      <TableCell className="font-mono text-[13px] text-muted-foreground">{v.gtin || '--'}</TableCell>
                      <TableCell className="font-mono text-[13px] text-muted-foreground">{v.weight ? `${v.weight} ${v.weightUnit}` : '--'}</TableCell>
                      <TableCell><StatusBadge status={v.available ? "Available" : "Unavailable"} /></TableCell>
                      <TableCell className="text-[13px] text-muted-foreground max-w-[200px] truncate" title={v.googleCategory || ''}>
                        {v.googleCategory || '--'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>

            <TabsContent value="markets" className="mt-0">
              <Table className="border-none shadow-none bg-transparent">
                <TableHeader>
                  <TableRow>
                    <TableHead>Variant ID</TableHead>
                    <TableHead>Market</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Compare At</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {marketVariants.map((mv, i) => (
                    <TableRow key={`${mv.variantId}-${mv.marketCode}-${i}`}>
                      <TableCell className="font-mono text-[13px] text-muted-foreground">{mv.variantId.substring(mv.variantId.length - 8)}</TableCell>
                      <TableCell className="font-semibold text-[13px] uppercase tracking-wider">{mv.marketCode}</TableCell>
                      <TableCell><StatusBadge status={mv.availability} /></TableCell>
                      <TableCell className="font-mono text-[13px] font-medium">{mv.priceAmount} {mv.priceCurrency}</TableCell>
                      <TableCell className="font-mono text-[13px] text-muted-foreground">{mv.compareAtPriceAmount ? `${mv.compareAtPriceAmount} ${mv.priceCurrency}` : '--'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>

            <TabsContent value="content" className="mt-0">
              <Table className="border-none shadow-none bg-transparent">
                <TableHeader>
                  <TableRow>
                    <TableHead>Language</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Description</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {translations.map((t, i) => (
                    <TableRow key={`${t.language}-${i}`}>
                      <TableCell className="font-semibold text-[13px] uppercase tracking-wider">{t.language}</TableCell>
                      <TableCell className="text-[13px] font-medium">{t.title}</TableCell>
                      <TableCell className="max-w-[400px]">
                        <div className="line-clamp-2 text-[13px] text-muted-foreground" title={t.description || ''}>
                          {t.description || '--'}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>

            <TabsContent value="images" className="mt-0">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                {images.map((img, i) => (
                  <Card key={img.id || i} className="overflow-hidden border-border bg-card shadow-sm p-0 rounded-[14px]">
                    <div className="aspect-square bg-muted flex items-center justify-center relative group p-4">
                      {img.url ? (
                        <img src={img.url} alt={`Product ${i}`} className="max-w-full max-h-full object-contain mix-blend-multiply" loading="lazy" />
                      ) : (
                        <ImageIcon className="w-8 h-8 text-muted-foreground/30" />
                      )}
                      <div className="absolute top-2 right-2 bg-white/90 backdrop-blur-sm px-2 py-1 rounded-[4px] font-mono text-[11px] font-medium shadow-xs border border-border">
                        Pos: {img.position}
                      </div>
                    </div>
                    <CardContent className="p-3 border-t border-border bg-card">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[11px] font-mono text-muted-foreground truncate" title={img.url}>{new URL(img.url).pathname.split('/').pop()}</div>
                      </div>
                      <div className="flex gap-2">
                        <StatusBadge status={img.classifiedAt ? 'analyzed' : 'pending'} variant="dot" label={img.classifiedAt ? 'Analyzed' : 'Pending'} />
                        {img.resolutionScore !== null && img.resolutionScore !== undefined && (
                          <div className={`text-[11px] font-mono font-medium ${img.resolutionScore < 50 ? 'text-[#e7000b]' : img.resolutionScore > 80 ? 'text-[hsl(142,71%,45%)]' : 'text-[hsl(38,92%,50%)]'}`}>
                            Score: {img.resolutionScore}
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="inventory" className="mt-0">
              <Table className="border-none shadow-none bg-transparent">
                <TableHeader>
                  <TableRow>
                    <TableHead>Location</TableHead>
                    <TableHead className="text-right">Available</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inventory.map((inv, i) => (
                    <TableRow key={`${inv.shopifyLocationId}-${i}`}>
                      <TableCell className="font-mono text-[13px] text-muted-foreground">{inv.shopifyLocationId.substring(inv.shopifyLocationId.length - 12)}</TableCell>
                      <TableCell className="text-right font-mono text-[13px] font-medium">
                        <span className={inv.available > 0 ? "text-[hsl(142,71%,45%)]" : "text-[#e7000b]"}>
                          {inv.available}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>

            <TabsContent value="feeds" className="mt-0">
              <Table className="border-none shadow-none bg-transparent">
                <TableHeader>
                  <TableRow>
                    <TableHead>Channel</TableHead>
                    <TableHead>Market</TableHead>
                    <TableHead>Variant ID</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {feedItems.map((fi, i) => (
                    <TableRow key={`${fi.channel}-${fi.marketCode}-${fi.variantId}-${i}`}>
                      <TableCell className="font-medium capitalize text-[13px]">{fi.channel}</TableCell>
                      <TableCell className="font-semibold text-[13px] uppercase tracking-wider">{fi.marketCode}</TableCell>
                      <TableCell className="font-mono text-[13px] text-muted-foreground">{fi.variantId.substring(fi.variantId.length - 8)}</TableCell>
                      <TableCell><StatusBadge status={fi.isEligible ? 'Eligible' : 'Excluded'} /></TableCell>
                      <TableCell className="text-[13px] text-muted-foreground whitespace-nowrap">
                        {fi.generatedAt ? format(new Date(fi.generatedAt), "yyyy-MM-dd HH:mm") : '--'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>

            <TabsContent value="recs" className="mt-0">
              <Table className="border-none shadow-none bg-transparent">
                <TableHeader>
                  <TableRow>
                    <TableHead>Market</TableHead>
                    <TableHead>Related products</TableHead>
                    <TableHead>Complementary products</TableHead>
                    <TableHead>Generated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recommendations.map((rec, i) => (
                    <TableRow key={`${rec.marketCode}-${i}`}>
                      <TableCell className="font-semibold text-[13px] uppercase tracking-wider">{rec.marketCode}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2 max-w-[400px]">
                          {rec.relatedProductIds.length === 0 ? (
                            <span className="text-muted-foreground text-[13px]">--</span>
                          ) : (
                            rec.relatedProductIds.map(pid => (
                              <Link key={pid} href={`/products/${pid}`} className="px-2 py-1 bg-muted text-[12px] rounded-[4px] font-mono text-foreground hover:bg-muted/80 transition-colors inline-flex items-center gap-1 border border-border">
                                {pid.substring(pid.length - 8)}
                                <ExternalLink className="w-3 h-3 text-muted-foreground" />
                              </Link>
                            ))
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2 max-w-[400px]">
                          {rec.complementaryProductIds.length === 0 ? (
                            <span className="text-muted-foreground text-[13px]">--</span>
                          ) : (
                            rec.complementaryProductIds.map(pid => (
                              <Link key={pid} href={`/products/${pid}`} className="px-2 py-1 bg-muted text-[12px] rounded-[4px] font-mono text-foreground hover:bg-muted/80 transition-colors inline-flex items-center gap-1 border border-border">
                                {pid.substring(pid.length - 8)}
                                <ExternalLink className="w-3 h-3 text-muted-foreground" />
                              </Link>
                            ))
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-[13px] text-muted-foreground whitespace-nowrap">
                        {rec.generatedAt ? format(new Date(rec.generatedAt), "yyyy-MM-dd HH:mm") : '--'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>
          </div>
        </Tabs>
      </section>
    </div>
  );
}