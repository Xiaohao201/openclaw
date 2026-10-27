import { randomUUID } from "node:crypto";
import amqplib from "amqplib";
import { expect, it } from "vitest";
import { RabbitMqClient } from "./rabbitmq-client.js";

it.runIf(process.env.OPENCLAW_LIFECYCLE_BROKER_TEST === "1")(
  "retains queued messages across a real broker consumer handoff",
  async () => {
    const queue = `openclaw_lifecycle_test_${randomUUID()}`;
    const config = {
      host: process.env.RABBITMQ_HOST ?? "127.0.0.1",
      port: Number(process.env.RABBITMQ_PORT ?? 5672),
      user: process.env.RABBITMQ_USER ?? "",
      password: process.env.RABBITMQ_PASSWORD ?? "",
      queue,
      reportTaskQueue: `${queue}_unused`,
      prefetch: 1,
    };
    if (!config.user) {
      throw new Error("Live broker test requires explicit RABBITMQ credentials");
    }
    const connection = await amqplib.connect(
      {
        hostname: config.host,
        port: config.port,
        username: config.user,
        password: config.password,
      },
      { timeout: 5000 },
    );
    const publisher = await connection.createConfirmChannel();
    await publisher.assertQueue(queue, { durable: true });
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    const seen: string[] = [];
    let finish!: () => void;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const old = new RabbitMqClient(config, logger, async (message) => {
      seen.push(`old:${message.content.toString()}`);
      await work;
    });
    const next = new RabbitMqClient(
      config,
      logger,
      async (message) => {
        seen.push(`new:${message.content.toString()}`);
      },
      undefined,
      { startPaused: true },
    );
    const oldLoop = old.start();
    const nextLoop = next.start();
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!condition()) {
        if (Date.now() > deadline) {
          throw new Error("Broker handoff condition timed out");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    };
    try {
      await until(() => old.isReady() && next.isConnected());
      publisher.sendToQueue(queue, Buffer.from("in-flight"), { persistent: true });
      await publisher.waitForConfirms();
      await until(() => seen.length === 1);
      const draining = old.pause(5000);
      publisher.sendToQueue(queue, Buffer.from("during-handoff"), { persistent: true });
      await publisher.waitForConfirms();
      expect(seen).toEqual(["old:in-flight"]);
      finish();
      await draining;
      await old.stop();
      await next.resume();
      await until(() => seen.length === 2);
      await next.pause(5000);
      expect(seen).toEqual(["old:in-flight", "new:during-handoff"]);
      expect((await publisher.checkQueue(queue)).messageCount).toBe(0);
    } finally {
      finish();
      await Promise.all([old.stop(), next.stop()]);
      await Promise.all([oldLoop, nextLoop]);
      await publisher.deleteQueue(queue);
      await publisher.close();
      await connection.close();
    }
  },
  30_000,
);
