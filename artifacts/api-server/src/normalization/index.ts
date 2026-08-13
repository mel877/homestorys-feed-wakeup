/**
 * Normalization layer — transforms raw Shopify data into cleaned values
 * ready for the canonical product model.
 *
 * Rules:
 * - Never invent data (spec section 11)
 * - Strip HTML/scripts from descriptions
 * - Validate GTIN format + checksum
 * - Normalise brand aliases from config
 * - Construct title per spec section 28
 */

// ── Title construction ────────────────────────────────────────────────────────

/**
 * Build the product title per spec section 28:
 *   Brand + Product Name + Product Type + Key Variant
 *
 * Example: "Ethnicraft Bok Dining Table Oak 200 cm"
 */
export function buildTitle(opts: {
  brand: string;
  productTitle: string;
  variantTitle?: string | null;
  productType?: string | null;
}): string {
  const { brand, productTitle, variantTitle, productType } = opts;
  const parts: string[] = [brand, productTitle];

  // Only append product type if it adds useful info not already in the title
  if (productType && !productTitle.toLowerCase().includes(productType.toLowerCase())) {
    parts.push(productType);
  }

  // Append variant title if meaningful (not generic "Default Title" from Shopify)
  if (variantTitle && variantTitle.toLowerCase() !== "default title" && variantTitle !== "-") {
    parts.push(variantTitle);
  }

  const title = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  // Shopify field caps at 150 chars for feeds
  return title.slice(0, 150);
}

// ── Description sanitization ─────────────────────────────────────────────────

// Tags/attributes to strip completely (including their content)
const STRIP_TAGS = ["script", "style", "noscript", "iframe", "meta", "link"];

/**
 * Strip HTML to plain text, removing scripts/styles and cleaning whitespace.
 * Per spec section 29: never generate marketing prose.
 */
export function sanitizeDescription(raw: string | null | undefined): string {
  if (!raw) return "";

  let text = raw;

  // Remove complete tags with content
  for (const tag of STRIP_TAGS) {
    text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
  }

  // Replace block-level tags with newlines for readability
  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|td|th)[^>]*>/gi, "\n");

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&eacute;/g, "é")
    .replace(/&egrave;/g, "è")
    .replace(/&agrave;/g, "à")
    .replace(/&ccedil;/g, "ç")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");

  // Collapse whitespace and newlines
  text = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Cap at 5000 characters (Google Merchant limit)
  return text.slice(0, 5000);
}

// ── GTIN validation ───────────────────────────────────────────────────────────

/** Valid GTIN lengths. */
const VALID_GTIN_LENGTHS = [8, 12, 13, 14];

/**
 * Validate a GTIN (EAN-8, UPC-A, EAN-13, GTIN-14) using checksum.
 * Returns normalised GTIN string if valid, null if invalid.
 * Never invents or generates a GTIN.
 */
export function validateGtin(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // Strip non-digit characters (sometimes Shopify barcodes have spaces/dashes)
  const digits = raw.replace(/\D/g, "");

  if (!VALID_GTIN_LENGTHS.includes(digits.length)) return null;

  // Verify check digit using Luhn-like GTIN algorithm
  const valid = verifyGtinCheckDigit(digits);
  if (!valid) return null;

  return digits;
}

function verifyGtinCheckDigit(digits: string): boolean {
  const len = digits.length;
  let sum = 0;

  for (let i = 0; i < len - 1; i++) {
    const d = parseInt(digits[i]!, 10);
    // Multiplier alternates based on position from the right (excluding check digit)
    const multiplier = (len - 1 - i) % 2 === 0 ? 3 : 1;
    sum += d * multiplier;
  }

  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(digits[len - 1]!, 10);
}

/**
 * Validate MPN format: must not be empty, not a placeholder.
 * Returns cleaned MPN or null.
 */
export function validateMpn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim();
  if (!cleaned || cleaned.toLowerCase() === "n/a" || cleaned === "-") return null;
  if (cleaned.length > 70) return null; // Google MPN limit
  return cleaned;
}

// ── Brand normalisation ───────────────────────────────────────────────────────

/** Brand alias map per spec section 83. */
const BRAND_ALIASES: Record<string, string> = {
  // Shopify vendor → canonical brand name
  vetsak: "vetsak",
  VETSAK: "vetsak",
  Ethnicraft: "Ethnicraft",
  ethnicraft: "Ethnicraft",
  ETHNICRAFT: "Ethnicraft",
  "Ethnicraft NV": "Ethnicraft",
  Tolix: "Tolix",
  TOLIX: "Tolix",
  "Hay Design": "HAY",
  Hay: "HAY",
  HAY: "HAY",
  Muuto: "Muuto",
  MUUTO: "Muuto",
  "Fritz Hansen": "Fritz Hansen",
  "Fritz-Hansen": "Fritz Hansen",
  "Gubi A/S": "GUBI",
  GUBI: "GUBI",
  Gubi: "GUBI",
};

/**
 * Normalise vendor string to canonical brand name.
 * Falls back to the raw vendor string, trimmed.
 * Returns empty string if vendor is null/empty.
 */
export function normaliseBrand(vendor: string | null | undefined): string {
  if (!vendor) return "";
  const trimmed = vendor.trim();
  return BRAND_ALIASES[trimmed] ?? trimmed;
}

// ── Color extraction ──────────────────────────────────────────────────────────

/** Common furniture colours to detect in title/tags. */
const COLOUR_KEYWORDS: string[] = [
  "black", "white", "grey", "gray", "brown", "beige", "cream", "natural",
  "oak", "walnut", "dark", "light", "navy", "green", "blue", "red",
  "yellow", "orange", "pink", "purple", "gold", "silver", "copper",
  "noir", "blanc", "gris", "brun", "bois", "chêne", "noyer",
];

/**
 * Extract colour keywords from title and tags.
 * Never invents colours not present in the source data.
 */
export function extractColors(opts: {
  variantTitle: string;
  productTitle: string;
  tags: string[];
}): string[] {
  const source = [
    opts.variantTitle.toLowerCase(),
    opts.productTitle.toLowerCase(),
    ...opts.tags.map((t) => t.toLowerCase()),
  ].join(" ");

  const found = new Set<string>();
  for (const colour of COLOUR_KEYWORDS) {
    if (source.includes(colour)) {
      found.add(colour);
    }
  }

  return [...found];
}

// ── Dimension normalisation ───────────────────────────────────────────────────

/**
 * Convert weight to kilograms (Google requires kg or lb).
 * Returns null if weight is null or unit is unrecognised.
 */
export function normaliseWeight(
  weight: string | null,
  unit: string | null,
): { value: number; unit: "kg" | "lb" } | null {
  if (weight === null || weight === undefined) return null;
  const num = parseFloat(weight);
  if (isNaN(num) || num <= 0) return null;

  switch ((unit ?? "").toLowerCase()) {
    case "kg":
    case "kilograms":
      return { value: num, unit: "kg" };
    case "g":
    case "grams":
    case "gram":
      return { value: num / 1000, unit: "kg" };
    case "lb":
    case "lbs":
    case "pounds":
      return { value: num, unit: "lb" };
    case "oz":
    case "ounces":
      return { value: num / 16, unit: "lb" };
    default:
      return null;
  }
}

// ── isNew detection ───────────────────────────────────────────────────────────

/**
 * Detect if product is "new" based on published date and threshold days.
 */
export function isNewProduct(
  publishedAt: Date | null | undefined,
  newProductDays: number,
): boolean {
  if (!publishedAt) return false;
  const ageMs = Date.now() - publishedAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays <= newProductDays;
}
