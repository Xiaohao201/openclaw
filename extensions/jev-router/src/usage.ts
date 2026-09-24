import { z } from "zod";

export type Usage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
};
const tokens = z.number().int().nonnegative();
const usageSchema = z.object({
  prompt_tokens: tokens.optional(),
  completion_tokens: tokens.optional(),
  input_tokens: tokens.optional(),
  output_tokens: tokens.optional(),
  cost: z.number().finite().nonnegative().nullable().optional(),
  prompt_tokens_details: z.object({ cached_tokens: tokens.optional() }).optional(),
});
export function parseUsage(body: unknown): Usage {
  const parsed = z.object({ usage: usageSchema }).safeParse(body);
  const usage = parsed.success ? parsed.data.usage : undefined;
  return {
    inputTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? null,
    outputTokens: usage?.completion_tokens ?? usage?.output_tokens ?? null,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
    costUsd: usage?.cost ?? null,
  };
}
export function sumKnown(values: Array<number | null | undefined>): number | null {
  let sum = 0;
  for (const value of values) {
    if (value == null) {
      return null;
    }
    sum += value;
  }
  return sum;
}
