/**
 * Tests for src/validation/feed-validator.ts
 *
 * Tests the pure CSV/TSV parsing and schema validation logic.
 * GCS download is mocked via module-level vi.mock.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the storage module — no real GCS calls
vi.mock("../src/lib/storage", () => ({
  downloadFeedFile: vi.fn(),
  listFeedFiles: vi.fn(),
}));

import { validateGoogleFeed, validateMetaFeed } from "../src/validation/feed-validator";
import { downloadFeedFile, listFeedFiles } from "../src/lib/storage";

const mockDownload = downloadFeedFile as ReturnType<typeof vi.fn>;

// ── Google TSV fixtures ───────────────────────────────────────────────────────

const VALID_GOOGLE_TSV = [
  "id\ttitle\tdescription\tlink\timage_link\tadditional_image_link\tlifestyle_image_link\tavailability\tavailability_date\tprice\tsale_price\tsale_price_effective_date\tbrand\tgtin\tmpn\tidentifier_exists\tcondition\tgoogle_product_category\tproduct_type\titem_group_id\tcolor\tmaterial\tsize\tshipping_weight\tcustom_label_0\tcustom_label_1\tcustom_label_2\tcustom_label_3\tcustom_label_4\tproduct_detail\tproduct_highlight",
  "online:fr:BE:uuid-1\tCanapé\tDescription\thttps://example.com\thttps://example.com/img.jpg\t\t\tin stock\t\t599.00 EUR\t\t\tHomeStorys\t5901234123457\t\tyes\tnew\t436\t\tGRP1\t\t\t\t45 kg\tsale\thigh\t500_1000\t21_30\tonline\t\t",
].join("\n");

const INVALID_GOOGLE_TSV_MISSING_REQUIRED = [
  "id\ttitle\tdescription\tlink\timage_link\tadditional_image_link\tlifestyle_image_link\tavailability\tavailability_date\tprice\tsale_price\tsale_price_effective_date\tbrand\tgtin\tmpn\tidentifier_exists\tcondition\tgoogle_product_category\tproduct_type\titem_group_id\tcolor\tmaterial\tsize\tshipping_weight\tcustom_label_0\tcustom_label_1\tcustom_label_2\tcustom_label_3\tcustom_label_4\tproduct_detail\tproduct_highlight",
  // Missing title and image_link
  "online:fr:BE:uuid-2\t\tDescription\thttps://example.com\t\t\t\tin stock\t\t599.00 EUR\t\t\tBrand\t\t\tno\tnew\t\t\tGRP2\t\t\t\t\tevergreen\tunknown\t0_500\tnone\tonline\t\t",
].join("\n");

const INVALID_GOOGLE_ENUM = [
  "id\ttitle\tdescription\tlink\timage_link\tadditional_image_link\tlifestyle_image_link\tavailability\tavailability_date\tprice\tsale_price\tsale_price_effective_date\tbrand\tgtin\tmpn\tidentifier_exists\tcondition\tgoogle_product_category\tproduct_type\titem_group_id\tcolor\tmaterial\tsize\tshipping_weight\tcustom_label_0\tcustom_label_1\tcustom_label_2\tcustom_label_3\tcustom_label_4\tproduct_detail\tproduct_highlight",
  // invalid availability value
  "online:fr:BE:uuid-3\tTitle\tDesc\thttps://example.com\thttps://example.com/img.jpg\t\t\tIN_STOCK\t\t599.00 EUR\t\t\tBrand\t\t\tno\tnew\t\t\tGRP3\t\t\t\t\tevergreen\tunknown\t0_500\tnone\tonline\t\t",
].join("\n");

// ── Meta CSV fixtures — per layer ─────────────────────────────────────────────

// Base layer: identity + images (no title/price/availability)
const VALID_META_BASE_CSV = [
  `id,item_group_id,gtin,mpn,brand,condition,image_link,additional_image_link,lifestyle_image_link,google_product_category,product_type,color,material,age_group,gender,custom_label_0,custom_label_1,custom_label_2,custom_label_3,custom_label_4`,
  `uuid-1_FR,grp1,5901234123457,,Homestorys,new,https://example.com/img.jpg,,,436,Table,,Chêne,adult,unisex,new,medium,0_500,none,online`,
].join("\n");

const INVALID_META_BASE_CSV_MISSING_IMAGE = [
  `id,item_group_id,gtin,mpn,brand,condition,image_link`,
  `uuid-2_FR,grp2,,,,new,`,
].join("\n");

// Language layer: title + description + link
const VALID_META_LANGUAGE_CSV = [
  `id,title,description,link`,
  `uuid-1_FR,"Table basse","Belle table en chêne","https://example.com/fr/table"`,
].join("\n");

const INVALID_META_LANGUAGE_CSV_BAD_LINK = [
  `id,title,description,link`,
  `uuid-2_FR,"Canapé","Desc","not-a-url"`,
].join("\n");

// Country layer: price + availability
const VALID_META_COUNTRY_CSV = [
  `id,price,sale_price,sale_price_effective_date,availability`,
  `uuid-1_FR,349.00 EUR,,,in stock`,
].join("\n");

const INVALID_META_COUNTRY_CSV_BAD_PRICE = [
  `id,price,sale_price,sale_price_effective_date,availability`,
  `uuid-2_FR,349 euros,,,in stock`,
].join("\n");

const INVALID_META_CSV_MISSING_REQUIRED = INVALID_META_BASE_CSV_MISSING_IMAGE;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("validateGoogleFeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns file not found error when storage returns null", async () => {
    mockDownload.mockResolvedValue(null);
    const result = await validateGoogleFeed("feeds/google/google-fr-BE_FR.tsv");
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toContain("not found");
  });

  it("validates a correct Google TSV as valid", async () => {
    mockDownload.mockResolvedValue(Buffer.from(VALID_GOOGLE_TSV, "utf-8"));
    const result = await validateGoogleFeed("feeds/google/google-fr-BE_FR.tsv");
    expect(result.valid).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.rowCount).toBe(1);
  });

  it("detects missing required fields", async () => {
    mockDownload.mockResolvedValue(Buffer.from(INVALID_GOOGLE_TSV_MISSING_REQUIRED, "utf-8"));
    const result = await validateGoogleFeed("feeds/google/google-fr-BE_FR.tsv");
    expect(result.valid).toBe(false);
    expect(result.errorCount).toBeGreaterThan(0);
    const requiredErrors = result.errors.filter((e) => e.message.includes("Required"));
    expect(requiredErrors.length).toBeGreaterThan(0);
  });

  it("detects invalid enum values", async () => {
    mockDownload.mockResolvedValue(Buffer.from(INVALID_GOOGLE_ENUM, "utf-8"));
    const result = await validateGoogleFeed("feeds/google/google-fr-BE_FR.tsv");
    expect(result.valid).toBe(false);
    const enumErrors = result.errors.filter((e) => e.field === "availability");
    expect(enumErrors.length).toBeGreaterThan(0);
  });

  it("sets schema to 'google-product'", async () => {
    mockDownload.mockResolvedValue(Buffer.from(VALID_GOOGLE_TSV, "utf-8"));
    const result = await validateGoogleFeed("feeds/google/google-fr-BE_FR.tsv");
    expect(result.schema).toBe("google-product");
  });

  it("reports rowCount correctly", async () => {
    const twoRowTsv = VALID_GOOGLE_TSV + "\n" + VALID_GOOGLE_TSV.split("\n")[1];
    mockDownload.mockResolvedValue(Buffer.from(twoRowTsv, "utf-8"));
    const result = await validateGoogleFeed("feeds/google/google-fr-BE_FR.tsv");
    expect(result.rowCount).toBe(2);
  });
});

describe("validateMetaFeed — base layer (meta-base.csv)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns file not found error when storage returns null", async () => {
    mockDownload.mockResolvedValue(null);
    const result = await validateMetaFeed("feeds/meta/meta-base.csv");
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toContain("not found");
  });

  it("validates a correct base CSV as valid with meta-base schema", async () => {
    mockDownload.mockResolvedValue(Buffer.from(VALID_META_BASE_CSV, "utf-8"));
    const result = await validateMetaFeed("feeds/meta/meta-base.csv");
    expect(result.valid).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(result.schema).toBe("meta-base");
  });

  it("detects missing required fields in base layer", async () => {
    mockDownload.mockResolvedValue(Buffer.from(INVALID_META_BASE_CSV_MISSING_IMAGE, "utf-8"));
    const result = await validateMetaFeed("feeds/meta/meta-base.csv");
    expect(result.valid).toBe(false);
    expect(result.errorCount).toBeGreaterThan(0);
  });
});

describe("validateMetaFeed — language layer (meta-language-fr.csv)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("validates a correct language CSV as valid with meta-language schema", async () => {
    mockDownload.mockResolvedValue(Buffer.from(VALID_META_LANGUAGE_CSV, "utf-8"));
    const result = await validateMetaFeed("feeds/meta/meta-language-fr.csv");
    expect(result.valid).toBe(true);
    expect(result.schema).toBe("meta-language");
  });

  it("detects invalid link pattern in language layer", async () => {
    mockDownload.mockResolvedValue(Buffer.from(INVALID_META_LANGUAGE_CSV_BAD_LINK, "utf-8"));
    const result = await validateMetaFeed("feeds/meta/meta-language-fr.csv");
    expect(result.valid).toBe(false);
    const linkErrors = result.errors.filter((e) => e.field === "link");
    expect(linkErrors.length).toBeGreaterThan(0);
  });

  it("uses meta-language schema for de language file", async () => {
    mockDownload.mockResolvedValue(Buffer.from(VALID_META_LANGUAGE_CSV, "utf-8"));
    const result = await validateMetaFeed("feeds/meta/meta-language-de.csv");
    expect(result.schema).toBe("meta-language");
  });
});

describe("validateMetaFeed — multiline descriptions in language layer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts a language CSV whose description contains embedded newlines in a quoted field", async () => {
    // csv-stringify emits multiline descriptions inside quotes, e.g.:
    //   id,title,description,link
    //   uuid-1_FR,"Table","Ligne 1\nLigne 2","https://..."
    // The parser must not split the record at the embedded \n.
    const multilineDesc = "Ligne 1\nLigne 2\nLigne 3";
    const csvContent = [
      `id,title,description,link`,
      `uuid-1_FR,"Table basse","${multilineDesc}","https://example.com/fr/table"`,
    ].join("\n");

    mockDownload.mockResolvedValue(Buffer.from(csvContent, "utf-8"));
    const result = await validateMetaFeed("feeds/meta/meta-language-fr.csv");

    // The parser must produce exactly 1 data row, not 3 broken rows
    expect(result.rowCount).toBe(1);
    // The single complete row should be valid
    expect(result.valid).toBe(true);
  });

  it("validates multiple records, some with multiline descriptions and some without", async () => {
    const csvContent = [
      `id,title,description,link`,
      `uuid-1_FR,"Table","Une description\navec saut de ligne","https://example.com/fr/table"`,
      `uuid-2_FR,"Canapé","Description simple","https://example.com/fr/canape"`,
    ].join("\n");

    mockDownload.mockResolvedValue(Buffer.from(csvContent, "utf-8"));
    const result = await validateMetaFeed("feeds/meta/meta-language-fr.csv");

    expect(result.rowCount).toBe(2);
    expect(result.valid).toBe(true);
  });
});

describe("validateMetaFeed — country layer (meta-country-BE.csv)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("validates a correct country CSV as valid with meta-country schema", async () => {
    mockDownload.mockResolvedValue(Buffer.from(VALID_META_COUNTRY_CSV, "utf-8"));
    const result = await validateMetaFeed("feeds/meta/meta-country-BE.csv");
    expect(result.valid).toBe(true);
    expect(result.schema).toBe("meta-country");
  });

  it("detects invalid price format in country layer", async () => {
    mockDownload.mockResolvedValue(Buffer.from(INVALID_META_COUNTRY_CSV_BAD_PRICE, "utf-8"));
    const result = await validateMetaFeed("feeds/meta/meta-country-BE.csv");
    expect(result.valid).toBe(false);
    const priceErrors = result.errors.filter((e) => e.field === "price");
    expect(priceErrors.length).toBeGreaterThan(0);
  });

  it("uses meta-country schema for all country codes", async () => {
    for (const cc of ["FR", "DE", "AT"]) {
      mockDownload.mockResolvedValue(Buffer.from(VALID_META_COUNTRY_CSV, "utf-8"));
      const result = await validateMetaFeed(`feeds/meta/meta-country-${cc}.csv`);
      expect(result.schema).toBe("meta-country");
    }
  });
});
