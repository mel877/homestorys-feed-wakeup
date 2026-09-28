/**
 * Google Custom Labels — spec sections 31, 85.
 *
 * custom_label_0: lifecycle    outlet > sale > new > evergreen
 * custom_label_1: performance  bestseller | high | medium | low | unknown
 * custom_label_2: price_band   0_500 | 500_1000 | 1000_2500 | 2500_5000 | 5000_plus
 * custom_label_3: discount     none | 1_10 | 11_20 | 21_30 | 31_50 | 51_70 | 70_plus
 * custom_label_4: inventory    online | showroom | online_and_showroom | made_to_order | backorder | out_of_stock
 */

import type { DiscountBucket, BestsellerClass } from "./types";
import type { LabelsConfig } from "../config/schemas";

export interface CustomLabels {
  custom_label_0: string;
  custom_label_1: string;
  custom_label_2: string;
  custom_label_3: string;
  custom_label_4: string;
}

export interface LabelsInput {
  isOutlet: boolean;
  isOnSale: boolean;
  isNew: boolean;
  isBestseller: boolean;
  bestsellerClass: BestsellerClass | null;
  priceAmount: number;
  discountBucket: DiscountBucket;
  inventoryLabel: string;
  config: LabelsConfig;
}

/**
 * Compute all 5 Google Custom Labels from product signals.
 */
export function computeCustomLabels(input: LabelsInput): CustomLabels {
  return {
    custom_label_0: computeLifecycleLabel(input),
    custom_label_1: computePerformanceLabel(input),
    custom_label_2: computePriceBandLabel(input.priceAmount, input.config),
    custom_label_3: input.discountBucket,
    custom_label_4: input.inventoryLabel,
  };
}

/**
 * Lifecycle label — priority: outlet > sale > new > evergreen
 */
function computeLifecycleLabel(input: LabelsInput): string {
  if (input.isOutlet) return "outlet";
  if (input.isOnSale) return "sale";
  if (input.isNew) return "new";
  return "evergreen";
}

/**
 * Performance / bestseller label.
 */
function computePerformanceLabel(input: LabelsInput): string {
  if (input.isBestseller) return "bestseller";
  if (input.bestsellerClass) return input.bestsellerClass;
  return "unknown";
}

/**
 * Price band label from config bands (EUR-based, market-agnostic).
 */
function computePriceBandLabel(priceAmount: number, config: LabelsConfig): string {
  for (const band of config.price_bands) {
    if (priceAmount >= band.min && (band.max === null || priceAmount <= band.max)) {
      return band.key;
    }
  }
  return "5000_plus";
}
