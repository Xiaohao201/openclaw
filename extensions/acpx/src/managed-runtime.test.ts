import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { AcpRuntime } from "../runtime-api.js";
import { createManagedAcpRuntime } from "./managed-runtime.js";

const handle = { sessionKey: "test", backend: "acpx", runtimeSessionName: "test" };
function makeRuntime(): AcpRuntime {
  return {
    ensureSession: async () => handle,
    async *runTurn() {
      yield { type: "done" };
    },
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    getCapabilities: () => ({ controls: [] }),
    getStatus: async () => ({ summary: "ready" }),
    setMode: vi.fn(async () => {}),
    setConfigOption: vi.fn(async () => {}),
    prepareFreshSession: vi.fn(async () => {}),
    doctor: async () => ({ ok: true, message: "ok" }),
  };
}
describe("managed ACP operations", () => {
  it("tracks all optional control methods and denies new work after pause", async () => {
    const source = makeRuntime();
    const managed = createManagedAcpRuntime(source);
    managed.work.resume();
    const runtime = managed.runtime;
    await runtime.ensureSession({ sessionKey: "test", agent: "test", mode: "oneshot" });
    expect(await runtime.getCapabilities!({ handle })).toEqual({ controls: [] });
    expect(await runtime.getStatus!({ handle })).toEqual({ summary: "ready" });
    await runtime.setMode!({ handle, mode: "test" });
    await runtime.setConfigOption!({ handle, key: "test", value: "test" });
    await runtime.prepareFreshSession!({ sessionKey: "test" });
    expect(await runtime.doctor!()).toEqual({ ok: true, message: "ok" });
    await runtime.cancel({ handle });
    await runtime.close({ handle, reason: "test" });
    await managed.pause(100);
    await expect(
      runtime.ensureSession({ sessionKey: "test", agent: "test", mode: "oneshot" }),
    ).rejects.toThrow("not accepting");
    expect(managed.work.activeCount()).toBe(0);
  });

  it("refuses to orphan a prepared persistent client when the dependency cannot dispose it", async () => {
    const source = makeRuntime();
    const managed = createManagedAcpRuntime(source);
    managed.work.resume();
    await managed.runtime.ensureSession({ sessionKey: "test", agent: "test", mode: "persistent" });
    await expect(managed.pause(100)).rejects.toThrow("safe disposal is unavailable");
    expect(source.close).not.toHaveBeenCalled();
    expect(source.cancel).not.toHaveBeenCalled();
    managed.work.resume();
    for await (const _event of managed.runtime.runTurn({
      handle,
      text: "test",
      mode: "prompt",
      requestId: "test",
    })) {
      /* drain */
    }
    await managed.pause(100);
  });

  it("keeps a lease until the producer finishes even if the consumer returns early", async () => {
    const finished = createDeferred<void>();
    const source = makeRuntime();
    source.runTurn = async function* () {
      yield { type: "text_delta", text: "start" };
      await finished.promise;
      yield { type: "done" };
    };
    const managed = createManagedAcpRuntime(source);
    managed.work.resume();
    const stream = managed.runtime.runTurn({
      handle,
      text: "test",
      mode: "prompt",
      requestId: "test",
    });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    const returned = iterator.return!();
    await expect(managed.pause(5)).rejects.toThrow("active");
    finished.resolve(undefined);
    await returned;
    await managed.pause(100);
  });

  it("does not manufacture optional capabilities", () => {
    const managed = createManagedAcpRuntime({
      ensureSession: async () => handle,
      async *runTurn() {},
      cancel: async () => {},
      close: async () => {},
    });
    expect(managed.runtime.getStatus).toBeUndefined();
    expect(managed.runtime.doctor).toBeUndefined();
  });
  it("releases a prepared session only after an explicit destructive close succeeds", async () => {
    const managed = createManagedAcpRuntime(makeRuntime());
    managed.work.resume();
    await managed.runtime.ensureSession({ sessionKey: "test", agent: "test", mode: "persistent" });
    await managed.runtime.close({ handle, reason: "user reset", discardPersistentState: true });
    await managed.pause(100);
  });
});
