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
  consume = vi.fn().mockResolvedValue(undefined);
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
