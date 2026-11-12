import { describe, expect, it, vi } from "vitest";
import { GroupAdminError } from "./admin.js";
import { createBridgeWorker, type PendingReport } from "./bridge.js";

describe("group management bridge", () => {
  function setup(initial: PendingReport | null = null) {
    let pending = initial;
    const job = {
      id: "a".repeat(32),
      lease: "b".repeat(32),
      input: { action: "delete", name: "Beta", version: "v1" },
    };
    const api = vi
      .fn()
      .mockImplementation(async (action: string) => (action === "claim" ? { job } : {}));
    const mutate = vi
      .fn()
      .mockResolvedValue({ groups: { Alpha: "a" }, version: "v2", status: "saved" });
    const journal = {
      read: async () => pending,
      write: async (value: PendingReport | null) => {
        pending = value;
      },
    };
    const worker = createBridgeWorker({
      api,
      journal,
      admin: { read: async () => ({ groups: { Alpha: "a", Beta: "b" }, version: "v1" }), mutate },
    });
    return { worker, api, mutate, journal, job };
  }
  it("executes claimed work and reports the local revision", async () => {
    const h = setup();
    await h.worker.tick();
    expect(h.mutate).toHaveBeenCalledOnce();
    expect(h.api).toHaveBeenLastCalledWith(
      "complete",
      expect.objectContaining({
        result: { ok: true, value: expect.objectContaining({ version: "v2" }) },
      }),
    );
    expect(await h.journal.read()).toBeNull();
  });
  it("retries delivery, never the mutation, after a report failure", async () => {
    const h = setup();
    h.api
      .mockImplementationOnce(async () => ({ job: h.job }))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({});
    await expect(h.worker.tick()).rejects.toThrow("offline");
    await h.worker.tick();
    expect(h.mutate).toHaveBeenCalledOnce();
    expect(await h.journal.read()).toBeNull();
  });
  it("reports unknown after a crash between the durable start and result", async () => {
    const h = setup({
      id: "a".repeat(32),
      lease: "b".repeat(32),
      result: null,
      chatId: "c".repeat(32),
    });
    await h.worker.tick();
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.api).toHaveBeenCalledWith(
      "complete",
      expect.objectContaining({
        result: expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: "EXECUTION_UNKNOWN", chatId: "c".repeat(32) }),
        }),
      }),
    );
  });
  it("does not execute when journaling fails", async () => {
    const h = setup();
    h.journal.write = async () => {
      throw new Error("disk full");
    };
    await expect(h.worker.tick()).rejects.toThrow("disk full");
    expect(h.mutate).not.toHaveBeenCalled();
  });
  it("ignores overlapping polls and rejects malformed jobs", async () => {
    const h = setup();
    await Promise.all([h.worker.tick(), h.worker.tick()]);
    expect(h.mutate).toHaveBeenCalledOnce();
    h.api.mockResolvedValue({ job: { id: "../bad" } });
    await expect(h.worker.tick()).rejects.toThrow();
    expect(h.mutate).toHaveBeenCalledOnce();
  });
  it.each([true, false])(
    "reports known and uncertain execution failures without repeating them (%s)",
    async (known) => {
      const h = setup();
      h.mutate.mockRejectedValue(
        known ? new GroupAdminError(409, "CONFLICT", "Refresh first") : new Error("private error"),
      );
      await h.worker.tick();
      expect(h.api).toHaveBeenLastCalledWith(
        "complete",
        expect.objectContaining({
          result: {
            ok: false,
            error: expect.objectContaining({ code: known ? "CONFLICT" : "EXECUTION_UNKNOWN" }),
          },
        }),
      );
      expect(JSON.stringify(h.api.mock.calls)).not.toContain("private error");
    },
  );
  it("journals the requested chat ID before attempting group creation", async () => {
    const h = setup();
    const input = {
      action: "create",
      name: "Example",
      version: "v1",
      owner: "one",
      userlist: ["one", "two"],
      requestId: "c".repeat(32),
    };
    h.api.mockResolvedValueOnce({ job: { ...h.job, input } });
    h.mutate.mockImplementation(async () => {
      expect(await h.journal.read()).toEqual(
        expect.objectContaining({ result: null, chatId: input.requestId }),
      );
      throw new GroupAdminError(502, "CREATE_UNKNOWN", "Verify first", input.requestId);
    });
    await h.worker.tick();
    expect(h.api).toHaveBeenLastCalledWith(
      "complete",
      expect.objectContaining({
        result: { ok: false, error: expect.objectContaining({ chatId: input.requestId }) },
      }),
    );
  });
});
