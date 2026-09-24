import { describe, expect, it } from "vitest";
import { evaluate, parseDataset } from "./evaluation.js";

describe("JEV evaluation", () => {
  const dataset = [
    {
      id: "search",
      prompt: "news",
      candidates: ["read", "web_search"],
      expected: "selected",
      requiredTools: ["web_search"],
    },
    { id: "hello", prompt: "hello", candidates: ["read"], expected: "no_tools", requiredTools: [] },
    {
      id: "write",
      prompt: "write code",
      candidates: ["read"],
      expected: "abstain",
      requiredTools: [],
    },
  ];
  it("separates fallback-inclusive recall from actual selection quality", () => {
    const report = evaluate(parseDataset(dataset), [
      { status: "abstain", candidates: ["read", "web_search"], reason: "timeout", elapsedMs: 20 },
      { status: "no_tools", candidates: [], confidence: 0.9, elapsedMs: 10 },
      { status: "abstain", candidates: ["read"], reason: "model_abstained", elapsedMs: 30 },
    ]);
    expect(report).toMatchObject({
      count: 3,
      routeAccuracy: 2 / 3,
      fallbackRate: 2 / 3,
      effectiveRequiredToolRecall: 1,
      selectedRequiredToolRecall: null,
      latencyMs: { p50: 20, p95: 30 },
      candidateReduction: 0.25,
    });
  });
  it("counts missed required tools even when the route is correct", () => {
    const report = evaluate(parseDataset(dataset.slice(0, 1)), [
      { status: "selected", candidates: ["read"], confidence: 0.9, elapsedMs: 12 },
    ]);
    expect(report.routeAccuracy).toBe(1);
    expect(report.effectiveRequiredToolRecall).toBe(0);
    expect(report.selectedRequiredToolRecall).toBe(0);
  });
  it("rejects duplicate ids, write tools, impossible labels and missing observations", () => {
    expect(() => parseDataset([...dataset, dataset[0]])).toThrow();
    expect(() => parseDataset([{ ...dataset[0], candidates: ["exec"] }])).toThrow();
    expect(() => parseDataset([{ ...dataset[0], candidates: ["read"] }])).toThrow();
    expect(() => parseDataset([{ ...dataset[0], expected: "no_tools" }])).toThrow();
    expect(() => evaluate(parseDataset(dataset), [])).toThrow();
  });
});
