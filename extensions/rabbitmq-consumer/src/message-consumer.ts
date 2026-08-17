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
 * Build the RabbitMQ message handler with per-conversation serialization.
 *
 * With prefetch > 1 the broker hands us several messages at once. Different
 * conversation windows must run concurrently (the gateway schedules their
 * independent session lanes), but messages inside one window must stay strictly
 * ordered: the pipeline's
 * pre-processing (LLM topic pick, attachment download, DB writes) has variable
 * latency, so without this a later message could reach the session lane first —
 * reordering replies and burning the 300s waitForRun budget while queued.
 *
 * Parsing and key resolution happen synchronously (before the first await) so
 * broker delivery order becomes per-session chain order. Legacy messages with
 * no session id use their history id as an isolated lane instead of blocking
 * every other window owned by the same user. The returned promise
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
    // A session-aware warmup stays ordered with that window's first chat turn,
    // without blocking the same user's other windows.
    const warmup = parseWarmup(msg.content);
    if (warmup) {
      deps.logger.info(`[RABBITMQ_CONSUMER] Warmup request: userId=${warmup.userId}`);
      const lane = warmup.sessionId
        ? `user:${warmup.userId}:session:${warmup.sessionId}`
        : `user:${warmup.userId}:warmup`;
      return enqueue(lane, async () => {
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

    const lane = chatMsg.sessionId
      ? `user:${chatMsg.userId}:session:${chatMsg.sessionId}`
      : `user:${chatMsg.userId}:history:${chatMsg.historyId}`;
    return enqueue(lane, async () => {
      await deps.runChat(chatMsg);
    });
  };
}
