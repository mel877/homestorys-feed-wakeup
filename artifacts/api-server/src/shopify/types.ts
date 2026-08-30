/**
 * TypeScript types for Shopify Admin GraphQL API responses.
 * All GIDs are full GraphQL IDs like "gid://shopify/Product/123".
 */

// ── Core ──────────────────────────────────────────────────────────────────────

export interface ShopifyMoney {
  amount: string; // decimal string e.g. "1299.00"
  currencyCode: string;
}

export interface ShopifyImage {
  id: string;
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
}

export interface ShopifyMetafield {
  id: string;
  namespace: string;
  key: string;
  value: string;
  type: string; // boolean | single_line_text_field | list.single_line_text_field | ...
}

// ── Products & Variants ───────────────────────────────────────────────────────

export interface ShopifyProductVariant {
  id: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  position: number;
  price: string; // decimal string
  compareAtPrice: string | null;
  weight: number | null;
  weightUnit: string | null;
  requiresShipping: boolean;
  taxable: boolean;
  availableForSale: boolean;
  inventoryItem: { id: string } | null;
  metafields: {
    edges: Array<{ node: ShopifyMetafield }>;
  };
}

export interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  status: "ACTIVE" | "ARCHIVED" | "DRAFT";
  publishedAt: string | null;
  updatedAt: string;
  variants: {
    edges: Array<{ node: ShopifyProductVariant }>;
  };
  images: {
    edges: Array<{ node: ShopifyImage }>;
  };
}

// ── Bulk Operation nodes (flat JSONL format) ──────────────────────────────────

export interface BulkNode {
  id: string;
  __parentId?: string;
  [key: string]: unknown;
}

export interface BulkProductNode extends BulkNode {
  title: string;
  handle: string;
  descriptionHtml: string | null; // primary product description; null if Shopify returns empty
  vendor: string | null;
  productType: string | null;
  tags: string[];
  status: string;
  publishedAt: string | null;
  updatedAt: string;
}

export interface BulkVariantNode extends BulkNode {
  __parentId: string; // Product GID
  title: string;
  sku: string | null;
  barcode: string | null;
  position: number;
  price: string;
  compareAtPrice: string | null;
  taxable: boolean;
  availableForSale: boolean;
  /**
   * Shopify API 2025-01: weight, weightUnit, requiresShipping moved from
   * ProductVariant to inventoryItem.measurement / inventoryItem.requiresShipping.
   */
  inventoryItem: {
    id: string;
    requiresShipping: boolean;
    measurement: { weight: { value: number; unit: string } | null } | null;
  } | null;
}

export interface BulkMetafieldNode extends BulkNode {
  __parentId: string; // Variant GID
  namespace: string;
  key: string;
  value: string;
  type: string;
}

export interface BulkImageNode extends BulkNode {
  __parentId: string; // Product GID
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
}

// ── Bulk Operations ───────────────────────────────────────────────────────────

export type BulkOperationStatus =
  | "CREATED"
  | "RUNNING"
  | "COMPLETED"
  | "CANCELING"
  | "CANCELED"
  | "FAILED"
  | "EXPIRED";

export interface BulkOperation {
  id: string;
  status: BulkOperationStatus;
  errorCode: string | null;
  url: string | null;
  objectCount: string; // number as string
  fileSize: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Admin API BulkOperation.query, used only to safely recover a create gap. */
  query?: string | null;
}

// ── Shopify GraphQL rate limit info ──────────────────────────────────────────

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface CostExtension {
  requestedQueryCost: number;
  actualQueryCost: number;
  throttleStatus: ThrottleStatus;
}

export interface GraphQLResponse<T = unknown> {
  data: T;
  errors?: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
    extensions?: { code?: string };
  }>;
  extensions?: {
    cost?: CostExtension;
  };
}

// ── Markets ───────────────────────────────────────────────────────────────────

export interface ShopifyMarketWebPresence {
  rootUrls: Array<{ locale: string; url: string }>;
  /** Shopify API 2025-01: defaultLocale is now an object { locale } not a bare string. */
  defaultLocale: { locale: string } | null;
  domain: { host: string } | null;
}

export interface ShopifyMarket {
  id: string;
  name: string;
  handle: string;
  enabled: boolean;
  primary: boolean;
  currencySettings: {
    baseCurrency: { currencyCode: string };
  };
  webPresence: ShopifyMarketWebPresence | null;
}

// ── Price Lists ───────────────────────────────────────────────────────────────

export interface ShopifyPriceListPrice {
  price: ShopifyMoney;
  compareAtPrice: ShopifyMoney | null;
  variant: { id: string };
}

export interface ShopifyPriceList {
  id: string;
  name: string;
  currency: string;
  parent: {
    adjustment?: {
      type: string;
      value: number;
    };
  } | null;
  // In API 2025-01+, the market link moved from parent.market to catalog.
  // catalog is a MarketCatalog when the price list is market-scoped.
  catalog: {
    markets: {
      nodes: Array<{ id: string; name: string; handle: string }>;
    };
  } | null;
  prices: {
    nodes: ShopifyPriceListPrice[];
    pageInfo: PageInfo;
  };
}

// ── Inventory ─────────────────────────────────────────────────────────────────

export interface ShopifyInventoryLevel {
  // In API 2025-01+, `available` was replaced by quantities(names:["available"]).
  quantities: Array<{ name: string; quantity: number }>;
  location: {
    id: string;
    name: string;
  };
}

export interface ShopifyInventoryItem {
  id: string;
  sku: string | null;
  inventoryLevels: {
    edges: Array<{ node: ShopifyInventoryLevel }>;
    pageInfo: PageInfo;
  };
}

// ── Locations ─────────────────────────────────────────────────────────────────

export interface ShopifyLocation {
  id: string;
  name: string;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
  address: {
    address1: string | null;
    city: string | null;
    countryCode: string | null;
    zip: string | null;
  };
}

// ── Translations ──────────────────────────────────────────────────────────────

export interface ShopifyTranslatableResource {
  resourceId: string;
  translations: Array<{
    key: string;
    value: string | null;
    locale: string;
    outdated: boolean;
  }>;
}

// ── Pagination ────────────────────────────────────────────────────────────────

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

// ── App/Shop info ─────────────────────────────────────────────────────────────

export interface ShopifyShopInfo {
  name: string;
  myshopifyDomain: string;
  plan: { displayName: string };
  primaryDomain: { url: string };
}

export interface ShopifyAccessScope {
  handle: string;
  description: string;
}

// ── Parsed metafields map ─────────────────────────────────────────────────────

export interface ParsedFeedMetafields {
  outlet: boolean | null;
  exhibitionModel: boolean | null;
  exhibitionStore: string | null;
  bestseller: boolean | null;
  discontinued: boolean | null;
  shippingClass: string | null;
  returnClass: string | null;
  googleCategory: string | null;
  metaCategory: string | null;
  material: string[] | null;
  style: string[] | null;
  room: string[] | null;
  indoorOutdoor: string | null;
  lifestyleImageOverride: string | null;
  primaryImageOverride: string | null;
  mpn: string | null;
  raw: Record<string, string>;
}
