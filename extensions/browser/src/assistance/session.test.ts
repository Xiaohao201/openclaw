import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../core-api.js";
import {
  registerBrowserAssistanceSession,
  resolveAssistanceBinding,
  withBrowserAssistance,
} from "./session.js";
import type { BrowserAssistanceControl } from "./types.js";

const mocks = vi.hoisted(() => ({
  reason: vi.fn(),
  dispose: vi.fn(),
  frames: vi.fn(),
  input: vi.fn(),
  locked: [] as Array<() => boolean>,
}));
vi.mock("./managed.runtime.js", () => ({
  createManagedAssistanceBrowser: async (locked: () => boolean) => {
    mocks.locked.push(locked);
    return {
      baseUrl: `http://127.0.0.1:${20000 + mocks.locked.length}`,
      profile: `isolated-${mocks.locked.length}`,
      cdpUrl: "http://127.0.0.1:20000",
      dispose: mocks.dispose,
    };
  },
}));
vi.mock("./page.runtime.js", () => ({
  AssistancePage: {
    connect: async () => ({
      page: { url: () => "https://example.com/login?private=value", on: vi.fn(), off: vi.fn() },
      reason: mocks.reason,
      startFrames: mocks.frames,
      stopFrames: async () => {},
      input: mocks.input,
    }),
  },
}));

