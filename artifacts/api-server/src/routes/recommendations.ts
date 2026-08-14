import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { recommendationsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

const router: IRouter = Router();

/**
 * GET /api/recommendations/:productId
 *
 * Returns related and complementary product IDs for a product in a given market.
 *
 * Query params:
 *   market - market code (default: BE_FR)
 *   limit  - max results per category (default: 8)
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/:productId", async (req, res) => {
  const { productId } = req.params as { productId: string };
  if (!UUID_RE.test(productId)) {
    res.status(400).json({ error: "Invalid product ID" });
    return;
  }
  const market = (req.query["market"] as string) ?? "BE_FR";
  const limit = Math.min(
    parseInt((req.query["limit"] as string) ?? "8", 10),
    20,
  );

  try {
    const recs = await db
      .select()
      .from(recommendationsTable)
      .where(
        and(
          eq(recommendationsTable.productId, productId),
          eq(recommendationsTable.marketCode, market),
        ),
      )
      .limit(1);

    if (recs.length === 0) {
      res.json({
        productId,
        market,
        related: [],
        complementary: [],
      });
      return;
    }

    const rec = recs[0]!;
    res.json({
      productId,
      market,
      related: rec.relatedProductIds.slice(0, limit),
      complementary: rec.complementaryProductIds.slice(0, limit),
    });
  } catch (err) {
    req.log.error({ err, productId }, "Failed to fetch recommendations");
    res.status(500).json({ error: "Failed to fetch recommendations" });
  }
});

export default router;
