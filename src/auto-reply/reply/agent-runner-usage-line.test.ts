import { describe, expect, it } from "vitest";
import { formatResponseUsageLine } from "./agent-runner-usage-line.js";

describe("formatResponseUsageLine CNY pricing", () => {
  const costConfig = { input: 10, output: 30, cacheRead: 0.5, cacheWrite: 12.5 };

  it("calculates and labels yuan costs from per-million-token prices", () => {
    expect(
      formatResponseUsageLine({
        usage: { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
        showCost: true,
        costConfig,
      }),
    ).toBe("Usage: 1.0m in / 1.0m out · cache 1.0m cached / 1.0m new · est ¥53.00");
  });

  it("preserves precision for small charges", () => {
    expect(
      formatResponseUsageLine({ usage: { input: 100, output: 100 }, showCost: true, costConfig }),
    ).toBe("Usage: 100 in / 100 out · est ¥0.0040");
  });

  it("does not invent costs for missing pricing or hide-cost mode", () => {
    expect(formatResponseUsageLine({ usage: { input: 100, output: 100 }, showCost: true })).toBe(
      "Usage: 100 in / 100 out",
    );
    expect(
      formatResponseUsageLine({ usage: { input: 100, output: 100 }, showCost: false, costConfig }),
    ).toBe("Usage: 100 in / 100 out");
  });
});
