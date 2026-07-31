import { afterEach, describe, expect, it, vi } from "vitest";

const { mockInsert } = vi.hoisted(() => ({
  mockInsert: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock("../history-row.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../history-row.js")>()),
  insertHistoryRow: mockInsert,
}));

import type { MySqlConfig } from "../../client/types.js";
import type { Notification } from "../notification.js";
import type { TurnUsageRecord } from "../usage.js";
import { DbHistoryTransport } from "./db-history.js";

const db = {
  host: "h",
  port: 3306,
  user: "u",
  password: "p",
  database: "superworker",
} as MySqlConfig;
const note: Notification = {
  id: "crawl_refresh:U1",
  uid: "1749",
  category: "crawl_refresh",
  level: "success",
  title: "互动量刷新完成",
  body: "转10 评5 赞100",
  ts: 1_750_000_000_000,
};
const to = { sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_9_z" };

afterEach(() => vi.clearAllMocks());

describe("DbHistoryTransport", () => {
  it("inserts an assistant-only history row for the session", async () => {
    const res = await new DbHistoryTransport(db).deliver(note, to);

    expect(res.ok).toBe(true);
    const [, row] = mockInsert.mock.calls[0] as [unknown, { uid: string; response: string }];
    expect(row).toMatchObject({ sessionId: "session_9_z", uid: "1749" });
    expect(row.response).toContain("互动量刷新完成");
    expect(row.response).toContain("转10 评5 赞100");
  });

  it("appends the detail link when the notification carries one", async () => {
    await new DbHistoryTransport(db).deliver({ ...note, link: "https://x.test/r/1" }, to);
    const [, row] = mockInsert.mock.calls[0] as [unknown, { response: string }];
    expect(row.response).toContain("[查看详情](https://x.test/r/1)");
  });

  it("passes the run's usage through so the row is billed", async () => {
    const usage = { totalCost: 1, currency: "CNY" } as TurnUsageRecord;
    await new DbHistoryTransport(db).deliver({ ...note, usage }, to);
    const [, row] = mockInsert.mock.calls[0] as [unknown, { usage?: TurnUsageRecord }];
    expect(row.usage).toBe(usage);
  });

  it("skips when no session id is resolvable", async () => {
    const res = await new DbHistoryTransport(db).deliver(note, {});
    expect(res.ok).toBe(false);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
