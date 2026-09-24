import { describe, expect, it, vi } from "vitest";
import { decideBusinessRoute } from "./business-decision.js";

const state = {
  request: "[JEV_SYNTHETIC_BENCH] read that file",
  history: [{ role: "user", content: "file=fixture.txt" }],
  allowMemory: false,
};
const routes = [
  "answer",
  "clarify",
  "read",
  "search",
  "memory",
  "query",
  "check",
  "report",
  "write",
  "think",
  "schedule",
  "uncertain",
];
function response(choice = "read", confidence = 0.95) {
  return {
    answers: {
      route: {
        type: "choice",
        choice,
        confidence,
        probabilities: Object.fromEntries(routes.map((route) => [route, route === choice ? 1 : 0])),
      },
    },
  };
}
describe("JEV business route decision", () => {
  it("sends a single structured workflow question with history, not one question per tool", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response()));
    expect(await decideBusinessRoute(state, { apiKey: "test-key", fetch: fetcher })).toMatchObject({
      version: 1,
      route: "read",
      confidence: 0.95,
    });
    const payload = JSON.parse(fetcher.mock.calls[0][1]?.body as string);
    expect(payload.state).toEqual(state);
    expect(Object.keys(payload.questions)).toEqual(["route"]);
    expect(Object.keys(payload.questions.route.criteria)).toEqual(routes);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not send real/unbounded contexts or requests without a key", async () => {
    const fetcher = vi.fn();
    for (const input of [
      {},
      { ...state, request: "real message" },
      { ...state, history: ["x".repeat(21000)] },
    ]) {
      expect(await decideBusinessRoute(input, { apiKey: "key", fetch: fetcher })).toMatchObject({
        route: "uncertain",
        reason: "invalid_state",
      });
    }
    expect(await decideBusinessRoute(state, { apiKey: "", fetch: fetcher })).toMatchObject({
      reason: "missing_key",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("distinguishes answer, clarification, uncertainty, low confidence and contract errors", async () => {
    for (const route of routes) {
      expect(
        await decideBusinessRoute(state, {
          apiKey: "key",
          fetch: vi.fn().mockResolvedValue(Response.json(response(route))),
        }),
      ).toMatchObject({ route });
    }
    const invalid = response();
    invalid.answers.route.probabilities.read = 0;
    for (const [body, reason] of [
      [response("answer", 0.5), "low_confidence"],
      [{}, "invalid_response"],
      [invalid, "invalid_response"],
    ] as const) {
      expect(
        await decideBusinessRoute(state, {
          apiKey: "key",
          fetch: vi.fn().mockResolvedValue(Response.json(body)),
        }),
      ).toMatchObject({ route: "uncertain", reason });
    }
  });
  it("falls back without retrying or echoing upstream errors", async () => {
    for (const fetcher of [
      vi.fn().mockResolvedValue(new Response("secret", { status: 429 })),
      vi.fn().mockRejectedValue(new Error("secret")),
    ]) {
      const result = await decideBusinessRoute(state, { apiKey: "key", fetch: fetcher });
      expect(result.route).toBe("uncertain");
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
});
