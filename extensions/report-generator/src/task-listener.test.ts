import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockConnect } = vi.hoisted(() => ({ mockConnect: vi.fn() }));
vi.mock("amqplib", () => ({ default: { connect: mockConnect } }));

const { TaskListener } = await import("./task-listener.js");
import type { RabbitMqListenerConfig } from "./types.js";

/** Minimal amqplib channel double — enough for connect() to wire up. */
class FakeChannel extends EventEmitter {
  assertQueue = vi.fn().mockResolvedValue(undefined);
  prefetch = vi.fn().mockResolvedValue(undefined);
  consume = vi.fn().mockResolvedValue({ consumerTag: "report-consumer" });
  cancel = vi.fn().mockResolvedValue(undefined);
  ack = vi.fn();
  nack = vi.fn();
  close = vi.fn().mockImplementation(async () => {
    this.emit("close");
  });
}

/** Minimal amqplib connection double. */
class FakeConnection extends EventEmitter {
  channel = new FakeChannel();
  createChannel = vi.fn().mockImplementation(async () => this.channel);
  close = vi.fn().mockImplementation(async () => {
    this.emit("close");
  });
}

const config: RabbitMqListenerConfig = {
  host: "localhost",
  port: 5672,
  user: "guest",
  password: "guest",
  queue: "report_tasks",
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.clearAllMocks());

describe("TaskListener connection resilience", () => {
  it("prepares a standby listener and drains accepted reports before closing", async () => {
    const conn = new FakeConnection();
    mockConnect.mockResolvedValue(conn);
    let finish!: () => void;
    const listener = new TaskListener(
      config,
      logger,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      { startPaused: true },
    );
    const running = listener.start();
    await flush();
    expect(listener.isConnected()).toBe(true);
    expect(conn.channel.consume).not.toHaveBeenCalled();
    await listener.resume();
    const receive = conn.channel.consume.mock.calls[0][1] as (message: unknown) => Promise<void>;
    const message = { content: Buffer.from('{"taskId":42}') };
    const handling = receive(message);
    const pause = listener.pause();
    await flush();
    expect(conn.channel.cancel).toHaveBeenCalledWith("report-consumer");
    expect(conn.channel.close).not.toHaveBeenCalled();
    finish();
    await handling;
    await pause;
    expect(conn.channel.ack).toHaveBeenCalledWith(message);
    await listener.stop();
    await running;
  });
  it("attaches a connection 'error' handler so a drop never crashes the process", async () => {
    const conn = new FakeConnection();
    mockConnect.mockResolvedValue(conn);

    const listener = new TaskListener(config, logger as never, vi.fn());
    void listener.start();
    await flush();

    // The regression: without this listener amqplib rethrows 'error' as an
    // uncaught exception. Node throws synchronously on an unheard 'error'.
    expect(conn.listenerCount("error")).toBeGreaterThan(0);
    expect(() => conn.emit("error", new Error("Unexpected close"))).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Connection error: Unexpected close"),
    );

    await listener.stop();
  });
});
