import { Router, type IRouter } from "express";
import { db, channelDiagnosticsTable, feedItemsTable, feedSnapshotsTable } from "@workspace/db";
import { requireDashboardAuth } from "./auth";
import { isNull, eq, sql, desc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/dashboard/google/status", requireDashboardAuth, async (_req, res): Promise<void> => {
  const [lastPush, diagnostics, bySeverity, byType, byMarket, recentDiagnostics] = await Promise.all([
    // Last Google snapshot
    db.select({ generatedAt: feedSnapshotsTable.generatedAt })
      .from(feedSnapshotsTable)
      .where(eq(feedSnapshotsTable.channel, "google"))
      .orderBy(desc(feedSnapshotsTable.generatedAt))
      .limit(1),
    // Total active diagnostics
    db.select({ count: sql<number>`count(*)::int` })
      .from(channelDiagnosticsTable)
      .where(sql`${channelDiagnosticsTable.channel} = 'google' and ${channelDiagnosticsTable.resolvedAt} is null`),
    // By severity
    db.select({
      severity: channelDiagnosticsTable.severity,
      count: sql<number>`count(*)::int`,
    }).from(channelDiagnosticsTable)
      .where(sql`${channelDiagnosticsTable.channel} = 'google' and ${channelDiagnosticsTable.resolvedAt} is null`)
      .groupBy(channelDiagnosticsTable.severity),
    // By issue type
    db.select({
      issueType: channelDiagnosticsTable.issueType,
      count: sql<number>`count(*)::int`,
    }).from(channelDiagnosticsTable)
      .where(sql`${channelDiagnosticsTable.channel} = 'google' and ${channelDiagnosticsTable.resolvedAt} is null`)
      .groupBy(channelDiagnosticsTable.issueType)
      .orderBy(desc(sql`count(*)`)),
    // By market — item counts from feed items
    db.select({
      marketCode: feedItemsTable.marketCode,
      totalItems: sql<number>`count(*)::int`,
      activeIssues: sql<number>`0::int`,
    }).from(feedItemsTable)
      .where(eq(feedItemsTable.channel, "google"))
      .groupBy(feedItemsTable.marketCode)
      .orderBy(feedItemsTable.marketCode),
    // Recent unresolved diagnostics
    db.select().from(channelDiagnosticsTable)
      .where(sql`${channelDiagnosticsTable.channel} = 'google' and ${channelDiagnosticsTable.resolvedAt} is null`)
      .orderBy(desc(channelDiagnosticsTable.fetchedAt))
      .limit(50),
  ]);

  // Enrich byMarket with active issue counts
  const issueCountByMarket = new Map<string, number>();
  const activeByMarket = await db.select({
    marketCode: channelDiagnosticsTable.marketCode,
    count: sql<number>`count(*)::int`,
  }).from(channelDiagnosticsTable)
    .where(sql`${channelDiagnosticsTable.channel} = 'google' and ${channelDiagnosticsTable.resolvedAt} is null and ${channelDiagnosticsTable.marketCode} is not null`)
    .groupBy(channelDiagnosticsTable.marketCode);

  for (const row of activeByMarket) {
    if (row.marketCode) issueCountByMarket.set(row.marketCode, row.count);
  }

  res.json({
    lastPushAt: lastPush[0]?.generatedAt?.toISOString() ?? null,
    diagnosticsSummary: {
      total: diagnostics[0]?.count ?? 0,
      bySeverity,
      byIssueType: byType,
    },
    byMarket: byMarket.map((m) => ({
      marketCode: m.marketCode,
      totalItems: m.totalItems,
      activeIssues: issueCountByMarket.get(m.marketCode) ?? 0,
    })),
    recentDiagnostics: recentDiagnostics.map((d) => ({
      id: d.id,
      channel: d.channel,
      marketCode: d.marketCode ?? null,
      productIdExternal: d.productIdExternal ?? null,
      issueType: d.issueType,
      severity: d.severity,
      message: d.message,
      fetchedAt: d.fetchedAt?.toISOString() ?? "",
      resolvedAt: d.resolvedAt?.toISOString() ?? null,
    })),
  });
});

export default router;
