import type amqplib from "amqplib";
import { describe, expect, it, vi } from "vitest";
import { createMessageConsumer, type MessageConsumerDeps } from "./message-consumer.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function msgOf(payload: unknown): amqplib.ConsumeMessage {
  return { content: Buffer.from(JSON.stringify(payload)) } as amqplib.ConsumeMessage;
}

function chatPayload(historyId: number, userId: string) {
  return { id: historyId, message: `msg-${historyId}`, user_id: userId, session_id: "s1" };
}

function makeGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeDeps(overrides?: Partial<MessageConsumerDeps>): MessageConsumerDeps {
  return {
    logger: logger as never,
    runWarmup: vi.fn().mockResolvedValue(undefined),
    runChat: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("createMessageConsumer", () => {
  it("serializes same-user chat messages in delivery order", async () => {
    const gate1 = makeGate();
    const started: number[] = [];
    const runChat = vi.fn(async (chatMsg: { historyId: number }) => {
      started.push(chatMsg.historyId);
      if (chatMsg.historyId === 1) {
        await gate1.promise;
      }
    });
    const handler = createMessageConsumer(makeDeps({ runChat: runChat as never }));

    const p1 = handler(msgOf(chatPayload(1, "1749")));
    const p2 = handler(msgOf(chatPayload(2, "1749")));

    await tick();
    // Message 2 must wait for message 1's full turn.
    expect(started).toEqual([1]);

    gate1.resolve();
    await Promise.all([p1, p2]);
    expect(started).toEqual([1, 2]);
  });

  it("runs different users' messages concurrently", async () => {
    const gate1 = makeGate();
    const started: number[] = [];
    const runChat = vi.fn(async (chatMsg: { historyId: number }) => {
      started.push(chatMsg.historyId);
      if (chatMsg.historyId === 1) {
        await gate1.promise;
      }
    });
    const handler = createMessageConsumer(makeDeps({ runChat: runChat as never }));

    const p1 = handler(msgOf(chatPayload(1, "1749")));
    const p2 = handler(msgOf(chatPayload(2, "2005")));

    await tick();
    // User 2005 starts (and finishes) while user 1749 is still mid-turn.
    expect(started).toEqual([1, 2]);
    await p2;

    gate1.resolve();
    await p1;
  });

  it("serializes a warmup with the same user's next chat message", async () => {
    const warmupGate = makeGate();
    const order: string[] = [];
    const runWarmup = vi.fn(async (userId: string) => {
      order.push(`warmup:${userId}`);
      await warmupGate.promise;
    });
    const runChat = vi.fn(async (chatMsg: { historyId: number }) => {
      order.push(`chat:${chatMsg.historyId}`);
    });
    const handler = createMessageConsumer(
      makeDeps({ runWarmup: runWarmup as never, runChat: runChat as never }),
    );

    const p1 = handler(msgOf({ type: "warmup", user_id: "1749" }));
    const p2 = handler(msgOf(chatPayload(1, "1749")));

    await tick();
    expect(order).toEqual(["warmup:1749"]);

    warmupGate.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["warmup:1749", "chat:1"]);
  });

  it("resolves unparseable messages without entering any chain", async () => {
    const deps = makeDeps();
    const handler = createMessageConsumer(deps);

    await expect(
      handler({ content: Buffer.from("not json") } as amqplib.ConsumeMessage),
    ).resolves.toBeUndefined();
    expect(deps.runChat).not.toHaveBeenCalled();
    expect(deps.runWarmup).not.toHaveBeenCalled();
  });

  it("propagates a chat failure so the caller can nack", async () => {
    const runChat = vi.fn().mockRejectedValue(new Error("pipeline down"));
    const handler = createMessageConsumer(makeDeps({ runChat }));

    await expect(handler(msgOf(chatPayload(1, "1749")))).rejects.toThrow("pipeline down");

    // A failed turn does not wedge the user's chain: the next message runs.
    runChat.mockResolvedValue(undefined);
    await expect(handler(msgOf(chatPayload(2, "1749")))).resolves.toBeUndefined();
    expect(runChat).toHaveBeenCalledTimes(2);
  });
});
