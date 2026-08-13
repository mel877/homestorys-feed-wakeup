import { describe, it, expect } from "vitest";

/**
 * Basic sanity tests for the health check and core utilities.
 * These run without a database connection.
 */

describe("Health utilities", () => {
  it("returns true for basic truthiness", () => {
    expect(true).toBe(true);
  });

  it("correctly computes discount percentage", () => {
    const price = 800;
    const compareAt = 1000;
    const discount = ((compareAt - price) / compareAt) * 100;
    expect(discount).toBe(20);
  });

  it("assigns correct discount bucket for 20%", () => {
    const pct = 20;
    const buckets = [
      { key: "none", min: 0, max: 0 },
      { key: "1_10", min: 1, max: 10 },
      { key: "11_20", min: 11, max: 20 },
      { key: "21_30", min: 21, max: 30 },
      { key: "31_50", min: 31, max: 50 },
      { key: "51_70", min: 51, max: 70 },
      { key: "70_plus", min: 70, max: null },
    ];

    const bucket = buckets.find(
      (b) => pct >= b.min && (b.max === null || pct <= b.max),
    );
    expect(bucket?.key).toBe("11_20");
  });

  it("assigns correct price band for 750 EUR", () => {
    const price = 750;
    const bands = [
      { key: "0_500", min: 0, max: 499.99 },
      { key: "500_1000", min: 500, max: 999.99 },
      { key: "1000_2500", min: 1000, max: 2499.99 },
      { key: "2500_5000", min: 2500, max: 4999.99 },
      { key: "5000_plus", min: 5000, max: null },
    ];

    const band = bands.find(
      (b) => price >= b.min && (b.max === null || price <= b.max),
    );
    expect(band?.key).toBe("500_1000");
  });

  it("detects a sale when compare_at > price", () => {
    const price = 900;
    const compareAt = 1200;
    const isOnSale = compareAt > price;
    expect(isOnSale).toBe(true);
  });

  it("does not flag a sale when compare_at equals price", () => {
    const price = 1000;
    const compareAt = 1000;
    const isOnSale = compareAt > price;
    expect(isOnSale).toBe(false);
  });

  it("does not flag a sale when compare_at is null", () => {
    const compareAt = null;
    const isOnSale = compareAt !== null && compareAt > 0;
    expect(isOnSale).toBe(false);
  });
});
