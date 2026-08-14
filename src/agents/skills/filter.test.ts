import { describe, expect, it } from "vitest";
import {
  matchesSkillFilter,
  mergeSkillFilters,
  normalizeSkillFilter,
  normalizeSkillFilterForComparison,
} from "./filter.js";

describe("skills/filter", () => {
  it("normalizes configured filters with trimming", () => {
    expect(normalizeSkillFilter([" weather ", "", "meme-factory"])).toEqual([
      "weather",
      "meme-factory",
    ]);
  });

  it("preserves explicit empty list as []", () => {
    expect(normalizeSkillFilter([])).toEqual([]);
    expect(normalizeSkillFilter(undefined)).toBeUndefined();
  });

  it("normalizes for comparison with dedupe + ordering", () => {
    expect(normalizeSkillFilterForComparison(["weather", "meme-factory", "weather"])).toEqual([
      "meme-factory",
      "weather",
    ]);
  });

  it("matches equivalent filters after normalization", () => {
    expect(matchesSkillFilter(["weather", "meme-factory"], [" meme-factory ", "weather"])).toBe(
      true,
    );
    expect(matchesSkillFilter(undefined, undefined)).toBe(true);
    expect(matchesSkillFilter([], undefined)).toBe(false);
  });

  it("intersects a per-run filter with the configured agent filter", () => {
    expect(mergeSkillFilters(["weather", "github"], ["github", "docs"])).toEqual(["github"]);
    expect(mergeSkillFilters(["weather"], undefined)).toEqual(["weather"]);
    expect(mergeSkillFilters(undefined, ["docs"])).toEqual(["docs"]);
    expect(mergeSkillFilters([], ["docs"])).toEqual([]);
  });
});
