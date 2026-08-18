import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { requireDashboardAuth } from "./auth";
import { sql, desc, eq, and, ne } from "drizzle-orm";
import { loadConfig } from "../../config";
import { getActiveAlerts } from "../../observability/alerts";
import {
  productsTable,
  variantsTable,
  marketVariantsTable,
  feedItemsTable,
  imagesTable,
  syncRunsTable,
  feedSnapshotsTable,
  productTranslationsTable,
} from "@workspace/db";

const router: IRouter = Router();

router.get("/dashboard/overview", requireDashboardAuth, async (req, res): Promise<void> => {
  const [
    productCount,
    variantCount,
    eligibleCount,
    byMarket,
    byAvailability,
    recentRuns,
    computedAlerts,
    avgQuality,
    below70,
    imageCounts,
    lastFullSync,
    lastGooglePush,
    lastMetaPush,
    dbTranslationCoverage,
  ] = await Promise.all([
    // Active products only — denominator for translation coverage and the "Total Products" card;
    // inactive/draft products are not feedable so they should not count toward totals.
    db.select({ count: sql<number>`count(*)::int` }).from(productsTable).where(eq(productsTable.status, "active")),
    // Total variants
    db.select({ count: sql<number>`count(*)::int` }).from(variantsTable),
    // Eligible variants (any market)
    db.select({ count: sql<number>`count(distinct ${marketVariantsTable.variantId})::int` })
      .from(marketVariantsTable)
      .where(sql`${marketVariantsTable.isEligible} = true`),
    // By market
    db.select({
      marketCode: marketVariantsTable.marketCode,
      totalVariants: sql<number>`count(*)::int`,
      eligibleVariants: sql<number>`sum(case when ${marketVariantsTable.isEligible} then 1 else 0 end)::int`,
    })
      .from(marketVariantsTable)
      .groupBy(marketVariantsTable.marketCode)
      .orderBy(marketVariantsTable.marketCode),
    // By availability
    db.select({
      availability: marketVariantsTable.availability,
      count: sql<number>`count(*)::int`,
    })
      .from(marketVariantsTable)
      .groupBy(marketVariantsTable.availability),
    // Recent sync runs
    db.select().from(syncRunsTable).orderBy(desc(syncRunsTable.startedAt)).limit(10),
    // All active alert conditions — includes translation coverage, feed staleness,
    // product count drops, and Merchant Center diagnostics. Read-only, no side-effects.
    getActiveAlerts(),
    // Avg quality score
    db.select({ avg: sql<number | null>`avg(${feedItemsTable.dataQualityScore})::numeric` }).from(feedItemsTable),
    // Variants below 70
    db.select({ count: sql<number>`count(distinct ${feedItemsTable.variantId})::int` })
      .from(feedItemsTable)
      .where(sql`${feedItemsTable.dataQualityScore} < 70`),
    // Image counts
    db.select({
      total: sql<number>`count(*)::int`,
      classified: sql<number>`sum(case when ${imagesTable.isClassified} then 1 else 0 end)::int`,
      productsWithImages: sql<number>`count(distinct ${imagesTable.productId})::int`,
    }).from(imagesTable),
    // Last full sync
    db.select({ startedAt: syncRunsTable.startedAt })
      .from(syncRunsTable)
      .where(sql`${syncRunsTable.runType} = 'full' and ${syncRunsTable.status} = 'completed'`)
      .orderBy(desc(syncRunsTable.startedAt))
      .limit(1),
    // Last Google push (feed snapshot)
    db.select({ generatedAt: feedSnapshotsTable.generatedAt })
      .from(feedSnapshotsTable)
      .where(sql`${feedSnapshotsTable.channel} = 'google'`)
      .orderBy(desc(feedSnapshotsTable.generatedAt))
      .limit(1),
    // Last Meta push (feed snapshot)
    db.select({ generatedAt: feedSnapshotsTable.generatedAt })
      .from(feedSnapshotsTable)
      .where(sql`${feedSnapshotsTable.channel} = 'meta'`)
      .orderBy(desc(feedSnapshotsTable.generatedAt))
      .limit(1),
    // Translation coverage: count distinct ACTIVE products with a complete translation
    // (non-empty title required — syncLocale writes "" when no title translation exists).
    // Joining to productsTable with status='active' ensures inactive/deleted products
    // do not inflate the numerator — consistent with the active-product denominator.
    db.select({
      language: productTranslationsTable.language,
      productCount: sql<number>`count(distinct ${productTranslationsTable.productId})::int`,
    })
      .from(productTranslationsTable)
      .innerJoin(
        productsTable,
        and(
          eq(productsTable.id, productTranslationsTable.productId),
          eq(productsTable.status, "active"),
        ),
      )
      .where(ne(productTranslationsTable.title, ""))
      .groupBy(productTranslationsTable.language),
  ]);

  // Build complete per-language coverage including all configured locales, even those
  // with 0 rows (the GROUP BY above omits them).
  // Primary locale (fr) content lives on the products table, not product_translations —
  // use the active product count so it never shows a false zero.
  const config = loadConfig();
  // Primary locale = the Shopify store default (marked primary:true in languages.yaml).
  // Its content lives on the products table, not product_translations, so we use the
  // active product count as its coverage denominator instead of counting translation rows.
  const primaryLang = config.languages.languages.find((l) => l.primary) ?? config.languages.languages[0]!;
  const primaryLocale = primaryLang.code;
  const translationCountMap = new Map(dbTranslationCoverage.map((r) => [r.language, r.productCount]));
  const byLanguage = config.languages.languages.map((lang) => ({
    language: lang.code,
    productCount:
      lang.code === primaryLocale
        ? (productCount[0]?.count ?? 0)
        : (translationCountMap.get(lang.code) ?? 0),
  }));

  res.json({
    totalProducts: productCount[0]?.count ?? 0,
    totalVariants: variantCount[0]?.count ?? 0,
    eligibleVariants: eligibleCount[0]?.count ?? 0,
    byMarket,
    byAvailability,
    recentRuns: recentRuns.map((r) => ({
      id: r.id,
      runType: r.runType,
      status: r.status,
      startedAt: r.startedAt?.toISOString() ?? "",
      finishedAt: r.finishedAt?.toISOString() ?? null,
      durationMs: r.durationMs ?? null,
      recordsRead: r.recordsRead ?? 0,
      recordsChanged: r.recordsChanged ?? 0,
      errors: r.errors ?? 0,
      warnings: r.warnings ?? 0,
    })),
    activeAlerts: computedAlerts.map((a) => ({
      type: a.type,
      severity: a.severity,
      message: a.message,
      count: null,
    })),
    feedHealth: {
      avgDataQualityScore: avgQuality[0]?.avg != null ? Number(avgQuality[0].avg) : null,
      variantsBelow70: below70[0]?.count ?? 0,
      classifiedImages: imageCounts[0]?.classified ?? 0,
      totalImages: imageCounts[0]?.total ?? 0,
      productsWithImages: imageCounts[0]?.productsWithImages ?? 0,
      productsWithoutImages: Math.max(0, (productCount[0]?.count ?? 0) - (imageCounts[0]?.productsWithImages ?? 0)),
      lastFullSync: lastFullSync[0]?.startedAt?.toISOString() ?? null,
      lastGooglePush: lastGooglePush[0]?.generatedAt?.toISOString() ?? null,
      lastMetaPush: lastMetaPush[0]?.generatedAt?.toISOString() ?? null,
    },
    byLanguage,
    primaryLocale,
  });
});

export default router;
