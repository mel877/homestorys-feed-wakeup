const CANONICAL_STOREFRONT_ORIGIN = "https://shop.homestorys.com";

const MARKET_PATH_PREFIX: Record<string, string> = {
  FR: "/fr",
  BE_FR: "/fr",
  DE: "",
  BE_DE: "",
  AT: "",
  LU_DE: "",
  CH_FR: "/fr-ch",
  CH_DE: "/de-ch",
};

const EXISTING_MARKET_PREFIX = /^\/(?:fr|de|fr-ch|de-ch)(?=\/|$)/;

export function normalizeMarketProductLink(
  productUrl: string,
  marketCode: string,
): string {
  const prefix = MARKET_PATH_PREFIX[marketCode];
  if (prefix === undefined) {
    throw new Error(`Unsupported feed market for product link: ${marketCode}`);
  }

  const source = new URL(productUrl);
  const productPath = source.pathname.replace(EXISTING_MARKET_PREFIX, "");
  const target = new URL(CANONICAL_STOREFRONT_ORIGIN);
  target.pathname = `${prefix}${productPath.startsWith("/") ? productPath : `/${productPath}`}`;
  target.search = source.search;
  target.hash = source.hash;
  return target.toString();
}