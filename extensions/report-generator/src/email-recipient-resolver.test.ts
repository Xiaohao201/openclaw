import type mysql from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { resolveReportEmailRecipient } from "./email-recipient-resolver.js";

describe("resolveReportEmailRecipient", () => {
  it("selects a subscriber whose Chinese periods include the report period", async () => {
    const execute = vi.fn().mockResolvedValue([
      [
        { email: "daily@example.com", periods: "日报", sender: "专题观察员" },
        { email: "weekly@example.com", periods: "周报、月报", sender: "专题观察员" },
      ],
      [],
    ]);

    const recipient = await resolveReportEmailRecipient({ execute } as unknown as mysql.Pool, {
      uid: 1749,
      topicId: 21,
      slaveTopicId: 0,
      period: "Weekly",
    });

    expect(recipient).toEqual({ email: "weekly@example.com", sender: "专题观察员" });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("feed_report_subscriber"),
      expect.arrayContaining([1749, 21]),
    );
  });

  it("supports JSON/English periods and defaults a NULL sender", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue([
        [{ email: "user@example.com", periods: '["Daily","Monthly"]', sender: null }],
        [],
      ]);

    const recipient = await resolveReportEmailRecipient({ execute } as unknown as mysql.Pool, {
      uid: 7,
      topicId: 9,
      slaveTopicId: 0,
      period: "Monthly",
    });

    expect(recipient).toEqual({ email: "user@example.com", sender: "观舆卫士" });
  });

  it("skips invalid email addresses and non-matching periods", async () => {
    const execute = vi.fn().mockResolvedValue([
      [
        { email: "bad\n@example.com", periods: "日报", sender: "Sender" },
        { email: "weekly@example.com", periods: "周报", sender: "Sender" },
      ],
      [],
    ]);

    const recipient = await resolveReportEmailRecipient({ execute } as unknown as mysql.Pool, {
      uid: 7,
      topicId: 9,
      slaveTopicId: 0,
      period: "Daily",
    });

    expect(recipient).toBeNull();
  });
});
