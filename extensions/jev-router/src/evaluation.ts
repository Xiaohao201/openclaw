import { z } from "zod";
import type { Decision } from "./client.js";
import { TOOL_IDS } from "./router.js";
import { sumKnown } from "./usage.js";

const tools = z
  .array(z.enum(TOOL_IDS))
  .max(5)
  .refine((ids) => new Set(ids).size === ids.length);
const caseSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9_-]{1,80}$/),
    prompt: z.string().min(1).max(20000),
    candidates: tools.min(1),
    expected: z.enum(["selected", "no_tools", "abstain"]),
    requiredTools: tools,
  })
  .refine((row) => row.requiredTools.every((id) => row.candidates.includes(id)))
  .refine((row) =>
    row.expected === "selected" ? row.requiredTools.length > 0 : row.requiredTools.length === 0,
  );
const datasetSchema = z
  .array(caseSchema)
  .min(1)
  .max(500)
  .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length);
export type EvalCase = z.infer<typeof caseSchema>;
export function parseDataset(value: unknown): EvalCase[] {
  return datasetSchema.parse(value);
}

export function evaluate(rows: EvalCase[], decisions: Decision[]) {
  if (rows.length === 0 || rows.length !== decisions.length) {
    throw new Error("One decision per evaluation case is required.");
  }
  let correct = 0;
  let fallbacks = 0;
  let required = 0;
  let retained = 0;
  let selectedRequired = 0;
  let selectedRetained = 0;
  let before = 0;
  let after = 0;
  const cases = rows.map((row, index) => {
    const decision = decisions[index];
    if (decision.candidates.some((id) => !row.candidates.includes(id))) {
      throw new Error("Decision expanded the candidate pool.");
    }
    correct += Number(row.expected === decision.status);
    fallbacks += Number(decision.status === "abstain");
    // Abstention preserves the input catalog regardless of what a replay claims.
    const effective = decision.status === "abstain" ? row.candidates : decision.candidates;
    const hits = row.requiredTools.filter((id) => effective.includes(id)).length;
    required += row.requiredTools.length;
    retained += hits;
    if (decision.status !== "abstain") {
      selectedRequired += row.requiredTools.length;
      selectedRetained += hits;
    }
    before += row.candidates.length;
    after += effective.length;
    return {
      id: row.id,
      expected: row.expected,
      ...decision,
      missingRequiredTools: row.requiredTools.filter((id) => !effective.includes(id)),
    };
  });
  const elapsed = decisions.map((d) => d.elapsedMs).toSorted((a, b) => a - b);
  const percentile = (p: number) => elapsed[Math.max(0, Math.ceil(elapsed.length * p) - 1)];
  return {
    count: rows.length,
    routeAccuracy: correct / rows.length,
    fallbackRate: fallbacks / rows.length,
    effectiveRequiredToolRecall: required ? retained / required : null,
    selectedRequiredToolRecall: selectedRequired ? selectedRetained / selectedRequired : null,
    candidateReduction: before ? 1 - after / before : null,
    latencyMs: { p50: percentile(0.5), p95: percentile(0.95) },
    usage: {
      inputTokens: sumKnown(decisions.map((d) => d.usage?.inputTokens)),
      outputTokens: sumKnown(decisions.map((d) => d.usage?.outputTokens)),
      costUsd: sumKnown(decisions.map((d) => d.usage?.costUsd)),
    },
    byExpectedRoute: Object.fromEntries(
      ["selected", "no_tools", "abstain"].map((route) => {
        const group = cases.filter((row) => row.expected === route);
        return [
          route,
          { count: group.length, correct: group.filter((row) => row.status === route).length },
        ];
      }),
    ),
    cases,
  };
}
