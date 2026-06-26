import { centralGovPlatform } from "./data/central-gov-platform.js";
import { centralIndustryMedia } from "./data/central-industry-media.js";
import { centralNews } from "./data/central-news.js";
import { localCity } from "./data/local-city.js";
import { localProvince } from "./data/local-province.js";

/**
 * Authoritative media / official-platform whitelist, ported from judgemilvus.
 * Supports 标准① of the rubric ("发文作者是否新闻媒体"). Five source categories
 * are merged into one lookup set; matching mirrors the original `is_news_media`:
 * exact match, plus case-insensitive match for Latin-letter names.
 */
const COMBINED: readonly string[] = [
  ...centralIndustryMedia,
  ...centralGovPlatform,
  ...centralNews,
  ...localCity,
  ...localProvince,
];

const EXACT = new Set(COMBINED);
const LOWER = new Set(COMBINED.map((s) => s.toLowerCase()));

/** Total whitelist size, exposed for diagnostics / health checks. */
export const MEDIA_WHITELIST_SIZE = EXACT.size;

/**
 * Whether `author` is a known news outlet / official publishing platform.
 * Exact match first, then a case-insensitive fallback for English names.
 * Empty / missing author is never a media outlet.
 */
export function isNewsMedia(author: string | null | undefined): boolean {
  if (!author) {
    return false;
  }
  const name = author.trim();
  if (!name) {
    return false;
  }
  if (EXACT.has(name)) {
    return true;
  }
  return LOWER.has(name.toLowerCase());
}
