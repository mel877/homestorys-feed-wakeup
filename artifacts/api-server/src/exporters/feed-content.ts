import type { CanonicalProduct } from "../canonical/types";

/**
 * Channable parity: add market-language reassurance copy for short
 * descriptions, then keep the exported catalog copy concise.
 */
const SHORT_DESCRIPTION_SUFFIX_BY_LANGUAGE: Record<string, string> = {
  fr: " Avec Homestorys partez dans un voyage passionnant avec nos 9 Homestorys pour découvrir les meilleures idées d'aménagement et de style de vie à la Belge sur les thèmes suivants : le plaisir, famille et traditions, loisirs et voyages, expériences dans la nature et paradis du jardin, design et une nouvelle forme de luxe.",
  de: " Herzlich willkommen bei Homestorys, dem Online-Shop für Ihr Zuhause. Entdecken Sie die Best of Belgian Lifestyle und lassen Sie sich von unseren Themenwelten inspirieren! Entdecken Sie für sich das Beste aus allen Welten für Ihr Zuhause-Gefühl.",
};

function truncateAtWordBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;

  const truncated = value.slice(0, maxLength + 1);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : value.slice(0, maxLength)).trimEnd();
}

/**
 * Produces one description policy for Google and Meta:
 * - fallback to title when source content is absent;
 * - append language-specific reassurance copy when source is short;
 * - cap the result at Channable's 800-character limit.
 */
export function buildFeedDescription(canonical: CanonicalProduct): string {
  const base = (canonical.description || canonical.title).trim();
  const suffix = SHORT_DESCRIPTION_SUFFIX_BY_LANGUAGE[canonical.language] ?? "";
  const enriched = base.length <= 500 && suffix ? `${base}${suffix}` : base;
  return truncateAtWordBoundary(enriched, 800);
}