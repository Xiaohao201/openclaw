import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginService } from "openclaw/plugin-sdk/service-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";

const listDevicePairingMock = vi.hoisted(() => vi.fn(async () => ({ pending: [] })));

vi.mock("./api.js", () => ({
  listDevicePairing: listDevicePairingMock,
}));

import { handleNotifyCommand, registerPairingNotifierService } from "./notify.js";

describe("device-pair notify persistence", () => {
  let stateDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    listDevicePairingMock.mockResolvedValue({ pending: [] });
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-pair-notify-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("keeps managed startup silent and waits for a pending poll before pausing", async () => {
    const registered: OpenClawPluginService[] = [];
    const api = createTestPluginApi({
      registerService: (service) => {
        registered.push(service);
      },
    });
    registerPairingNotifierService(api);
    const service = registered[0];
    const ctx = {
      config: {},
      stateDir,
      logger: console,
      lifecycleMode: "externally-managed" as const,
    };
    await service.start(ctx);
    expect(listDevicePairingMock).not.toHaveBeenCalled();
    expect(service.handoff!.isReady(ctx)).toBe(true);
    const pending = createDeferred<{ pending: [] }>();
    listDevicePairingMock.mockReturnValueOnce(pending.promise);
    await service.handoff!.resume(ctx);
    await vi.waitFor(() => expect(listDevicePairingMock).toHaveBeenCalledOnce());
    await expect(service.handoff!.pause(ctx, 5)).rejects.toThrow("active");
    pending.resolve({ pending: [] });
    await service.handoff!.pause(ctx, 1000);
    await service.stop!(ctx);
  });

  it("serializes concurrent subscriber updates without losing either chat", async () => {
    const api = createTestPluginApi({
      runtime: { state: { resolveStateDir: () => stateDir } } as never,
    });
    await Promise.all(
      ["chat-a", "chat-b"].map((senderId) =>
        handleNotifyCommand({ api, ctx: { channel: "telegram", senderId }, action: "on" }),
      ),
    );
    const state = JSON.parse(
      await fs.readFile(path.join(stateDir, "device-pair-notify.json"), "utf8"),
    ) as { subscribers: { to: string }[] };
    expect(state.subscribers.map((entry) => entry.to).toSorted()).toEqual(["chat-a", "chat-b"]);
  });

  it("waits for sending and persistence, then resumes without duplicate notifications", async () => {
    const registered: OpenClawPluginService[] = [];
    const sent = createDeferred<void>();
    const send = vi.fn(() => sent.promise);
    const api = createTestPluginApi({
      registerService: (service) => {
        registered.push(service);
      },
      runtime: {
        state: { resolveStateDir: () => stateDir },
        channel: { outbound: { loadAdapter: async () => ({ sendText: send }) } },
      } as never,
    });
    await handleNotifyCommand({
      api,
      ctx: { channel: "telegram", senderId: "chat-test" },
      action: "on",
    });
    listDevicePairingMock.mockResolvedValue({
      pending: [{ requestId: "request-test", deviceId: "test-device", ts: Date.now() }],
    } as never);
    registerPairingNotifierService(api);
    const service = registered[0];
    const ctx = {
      config: {},
      stateDir,
      logger: console,
      lifecycleMode: "externally-managed" as const,
    };
    await service.start(ctx);
    await service.handoff!.resume(ctx);
    await service.handoff!.resume(ctx);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await expect(service.handoff!.pause(ctx, 5)).rejects.toThrow("active");
    const update = handleNotifyCommand({
      api,
      ctx: { channel: "telegram", senderId: "second-chat" },
      action: "on",
    });
    sent.resolve(undefined);
    await service.handoff!.pause(ctx, 1000);
    await update;
    const persisted = JSON.parse(
      await fs.readFile(path.join(stateDir, "device-pair-notify.json"), "utf8"),
    ) as { notifiedRequestIds: Record<string, number>; subscribers: unknown[] };
    expect(persisted.notifiedRequestIds["request-test"]).toBeGreaterThan(0);
    expect(persisted.subscribers).toHaveLength(2);
    await service.handoff!.resume(ctx);
    await vi.waitFor(() => expect(listDevicePairingMock).toHaveBeenCalledTimes(2));
    await service.handoff!.pause(ctx, 1000);
    expect(send).toHaveBeenCalledOnce();
    await service.stop!(ctx);
  });

  it("does not report readiness when persisted notification state is unreadable", async () => {
    await fs.writeFile(path.join(stateDir, "device-pair-notify.json"), "{broken json");
    const registered: OpenClawPluginService[] = [];
    const api = createTestPluginApi({
      registerService: (service) => {
        registered.push(service);
      },
    });
    registerPairingNotifierService(api);
    const ctx = {
      config: {},
      stateDir,
      logger: console,
      lifecycleMode: "externally-managed" as const,
    };
    await expect(registered[0].start(ctx)).rejects.toThrow();
    expect(registered[0].handoff!.isReady(ctx)).toBe(false);
    await registered[0].stop!(ctx);
  });

  it("matches persisted telegram thread ids across number and string roundtrips", async () => {
    await fs.writeFile(
      path.join(stateDir, "device-pair-notify.json"),
      JSON.stringify(
        {
          subscribers: [
            {
              to: "chat-123",
              accountId: "telegram-default",
              messageThreadId: 271,
              mode: "persistent",
              addedAtMs: 1,
            },
          ],
          notifiedRequestIds: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    const api = createTestPluginApi({
      runtime: {
        state: {
          resolveStateDir: () => stateDir,
        },
      } as never,
    });

    const status = await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat-123",
        accountId: "telegram-default",
        messageThreadId: "271",
      },
      action: "status",
    });

    expect(status.text).toContain("Pair request notifications: enabled for this chat.");
    expect(status.text).toContain("Mode: persistent");

    await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat-123",
        accountId: "telegram-default",
        messageThreadId: "271",
      },
      action: "off",
    });

    const persisted = JSON.parse(
      await fs.readFile(path.join(stateDir, "device-pair-notify.json"), "utf8"),
    ) as { subscribers: unknown[] };
    expect(persisted.subscribers).toEqual([]);
  });

  it("does not remove a different persisted subscriber when notify fields contain pipes", async () => {
    await fs.writeFile(
      path.join(stateDir, "device-pair-notify.json"),
      JSON.stringify(
        {
          subscribers: [
            {
              to: "chat|123",
              accountId: "acct",
              mode: "persistent",
              addedAtMs: 1,
            },
            {
              to: "chat",
              accountId: "123|acct",
              mode: "persistent",
              addedAtMs: 2,
            },
          ],
          notifiedRequestIds: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    const api = createTestPluginApi({
      runtime: {
        state: {
          resolveStateDir: () => stateDir,
        },
      } as never,
    });

    await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat",
        accountId: "123|acct",
      },
      action: "off",
    });

    const status = await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat",
        accountId: "123|acct",
      },
      action: "status",
    });
    expect(status.text).toContain("Pair request notifications: disabled for this chat.");

    const persisted = JSON.parse(
      await fs.readFile(path.join(stateDir, "device-pair-notify.json"), "utf8"),
    ) as { subscribers: Array<{ to: string; accountId?: string }> };
    expect(persisted.subscribers).toHaveLength(1);
    expect(persisted.subscribers[0]).toMatchObject({
      to: "chat|123",
      accountId: "acct",
    });
  });
});
