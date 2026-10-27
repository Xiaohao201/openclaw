import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockConnect } = vi.hoisted(() => ({ mockConnect: vi.fn() }));
vi.mock("amqplib", () => ({ default: { connect: mockConnect } }));

const { RabbitMqClient } = await import("./rabbitmq-client.js");
import type { RabbitMqConfig } from "./types.js";

class FakeChannel extends EventEmitter {
  assertQueue = vi.fn().mockResolvedValue(undefined);
  prefetch = vi.fn().mockResolvedValue(undefined);
  consume = vi.fn().mockResolvedValue({ consumerTag: "consumer-1" });
  cancel = vi.fn().mockResolvedValue(undefined);
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
  it("reports ready only after consumer registration and rejects readiness after stop", async () => {
    const conn = new FakeConnection();
    mockConnect.mockResolvedValue(conn);
    const client = new RabbitMqClient(config, logger, vi.fn());
    void client.start();
    await client.waitUntilReady(1000);
    expect(conn.channel.consume).toHaveBeenCalledOnce();
    await client.stop();
    await expect(client.waitUntilReady()).rejects.toThrow("did not become ready");
  });

  it("fails readiness on a broker timeout without claiming execution is healthy", async () => {
    mockConnect.mockRejectedValue(new Error("offline"));
    const client = new RabbitMqClient(config, logger, vi.fn());
    void client.start();
    await expect(client.waitUntilReady(1)).rejects.toThrow("did not become ready");
    await client.stop();
  });
  it("finishes shutdown when broker cancellation and close operations fail", async () => {
    const conn = new FakeConnection();
    const control = new FakeChannel();
    conn.createChannel
      .mockImplementationOnce(async () => conn.channel)
      .mockImplementationOnce(async () => control);
    for (const channel of [conn.channel, control]) {
      channel.cancel.mockRejectedValue(new Error("connection lost"));
      channel.close.mockImplementation(async () => {
        channel.emit("close");
        throw new Error("already closed");
      });
    }
    conn.close.mockImplementation(async () => {
      throw new Error("already closed");
    });
    mockConnect.mockResolvedValue(conn);
    const client = new RabbitMqClient(config, logger, vi.fn(), vi.fn());
    const running = client.start();
    expect(client.start()).toBe(running);
    await flush();
    await client.stop();
    await running;
    expect(conn.channel.cancel).toHaveBeenCalled();
    expect(control.cancel).toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalled();
  });

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
  it("resumes surviving consumers after cancellation fails without duplicating them", async () => {
    const conn = new FakeConnection();
    mockConnect.mockResolvedValue(conn);
    const client = new RabbitMqClient(config, logger, vi.fn());
    const running = client.start();
    await flush();
    conn.channel.cancel.mockRejectedValueOnce(new Error("cancel failed"));
    await expect(client.pause()).rejects.toThrow("cancellation failed");
    await client.resume();
    expect(client.isReady()).toBe(true);
    expect(conn.channel.consume).toHaveBeenCalledOnce();
    await client.stop();
    await running;
  });
  it("connects standby workers without claiming any messages", async () => {
    const conn = new FakeConnection();
    mockConnect.mockResolvedValue(conn);
    const client = new RabbitMqClient(config, logger, vi.fn(), undefined, { startPaused: true });
    const running = client.start();
    await flush();
    expect(client.isConnected()).toBe(true);
    await client.waitUntilReady();
    expect(client.isReady()).toBe(false);
    expect(conn.channel.consume).not.toHaveBeenCalled();
    await client.resume();
    expect(conn.channel.consume).toHaveBeenCalledOnce();
    await client.stop();
    await running;
  });
  it("cancels delivery but retains the connection until accepted work is acknowledged", async () => {
    const conn = new FakeConnection();
    mockConnect.mockResolvedValue(conn);
    let finish!: () => void;
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const client = new RabbitMqClient(config, logger, handler);
    const running = client.start();
    await flush();
    const receive = conn.channel.consume.mock.calls[0][1] as (msg: unknown) => Promise<void>;
    const msg = { content: Buffer.from("work") };
    const handling = receive(msg);
    let drained = false;
    const pause = client.pause().then(() => {
      drained = true;
    });
    await flush();
    expect(conn.channel.cancel).toHaveBeenCalledWith("consumer-1");
    expect(drained).toBe(false);
    expect(conn.channel.close).not.toHaveBeenCalled();
    finish();
    await handling;
    await pause;
    expect(conn.channel.ack).toHaveBeenCalledWith(msg);
    expect(client.isReady()).toBe(false);
    await client.resume();
    expect(conn.channel.consume).toHaveBeenCalledTimes(2);
    expect(client.isReady()).toBe(true);
    await client.stop();
    await running;
  });

  it("requeues deliveries racing with cancellation without executing them", async () => {
    const conn = new FakeConnection();
    mockConnect.mockResolvedValue(conn);
    const handler = vi.fn();
    const client = new RabbitMqClient(config, logger, handler);
    const running = client.start();
    await flush();
    const receive = conn.channel.consume.mock.calls[0][1] as (msg: unknown) => Promise<void>;
    await client.pause();
    const msg = { content: Buffer.from("late") };
    await receive(msg);
    expect(handler).not.toHaveBeenCalled();
    expect(conn.channel.nack).toHaveBeenCalledWith(msg, false, true);
    await client.stop();
    await running;
  });

