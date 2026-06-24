import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockConnect } = vi.hoisted(() => ({ mockConnect: vi.fn() }));
vi.mock("amqplib", () => ({ default: { connect: mockConnect } }));

const { RabbitMqClient } = await import("./rabbitmq-client.js");
import type { RabbitMqConfig } from "./types.js";

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

class FakeConnection extends EventEmitter {
  channel = new FakeChannel();
  createChannel = vi.fn().mockImplementation(async () => this.channel);
  close = vi.fn().mockImplementation(async () => {
    this.emit("close");
  });
}

const config: RabbitMqConfig = {
  host: "localhost",
  port: 5672,
  user: "guest",
  password: "guest",
  queue: "chat",
  reportTaskQueue: "report_tasks",
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.clearAllMocks());

describe("RabbitMqClient connection resilience", () => {
  it("attaches a connection 'error' handler so a drop never crashes the process", async () => {
    const conn = new FakeConnection();
    mockConnect.mockResolvedValue(conn);

    const client = new RabbitMqClient(config, logger as never, vi.fn());
    void client.start();
    await flush();

    expect(conn.listenerCount("error")).toBeGreaterThan(0);
    expect(() => conn.emit("error", new Error("Unexpected close"))).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Connection error: Unexpected close"),
    );

    await client.stop();
  });
});
