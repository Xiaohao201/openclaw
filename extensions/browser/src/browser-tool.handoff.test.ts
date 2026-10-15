import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./core-api.js";
import { withSessionBrowserHandoff } from "./browser-tool.handoff.js";

describe("browser session handoff identity", () => {
  it("marks the actual target and preserves the original tool result", async () => {
    const mark = vi.fn().mockResolvedValue({ ok: true });
    const tool = { execute: vi.fn().mockResolvedValue({ content: [], details: { targetId: "7", url: "https://example.org" } }) } as unknown as AnyAgentTool;
    const result = await withSessionBrowserHandoff(tool, true, mark).execute("id", { action: "open", target: "host", profile: "user" });
    expect(mark).toHaveBeenCalledWith("user", "7", expect.stringContaining("__openclaw_session_handoff_v1"));
    expect(result.details).toMatchObject({ targetId: "7", sessionHandoff: { version: 1, marker: expect.any(String) } });
  });
  it("does not mark remote tools or advertise a handoff after a failed evaluation", async () => {
    const mark = vi.fn().mockRejectedValue(new Error("evaluation disabled"));
    const tool = { execute: vi.fn().mockResolvedValue({ content: [], details: { targetId: "7" } }) } as unknown as AnyAgentTool;
    const wrapped = withSessionBrowserHandoff(tool, true, mark);
    await wrapped.execute("id", { action: "snapshot", target: "node" });
    expect(mark).not.toHaveBeenCalled();
    expect((await wrapped.execute("id", { action: "snapshot", target: "host" })).details).toMatchObject({ sessionHandoff: null });
  });
});