  it("leaves accepted work running when the drain deadline expires", async () => {
    const conn = new FakeConnection();
    mockConnect.mockResolvedValue(conn);
    let finish!: () => void;
    const client = new RabbitMqClient(
      config,
      logger,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const running = client.start();
    await flush();
    const receive = conn.channel.consume.mock.calls[0][1] as (msg: unknown) => Promise<void>;
    const handling = receive({ content: Buffer.from("slow") });
    await expect(client.pause(5)).rejects.toThrow(/drain/);
    expect(conn.channel.close).not.toHaveBeenCalled();
    await client.resume();
    finish();
    await handling;
    await client.stop();
    await running;
  });

  it("cancels intake and waits for accepted messages to settle before closing", async () => {
    const conn = new FakeConnection();
    mockConnect.mockResolvedValue(conn);
    let finish!: () => void;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const client = new RabbitMqClient(config, logger, () => work);
    const running = client.start();
    await flush();
    const deliver = conn.channel.consume.mock.calls[0][1] as (msg: unknown) => Promise<void>;
    const message = { content: Buffer.from("accepted") };
    const delivery = deliver(message);
    const stopping = client.stop();
    await expect(client.start()).rejects.toThrow("while it is stopping");
    await flush();
    expect(conn.channel.cancel).toHaveBeenCalledWith("consumer-1");
    expect(conn.channel.close).not.toHaveBeenCalled();
    finish();
    await delivery;
    await stopping;
    await running;
    expect(conn.channel.ack).toHaveBeenCalledWith(message);
    expect(conn.channel.ack.mock.invocationCallOrder[0]).toBeLessThan(
      conn.channel.close.mock.invocationCallOrder[0],
    );
  });

  it("requeues deliveries racing with stop without starting a new handler", async () => {
    const conn = new FakeConnection();
    mockConnect.mockResolvedValue(conn);
    const handler = vi.fn();
    const client = new RabbitMqClient(config, logger, handler);
    const running = client.start();
    await flush();
    const deliver = conn.channel.consume.mock.calls[0][1] as (msg: unknown) => Promise<void>;
    const stopping = client.stop();
    const message = { content: Buffer.from("late") };
    await deliver(message);
    await stopping;
    await running;
    expect(handler).not.toHaveBeenCalled();
    expect(conn.channel.nack).toHaveBeenCalledWith(message, false, true);
  });

  it("settles start when stop interrupts reconnect backoff", async () => {
    mockConnect.mockRejectedValue(new Error("offline"));
    const client = new RabbitMqClient(config, logger, vi.fn());
    const running = client.start();
    await flush();
    await client.stop();
    await running;
  });

  it("does not create a consumer when stop races with connection setup", async () => {
    const conn = new FakeConnection();
    let connected!: (value: FakeConnection) => void;
    mockConnect.mockReturnValue(
      new Promise<FakeConnection>((resolve) => {
        connected = resolve;
      }),
    );
    const client = new RabbitMqClient(config, logger, vi.fn());
    const running = client.start();
    const stopping = client.stop();
    connected(conn);
    await stopping;
    await running;
    expect(conn.channel.consume).not.toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalled();
  });

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

  it("does not nack or reject when the channel closes before a successful ack", async () => {
    const conn = new FakeConnection();
    const channelClosed = new Error("Channel closed");
    conn.channel.ack.mockImplementation(() => {
      throw channelClosed;
    });
    conn.channel.nack.mockImplementation(() => {
      throw channelClosed;
    });
    mockConnect.mockResolvedValue(conn);

    const client = new RabbitMqClient(
      config,
      logger as never,
      vi.fn().mockResolvedValue(undefined),
    );
    void client.start();
    await flush();

    const consumeCb = conn.channel.consume.mock.calls[0]?.[1] as (msg: unknown) => Promise<void>;
    const msg = { content: Buffer.from("completed") };

    await expect(consumeCb(msg)).resolves.toBeUndefined();
    expect(conn.channel.ack).toHaveBeenCalledWith(msg);
    expect(conn.channel.nack).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to ack message: Error: Channel closed"),
    );

    await client.stop();
  });

  it("does not reject when nack races with a closed channel", async () => {
    const conn = new FakeConnection();
    conn.channel.nack.mockImplementation(() => {
      throw new Error("Channel closed");
    });
    mockConnect.mockResolvedValue(conn);
    const handlerError = new Error("handler failed");

    const client = new RabbitMqClient(
      config,
      logger as never,
      vi.fn().mockRejectedValue(handlerError),
    );
    void client.start();
    await flush();

    const consumeCb = conn.channel.consume.mock.calls[0]?.[1] as (msg: unknown) => Promise<void>;

    await expect(consumeCb({ content: Buffer.from("failed") })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Message handler error: Error: handler failed"),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to nack message: Error: Channel closed"),
    );

    await client.stop();
  });
});
