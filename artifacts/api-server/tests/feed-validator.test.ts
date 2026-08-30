/**
 * Tests for src/validation/feed-validator.ts
 *
 * Tests the pure CSV/TSV parsing and schema validation logic.
 * GCS download is mocked via module-level vi.mock.
 */

import { Readable } from "node:stream";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the storage module — no real GCS calls
vi.mock("../src/lib/storage", () => ({
  downloadFeedFile: vi.fn(),
  openFeedFileReadStream: vi.fn(),
  listFeedFiles: vi.fn(),
}));

import { validateGoogleFeed, validateMetaFeed } from "../src/validation/feed-validator";
import { downloadFeedFile, openFeedFileReadStream } from "../src/lib/storage";

const mockDownloadFunction = downloadFeedFile as ReturnType<typeof vi.fn>;
const mockOpen = openFeedFileReadStream as ReturnType<typeof vi.fn>;
const mockDownload = {
  mockResolvedValue(content: Buffer | null) {
    mockOpen.mockResolvedValue(content === null
      ? null
      : { stream: Readable.from([content]), size: content.length });
  },
};

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

  it("streams the feed instead of downloading the complete object", async () => {
    mockDownload.mockResolvedValue(Buffer.from(VALID_GOOGLE_TSV, "utf-8"));

    await validateGoogleFeed("feeds/google/google-fr-BE_FR.tsv");

    expect(mockOpen).toHaveBeenCalledOnce();
    expect(mockDownloadFunction).not.toHaveBeenCalled();
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

  it("rejects invalid UTF-8", async () => {
    mockDownload.mockResolvedValue(Buffer.from([0xc3, 0x28]));
    const result = await validateGoogleFeed("feeds/google/google-fr-BE_FR.tsv");
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ field: "encoding" }));
  });

  it("rejects duplicate product IDs", async () => {
    const duplicate = VALID_GOOGLE_TSV + "\n" + VALID_GOOGLE_TSV.split("\n")[1];
    mockDownload.mockResolvedValue(Buffer.from(duplicate, "utf-8"));
    const result = await validateGoogleFeed("feeds/google/google-fr-BE_FR.tsv");
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ field: "id", message: expect.stringContaining("Duplicate") }));
  });

  it("blocks a Swiss Google feed containing EUR prices", async () => {
    mockDownload.mockResolvedValue(Buffer.from(VALID_GOOGLE_TSV, "utf-8"));
    const result = await validateGoogleFeed(
      "feeds/google/google-de-CH_DE.tsv",
      { expectedCurrency: "CHF" },
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({
      field: "price",
      message: expect.stringContaining("CHF"),
    }));
  });

  it("checks sale price and shipping currency as part of the market gate", async () => {
    const lines = VALID_GOOGLE_TSV.split("\n");
    const headers = lines[0]!.split("\t");
    const values = lines[1]!.split("\t");
    values[headers.indexOf("price")] = "599.00 CHF";
    values[headers.indexOf("sale_price")] = "499.00 EUR";
    headers.push("shipping");
    values.push("CH::Standard:10.00 EUR");
    mockDownload.mockResolvedValue(Buffer.from([headers.join("\t"), values.join("\t")].join("\n")));

    const result = await validateGoogleFeed(
      "feeds/google/google-de-CH_DE.tsv",
      { expectedCurrency: "CHF" },
    );
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "sale_price" }),
      expect.objectContaining({ field: "shipping" }),
    ]));
  });
});

