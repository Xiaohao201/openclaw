import { describe, expect, it } from "vitest";
import { formatCny } from "./model-cost-format.js";

describe("formatCny", () => {
  it.each([
    [53, "¥53.00"],
    [0.5, "¥0.50"],
    [0.0042, "¥0.0042"],
    [-0.0042, "¥-0.0042"],
  ])("formats yuan without an exchange-rate conversion: %s", (value, expected) => {
    expect(formatCny(value)).toBe(expected);
  });

  it("supports chart and message precision", () => {
    expect(formatCny(0, 2)).toBe("¥0.00");
    expect(formatCny(0.125, 3)).toBe("¥0.125");
    expect(formatCny(53, 4)).toBe("¥53.0000");
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not invent an amount for %s",
    (value) => expect(formatCny(value)).toBeUndefined(),
  );
});
