import { describe, expect, it } from "vitest";
import { formatCost } from "./usage-metrics.ts";
import { buildDailyCsv, buildSessionsCsv } from "./usage-query.ts";
import type { CostDailyEntry, UsageSessionEntry } from "./usageTypes.ts";

describe("usage reporting currency", () => {
  it("uses yuan in chart labels and preserves throughput precision", () => {
    expect(formatCost(40)).toBe("¥40.00");
    expect(formatCost(0.0042, 4)).toBe("¥0.0042");
    expect(formatCost(Number.NaN)).toBe("—");
  });

  it("exports a CNY currency column without converting numeric costs", () => {
    const day: CostDailyEntry = {
      date: "2026-11-19",
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2_000_000,
      inputCost: 10,
      outputCost: 30,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      totalCost: 40,
      missingCostEntries: 0,
    };
    const session: UsageSessionEntry = { key: "example", usage: day };
    for (const csv of [buildDailyCsv([day]), buildSessionsCsv([session])]) {
      const [header, row] = csv.split("\n").map((line) => line.split(","));
      expect(row[header.indexOf("currency")]).toBe("CNY");
      expect(row[header.indexOf("totalCost")]).toBe("40");
      expect(row).toHaveLength(header.length);
    }
  });
});
