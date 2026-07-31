import type { PluginLogger } from "../../../api.js";
import type { MySqlConfig } from "../../client/types.js";
import { insertHistoryRow, sessionIdFromKey } from "../history-row.js";
import type { Notification, NotificationTransport, NotifyAddressing } from "../notification.js";

/**
 * T2 — durable delivery: persist the notification as an assistant-only row in
 * history_messages, so it shows up in the conversation on next reload even if
 * the user was offline when it fired. The web history loader renders `response`
 * as an assistant bubble and skips the empty `message` (no phantom user bubble).
 *
 * When the notification carries `usage` (a scheduled LLM run), the row is
 * written with that run's token/cost columns filled in, so scheduled work is
 * billed on the same table and by the same rollups as chat turns.
 */
export class DbHistoryTransport implements NotificationTransport {
  readonly id = "db-history";

  constructor(
    private readonly db: MySqlConfig,
    private readonly logger?: PluginLogger,
  ) {}

  async deliver(n: Notification, to: NotifyAddressing): Promise<{ ok: boolean; note?: string }> {
    const sessionId = sessionIdFromKey(to.sessionKey);
    if (!sessionId) {
      return { ok: false, note: "no session id in sessionKey" };
    }
    const body = n.title ? `**${n.title}**\n\n${n.body}` : n.body;
    const text = n.link ? `${body}\n\n[查看详情](${n.link})` : body;
    await insertHistoryRow(
      this.db,
      { sessionId, uid: n.uid, response: text, usage: n.usage },
      this.logger,
    );
    return { ok: true };
  }
}
