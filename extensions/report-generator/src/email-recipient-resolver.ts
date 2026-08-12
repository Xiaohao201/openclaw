import type mysql from "mysql2/promise";
import type { ReportPeriod } from "./types.js";

const DEFAULT_SENDER = "观舆卫士";

interface SubscriberRow extends mysql.RowDataPacket {
  email: unknown;
  periods: unknown;
  sender: unknown;
}

export interface ReportEmailRecipient {
  email: string;
  sender: string;
}

export interface ReportEmailLookup {
  uid: number;
  topicId: number;
  slaveTopicId: number;
  period: ReportPeriod;
}

const PERIOD_ALIASES: Record<ReportPeriod, ReadonlySet<string>> = {
  Daily: new Set(["daily", "day", "日报"]),
  Weekly: new Set(["weekly", "week", "周报"]),
  Monthly: new Set(["monthly", "month", "月报"]),
};

function parsePeriods(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === "string");
  }
  if (typeof raw !== "string") {
    return [];
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      // Fall through for legacy delimiter-separated values.
    }
  }
  return trimmed.split(/[\s,，、;；|/]+/u);
}

function subscribesToPeriod(raw: unknown, period: ReportPeriod): boolean {
  const aliases = PERIOD_ALIASES[period];
  return parsePeriods(raw).some((value) => aliases.has(value.trim().toLowerCase()));
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const email = raw.trim();
  if (email.length > 254 || /[\r\n]/u.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    return null;
  }
  return email;
}

function normalizeSender(raw: unknown): string {
  if (typeof raw !== "string") {
    return DEFAULT_SENDER;
  }
  const sender = raw.trim();
  return sender && sender.length <= 100 && !/[\r\n]/u.test(sender) ? sender : DEFAULT_SENDER;
}

/** Resolve a report subscriber and topic-owned sender label from MySQL. */
export async function resolveReportEmailRecipient(
  pool: mysql.Pool,
  lookup: ReportEmailLookup,
): Promise<ReportEmailRecipient | null> {
  const [rows] = await pool.execute<SubscriberRow[]>(
    `SELECT s.email, s.periods, t.sender
     FROM feed_report_subscriber s
     LEFT JOIN feed_topic t
       ON t.id = CASE WHEN s.topicId = ? THEN ? ELSE ? END
     WHERE s.uid = ?
       AND (s.topicId = ? OR (? > 0 AND s.topicId = ?))
       AND s.active = 1
       AND s.email IS NOT NULL AND s.email != ''
     ORDER BY s.id ASC`,
    [
      lookup.topicId,
      lookup.topicId,
      lookup.slaveTopicId,
      lookup.uid,
      lookup.topicId,
      lookup.slaveTopicId,
      lookup.slaveTopicId,
    ],
  );

  for (const row of rows) {
    const email = normalizeEmail(row.email);
    if (email && subscribesToPeriod(row.periods, lookup.period)) {
      return { email, sender: normalizeSender(row.sender) };
    }
  }
  return null;
}
