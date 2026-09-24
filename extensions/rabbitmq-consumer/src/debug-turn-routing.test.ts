import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalTurnDecider, createTurnRouteTransform } from "./debug-turn-routing.js";

afterEach(() => vi.unstubAllGlobals());

const args = {
  sessionKey: "test-session",
  message: "unchanged full prompt",
  systemPromptMode: "full" as const,
};
const message = { message: "[JEV_SYNTHETIC_BENCH] read the previous file", useMemory: false };
describe("debug business routing", () => {
  it("accepts only a local decision endpoint and does not follow redirects", async () => {
    for (const endpoint of [
      undefined,
      "invalid",
      "https://example.test/turn-decision",
      "http://localhost/turn-decision",
      "http://127.0.0.1/other",
      "http://user:pass@127.0.0.1/turn-decision",
      "http://127.0.0.1/turn-decision?secret=x",
    ]) {
      expect(createLocalTurnDecider(endpoint)).toBeUndefined();
    }
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ version: 1, route: "answer", confidence: 0.9 }))
      .mockResolvedValueOnce(new Response("private", { status: 500 }));
    vi.stubGlobal("fetch", fetcher);
    const decide = createLocalTurnDecider("http://127.0.0.1:1234/random/turn-decision")!;
    const state = { request: "synthetic", history: [], allowMemory: false };
    expect(await decide(state)).toMatchObject({ route: "answer" });
    expect(fetcher.mock.calls[0][1].redirect).toBe("error");
    expect(await decide(state)).toBeUndefined();
  });
  it("keeps system context local and preserves allowed read-only memory routing", async () => {
    const decide = vi.fn().mockResolvedValue({ version: 1, route: "memory", confidence: 0.95 });
    const transform = createTurnRouteTransform({
      message: { ...message, useMemory: true },
      history: async () => ({
        messages: [
          { role: "system", content: "private-system" },
          { role: "toolResult", content: "synthetic-result" },
        ],
      }),
      decide,
    });
    expect(await transform(args)).toMatchObject({ toolsAllow: ["memory_get", "memory_search"] });
    expect(JSON.stringify(decide.mock.calls)).not.toContain("private-system");
    expect(JSON.stringify(decide.mock.calls)).toContain("synthetic-result");
    const large = createTurnRouteTransform({
      message,
      history: async () => ({ messages: [{ role: "user", content: "x".repeat(21000) }] }),
      decide: vi.fn(),
    });
    expect(await large(args)).toBe(args);
  });
  it("routes once per user turn with history while retaining original model context", async () => {
    const history = vi
      .fn()
      .mockResolvedValue({ messages: [{ role: "user", content: "path=fixture.txt" }] });
    const decide = vi.fn().mockResolvedValue({ version: 1, route: "read", confidence: 0.95 });
    const transform = createTurnRouteTransform({ message, history, decide });
    const first = await transform(args);
    expect(first).toMatchObject({ ...args, toolsAllow: ["read"] });
    expect(await transform(args)).toEqual(first);
    expect(decide).toHaveBeenCalledOnce();
    expect(history).toHaveBeenCalledOnce();
    expect(decide.mock.calls[0][0].history).toEqual([
      { role: "user", content: "path=fixture.txt" },
    ]);
  });
  it("bypasses explicit templates, skills, attachments and non-synthetic messages", async () => {
    for (const extra of [
      { templateId: 1 },
      { skillIds: [1] },
      { builtinSkillName: "report" },
      { hasAttachment: true },
      { attachments: [{}] },
      { message: "ordinary chat" },
    ]) {
      const decide = vi.fn();
      const transform = createTurnRouteTransform({
        message: { ...message, ...extra },
        history: vi.fn(),
        decide,
      });
      expect(await transform(args)).toBe(args);
      expect(decide).not.toHaveBeenCalled();
    }
    const decide = vi.fn();
    const transform = createTurnRouteTransform({ message, history: vi.fn(), decide });
    const explicit = { ...args, skillFilter: ["deterministic-report"] };
    expect(await transform(explicit)).toBe(explicit);
    expect(decide).not.toHaveBeenCalled();
  });
  it("distinguishes confident no-tools from uncertainty and unsupported business routes", async () => {
    for (const route of [
      "uncertain",
      "report",
      "write",
      "query",
      "check",
      "think",
      "schedule",
      "unknown",
    ]) {
      const transform = createTurnRouteTransform({
        message,
        history: async () => ({ messages: [] }),
        decide: async () => ({ version: 1, route, confidence: 0.99 }),
      });
      expect(await transform(args)).toBe(args);
    }
    for (const route of ["answer", "clarify"]) {
      const transform = createTurnRouteTransform({
        message,
        history: async () => ({ messages: [] }),
        decide: async () => ({ version: 1, route, confidence: 0.99 }),
      });
      expect(await transform(args)).toMatchObject({ disableTools: true, message: args.message });
    }
  });
  it("preserves narrower policies, never turns an empty intersection into unrestricted tools", async () => {
    const transform = createTurnRouteTransform({
      message,
      history: async () => ({ messages: [] }),
      decide: async () => ({ version: 1, route: "search", confidence: 0.99 }),
    });
    expect(await transform({ ...args, toolsAllow: ["read"] })).toMatchObject({
      disableTools: true,
    });
    expect(await transform({ ...args, toolsAllow: ["web_fetch"] })).toMatchObject({
      toolsAllow: ["web_fetch"],
    });
    expect(await transform({ ...args, disableTools: true })).toMatchObject({ disableTools: true });
  });
  it("fails open on errors, excessive history, memory opt-out, and low confidence", async () => {
    const scenarios = [
      {
        history: async () => {
          throw new Error("private");
        },
        decide: vi.fn(),
      },
      {
        history: async () => ({ messages: Array(101).fill({ role: "user", content: "x" }) }),
        decide: vi.fn(),
      },
      {
        history: async () => ({ messages: [] }),
        decide: async () => {
          throw new Error("timeout");
        },
      },
      {
        history: async () => ({ messages: [] }),
        decide: async () => ({ version: 1, route: "read", confidence: 0.5 }),
      },
      {
        history: async () => ({ messages: [] }),
        decide: async () => ({ version: 1, route: "memory", confidence: 0.99 }),
      },
    ];
    for (const scenario of scenarios) {
      expect(await createTurnRouteTransform({ message, ...scenario })(args)).toBe(args);
    }
  });
});