describe("session browser handoff", () => {
  const cleanup: Array<() => Promise<void>> = [];
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.locked.length = 0;
    mocks.reason.mockResolvedValue("challenge");
  });
  afterEach(async () => {
    for (const dispose of cleanup.splice(0)) {
      await dispose();
    }
  });
  function tool() {
    const execute = vi.fn(async (_id: string, _params: unknown) => ({
      content: [{ type: "text" as const, text: "page" }],
      details: { targetId: "tab-1" },
    }));
    return {
      execute,
      tool: {
        name: "browser",
        label: "Browser",
        description: "test",
        parameters: Type.Object({}),
        execute,
      } as AnyAgentTool,
    };
  }

  it("keeps the original tab, locks automation, and returns fresh evidence without replaying a mutation", async () => {
    let control: BrowserAssistanceControl | undefined;
    const notices: string[] = [];
    cleanup.push(
      registerBrowserAssistanceSession({
        sessionKey: "one",
        onRequest: async (value) => {
          control = value;
        },
        onState: async (notice) => {
          notices.push(notice.status);
        },
      }),
    );
    const original = tool();
    const running = withBrowserAssistance(original.tool, "one").execute("call", {
      action: "act",
      request: { kind: "click" },
    });
    await vi.waitFor(() => expect(control).toBeDefined());
    expect(mocks.locked[0]()).toBe(true);
    expect(control?.notice.origin).toBe("https://example.com");
    mocks.reason.mockResolvedValue(null);
    await control!.complete();
    await running;
    expect(mocks.locked[0]()).toBe(false);
    expect(
      original.execute.mock.calls.map((call) => (call[1] as { action: string }).action),
    ).toEqual(["act", "snapshot"]);
    expect(original.execute.mock.calls[1][1]).toMatchObject({
      targetId: "tab-1",
      profile: "isolated-1",
    });
    expect(notices).toContain("resumed");
  });

  it("isolates two sessions and rejects unsupported targets before browser execution", async () => {
    for (const sessionKey of ["one", "two"]) {
      cleanup.push(
        registerBrowserAssistanceSession({
          sessionKey,
          onRequest: async () => {},
          onState: async () => {},
        }),
      );
    }
    expect((await resolveAssistanceBinding("one"))?.profile).not.toBe(
      (await resolveAssistanceBinding("two"))?.profile,
    );
    const original = tool();
    await expect(
      withBrowserAssistance(original.tool, "one").execute("call", {
        action: "open",
        target: "node",
      }),
    ).rejects.toThrow("isolated");
    expect(original.execute).not.toHaveBeenCalled();
  });

  it.each([
    { reason: "login", action: "snapshot", trigger: "automatic" },
    { reason: "challenge", action: "navigate", trigger: "automatic" },
    { reason: "manual", action: "handoff", trigger: "manual" },
  ] as const)(
    "reports completed $reason assistance in model-visible output without rewriting the page result",
    async ({ reason, action, trigger }) => {
      let control: BrowserAssistanceControl | undefined;
      mocks.reason.mockResolvedValue(reason === "manual" ? null : reason);
      cleanup.push(
        registerBrowserAssistanceSession({
          sessionKey: "feedback",
          onRequest: async (value) => {
            control = value;
          },
          onState: async () => {},
        }),
      );
      const original = tool();
      const snapshot = {
        content: [{ type: "text" as const, text: "Public repository; signed-in user menu" }],
        details: { targetId: "tab-1", url: "https://example.com/repository" },
      };
      const unchangedSnapshot = structuredClone(snapshot);
      original.execute.mockResolvedValueOnce({
        content: [{ type: "text", text: "Initial page" }],
        details: { targetId: "tab-1" },
      });
      original.execute.mockResolvedValue(snapshot);
      const wrapped = withBrowserAssistance(original.tool, "feedback");
      const running = wrapped.execute("call", { action, targetId: "tab-1" });
      await vi.waitFor(() => expect(control).toBeDefined());
      mocks.reason.mockResolvedValue(null);
      expect(await control!.complete()).toBe(true);
      const result = await running;
      const assistance = {
        version: 1,
        requestId: control!.notice.requestId,
        status: "resumed",
        reason,
        trigger,
        humanAssisted: true,
        originalAction: action,
        snapshotPhase: "after-human-assistance",
      };
      expect(result.details).toEqual({ ...snapshot.details, browserAssistance: assistance });
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining(JSON.stringify({ browserAssistance: assistance })),
      });
      expect(result.content.slice(1)).toEqual(snapshot.content);
      expect(snapshot).toEqual(unchangedSnapshot);
      expect(JSON.stringify(result.content[0])).not.toContain("private=value");
      // A later tool call must not inherit or rewrite the prior handoff annotation.
      expect(await wrapped.execute("next-call", { action: "snapshot", targetId: "tab-1" })).toBe(
        snapshot,
      );
    },
  );

  it("does not invent human assistance for status calls or failures without a known tab", async () => {
    const onRequest = vi.fn();
    cleanup.push(
      registerBrowserAssistanceSession({
        sessionKey: "unassisted",
        onRequest,
        onState: async () => {},
      }),
    );
    const original = tool();
    const result = {
      content: [{ type: "text" as const, text: "Browser is ready" }],
      details: { targetId: "tab-1" },
    };
    original.execute.mockResolvedValueOnce(result);
    const wrapped = withBrowserAssistance(original.tool, "unassisted");
    expect(await wrapped.execute("status", { action: "status" })).toBe(result);
    const failure = new Error("Browser could not open a page");
    original.execute.mockRejectedValueOnce(failure);
    await expect(wrapped.execute("open", { action: "open" })).rejects.toBe(failure);
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("offers assistance after a navigation timeout when the known tab contains a challenge", async () => {
    let control: BrowserAssistanceControl | undefined;
    cleanup.push(
      registerBrowserAssistanceSession({
        sessionKey: "timeout",
        onRequest: async (value) => {
          control = value;
        },
        onState: async () => {},
      }),
    );
    const original = tool();
    original.execute.mockRejectedValueOnce(new Error("navigation timeout"));
    const running = withBrowserAssistance(original.tool, "timeout").execute("call", {
      action: "navigate",
      targetId: "tab-1",
    });
    await vi.waitFor(() => expect(control).toBeDefined());
    mocks.reason.mockResolvedValue(null);
    await control!.complete();
    await running;
    expect(original.execute).toHaveBeenCalledTimes(2);
    expect(original.execute.mock.calls[1][1]).toMatchObject({
      action: "snapshot",
      targetId: "tab-1",
    });
  });

  it("aborts the pending tool and ignores subsequent completion", async () => {
    let control: BrowserAssistanceControl | undefined;
    const abort = new AbortController();
    cleanup.push(
      registerBrowserAssistanceSession({
        sessionKey: "one",
        signal: abort.signal,
        onRequest: async (value) => {
          control = value;
        },
        onState: async () => {},
      }),
    );
    const running = withBrowserAssistance(tool().tool, "one").execute("call", { action: "open" });
    const outcome = expect(running).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(control).toBeDefined());
    abort.abort();
    await outcome;
    expect(await control!.complete()).toBe(false);
    await expect(control!.input({ type: "text", text: "secret" })).rejects.toThrow();
    expect(mocks.input).not.toHaveBeenCalled();
  });

  it("leaves unconfigured sessions unchanged and reports manual handoff unavailable", async () => {
    const original = tool();
    const wrapped = withBrowserAssistance(original.tool, "none");
    await wrapped.execute("call", { action: "open" });
    expect(original.execute.mock.calls[0][1]).toEqual({ action: "open" });
    await expect(wrapped.execute("call", { action: "handoff" })).rejects.toThrow("not configured");
  });
});
