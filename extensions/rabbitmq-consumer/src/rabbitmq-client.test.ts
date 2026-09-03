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
  prefetch: 6,
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

describe("RabbitMqClient concurrency", () => {
  it("consumes cancellation controls on an independent channel", async () => {
    const conn = new FakeConnection();
    const chatChannel = new FakeChannel();
    const controlChannel = new FakeChannel();
    conn.createChannel
      .mockImplementationOnce(async () => chatChannel)
      .mockImplementationOnce(async () => controlChannel);
    mockConnect.mockResolvedValue(conn);
    const controlHandler = vi.fn().mockResolvedValue(undefined);

    const client = new RabbitMqClient(config, logger as never, vi.fn(), controlHandler);
    void client.start();
    await flush();

    expect(controlChannel.assertQueue).toHaveBeenCalledWith("chat.control", { durable: true });
    const consumeControl = controlChannel.consume.mock.calls[0]?.[1] as (
      msg: unknown,
    ) => Promise<void>;
    const cancelMsg = { content: Buffer.from('{"type":"cancel"}') };
    await consumeControl(cancelMsg);
    expect(controlHandler).toHaveBeenCalledWith(cancelMsg);
    expect(controlChannel.ack).toHaveBeenCalledWith(cancelMsg);

    await client.stop();
  });

  it("applies the configured prefetch to the channel", async () => {
    const conn = new FakeConnection();
    mockConnect.mockResolvedValue(conn);

    const client = new RabbitMqClient(config, logger as never, vi.fn());
    void client.start();
    await flush();

    expect(conn.channel.prefetch).toHaveBeenCalledWith(6);

    await client.stop();
  });

  it("acks each message independently — a slow handler never blocks a fast one's ack", async () => {
    const conn = new FakeConnection();
    mockConnect.mockResolvedValue(conn);

    let releaseSlow!: () => void;
    const slowDone = new Promise<void>((r) => {
      releaseSlow = r;
    });
    const handler = vi.fn((msg: { content: Buffer }) =>
      msg.content.toString() === "slow" ? slowDone : Promise.resolve(),
    );

    const client = new RabbitMqClient(config, logger as never, handler as never);
    void client.start();
    await flush();

    const consumeCb = conn.channel.consume.mock.calls[0]?.[1] as (msg: unknown) => Promise<void>;
    const slowMsg = { content: Buffer.from("slow") };
    const fastMsg = { content: Buffer.from("fast") };

    void consumeCb(slowMsg);
    void consumeCb(fastMsg);
    await flush();

    // The fast message is acked while the slow one is still in flight.
    expect(conn.channel.ack).toHaveBeenCalledTimes(1);
    expect(conn.channel.ack).toHaveBeenCalledWith(fastMsg);

    releaseSlow();
    await flush();
    expect(conn.channel.ack).toHaveBeenCalledTimes(2);
    expect(conn.channel.ack).toHaveBeenLastCalledWith(slowMsg);

    await client.stop();
  });
});