describe("validateMetaFeed — base layer (meta-base.csv)", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["meta-base.csv", "meta-base"],
    ["meta-base.csv.final-xxx-attempt-1", "meta-base"],
    ["meta-language-fr.csv", "meta-language"],
    ["meta-language-fr.csv.final-xxx-attempt-2", "meta-language"],
    ["meta-country-CH.csv", "meta-country"],
    ["meta-country-CH.csv.final-xxx-attempt-1", "meta-country"],
    ["meta-generic.csv", "meta-product"],
  ])("detects %s as the %s schema", async (filename, expectedSchema) => {
    mockDownload.mockResolvedValue(Buffer.from("id\n"));

    const result = await validateMetaFeed(`feeds/meta/${filename}`);

    expect(result.schema).toBe(expectedSchema);
  });

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

  it("parses escaped quotes, commas, multiline fields, CRLF and LF across stream chunks", async () => {
    const chunks = [
      Buffer.from("id,title,description,link\r\nuuid-1_FR,\"Table, basse\",\"Ligne 1\r"),
      Buffer.from("\nLigne \""),
      Buffer.from("\"citée\"\"\",\"https://example.com/fr/table\"\nuuid-2_FR,Canapé,Simple,https://example.com/fr/canape\r\n"),
    ];
    mockOpen.mockResolvedValue({
      stream: Readable.from(chunks),
      size: chunks.reduce((total, chunk) => total + chunk.length, 0),
    });

    const result = await validateMetaFeed("feeds/meta/meta-language-fr.csv");

    expect(result.valid).toBe(true);
    expect(result.rowCount).toBe(2);
  });

  it("rejects an unterminated quoted field without buffering to end-of-process memory", async () => {
    const chunks = [
      Buffer.from("id,title,description,link\nuuid-1_FR,Title,\"unterminated"),
      Buffer.alloc(1024, "x"),
    ];
    mockOpen.mockResolvedValue({
      stream: Readable.from(chunks),
      size: chunks.reduce((total, chunk) => total + chunk.length, 0),
    });

    const result = await validateMetaFeed("feeds/meta/meta-language-fr.csv");

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ field: "csv" }));
  });

  it("preserves the exact prior error count when a later CSV record is malformed", async () => {
    const csv = [
      "id,title,description,link",
      "uuid-1_FR,,Description,not-a-url",
      "uuid-2_FR,Title,\"unterminated",
    ].join("\n");
    mockDownload.mockResolvedValue(Buffer.from(csv));

    const result = await validateMetaFeed("feeds/meta/meta-language-fr.csv");

    expect(result.errorCount).toBe(3);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "title" }),
      expect.objectContaining({ field: "link" }),
      expect.objectContaining({ field: "csv" }),
    ]));
  });

  it("rejects duplicate Meta IDs", async () => {
    const csvContent = VALID_META_LANGUAGE_CSV + "\n" + VALID_META_LANGUAGE_CSV.split("\n")[1];
    mockDownload.mockResolvedValue(Buffer.from(csvContent, "utf-8"));
    const result = await validateMetaFeed("feeds/meta/meta-language-fr.csv");
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ field: "id", message: expect.stringContaining("Duplicate") }));
  });

  it("counts every error while retaining only the first 200", async () => {
    const rows = Array.from(
      { length: 250 },
      (_, index) => `uuid-${index}_FR,,Description,not-a-url`,
    );
    mockDownload.mockResolvedValue(Buffer.from([
      "id,title,description,link",
      ...rows,
    ].join("\n")));

    const result = await validateMetaFeed("feeds/meta/meta-language-fr.csv");

    expect(result.errorCount).toBe(500);
    expect(result.errors).toHaveLength(200);
  });

  it("validates a production-sized stream without materializing the complete feed", async () => {
    const rowCount = 100_000;
    async function* rows() {
      yield Buffer.from("id,title,description,link\n");
      for (let index = 0; index < rowCount; index++) {
        yield Buffer.from(
          `uuid-${index}_FR,Title ${index},Description ${index},https://example.com/fr/${index}\n`,
        );
      }
    }
    mockOpen.mockResolvedValue({ stream: Readable.from(rows()), size: null });

    const result = await validateMetaFeed("feeds/meta/meta-language-fr.csv");

    expect(result.valid).toBe(true);
    expect(result.rowCount).toBe(rowCount);
  }, 60_000);
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

  it("blocks a Swiss Meta feed containing EUR prices", async () => {
    mockDownload.mockResolvedValue(Buffer.from(VALID_META_COUNTRY_CSV, "utf-8"));
    const result = await validateMetaFeed(
      "feeds/meta/meta-country-CH.csv",
      { expectedCurrency: "CHF" },
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({
      field: "price",
      message: expect.stringContaining("CHF"),
    }));
  });

  it("checks Meta sale price and shipping currency as part of the market gate", async () => {
    const csv = [
      "id,price,sale_price,sale_price_effective_date,availability,shipping",
      "uuid-1_FR,349.00 CHF,299.00 EUR,,in stock,CH::Standard:10.00 EUR",
    ].join("\n");
    mockDownload.mockResolvedValue(Buffer.from(csv));

    const result = await validateMetaFeed(
      "feeds/meta/meta-country-CH.csv",
      { expectedCurrency: "CHF" },
    );
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "sale_price" }),
      expect.objectContaining({ field: "shipping" }),
    ]));
  });

  it("rejects a promotional row when sale_price is equal to price", async () => {
    const csv = [
      "id,price,sale_price,sale_price_effective_date,availability,shipping",
      "uuid-1_CH_DE,341.00 CHF,341.00 CHF,,in stock,CH::Standard:19.50 CHF",
    ].join("\n");
    mockDownload.mockResolvedValue(Buffer.from(csv));

    const result = await validateMetaFeed(
      "feeds/meta/meta-country-CH.csv",
      { expectedCurrency: "CHF" },
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({
      field: "sale_price",
      message: expect.stringContaining("strictly lower"),
    }));
  });

  it("uses meta-country schema for all country codes", async () => {
    for (const cc of ["FR", "DE", "AT"]) {
      mockDownload.mockResolvedValue(Buffer.from(VALID_META_COUNTRY_CSV, "utf-8"));
      const result = await validateMetaFeed(`feeds/meta/meta-country-${cc}.csv`);
      expect(result.schema).toBe("meta-country");
    }
  });
});
