import type amqplib from "amqplib";
import type { PluginLogger } from "../api.js";
import { createKeyedSerialQueue } from "./keyed-serial-queue.js";
import { parseCancel, parseMessage, parseWarmup } from "./message-handler.js";
import type { ChatCancelMessage, ChatMessage } from "./types.js";

export interface MessageConsumerDeps {
  logger: PluginLogger;
  /** Best-effort per-user agent warmup (chat-pipeline.warmupAgent). */
  runWarmup: (userId: string) => Promise<unknown>;
  /** Full chat pipeline for one parsed message (chat-pipeline.processChatMessage). */
  runChat: (chatMsg: ChatMessage, abortSignal: AbortSignal) => Promise<unknown>;
}

type RegisteredTurn = {
  chatMsg: ChatMessage;
  controller: AbortController;
};

function matchesTurn(cancel: ChatCancelMessage, chatMsg: ChatMessage): boolean {
  return (
    cancel.historyId === chatMsg.historyId &&
    cancel.userId === chatMsg.userId &&
    cancel.sessionId === chatMsg.sessionId
  );
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
 * reordering replies and burning the turn's waitForRun budget while queued.
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
  const registeredTurns = new Map<number, RegisteredTurn>();
  const pendingCancels = new Map<number, ChatCancelMessage>();

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

    // Cancellation is a control-plane message: handle it before the per-session
    // queue so it can interrupt the turn currently occupying that queue.
    const cancel = parseCancel(msg.content);
    if (cancel) {
      const registered = registeredTurns.get(cancel.historyId);
      if (registered && matchesTurn(cancel, registered.chatMsg)) {
        deps.logger.info(
          `[RABBITMQ_CONSUMER] Cancelling message: historyId=${cancel.historyId}, ` +
            `userId=${cancel.userId}`,
        );
        registered.controller.abort();
      } else if (!registered) {
        // Chat and control messages use independent queues, so the control can
        // legitimately win the delivery race. Bound the pending set so stale
        // controls cannot grow memory indefinitely.
        pendingCancels.set(cancel.historyId, cancel);
        if (pendingCancels.size > 1_024) {
          const oldest = pendingCancels.keys().next().value;
          if (typeof oldest === "number") {
            pendingCancels.delete(oldest);
          }
        }
      } else {
        deps.logger.warn(
          `[RABBITMQ_CONSUMER] Ignored unmatched cancellation: historyId=${cancel.historyId}`,
        );
      }
      return Promise.resolve();
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
    const controller = new AbortController();
    registeredTurns.set(chatMsg.historyId, { chatMsg, controller });
    const pendingCancel = pendingCancels.get(chatMsg.historyId);
    if (pendingCancel) {
      pendingCancels.delete(chatMsg.historyId);
      if (matchesTurn(pendingCancel, chatMsg)) {
        controller.abort();
      } else {
        deps.logger.warn(
          `[RABBITMQ_CONSUMER] Ignored mismatched pending cancellation: ` +
            `historyId=${chatMsg.historyId}`,
        );
      }
    }
    return enqueue(lane, async () => {
      try {
        await deps.runChat(chatMsg, controller.signal);
      } finally {
        if (registeredTurns.get(chatMsg.historyId)?.controller === controller) {
          registeredTurns.delete(chatMsg.historyId);
        }
      }
    });
  };
}
