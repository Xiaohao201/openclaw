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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    config: RabbitMqConfig,
    logger: PluginLogger,
    handler: MessageHandler,
    controlHandler?: MessageHandler,
  ) {
    this.config = config;
    this.logger = logger;
    this.handler = handler;
    this.controlHandler = controlHandler;
  }

  /** Start consuming messages. Runs until stop() is called. */
  async start(): Promise<void> {
    this.consuming = true;
    await this.consumeLoop();
  }

  /** Stop consuming and disconnect. */
  async stop(): Promise<void> {
    this.consuming = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    await this.cleanupConnection();
  }

  private async consumeLoop(): Promise<void> {
    let retryDelay = 5_000; // 5 seconds initial
    const maxRetryDelay = 300_000; // 5 minutes max

    while (this.consuming) {
      try {
        await this.connect();
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

      await this.cleanupConnection();

      if (!this.consuming) {
        break;
      }

      // Exponential backoff (interruptible via stop())
      this.logger.info(`[RABBITMQ] Reconnecting in ${retryDelay / 1000}s...`);
      await new Promise<void>((resolve) => {
        this.reconnectTimer = setTimeout(resolve, retryDelay);
      });
      this.reconnectTimer = null;

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

    this.channel = await this.connection.createChannel();
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
    await channel.consume(queue, async (msg) => {
      if (!msg) {
        return;
      }

      try {
        await handler(msg);
        channel.ack(msg);
      } catch (error) {
        this.logger.error(`[RABBITMQ] Message handler error: ${String(error)}`);
        channel.nack(msg, false, false);
      }
    });
  }

  private async cleanupConnection(): Promise<void> {
    try {
      if (this.controlChannel) {
        await this.controlChannel.close().catch(() => {});
      }
    } catch {
      /* ignore */
    }

    try {
      if (this.channel) {
        await this.channel.close().catch(() => {});
      }
    } catch {
      /* ignore */
    }

    try {
      if (this.connection) {
        await this.connection.close().catch(() => {});
      }
    } catch {
      /* ignore */
    }

    this.channel = null;
    this.controlChannel = null;
    this.connection = null;
  }
}
