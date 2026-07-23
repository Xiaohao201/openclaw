import type amqplib from "amqplib";
import type { PluginLogger } from "../api.js";
import { createKeyedSerialQueue } from "./keyed-serial-queue.js";
import { parseMessage, parseWarmup } from "./message-handler.js";
import type { ChatMessage } from "./types.js";

export interface MessageConsumerDeps {
  logger: PluginLogger;
  /** Best-effort per-user agent warmup (chat-pipeline.warmupAgent). */
  runWarmup: (userId: string) => Promise<unknown>;
  /** Full chat pipeline for one parsed message (chat-pipeline.processChatMessage). */
  runChat: (chatMsg: ChatMessage) => Promise<unknown>;
}

/**
 * Build the RabbitMQ message handler with per-user serialization.
 *
 * With prefetch > 1 the broker hands us several messages at once. Different
 * users must run concurrently (the gateway's main lane schedules their runs),
 * but one user's messages must stay strictly ordered: the pipeline's
 * pre-processing (LLM topic pick, attachment download, DB writes) has variable
 * latency, so without this a later message could reach the session lane first —
 * reordering replies and burning the 300s waitForRun budget while queued.
 *
 * Parsing and key resolution happen synchronously (before the first await) so
 * broker delivery order becomes per-user chain order. The returned promise
 * settles only after the message's queued turn fully completes, keeping the
 * caller's ack-on-success / nack-on-error semantics intact.
 */
export function createMessageConsumer(
  deps: MessageConsumerDeps,
): (msg: amqplib.ConsumeMessage) => Promise<void> {
  const enqueue = createKeyedSerialQueue();

  return (msg) => {
    // Warmup envelopes carry no history id and must be handled before
    // parseMessage (which would reject them). Best-effort, fire silently.
    // Serialized with the same user's chat messages (matches the previous
    // global-serial behavior for one user).
    const warmup = parseWarmup(msg.content);
    if (warmup) {
      deps.logger.info(`[RABBITMQ_CONSUMER] Warmup request: userId=${warmup.userId}`);
      return enqueue(`user:${warmup.userId}`, async () => {
        await deps.runWarmup(warmup.userId);
      });
    }

    const chatMsg = parseMessage(msg.content, deps.logger);
    if (!chatMsg) {
      deps.logger.error("[RABBITMQ_CONSUMER] Failed to parse message");
      return Promise.resolve();
    }

    deps.logger.info(
      `[RABBITMQ_CONSUMER] Received message: historyId=${chatMsg.historyId}, ` +
        `userId=${chatMsg.userId}`,
    );

    return enqueue(`user:${chatMsg.userId}`, async () => {
      await deps.runChat(chatMsg);
    });
  };
}
