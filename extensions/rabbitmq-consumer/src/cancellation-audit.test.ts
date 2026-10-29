import type amqplib from "amqplib";
import { describe, expect, it, vi } from "vitest";
import { createMessageConsumer } from "./message-consumer.js";

// Regression probes from production disconnect/redelivery and cancellation audits.
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const envelope = (cancel = false): amqplib.ConsumeMessage =>
  ({
    content: Buffer.from(
      JSON.stringify({
        ...(cancel ? { type: "cancel" } : { message: "audit" }),
        id: 17,
        user_id: "audit-user",
        session_id: "audit-session",
      }),
    ),
  }) as amqplib.ConsumeMessage;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("cancellation delivery", () => {
  it("keeps cancellation attached to the original across redelivery", async () => {
    const started = gate();
    const release = gate();
    const signals: AbortSignal[] = [];
    const consumer = createMessageConsumer({
      logger,
      runWarmup: async () => {},
      runChat: async (_message, signal) => {
        signals.push(signal);
        started.resolve();
        await release.promise;
      },
    });
    const original = consumer(envelope());
    await started.promise;
    const redelivery = consumer(envelope());
    try {
      await consumer(envelope(true));
      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(true);
    } finally {
      release.resolve();
      await Promise.all([original, redelivery]);
    }
    expect(signals).toHaveLength(1);
  });

  it("recovers a control delivered to another instance through durable intent", async () => {
    const started = gate();
    const release = gate();
    let activeSignal: AbortSignal | undefined;
    let persisted = false;
    const owner = createMessageConsumer({
      logger,
      isCancellationRequested: async () => persisted,
      cancellationPollMs: 10,
      runWarmup: async () => {},
      runChat: async (_message, signal) => {
        activeSignal = signal;
        started.resolve();
        await release.promise;
      },
    });
    const other = createMessageConsumer({ logger, runWarmup: async () => {}, runChat: vi.fn() });
    const running = owner(envelope());
    try {
      await started.promise;
      persisted = true;
      // This resolved handler causes RabbitMqClient to ACK the control.
      await expect(other(envelope(true))).resolves.toBeUndefined();
      await vi.waitFor(() => expect(activeSignal?.aborted).toBe(true));
      // Positive control: identical payload works when routed to its owner.
      await owner(envelope(true));
      expect(activeSignal?.aborted).toBe(true);
    } finally {
      release.resolve();
      await running;
    }
  });

  it("restores cancellation from persistent intent after consumer recreation", async () => {
    const beforeRestart = createMessageConsumer({
      logger,
      runWarmup: async () => {},
      runChat: vi.fn(),
    });
    await beforeRestart(envelope(true));
    let aborted: boolean | undefined;
    const afterRestart = createMessageConsumer({
      logger,
      isCancellationRequested: async () => true,
      runWarmup: async () => {},
      runChat: async (_message, signal) => {
        aborted = signal.aborted;
      },
    });
    await afterRestart(envelope());
    expect(aborted).toBe(true);
  });
});
