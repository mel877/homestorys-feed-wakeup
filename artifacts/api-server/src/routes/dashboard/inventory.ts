import { Router, type IRouter } from "express";
import { db, inventoryLevelsTable, marketVariantsTable } from "@workspace/db";
import { requireDashboardAuth } from "./auth";
import { sql, desc } from "drizzle-orm";

const router: IRouter = Router();

const EUPEN_KEYWORDS = ["eupen", "showroom"];

router.get("/dashboard/inventory", requireDashboardAuth, async (_req, res): Promise<void> => {
  const [byLocation, byAvailability] = await Promise.all([
    db.select({
      shopifyLocationId: inventoryLevelsTable.shopifyLocationId,
      locationName: sql<string>`coalesce(${inventoryLevelsTable.locationName}, ${inventoryLevelsTable.shopifyLocationId})`,
      variantCount: sql<number>`count(distinct ${inventoryLevelsTable.variantId})::int`,
      totalUnits: sql<number>`sum(${inventoryLevelsTable.available})::int`,
    })
      .from(inventoryLevelsTable)
      .groupBy(inventoryLevelsTable.shopifyLocationId, inventoryLevelsTable.locationName)
      .orderBy(desc(sql`sum(${inventoryLevelsTable.available})`)),
    db.select({
      availability: marketVariantsTable.availability,
      count: sql<number>`count(*)::int`,
    })
      .from(marketVariantsTable)
      .groupBy(marketVariantsTable.availability),
  ]);

  const [totalVariants, inStockVariants] = await Promise.all([
    db.select({ count: sql<number>`count(distinct ${inventoryLevelsTable.variantId})::int` })
      .from(inventoryLevelsTable),
    db.select({ count: sql<number>`count(distinct ${inventoryLevelsTable.variantId})::int` })
      .from(inventoryLevelsTable)
      .where(sql`${inventoryLevelsTable.available} > 0`),
  ]);

  // Find Eupen showroom location
  const showroomLocation = byLocation.find((loc) =>
    EUPEN_KEYWORDS.some((kw) => (loc.locationName ?? "").toLowerCase().includes(kw))
  );

  res.json({
    byLocation: byLocation.map((loc) => ({
      shopifyLocationId: loc.shopifyLocationId,
      locationName: loc.locationName,
      variantCount: loc.variantCount,
      totalUnits: loc.totalUnits ?? 0,
    })),
    byAvailability,
    showroomStock: showroomLocation
      ? {
          locationName: showroomLocation.locationName,
          variantCount: showroomLocation.variantCount,
          totalUnits: showroomLocation.totalUnits ?? 0,
        }
      : { locationName: "Eupen (not found)", variantCount: 0, totalUnits: 0 },
    totalVariants: totalVariants[0]?.count ?? 0,
    inStockVariants: inStockVariants[0]?.count ?? 0,
    outOfStockVariants: (totalVariants[0]?.count ?? 0) - (inStockVariants[0]?.count ?? 0),
  });
});

export default router;
