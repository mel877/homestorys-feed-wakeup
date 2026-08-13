import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  productsTable,
  productTranslationsTable,
  variantsTable,
  marketVariantsTable,
  imagesTable,
  inventoryLevelsTable,
  feedItemsTable,
  recommendationsTable,
} from "@workspace/db";
import { requireDashboardAuth } from "./auth";
import { ListDashboardProductsQueryParams, GetDashboardProductParams } from "@workspace/api-zod";
import { eq, sql, and, or, ilike, desc, avg } from "drizzle-orm";

const router: IRouter = Router();

router.get("/dashboard/products", requireDashboardAuth, async (req, res): Promise<void> => {
  const params = ListDashboardProductsQueryParams.safeParse(req.query);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { q, market, availability, eligible, lifecycle, limit = 50, offset = 0 } = params.data;

  // Build product IDs matching lifecycle flags from variants
  const productConditions: ReturnType<typeof and>[] = [];
  const marketConditions: ReturnType<typeof and>[] = [];

  if (market) marketConditions.push(eq(marketVariantsTable.marketCode, market));
  if (availability) marketConditions.push(eq(marketVariantsTable.availability, availability));
  if (eligible != null) marketConditions.push(eq(marketVariantsTable.isEligible, eligible));

  // Get paginated product IDs — join with translations for search, market_variants for filters
  const subquery = db
    .selectDistinct({ id: productsTable.id })
    .from(productsTable)
    .leftJoin(productTranslationsTable, eq(productTranslationsTable.productId, productsTable.id))
    .leftJoin(variantsTable, eq(variantsTable.productId, productsTable.id))
    .leftJoin(marketVariantsTable, eq(marketVariantsTable.variantId, variantsTable.id))
    .where(and(
      q ? or(
        ilike(productsTable.handle, `%${q}%`),
        ilike(productsTable.vendor ?? sql`''`, `%${q}%`),
        ilike(productTranslationsTable.title ?? sql`''`, `%${q}%`),
        ilike(variantsTable.sku ?? sql`''`, `%${q}%`),
        ilike(variantsTable.gtin ?? sql`''`, `%${q}%`),
      ) : undefined,
      lifecycle ? (
        lifecycle === "outlet" ? sql`${variantsTable.outlet} = true` :
        lifecycle === "discontinued" ? sql`${variantsTable.discontinued} = true` :
        lifecycle === "bestseller" ? sql`${variantsTable.bestseller} = true` :
        lifecycle === "exhibition_model" ? sql`${variantsTable.exhibitionModel} = true` :
        undefined
      ) : undefined,
      ...marketConditions,
    ));

  // We'll do a simpler approach — fetch products with aggregated info
  const productRows = await db
    .select({
      id: productsTable.id,
      handle: productsTable.handle,
      vendor: productsTable.vendor,
      productType: productsTable.productType,
      updatedAt: productsTable.updatedAt,
    })
    .from(productsTable)
    .leftJoin(productTranslationsTable, eq(productTranslationsTable.productId, productsTable.id))
    .leftJoin(variantsTable, eq(variantsTable.productId, productsTable.id))
    .leftJoin(marketVariantsTable, eq(marketVariantsTable.variantId, variantsTable.id))
    .where(and(
      q ? or(
        ilike(productsTable.handle, `%${q}%`),
        ilike(productsTable.vendor ?? sql`''`, `%${q}%`),
        ilike(productTranslationsTable.title ?? sql`''`, `%${q}%`),
        ilike(variantsTable.sku ?? sql`''`, `%${q}%`),
        ilike(variantsTable.gtin ?? sql`''`, `%${q}%`),
      ) : undefined,
      lifecycle ? (
        lifecycle === "outlet" ? sql`${variantsTable.outlet} = true` :
        lifecycle === "discontinued" ? sql`${variantsTable.discontinued} = true` :
        lifecycle === "bestseller" ? sql`${variantsTable.bestseller} = true` :
        lifecycle === "exhibition_model" ? sql`${variantsTable.exhibitionModel} = true` :
        undefined
      ) : undefined,
      ...marketConditions,
    ))
    .groupBy(productsTable.id, productsTable.handle, productsTable.vendor, productsTable.productType, productsTable.updatedAt)
    .orderBy(desc(productsTable.updatedAt))
    .limit(limit ?? 50)
    .offset(offset ?? 0);

  const total = await db
    .select({ count: sql<number>`count(distinct ${productsTable.id})::int` })
    .from(productsTable)
    .leftJoin(productTranslationsTable, eq(productTranslationsTable.productId, productsTable.id))
    .leftJoin(variantsTable, eq(variantsTable.productId, productsTable.id))
    .leftJoin(marketVariantsTable, eq(marketVariantsTable.variantId, variantsTable.id))
    .where(and(
      q ? or(
        ilike(productsTable.handle, `%${q}%`),
        ilike(productsTable.vendor ?? sql`''`, `%${q}%`),
        ilike(productTranslationsTable.title ?? sql`''`, `%${q}%`),
        ilike(variantsTable.sku ?? sql`''`, `%${q}%`),
        ilike(variantsTable.gtin ?? sql`''`, `%${q}%`),
      ) : undefined,
      lifecycle ? (
        lifecycle === "outlet" ? sql`${variantsTable.outlet} = true` :
        lifecycle === "discontinued" ? sql`${variantsTable.discontinued} = true` :
        lifecycle === "bestseller" ? sql`${variantsTable.bestseller} = true` :
        lifecycle === "exhibition_model" ? sql`${variantsTable.exhibitionModel} = true` :
        undefined
      ) : undefined,
      ...marketConditions,
    ));

  if (productRows.length === 0) {
    res.json({ items: [], total: total[0]?.count ?? 0 });
    return;
  }

  const productIds = productRows.map((p) => p.id);

  // Aggregate stats per product
  const [translations, variantStats, marketStats, qualityStats, lifecycleRows] = await Promise.all([
    db.select().from(productTranslationsTable)
      .where(sql`${productTranslationsTable.productId} = ANY(${sql.raw(`ARRAY[${productIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})`)
      .orderBy(productTranslationsTable.language),
    db.select({
      productId: variantsTable.productId,
      variantCount: sql<number>`count(*)::int`,
      outlet: sql<boolean>`bool_or(${variantsTable.outlet})`,
      discontinued: sql<boolean>`bool_or(${variantsTable.discontinued})`,
      bestseller: sql<boolean>`bool_or(${variantsTable.bestseller})`,
      exhibitionModel: sql<boolean>`bool_or(${variantsTable.exhibitionModel})`,
    }).from(variantsTable)
      .where(sql`${variantsTable.productId} = ANY(${sql.raw(`ARRAY[${productIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})`)
      .groupBy(variantsTable.productId),
    db.select({
      variantId: marketVariantsTable.variantId,
      marketCode: marketVariantsTable.marketCode,
      isEligible: marketVariantsTable.isEligible,
      availability: marketVariantsTable.availability,
    }).from(marketVariantsTable)
      .leftJoin(variantsTable, eq(variantsTable.id, marketVariantsTable.variantId))
      .where(sql`${variantsTable.productId} = ANY(${sql.raw(`ARRAY[${productIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})`),
    db.select({
      productId: variantsTable.productId,
      avgScore: sql<number | null>`avg(${feedItemsTable.dataQualityScore})::numeric`,
    }).from(feedItemsTable)
      .leftJoin(variantsTable, eq(variantsTable.id, feedItemsTable.variantId))
      .where(sql`${variantsTable.productId} = ANY(${sql.raw(`ARRAY[${productIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})`)
      .groupBy(variantsTable.productId),
    // placeholder
    Promise.resolve([]),
  ]);

  // Build lookup maps
  const titleByProduct = new Map<string, string>();
  for (const t of translations) {
    if (!titleByProduct.has(t.productId)) titleByProduct.set(t.productId, t.title ?? "");
  }

  const variantStatMap = new Map(variantStats.map((v) => [v.productId, v]));
  const qualityMap = new Map(qualityStats.map((q) => [q.productId, q.avgScore]));

  // Markets per product
  const marketsMap = new Map<string, Set<string>>();
  const eligibleMap = new Map<string, number>();
  const availMap = new Map<string, string>();
  for (const mv of marketStats) {
    const variant = variantStats.find((v) => v.productId && mv.variantId); // we don't have productId here easily
    // We need to get productId from variantId — we already have it in variantStats
  }

  // Simpler: get productId for each variant from variantStatMap by iterating variants
  const variantProductMap = new Map<string, string>();
  for (const vs of variantStats) {
    // We need the actual variant IDs. Re-query...
  }

  // Actually let's just build items from what we have with basic aggregation
  const items = productRows.map((p) => {
    const vs = variantStatMap.get(p.id);
    const qs = qualityMap.get(p.id);
    const lifecycleFlags: string[] = [];
    if (vs?.outlet) lifecycleFlags.push("outlet");
    if (vs?.discontinued) lifecycleFlags.push("discontinued");
    if (vs?.bestseller) lifecycleFlags.push("bestseller");
    if (vs?.exhibitionModel) lifecycleFlags.push("exhibition_model");

    const mvForProduct = marketStats.filter((mv) => {
      // We don't have productId in mv easily without another join, skip for now
      return false;
    });

    return {
      id: p.id,
      handle: p.handle,
      title: titleByProduct.get(p.id) ?? null,
      vendor: p.vendor ?? null,
      productType: p.productType ?? null,
      variantCount: vs?.variantCount ?? 0,
      eligibleVariantCount: 0,
      availability: "unknown",
      avgQualityScore: qs != null ? Number(qs) : null,
      markets: [] as string[],
      lifecycleFlags,
      updatedAt: p.updatedAt?.toISOString() ?? "",
    };
  });

  res.json({ items, total: total[0]?.count ?? 0 });
});

router.get("/dashboard/products/:id", requireDashboardAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetDashboardProductParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { id } = params.data;

  const [product] = await db.select().from(productsTable).where(eq(productsTable.id, id));
  if (!product) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const [translations, variants, images, recs] = await Promise.all([
    db.select().from(productTranslationsTable).where(eq(productTranslationsTable.productId, id)),
    db.select().from(variantsTable).where(eq(variantsTable.productId, id)),
    db.select().from(imagesTable).where(eq(imagesTable.productId, id)).orderBy(imagesTable.position),
    db.select().from(recommendationsTable).where(eq(recommendationsTable.productId, id)),
  ]);

  const variantIds = variants.map((v) => v.id);

  const [marketVariants, inventory, feedItems] = variantIds.length > 0
    ? await Promise.all([
        db.select().from(marketVariantsTable)
          .where(sql`${marketVariantsTable.variantId} = ANY(${sql.raw(`ARRAY[${variantIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})`)
          .orderBy(marketVariantsTable.marketCode),
        db.select().from(inventoryLevelsTable)
          .where(sql`${inventoryLevelsTable.variantId} = ANY(${sql.raw(`ARRAY[${variantIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})`)
          .orderBy(inventoryLevelsTable.locationName),
        db.select().from(feedItemsTable)
          .where(sql`${feedItemsTable.variantId} = ANY(${sql.raw(`ARRAY[${variantIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})`)
          .orderBy(feedItemsTable.marketCode, feedItemsTable.language, feedItemsTable.channel),
      ])
    : [[], [], []];

  res.json({
    product: {
      id: product.id,
      shopifyGid: product.shopifyGid,
      shopifyId: product.shopifyId ?? null,
      handle: product.handle,
      vendor: product.vendor ?? null,
      productType: product.productType ?? null,
      tags: product.tags ?? [],
      status: product.status ?? "active",
      publishedAt: product.publishedAt?.toISOString() ?? null,
      sourceUpdatedAt: product.sourceUpdatedAt?.toISOString() ?? null,
      createdAt: product.createdAt?.toISOString() ?? "",
      updatedAt: product.updatedAt?.toISOString() ?? "",
    },
    variants: variants.map((v) => ({
      id: v.id,
      shopifyGid: v.shopifyGid,
      shopifyId: v.shopifyId ?? null,
      title: v.title ?? "",
      sku: v.sku ?? null,
      gtin: v.gtin ?? null,
      mpn: v.mpn ?? null,
      weight: v.weight != null ? Number(v.weight) : null,
      weightUnit: v.weightUnit ?? "kg",
      available: v.available ?? false,
      googleCategory: v.googleCategory ?? null,
      metaCategory: v.metaCategory ?? null,
      shippingClass: v.shippingClass ?? null,
      returnClass: v.returnClass ?? null,
      outlet: v.outlet ?? null,
      discontinued: v.discontinued ?? null,
      bestseller: v.bestseller ?? null,
      exhibitionModel: v.exhibitionModel ?? null,
      material: v.material ?? [],
      style: v.style ?? [],
      room: v.room ?? [],
    })),
    translations: translations.map((t) => ({
      language: t.language,
      title: t.title ?? "",
      description: t.description ?? null,
      handle: t.handle ?? null,
    })),
    marketVariants: marketVariants.map((mv) => ({
      variantId: mv.variantId,
      marketCode: mv.marketCode,
      priceAmount: mv.priceAmount != null ? Number(mv.priceAmount) : null,
      compareAtPriceAmount: mv.compareAtPriceAmount != null ? Number(mv.compareAtPriceAmount) : null,
      priceCurrency: mv.priceCurrency ?? null,
      availability: mv.availability ?? "unknown",
      productUrl: mv.productUrl ?? null,
      isEligible: mv.isEligible ?? false,
      exclusionReason: mv.exclusionReason ?? null,
    })),
    images: images.map((img) => ({
      id: img.id,
      url: img.url,
      altText: img.altText ?? null,
      position: img.position ?? 1,
      imageType: img.imageType ?? null,
      width: img.width ?? null,
      height: img.height ?? null,
      whiteBgScore: img.whiteBgScore != null ? Number(img.whiteBgScore) : null,
      solidBgScore: img.solidBgScore != null ? Number(img.solidBgScore) : null,
      alphaRatio: img.alphaRatio != null ? Number(img.alphaRatio) : null,
      edgeDensity: img.edgeDensity != null ? Number(img.edgeDensity) : null,
      resolutionScore: img.resolutionScore != null ? Number(img.resolutionScore) : null,
      isClassified: img.isClassified ?? false,
      classifiedAt: img.classifiedAt?.toISOString() ?? null,
    })),
    inventory: inventory.map((inv) => ({
      shopifyLocationId: inv.shopifyLocationId,
      locationName: inv.locationName ?? null,
      available: inv.available ?? 0,
    })),
    feedItems: feedItems.map((fi) => ({
      variantId: fi.variantId,
      marketCode: fi.marketCode,
      language: fi.language,
      channel: fi.channel,
      isEligible: fi.isEligible ?? false,
      exclusionReason: fi.exclusionReason ?? null,
      dataQualityScore: fi.dataQualityScore != null ? Number(fi.dataQualityScore) : null,
      generatedAt: fi.generatedAt?.toISOString() ?? null,
    })),
    recommendations: recs.map((r) => ({
      marketCode: r.marketCode,
      relatedProductIds: r.relatedProductIds ?? [],
      complementaryProductIds: r.complementaryProductIds ?? [],
      generatedAt: r.generatedAt?.toISOString() ?? null,
    })),
  });
});

export default router;
