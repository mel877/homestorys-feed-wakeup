const MARKET_STOREFRONT_BASE: Record<string, string> = {
  BE_FR: "https://shop.homestorys.com/fr/",
  BE_DE: "https://shop.homestorys.com/",
  FR: "https://shop-fr.homestorys.com/",
  DE: "https://shop-de.homestorys.com/",
  AT: "https://shop-de.homestorys.com/",
  LU_DE: "https://shop.homestorys.com/",
  CH_FR: "https://shop.homestorys.com/fr-ch/",
  CH_DE: "https://shop.homestorys.com/de-ch/",
};

const EXISTING_MARKET_PREFIX = /^\/(?:fr|de|fr-ch|de-ch)(?=\/|$)/;

export function normalizeMarketProductLink(
  productUrl: string,
  marketCode: string,
): string {
  const storefrontBase = MARKET_STOREFRONT_BASE[marketCode];

  if (storefrontBase === undefined) {
    throw new Error(`Unsupported feed market for product link: ${marketCode}`);
  }

  const source = new URL(productUrl);
  const productPath = source.pathname.replace(EXISTING_MARKET_PREFIX, "");

  const target = new URL(storefrontBase);
  const basePath = target.pathname.replace(/\/$/, "");

  target.pathname =
    `${basePath}${productPath.startsWith("/") ? productPath : `/${productPath}`}`;

  target.search = source.search;
  target.hash = source.hash;

  return target.toString();
}
