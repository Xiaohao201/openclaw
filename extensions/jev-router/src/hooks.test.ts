import { describe, expect, it, vi } from "vitest";
import { createPromptHook } from "./hooks.runtime.js";
import { parseConfig } from "./router.js";

describe("JEV prompt hook", () => {
  it("records metadata without changing prompts, history or tool availability in shadow mode", async () => {
    const decide = vi.fn().mockResolvedValue({
      status: "selected",
      candidates: ["read"],
      confidence: 0.95,
      elapsedMs: 10,
    });
    const log = vi.fn();
    const hook = createPromptHook(parseConfig({ candidates: ["read"] }), { decide }, log);
    const event = {
      prompt: "private path request",
      messages: [{ role: "user", content: "old secret" }],
    };
    const before = JSON.stringify(event);
    expect(await hook(event)).toBeUndefined();
    expect(JSON.stringify(event)).toBe(before);
    expect(decide).toHaveBeenCalledWith("private path request");
    expect(log.mock.calls.join(" ")).not.toMatch(/private|old secret/);
  });
  it("adds a current-turn advisory only for selected candidates", async () => {
    const decide = vi
      .fn()
      .mockResolvedValueOnce({
        status: "selected",
        candidates: ["read"],
        confidence: 0.95,
        elapsedMs: 10,
      })
      .mockResolvedValueOnce({
        status: "no_tools",
        candidates: [],
        confidence: 0.95,
        elapsedMs: 10,
      })
      .mockResolvedValueOnce({
        status: "abstain",
        candidates: ["read"],
        reason: "timeout",
        elapsedMs: 10,
      });
    const hook = createPromptHook(
      parseConfig({ mode: "advisory", candidates: ["read"] }),
      { decide },
      vi.fn(),
    );
    expect(await hook({ prompt: "read it" })).toEqual({
      prependContext: expect.stringContaining("read"),
    });
    expect(await hook({ prompt: "hello" })).toBeUndefined();
    expect(await hook({ prompt: "ambiguous" })).toBeUndefined();
  });
});
