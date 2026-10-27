import amqplib from "amqplib";
import type { PluginLogger } from "../api.js";
import type { RabbitMqConfig } from "./types.js";

type MessageHandler = (msg: amqplib.ConsumeMessage) => Promise<void>;

/**
 * RabbitMQ client with automatic reconnection and exponential backoff.
 *
 * Ported from Python rabbitmq_consumer.py RabbitMQConsumer.
 * Uses amqplib (async/await) instead of pika (sync).
 */
export class RabbitMqClient {
  private readonly config: RabbitMqConfig;
  private readonly logger: PluginLogger;
  private readonly handler: MessageHandler;
  private readonly controlHandler?: MessageHandler;

  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;
  private controlChannel: amqplib.Channel | null = null;
  private consuming = false;
  private running: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private readonly startPaused: boolean;
  private paused = false;
  private readonly consumerTags = new Map<amqplib.Channel, string>();
  private readonly inFlight = new Set<Promise<void>>();
  private connecting: Promise<void> | null = null;
  private canceling: Promise<void> = Promise.resolve();
  private wakeReconnect: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    config: RabbitMqConfig,
    logger: PluginLogger,
    handler: MessageHandler,
    controlHandler?: MessageHandler,
    options?: { startPaused?: boolean },
  ) {
    this.config = config;
    this.logger = logger;
    this.handler = handler;
    this.controlHandler = controlHandler;
    this.startPaused = options?.startPaused === true;
    this.paused = this.startPaused;
  }

  async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(this.startPaused ? this.isConnected() : this.isReady())) {
      if (!this.consuming || Date.now() >= deadline) {
        throw new Error("RabbitMQ consumer did not become ready");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  start(): Promise<void> {
    if (this.stopping) {
      return Promise.reject(new Error("Cannot start RabbitMQ consumer while it is stopping"));
    }
    if (this.running) {
      return this.running;
    }
    this.paused = this.startPaused;
    this.consuming = true;
    this.running = this.consumeLoop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  stop(): Promise<void> {
    this.stopping ??= this.stopAndDrain().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private async stopAndDrain(): Promise<void> {
    this.consuming = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.wakeReconnect?.();
    try {
      await this.pause();
    } catch (error) {
      // Final shutdown has already disabled intake. A disconnected broker cannot
      // acknowledge cancellation, but accepted local work must still finish.
      this.logger.warn(`[RABBITMQ] Consumer cancellation failed: ${String(error)}`);
      await Promise.all(this.inFlight);
    }
    await this.cleanupConnection();
    await this.running;
  }

  isReady(): boolean {
    return (
      this.consuming && !this.paused && this.consumerTags.size === (this.controlHandler ? 2 : 1)
    );
  }

  isConnected(): boolean {
    return (
      this.consuming &&
      this.connecting === null &&
      this.channel !== null &&
      (!this.controlHandler || this.controlChannel !== null)
    );
  }

  /** Cancel deliveries without closing the channel: accepted work keeps its ack ownership. */
  async pause(timeoutMs = 300_000): Promise<void> {
    this.paused = true;
    this.canceling = this.canceling
      .catch(() => {})
      .then(async () => {
        await this.connecting?.catch(() => {});
        const failures: unknown[] = [];
        for (const [channel, tag] of this.consumerTags) {
          try {
            await channel.cancel(tag);
            this.consumerTags.delete(channel);
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "RabbitMQ consumer cancellation failed");
        }
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drain = async () => {
      await this.canceling;
      while (this.inFlight.size > 0) {
        await Promise.all(this.inFlight);
      }
    };
    try {
      await Promise.race([
        drain(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("RabbitMQ drain deadline exceeded; active work was not aborted")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async resume(): Promise<void> {
    // A rejected pause can be rolled back after every cancellation has settled.
    // Successfully canceled tags were removed; surviving consumers must not be duplicated.
    await this.canceling.catch(() => {});
    await this.connecting;
    this.paused = false;
    if (this.channel && !this.consumerTags.has(this.channel)) {
      await this.consumeChannel(this.channel, this.config.queue, this.handler);
    }
    if (this.controlChannel && this.controlHandler && !this.consumerTags.has(this.controlChannel)) {
      await this.consumeChannel(
        this.controlChannel,
        `${this.config.queue}.control`,
        this.controlHandler,
      );
    }
  }

  private async consumeLoop(): Promise<void> {
    let retryDelay = 5_000; // 5 seconds initial
    const maxRetryDelay = 300_000; // 5 minutes max

    while (this.consuming) {
      try {
        this.connecting = this.connect();
        await this.connecting;
        this.connecting = null;
        retryDelay = 5_000; // reset on success

        // The consumer is event-driven via amqplib; start() resolves when
        // the channel closes or an error occurs.
        // We set up a "close" listener to trigger reconnection.
        if (this.channel) {
          await new Promise<void>((resolve) => {
            for (const ch of [this.channel, this.controlChannel]) {
              if (!ch) {
                continue;
              }
              ch.once("close", () => {
                this.logger.info("[RABBITMQ] Channel closed");
                resolve();
              });
              ch.once("error", (err: Error) => {
                this.logger.error(`[RABBITMQ] Channel error: ${err.message}`);
                resolve();
              });
            }
          });
        }
      } catch (error) {
        this.logger.error(`[RABBITMQ] Connection error: ${String(error)}`);
      }
      this.connecting = null;

      await Promise.all(this.inFlight);
      await this.cleanupConnection();

      if (!this.consuming) {
        break;
      }

      // Exponential backoff (interruptible via stop())
      this.logger.info(`[RABBITMQ] Reconnecting in ${retryDelay / 1000}s...`);
      await new Promise<void>((resolve) => {
        this.wakeReconnect = resolve;
        this.reconnectTimer = setTimeout(resolve, retryDelay);
      });
      this.reconnectTimer = null;
      this.wakeReconnect = null;

      retryDelay = Math.min(retryDelay * 2, maxRetryDelay);
    }

    this.logger.info("[RABBITMQ] Consumer stopped permanently");
  }

  private async connect(): Promise<void> {
    this.connection = await amqplib.connect({
      hostname: this.config.host,
      port: this.config.port,
      username: this.config.user,
      password: this.config.password,
      heartbeat: 60,
    });
    // A connection-level 'error' is mandatory: amqplib's EventEmitter rethrows
    // an unheard 'error' as an uncaught exception, crashing the whole process
    // when RabbitMQ drops the link ("Unexpected close"). Absorb it here — the
    // channel 'close' below drives reconnection.
    this.connection.on("error", (err: Error) => {
      this.logger.error(`[RABBITMQ] Connection error: ${err.message}`);
    });
    this.connection.on("close", () => {
      this.logger.info("[RABBITMQ] Connection closed");
    });

    if (!this.consuming) {
      return;
    }
    this.channel = await this.connection.createChannel();
    this.channel.once("close", () => {
      this.consumerTags.clear();
    });
    await this.channel.assertQueue(this.config.queue, { durable: true });
    await this.channel.prefetch(this.config.prefetch);

    this.logger.info(`[RABBITMQ] Started consuming from queue: ${this.config.queue}`);

    await this.consumeChannel(this.channel, this.config.queue, this.handler);

    if (this.controlHandler) {
      this.controlChannel = await this.connection.createChannel();
      const controlQueue = `${this.config.queue}.control`;
      await this.controlChannel.assertQueue(controlQueue, { durable: true });
      await this.controlChannel.prefetch(32);
      await this.consumeChannel(this.controlChannel, controlQueue, this.controlHandler);
      this.logger.info(`[RABBITMQ] Started consuming controls from queue: ${controlQueue}`);
    }
  }

  private async consumeChannel(
    channel: amqplib.Channel,
    queue: string,
    handler: MessageHandler,
  ): Promise<void> {
    if (this.paused || !this.consuming) {
      return;
    }
    const result = await channel.consume(queue, async (msg) => {
      if (!msg) {
        this.consumerTags.delete(channel);
        return;
      }
      if (this.paused || !this.consuming) {
        this.settleMessage(channel, msg, "requeue");
        return;
      }
      const task = (async () => {
        try {
          await handler(msg);
          this.settleMessage(channel, msg, "ack");
        } catch (error) {
          this.logger.error(`[RABBITMQ] Message handler error: ${String(error)}`);
          this.settleMessage(channel, msg, "nack");
        }
      })();
      this.inFlight.add(task);
      try {
        await task;
      } finally {
        this.inFlight.delete(task);
      }
    });
    this.consumerTags.set(channel, result.consumerTag);
  }

  private settleMessage(
    channel: amqplib.Channel,
    msg: amqplib.ConsumeMessage,
    action: "ack" | "nack" | "requeue",
  ): void {
    try {
      if (action === "ack") {
        channel.ack(msg);
      } else {
        channel.nack(msg, false, action === "requeue");
      }
    } catch (error) {
      // A channel can close while an async handler is still running. Once
      // closed, RabbitMQ owns redelivery of any unsettled delivery, so logging
      // is sufficient and must not escape as an unhandled rejection.
      this.logger.error(`[RABBITMQ] Failed to ${action} message: ${String(error)}`);
    }
  }

  private async cleanupConnection(): Promise<void> {
    const controlChannel = this.controlChannel;
    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.controlChannel = null;
    this.connection = null;
    this.consumerTags.clear();
    try {
      if (controlChannel) {
        await controlChannel.close().catch(() => {});
      }
    } catch {
      /* ignore */
    }

    try {
      if (channel) {
        await channel.close().catch(() => {});
      }
    } catch {
      /* ignore */
    }

    try {
      if (connection) {
        await connection.close().catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }
}
