import { describe, expect, it, vi } from "vitest";
import { SessionBrowserHandoffs } from "./complaint-session-handoff.js";

const a = { agentId: "rabbitmq-33", sessionKey: "agent:rabbitmq-33:chat:a", sessionId: "a" };
const b = { agentId: "rabbitmq-2005", sessionKey: "agent:rabbitmq-2005:chat:b", sessionId: "b" };
const marker = "12345678-1234-1234-1234-123456789abc";
const result = { details: { targetId: "7", sessionHandoff: { version: 1, marker } } };
const params = { action: "snapshot", target: "host", targetId: "7" };
const make = () => new SessionBrowserHandoffs(async () => ({ profile: "user", binding: { version: 2, profileDir: "fixture" } }));

describe("conversation browser handoff", () => {
  it("hands off the observed page only to its original user and session incarnation", async () => {
    const registry = make();
    await registry.observe(a, params, result);
    await expect(registry.acquire(b)).rejects.toThrow();
    await expect(registry.acquire({ ...a, sessionId: "after-reset" })).rejects.toThrow();
    await expect(registry.before(b, params)).rejects.toThrow("另一个对话");
    const lease = await registry.acquire(a);
    expect(lease.handoff).toMatchObject({ version: 1, targetId: "7", marker });
    await expect(registry.before(a, params)).rejects.toThrow("完成前");
    lease.release(); lease.release();
    await expect(registry.acquire(a)).rejects.toThrow();
    await expect(registry.before(a, params)).resolves.toMatchObject({ target: "host" });
  });
  it("never accepts target arguments or old successful selections without a fresh marker", async () => {
    const registry = make();
    await registry.observe(a, params, result);
    await registry.observe(a, params, { details: { targetId: "7" } });
    await expect(registry.acquire(a)).rejects.toThrow();
    await registry.observe(a, params, result);
    await registry.observe(a, params, undefined, "closed");
    await expect(registry.acquire(a)).rejects.toThrow();
    await expect(registry.before(a, { ...params, target: "node" })).rejects.toThrow();
  });
  it("invalidates closed, expired, and rebound accounts", async () => {
    let binding = { version: 2, profileDir: "first" };
    const registry = new SessionBrowserHandoffs(async () => ({ profile: "user", binding }));
    await registry.observe(a, params, result);
    binding = { version: 2, profileDir: "second" };
    await expect(registry.acquire(a)).rejects.toThrow("变化");
    await registry.observe(a, params, result);
    await registry.observe(a, { ...params, action: "close" }, {});
    await expect(registry.acquire(a)).rejects.toThrow();
    await registry.observe(a, params, result);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600_001);
    try { await expect(registry.acquire(a)).rejects.toThrow(); } finally { now.mockRestore(); }
  });
});
