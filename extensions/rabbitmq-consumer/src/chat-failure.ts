import { setTimeout as delay } from "node:timers/promises";
import type { PluginLogger } from "../api.js";
import type { MercureEventPusher, StreamingMercurePusher } from "./mercure-pusher.js";

/** Terminal events are idempotent and tagged with the turn; text and tool actions are never replayed. */
export async function notifyChatFailure(params: {
  mercure: MercureEventPusher;
  stream: StreamingMercurePusher | null;
  topic: string;
  historyId: number;
  message: string;
  logger: Pick<PluginLogger, "warn">;
}): Promise<void> {
  const send = async (event: "error" | "done", publish: () => Promise<boolean>) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (await publish()) {
          return;
        }
      } catch {
        // Hub failures must not escape into the consumer and replay a chat turn.
      }
      if (attempt < 3) {
        await delay(250 * attempt);
      }
    }
    params.logger.warn(
      `[CHAT_PIPELINE] Terminal event delivery failed: event=${event} historyId=${params.historyId} attempts=3`,
    );
  };
  await send("error", () =>
    params.stream
      ? params.stream.pushError(params.message)
      : params.mercure.pushError(params.topic, params.message, params.historyId),
  );
  // Also attempt done when the error event fails, so a recovered hub can still
  // stop the spinner. Never call finish(), which would replay buffered text.
  await send("done", () => params.mercure.pushDone(params.topic, params.historyId));
}
