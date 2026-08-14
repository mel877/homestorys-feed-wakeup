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
    return <div className="p-8">Loading product details...</div>;
  }

  if (!debug) {
    return <div className="p-8 text-destructive">Product not found</div>;
  }

  const { product, variants, translations, marketVariants, images, inventory, feedItems, recommendations } = debug;

  return (
    <div className="p-8 space-y-6 max-w-[1400px] mx-auto">
      <Link href="/products" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center">
        <ArrowLeft className="w-4 h-4 mr-1" /> Back to products
      </Link>

      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{product.handle}</h1>
            <StatusBadge status={product.status} />
          </div>
          <p className="text-muted-foreground mt-1">{product.vendor || 'No vendor'} • {product.productType || 'No type'}</p>
          <div className="flex gap-2 mt-2">
            {product.tags?.map(t => (
              <span key={t} className="px-2 py-0.5 bg-muted text-muted-foreground text-xs rounded-full border">
                {t}
              </span>
            ))}
          </div>
        </div>
        <div className="text-right text-sm text-muted-foreground font-mono bg-card p-3 rounded-lg border">
          <div>ID: {product.id}</div>
          <div>GID: {product.shopifyGid}</div>
          <div>Created: {product.createdAt ? format(new Date(product.createdAt), "yyyy-MM-dd HH:mm") : '--'}</div>
        </div>
      </div>

      <Tabs defaultValue="variants">
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="variants">Variants ({variants.length})</TabsTrigger>
          <TabsTrigger value="markets">Markets ({marketVariants.length})</TabsTrigger>
          <TabsTrigger value="content">Content ({translations.length})</TabsTrigger>
          <TabsTrigger value="images">Images ({images.length})</TabsTrigger>
          <TabsTrigger value="inventory">Inventory ({inventory.length})</TabsTrigger>
          <TabsTrigger value="feeds">Feed Output ({feedItems.length})</TabsTrigger>
          <TabsTrigger value="recs">Recommendations</TabsTrigger>
        </TabsList>

        <TabsContent value="variants" className="mt-6">
          <div className="border rounded-md bg-card overflow-hidden">
            <Table>
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
                    <TableCell className="font-mono text-sm">{v.sku || '--'}</TableCell>
                    <TableCell>{v.title}</TableCell>
                    <TableCell className="font-mono text-xs">{v.gtin || '--'}</TableCell>
                    <TableCell>{v.weight ? `${v.weight}${v.weightUnit}` : '--'}</TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        {v.outlet && <StatusBadge status="Outlet" />}
                        {v.discontinued && <StatusBadge status="Discontinued" className="bg-destructive/10 text-destructive border-destructive/20" />}
                        {v.bestseller && <StatusBadge status="Bestseller" className="bg-primary/10 text-primary border-primary/20" />}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground truncate max-w-[200px]" title={v.googleCategory || ''}>
                      {v.googleCategory || '--'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="markets" className="mt-6">
          <div className="border rounded-md bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Variant ID</TableHead>
                  <TableHead>Market</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead>Availability</TableHead>
                  <TableHead>Eligibility</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {marketVariants.map((mv, i) => (
                  <TableRow key={`${mv.variantId}-${mv.marketCode}-${i}`}>
                    <TableCell className="font-mono text-xs">{mv.variantId.substring(mv.variantId.length - 12)}</TableCell>
                    <TableCell className="font-mono">{mv.marketCode}</TableCell>
                    <TableCell className="text-right font-mono">
                      {mv.priceAmount ? `${mv.priceAmount.toFixed(2)} ${mv.priceCurrency}` : '--'}
                      {mv.compareAtPriceAmount && (
                        <div className="text-xs line-through text-muted-foreground">
                          {mv.compareAtPriceAmount.toFixed(2)} {mv.priceCurrency}
                        </div>
                      )}
                    </TableCell>
                    <TableCell><StatusBadge status={mv.availability} /></TableCell>
                    <TableCell>
                      {mv.isEligible ? (
                        <span className="flex items-center text-green-600 text-sm font-medium"><CheckCircle2 className="w-4 h-4 mr-1"/> Eligible</span>
                      ) : (
                        <div className="flex flex-col">
                          <span className="flex items-center text-destructive text-sm font-medium"><XCircle className="w-4 h-4 mr-1"/> Excluded</span>
                          <span className="text-xs text-muted-foreground mt-1 max-w-[250px] truncate" title={mv.exclusionReason || ''}>{mv.exclusionReason}</span>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="content" className="mt-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {translations.map(t => (
              <Card key={t.language}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <span className="px-2 py-1 bg-primary/10 text-primary rounded font-mono text-sm">{t.language}</span>
                    <span className="text-base truncate" title={t.title}>{t.title}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-sm font-mono text-muted-foreground mb-4">Handle: {t.handle || product.handle}</div>
                  <p className="text-sm text-muted-foreground line-clamp-6 whitespace-pre-wrap">{t.description || 'No description'}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="images" className="mt-6">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {images.map(img => (
              <Card key={img.id} className="overflow-hidden">
                <div className="aspect-square bg-muted relative flex items-center justify-center p-2">
                  {img.url ? (
                    <img src={img.url} alt={img.altText || ''} className="max-w-full max-h-full object-contain mix-blend-multiply" loading="lazy" />
                  ) : (
                    <ImageIcon className="w-8 h-8 text-muted-foreground/30" />
                  )}
                  <div className="absolute top-2 left-2 bg-black/60 text-white px-1.5 py-0.5 text-[10px] font-mono rounded">
                    Pos {img.position}
                  </div>
                </div>
                <CardContent className="p-3 text-xs space-y-1 bg-card">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Type:</span>
                    <span className="font-mono">{img.imageType || '--'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">White Bg:</span>
                    <span className={`font-mono ${img.whiteBgScore && img.whiteBgScore > 0.9 ? 'text-green-600' : ''}`}>
                      {img.whiteBgScore ? img.whiteBgScore.toFixed(2) : '--'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Solid Bg:</span>
                    <span className="font-mono">{img.solidBgScore ? img.solidBgScore.toFixed(2) : '--'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Alpha:</span>
                    <span className="font-mono">{img.alphaRatio ? img.alphaRatio.toFixed(2) : '--'}</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="feeds" className="mt-6">
          <div className="border rounded-md bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Channel</TableHead>
                  <TableHead>Market/Lang</TableHead>
                  <TableHead>Variant ID</TableHead>
                  <TableHead>Score</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {feedItems.map((fi, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium capitalize">{fi.channel}</TableCell>
                    <TableCell className="font-mono text-sm">{fi.marketCode}-{fi.language}</TableCell>
                    <TableCell className="font-mono text-xs">{fi.variantId.substring(fi.variantId.length - 12)}</TableCell>
                    <TableCell className="font-mono">
                      {fi.dataQualityScore ? (
                        <span className={fi.dataQualityScore >= 70 ? 'text-green-600' : 'text-destructive'}>
                          {fi.dataQualityScore.toFixed(0)}
                        </span>
                      ) : '--'}
                    </TableCell>
                    <TableCell>
                      {fi.isEligible ? (
                        <span className="text-green-600 flex items-center text-sm"><CheckCircle2 className="w-3 h-3 mr-1"/> Included</span>
                      ) : (
                        <span className="text-destructive flex items-center text-sm" title={fi.exclusionReason || ''}>
                          <XCircle className="w-3 h-3 mr-1"/> {fi.exclusionReason?.split(':')[0] || 'Excluded'}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
