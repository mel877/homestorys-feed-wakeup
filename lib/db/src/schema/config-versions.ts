import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const configVersionsTable = pgTable(
  "config_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    configKey: text("config_key").notNull(), // e.g. markets | shipping | categories
    versionHash: text("version_hash").notNull(),
    content: jsonb("content"),
    deployedAt: timestamp("deployed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("config_versions_config_key_idx").on(t.configKey),
    index("config_versions_deployed_at_idx").on(t.deployedAt),
  ],
);

export const insertConfigVersionSchema = createInsertSchema(
  configVersionsTable,
).omit({ id: true, createdAt: true });
export type InsertConfigVersion = z.infer<typeof insertConfigVersionSchema>;
export type ConfigVersion = typeof configVersionsTable.$inferSelect;
