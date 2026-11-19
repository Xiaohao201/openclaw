/** Configured model prices and usage reports in this deployment use yuan. */
export const MODEL_COST_CURRENCY = "CNY";

/** Format an amount already expressed in CNY; this does not convert currencies. */
export function formatCny(
  value: number | null | undefined,
  fractionDigits?: number,
): string | undefined {
  if (value == null || !Number.isFinite(value)) {
    return undefined;
  }
  const digits = fractionDigits ?? (Math.abs(value) < 0.01 ? 4 : 2);
  return `¥${value.toFixed(digits)}`;
}
