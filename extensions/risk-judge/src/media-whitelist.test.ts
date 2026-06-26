import { describe, expect, it } from "vitest";
import { isNewsMedia, MEDIA_WHITELIST_SIZE } from "./media-whitelist.js";

describe("isNewsMedia", () => {
  it("loads the full merged whitelist", () => {
    // 147 + 272 + 188 + 1401 + 623 = 2631 (minus any cross-category duplicates).
    expect(MEDIA_WHITELIST_SIZE).toBeGreaterThan(2000);
  });

  it("matches a known central outlet exactly", () => {
    expect(isNewsMedia("人民网")).toBe(true);
    expect(isNewsMedia("新华网")).toBe(true);
  });

  it("trims surrounding whitespace before matching", () => {
    expect(isNewsMedia("  人民网  ")).toBe(true);
  });

  it("treats unknown accounts as non-media", () => {
    expect(isNewsMedia("某网民小红书账号")).toBe(false);
    expect(isNewsMedia("X平台大V")).toBe(false);
  });

  it("returns false for empty / missing author", () => {
    expect(isNewsMedia(undefined)).toBe(false);
    expect(isNewsMedia(null)).toBe(false);
    expect(isNewsMedia("")).toBe(false);
    expect(isNewsMedia("   ")).toBe(false);
  });
});
