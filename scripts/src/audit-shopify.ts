/**
 * Shopify Audit Script
 *
 * Discovers and documents the Homestorys Shopify store structure:
 * - Shop info + API version
 * - All locations (identifies Eupen showroom automatically)
 * - All markets (currency, locales, handles)
 * - Metafield definitions in the `feed.*` namespace
 * - Active API scopes
 *
 * Writes a comprehensive audit report to docs/shopify-audit.md.
 *
 * Usage: pnpm --filter @workspace/scripts run audit:shopify
 *
 * Required env:
 *   SHOPIFY_SHOP_DOMAIN
 *   SHOPIFY_ADMIN_ACCESS_TOKEN
 *   SHOPIFY_API_VERSION  (optional, defaults to 2025-01)
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync } from "fs";

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Env helpers ────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`  ✗  Required env var ${name} is not set`);
    process.exit(1);
  }
  return val;
}

const SHOP_DOMAIN = requireEnv("SHOPIFY_SHOP_DOMAIN");
const ACCESS_TOKEN = requireEnv("SHOPIFY_ADMIN_ACCESS_TOKEN");
const API_VERSION = process.env["SHOPIFY_API_VERSION"] ?? "2025-01";
const GRAPHQL_URL = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

// ── GraphQL client ─────────────────────────────────────────────────────────────

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL HTTP ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as { data: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  return body.data;
}

async function rest<T>(path: string): Promise<T> {
  const response = await fetch(
    `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}${path}`,
    {
      headers: {
        "X-Shopify-Access-Token": ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
    },
  );
  if (!response.ok) throw new Error(`REST ${path} → ${response.status}`);
  return response.json() as Promise<T>;
}

// ── Queries ───────────────────────────────────────────────────────────────────

const SHOP_QUERY = `{
  shop {
    name
    myshopifyDomain
    primaryDomain { url }
    plan { displayName }
    currencyCode
    billingAddress { countryCode }
  }
}`;

const LOCATIONS_QUERY = `{
  locations(first: 50) {
    nodes {
      id
      name
      isActive
      fulfillsOnlineOrders
      address {
        address1
        city
        countryCode
        zip
      }
    }
  }
}`;

const MARKETS_QUERY = `{
  markets(first: 50) {
    nodes {
      id
      name
      handle
      enabled
      primary
      currencySettings { baseCurrency { currencyCode } }
      webPresence {
        defaultLocale
        domain { host }
        rootUrls { locale url }
      }
    }
  }
}`;

const METAFIELD_DEFS_QUERY = `
  query MetafieldDefinitions($namespace: String!, $cursor: String) {
    metafieldDefinitions(
      ownerType: PRODUCTVARIANT
      namespace: $namespace
      first: 50
      after: $cursor
    ) {
      nodes {
        id
        name
        key
        namespace
        type { name }
        description
        validations { name value }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PRODUCT_METAFIELD_DEFS_QUERY = `
  query ProductMetafieldDefinitions($namespace: String!, $cursor: String) {
    metafieldDefinitions(
      ownerType: PRODUCT
      namespace: $namespace
      first: 50
      after: $cursor
    ) {
      nodes {
        id
        name
        key
        namespace
        type { name }
        description
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PUBLICATIONS_QUERY = `{
  publications(first: 30) {
    nodes {
      id
      name
      catalog { id }
    }
  }
}`;

// ── Types ─────────────────────────────────────────────────────────────────────

interface ShopInfo {
  name: string;
  myshopifyDomain: string;
  primaryDomain: { url: string };
  plan: { displayName: string };
  currencyCode: string;
  billingAddress: { countryCode: string };
}

interface Location {
  id: string;
  name: string;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
  address: { address1: string | null; city: string | null; countryCode: string | null; zip: string | null };
}

interface Market {
  id: string;
  name: string;
  handle: string;
  enabled: boolean;
  primary: boolean;
  currencySettings: { baseCurrency: { currencyCode: string } };
  webPresence: {
    defaultLocale: string;
    domain: { host: string } | null;
    rootUrls: Array<{ locale: string; url: string }>;
  } | null;
}

interface MetafieldDef {
  id: string;
  name: string;
  key: string;
  namespace: string;
  type: { name: string };
  description: string | null;
  validations?: Array<{ name: string; value: string }>;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════");
  console.log("  Homestorys Shopify Audit");
  console.log("══════════════════════════════════════════════════\n");
  console.log(`  Shop: ${SHOP_DOMAIN}`);
  console.log(`  API version: ${API_VERSION}\n`);

  const lines: string[] = [
    `# Shopify Audit Report`,
    ``,
    `**Generated:** ${new Date().toISOString()}  `,
    `**Shop:** ${SHOP_DOMAIN}  `,
    `**API version:** ${API_VERSION}  `,
    ``,
  ];

  // ── Shop info ────────────────────────────────────────────────────────────────
  console.log("── Shop info ────────────────────────────────────");
  const shopData = await gql<{ shop: ShopInfo }>(SHOP_QUERY);
  const shop = shopData.shop;

  console.log(`  Name:     ${shop.name}`);
  console.log(`  Domain:   ${shop.myshopifyDomain}`);
  console.log(`  URL:      ${shop.primaryDomain.url}`);
  console.log(`  Plan:     ${shop.plan.displayName}`);
  console.log(`  Currency: ${shop.currencyCode}`);
  console.log(`  Country:  ${shop.billingAddress.countryCode}`);
  console.log();

  lines.push(
    `## Shop Information`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| Name | ${shop.name} |`,
    `| Domain | ${shop.myshopifyDomain} |`,
    `| Primary URL | ${shop.primaryDomain.url} |`,
    `| Plan | ${shop.plan.displayName} |`,
    `| Store Currency | ${shop.currencyCode} |`,
    `| Country | ${shop.billingAddress.countryCode} |`,
    ``,
  );

  // ── Access scopes ────────────────────────────────────────────────────────────
  console.log("── Access scopes ────────────────────────────────");
  try {
    const scopeData = await rest<{ access_scopes: Array<{ handle: string; description: string }> }>(
      "/access_scopes.json",
    );
    const scopes = scopeData.access_scopes;

    const REQUIRED = ["read_products", "read_inventory", "read_markets", "read_translations", "read_locales"];
    for (const scope of scopes) {
      const isRequired = REQUIRED.includes(scope.handle);
      console.log(`  ${isRequired ? "✓" : "-"}  ${scope.handle}`);
    }
    console.log();

    const grantedSet = new Set(scopes.map((s) => s.handle));
    const missing = REQUIRED.filter((s) => !grantedSet.has(s));
    if (missing.length > 0) {
      console.warn(`  ⚠  Missing required scopes: ${missing.join(", ")}`);
    }

    lines.push(
      `## API Access Scopes`,
      ``,
      `| Scope | Required |`,
      `|-------|----------|`,
      ...scopes.map((s) => `| \`${s.handle}\` | ${REQUIRED.includes(s.handle) ? "✅ Yes" : "—"} |`),
      ``,
    );

    if (missing.length > 0) {
      lines.push(`**⚠ Missing required scopes:** ${missing.map((s) => `\`${s}\``).join(", ")}`, ``);
    }
  } catch (err) {
    console.warn(`  ⚠  Could not fetch access scopes: ${String(err)}`);
    lines.push(`## Access Scopes`, ``, `Could not fetch access scopes.`, ``);
  }

  // ── Locations ────────────────────────────────────────────────────────────────
  console.log("── Locations ────────────────────────────────────");
  const locData = await gql<{ locations: { nodes: Location[] } }>(LOCATIONS_QUERY);
  const locations = locData.locations.nodes;

  let eupenLocation: Location | null = null;

  for (const loc of locations) {
    const isEupen = loc.name.toLowerCase().includes("eupen") || loc.address.city?.toLowerCase() === "eupen";
    if (isEupen) eupenLocation = loc;

    const status = loc.isActive ? "active" : "inactive";
    console.log(`  ${isEupen ? "★" : " "} ${loc.name} (${status})`);
    if (loc.address.city) {
      console.log(`      ${loc.address.address1 ?? ""}, ${loc.address.zip ?? ""} ${loc.address.city}, ${loc.address.countryCode ?? ""}`);
    }
    console.log(`      ID: ${loc.id}`);
    console.log(`      Fulfills online: ${loc.fulfillsOnlineOrders}`);
  }

  if (eupenLocation) {
    const numericId = eupenLocation.id.split("/").pop();
    console.log(`\n  ✓  Eupen showroom identified: ${eupenLocation.name}`);
    console.log(`     Location ID: ${eupenLocation.id}`);
    console.log(`     Numeric ID: ${numericId}`);
    console.log(`\n  → Add to config/stores.yaml: shopify_location_id: "${eupenLocation.id}"`);
    console.log(`  → Add to .env: SHOPIFY_EUPEN_LOCATION_ID=${numericId}`);
  } else {
    console.warn("  ⚠  No location named 'Eupen' found — check location names in Shopify");
  }
  console.log();

  lines.push(
    `## Locations`,
    ``,
    `| Name | Status | City | Online Fulfillment | Shopify GID |`,
    `|------|--------|------|--------------------|-------------|`,
    ...locations.map((l) => {
      const isEupen = l.id === eupenLocation?.id;
      return `| ${isEupen ? "**" : ""}${l.name}${isEupen ? "** ⭐" : ""} | ${l.isActive ? "Active" : "Inactive"} | ${l.address.city ?? "—"} | ${l.fulfillsOnlineOrders ? "✅" : "❌"} | \`${l.id}\` |`;
    }),
    ``,
  );

  if (eupenLocation) {
    const numericId = eupenLocation.id.split("/").pop();
    lines.push(
      `### Eupen Showroom`,
      ``,
      `**Identified:** ${eupenLocation.name}  `,
      `**GID:** \`${eupenLocation.id}\`  `,
      `**Numeric ID:** \`${numericId}\`  `,
      ``,
      `**Action required:**`,
      `\`\`\`yaml`,
      `# config/stores.yaml`,
      `stores:`,
      `  eupen:`,
      `    shopify_location_id: "${eupenLocation.id}"`,
      `\`\`\``,
      `\`\`\`bash`,
      `# .env`,
      `SHOPIFY_EUPEN_LOCATION_ID=${numericId}`,
      `\`\`\``,
      ``,
    );
  }

  // ── Markets ──────────────────────────────────────────────────────────────────
  console.log("── Markets ──────────────────────────────────────");
  const marketData = await gql<{ markets: { nodes: Market[] } }>(MARKETS_QUERY);
  const markets = marketData.markets.nodes;

  for (const market of markets) {
    const locale = market.webPresence?.defaultLocale ?? "—";
    const currency = market.currencySettings.baseCurrency.currencyCode;
    const domain = market.webPresence?.domain?.host ?? "(subpath)";
    console.log(`  ${market.enabled ? "✓" : "○"} ${market.name} (${market.handle})`);
    console.log(`      ID: ${market.id}`);
    console.log(`      Locale: ${locale}  Currency: ${currency}  Domain: ${domain}`);
    if (market.webPresence?.rootUrls.length) {
      for (const ru of market.webPresence.rootUrls) {
        console.log(`      ${ru.locale}: ${ru.url}`);
      }
    }
  }
  console.log();

  lines.push(
    `## Markets`,
    ``,
    `| Name | Handle | Enabled | Currency | Default Locale | Domain | Shopify GID |`,
    `|------|--------|---------|----------|----------------|--------|-------------|`,
    ...markets.map((m) => {
      const locale = m.webPresence?.defaultLocale ?? "—";
      const currency = m.currencySettings.baseCurrency.currencyCode;
      const domain = m.webPresence?.domain?.host ?? "(subpath)";
      return `| ${m.name} | \`${m.handle}\` | ${m.enabled ? "✅" : "❌"} | ${currency} | ${locale} | ${domain} | \`${m.id}\` |`;
    }),
    ``,
    `### Market → Config Code Mapping (suggested)`,
    ``,
    `| Shopify Market | Handle | Suggested config/markets.yaml key |`,
    `|----------------|--------|-----------------------------------|`,
    ...markets.map((m) => {
      const locale = m.webPresence?.defaultLocale ?? "";
      const handle = m.handle.toLowerCase();
      let suggested = "?";
      if (handle.includes("belgium") && locale === "fr") suggested = "BE_FR";
      else if (handle.includes("belgium") && locale === "de") suggested = "BE_DE";
      else if (handle.includes("france") || handle === "fr") suggested = "FR";
      else if (handle.includes("germany") || handle === "de") suggested = "DE";
      else if (handle.includes("austria") || handle === "at") suggested = "AT";
      return `| ${m.name} | \`${m.handle}\` | \`${suggested}\` |`;
    }),
    ``,
  );

  // ── Metafield definitions ────────────────────────────────────────────────────
  console.log("── Metafield definitions (feed.* namespace) ──────");

  const metafieldsData = await gql<{
    metafieldDefinitions: { nodes: MetafieldDef[]; pageInfo: { hasNextPage: boolean } };
  }>(METAFIELD_DEFS_QUERY, { namespace: "feed" });

  const variantMetafields = metafieldsData.metafieldDefinitions.nodes;

  const productMetafieldsData = await gql<{
    metafieldDefinitions: { nodes: MetafieldDef[]; pageInfo: { hasNextPage: boolean } };
  }>(PRODUCT_METAFIELD_DEFS_QUERY, { namespace: "feed" });

  const productMetafields = productMetafieldsData.metafieldDefinitions.nodes;

  console.log("\n  Variant metafields (feed.*):");
  if (variantMetafields.length === 0) {
    console.log("    (none defined — metafields may be set without definitions)");
  }
  for (const m of variantMetafields) {
    console.log(`    feed.${m.key}  [${m.type.name}]  ${m.name}`);
  }

  console.log("\n  Product metafields (feed.*):");
  if (productMetafields.length === 0) {
    console.log("    (none defined)");
  }
  for (const m of productMetafields) {
    console.log(`    feed.${m.key}  [${m.type.name}]  ${m.name}`);
  }
  console.log();

  lines.push(
    `## Metafield Definitions (feed.* namespace)`,
    ``,
    `### Variant Metafields`,
    ``,
    variantMetafields.length > 0
      ? [
          `| Key | Type | Name | Description |`,
          `|-----|------|------|-------------|`,
          ...variantMetafields.map(
            (m) => `| \`feed.${m.key}\` | \`${m.type.name}\` | ${m.name} | ${m.description ?? "—"} |`,
          ),
        ].join("\n")
      : "_No metafield definitions found. Metafields may exist on variants without formal definitions._",
    ``,
    `### Product Metafields`,
    ``,
    productMetafields.length > 0
      ? [
          `| Key | Type | Name | Description |`,
          `|-----|------|------|-------------|`,
          ...productMetafields.map(
            (m) => `| \`feed.${m.key}\` | \`${m.type.name}\` | ${m.name} | ${m.description ?? "—"} |`,
          ),
        ].join("\n")
      : "_No product metafield definitions found._",
    ``,
    `### Expected feed.* Metafields (from spec)`,
    ``,
    `| Key | Type | DB Column |`,
    `|-----|------|-----------|`,
    `| \`feed.outlet\` | boolean | \`metafield_outlet\` |`,
    `| \`feed.exhibition_model\` | boolean | \`metafield_exhibition_model\` |`,
    `| \`feed.exhibition_store\` | single_line_text_field | \`metafield_exhibition_store\` |`,
    `| \`feed.bestseller\` | boolean | \`metafield_bestseller\` |`,
    `| \`feed.discontinued\` | boolean | \`metafield_discontinued\` |`,
    `| \`feed.shipping_class\` | single_line_text_field | \`metafield_shipping_class\` |`,
    `| \`feed.return_class\` | single_line_text_field | \`metafield_return_class\` |`,
    `| \`feed.google_category\` | single_line_text_field | \`metafield_google_category\` |`,
    `| \`feed.meta_category\` | single_line_text_field | \`metafield_meta_category\` |`,
    `| \`feed.material\` | list.single_line_text_field | \`metafield_material\` |`,
    `| \`feed.style\` | list.single_line_text_field | \`metafield_style\` |`,
    `| \`feed.room\` | list.single_line_text_field | \`metafield_room\` |`,
    `| \`feed.indoor_outdoor\` | single_line_text_field | \`metafield_indoor_outdoor\` |`,
    `| \`feed.lifestyle_image_override\` | url | \`metafield_lifestyle_image_override\` |`,
    `| \`feed.primary_image_override\` | url | \`metafield_primary_image_override\` |`,
    `| \`feed.mpn\` | single_line_text_field | \`mpn\` (on variants) |`,
    ``,
  );

  // ── Summary ──────────────────────────────────────────────────────────────────
  lines.push(
    `## Next Steps`,
    ``,
    `1. Update \`config/stores.yaml\` with the Eupen location GID above`,
    `2. Set \`SHOPIFY_EUPEN_LOCATION_ID\` in environment secrets`,
    `3. Verify market → config mapping in the table above`,
    `4. Add any missing \`feed.*\` metafield definitions in Shopify admin`,
    `5. Run \`pnpm --filter @workspace/api-server run dev\` and trigger a full sync:`,
    `   \`curl -X POST http://localhost:PORT/api/internal/sync/full -H "Authorization: Bearer INTERNAL_API_SECRET"\``,
    ``,
    `---`,
    `*Generated by \`pnpm --filter @workspace/scripts run audit:shopify\`*`,
  );

  // ── Write report ─────────────────────────────────────────────────────────────
  const reportDir = resolve(__dir, "../../docs");
  const reportPath = resolve(reportDir, "shopify-audit.md");

  mkdirSync(reportDir, { recursive: true });
  writeFileSync(reportPath, lines.join("\n"), "utf8");

  console.log("══════════════════════════════════════════════════");
  console.log(`  Report written to: docs/shopify-audit.md`);
  console.log("══════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
