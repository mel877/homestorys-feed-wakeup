/**
 * Inventory computation — spec sections 20, 23.
 *
 * Derives availability status from inventory levels per location.
 * Eupen showroom is identified by location ID from config.
 * Fail-safe: never assume in-stock if API data is missing.
 */

import type { AvailabilityStatus } from "../canonical/types";
import type { InventoryRow } from "../canonical/types";

export interface InventoryResult {
  availability: AvailabilityStatus;
  stockTotal: number | null;
  stockOnline: number | null;
  stockEupen: number | null;
  pickupEupen: boolean;
  /** Inventory label for custom_label_4 */
  inventoryLabel: string;
}

/**
 * Derive availability and stock figures from inventory level rows.
 *
 * @param inventoryLevels - all inventory rows for this variant
 * @param eupenLocationId - Shopify GID of the Eupen showroom location (e.g. "gid://shopify/Location/1234")
 * @param requiresShipping - variant requires_shipping flag
 * @param sellWhenOutOfStock - set true if variant can be backordered
 * @param isDiscontinued - feed.discontinued metafield
 */
export function computeInventory(
  inventoryLevels: InventoryRow[],
  eupenLocationId: string | null,
  requiresShipping: boolean,
  sellWhenOutOfStock: boolean,
  isDiscontinued: boolean,
): InventoryResult {
  // Discontinued always wins
  if (isDiscontinued) {
    return {
      availability: "discontinued",
      stockTotal: null,
      stockOnline: null,
      stockEupen: null,
      pickupEupen: false,
      inventoryLabel: "out_of_stock",
    };
  }

  // Digital / non-shipping products are always in_stock
  if (!requiresShipping) {
    return {
      availability: "in_stock",
      stockTotal: null,
      stockOnline: null,
      stockEupen: null,
      pickupEupen: false,
      inventoryLabel: "online",
    };
  }

  if (inventoryLevels.length === 0) {
    // No inventory data — fail safe (spec section 89: never assume in-stock)
    return {
      availability: "out_of_stock",
      stockTotal: null,
      stockOnline: null,
      stockEupen: null,
      pickupEupen: false,
      inventoryLabel: "out_of_stock",
    };
  }

  // Separate Eupen stock from online stock
  let stockEupen = 0;
  let stockOnline = 0;
  let hasEupenLocation = false;

  for (const level of inventoryLevels) {
    const isEupen = eupenLocationId
      ? level.shopifyLocationId === eupenLocationId
      : (level.locationName?.toLowerCase().includes("eupen") ?? false);

    if (isEupen) {
      stockEupen += level.available;
      hasEupenLocation = true;
    } else {
      stockOnline += level.available;
    }
  }

  const stockTotal = stockOnline + stockEupen;
  const pickupEupen = stockEupen > 0;

  // Determine primary availability status
  let availability: AvailabilityStatus;
  const LOW_STOCK_THRESHOLD = 3;

  if (stockOnline > LOW_STOCK_THRESHOLD) {
    availability = "in_stock";
  } else if (stockOnline > 0) {
    availability = "low_stock";
  } else if (sellWhenOutOfStock) {
    availability = "backorder";
  } else {
    availability = "out_of_stock";
  }

  // Inventory label for custom_label_4
  const inventoryLabel = deriveInventoryLabel(stockOnline, stockEupen, availability, hasEupenLocation);

  return {
    availability,
    stockTotal,
    stockOnline,
    stockEupen,
    pickupEupen,
    inventoryLabel,
  };
}

/**
 * Map stock figures to inventory label for Google Custom Label 4.
 * Values: online | showroom | online_and_showroom | made_to_order | backorder | out_of_stock
 */
export function deriveInventoryLabel(
  stockOnline: number,
  stockEupen: number,
  availability: AvailabilityStatus,
  hasEupenLocation: boolean,
): string {
  if (availability === "discontinued") {
    return "out_of_stock";
  }
  if (availability === "backorder") {
    return "backorder";
  }

  const onlineAvailable = stockOnline > 0;
  const eupenAvailable = stockEupen > 0;

  // Check showroom/online availability before falling through to out_of_stock.
  // A product may be out_of_stock online but still pickable at the Eupen showroom.
  if (onlineAvailable && eupenAvailable) return "online_and_showroom";
  if (onlineAvailable) return "online";
  if (eupenAvailable && hasEupenLocation) return "showroom";

  return "out_of_stock";
}

/**
 * Convert AvailabilityStatus to Google Merchant `availability` field value.
 */
export function toGoogleAvailability(status: AvailabilityStatus): string {
  switch (status) {
    case "in_stock":
    case "low_stock":
      return "in_stock";
    case "backorder":
      return "backorder";
    case "out_of_stock":
    case "discontinued":
      return "out_of_stock";
    default:
      return "out_of_stock";
  }
}
