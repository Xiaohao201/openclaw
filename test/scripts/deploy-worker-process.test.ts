import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ProcessWorker } from "../../scripts/deploy-worker-process.js";

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", () => ({ fork }));

function fixture(pid: number | null = 1234) {
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    pid: pid ?? undefined,
    send: vi.fn(
      (_message: { command: string; id: number }, callback: (error: Error | null) => void) =>
        callback(null),
    ),
    kill: vi.fn(() => {
      emitter.emit("exit", 0, null);
      return true;
    }),
  });
  fork.mockReturnValue(child);
  const persist = vi.fn(async () => {});
  const exited = vi.fn();
  const worker = new ProcessWorker(
    19001,
    "release",
    {
      stateDir: "state",
      configPath: "config",
      startupTimeoutMs: 30,
      recovery: { retireTimeoutMs: 30 },
    },
    persist,
    exited,
  );
  return { child, worker, persist, exited };
}

describe("worker ownership and IPC failures", () => {
  it("does not activate when ownership cannot be persisted and only kills unactivated workers", async () => {
    const f = fixture();
    f.child.emit("message", { nonsense: true });
    f.child.emit("message", { ready: true });
    await f.worker.prepared(30);
    f.persist.mockRejectedValue(new Error("disk unavailable"));
    await expect(f.worker.activate()).rejects.toThrow("disk unavailable");
    expect(f.child.send).not.toHaveBeenCalled();
    await f.worker.discard();
    expect(f.child.kill).toHaveBeenCalledOnce();
  });

  it("blocks retirement on negative acknowledgement without force-killing an activated worker", async () => {
    const f = fixture();
    f.child.emit("message", { ready: true });
    f.child.send.mockImplementation((message, callback) => {
      callback(null);
      f.child.emit("message", { id: message.id, ok: message.command === "activate" });
    });
    await f.worker.activate();
    await expect(f.worker.discard()).rejects.toThrow("Worker command failed");
    expect(f.child.kill).not.toHaveBeenCalled();
    f.child.emit("exit", 1, null);
    await f.worker.retire();
    await expect(f.worker.activate()).rejects.toThrow("already exited");
  });

  it("bounds startup and retirement waits without granting another execution owner", async () => {
    const f = fixture();
    await expect(f.worker.prepared(5)).rejects.toThrow("timed out");
    f.child.emit("message", { ready: true });
    f.child.send.mockImplementation((message, callback) => {
      callback(null);
      if (message.command === "activate") {
        f.child.emit("message", { id: message.id, ok: true });
      }
    });
    await f.worker.activate();
    await expect(f.worker.retire()).rejects.toThrow("timed out");
    expect(f.child.kill).not.toHaveBeenCalled();
    f.child.emit("exit", 1, null);
    expect(f.worker.isExited).toBe(true);
    expect(f.exited).toHaveBeenCalledWith(f.worker, 1, null);
  });

  it("handles spawn errors before a PID exists and IPC send errors", async () => {
    const f = fixture(null);
    const prepared = f.worker.prepared(30);
    f.child.emit("error", new Error("spawn failed"));
    await expect(prepared).rejects.toThrow("spawn failed");
    expect(f.worker.isExited).toBe(true);
    const next = fixture();
    next.child.emit("message", { ready: true });
    next.child.send.mockImplementation((_message, callback) =>
      callback(new Error("IPC unavailable")),
    );
    await expect(next.worker.activate()).rejects.toThrow("IPC unavailable");
    next.child.emit("exit", 1, null);
  });
});
