import { describe, expect, it } from "vitest";
import { parseMessage } from "./message-handler.js";

const buf = (obj: unknown): Buffer => Buffer.from(JSON.stringify(obj), "utf-8");

describe("parseMessage", () => {
  it("returns null for non-JSON input", () => {
    expect(parseMessage(Buffer.from("not json", "utf-8"))).toBeNull();
  });

  it("parses the flat format without a template_id (ordinary chat)", () => {
    const msg = parseMessage(buf({ id: 5, message: "hello", user_id: 42, session_id: "s1" }));
    expect(msg).not.toBeNull();
    expect(msg?.historyId).toBe(5);
    expect(msg?.message).toBe("hello");
    expect(msg?.userId).toBe("42");
    expect(msg?.templateId).toBeUndefined();
  });

  it("parses a numeric template_id in the flat format", () => {
    const msg = parseMessage(buf({ id: 5, message: "周报", user_id: 42, template_id: 7 }));
    expect(msg?.templateId).toBe(7);
  });

  it("coerces a numeric-string template_id (PHP/JSON producers vary)", () => {
    const msg = parseMessage(buf({ id: 5, message: "周报", user_id: 42, template_id: "7" }));
    expect(msg?.templateId).toBe(7);
  });

  it.each([0, -1, "", "abc", 3.5])("drops an invalid template_id %p", (value) => {
    const msg = parseMessage(buf({ id: 5, message: "x", user_id: 42, template_id: value }));
    expect(msg?.templateId).toBeUndefined();
  });

  it("reads template_id from the nested body (old format)", () => {
    const msg = parseMessage(
      buf({ id: 9, body: { message: "周报", user_id: 42, template_id: 12 } }),
    );
    expect(msg?.historyId).toBe(9);
    expect(msg?.message).toBe("周报");
    expect(msg?.templateId).toBe(12);
  });

  it("falls back to a top-level template_id when body omits it (old format)", () => {
    const msg = parseMessage(
      buf({ id: 9, template_id: 3, body: { message: "周报", user_id: 42 } }),
    );
    expect(msg?.templateId).toBe(3);
  });

  it("defaults hasAttachment to false when absent", () => {
    const msg = parseMessage(buf({ id: 5, message: "hello", user_id: 42 }));
    expect(msg?.hasAttachment).toBe(false);
  });

  it("parses has_attachment from the flat format", () => {
    const msg = parseMessage(
      buf({ id: 5, message: "分析这份表", user_id: 42, has_attachment: true }),
    );
    expect(msg?.hasAttachment).toBe(true);
  });

  it("reads has_attachment from the nested body (old format)", () => {
    const msg = parseMessage(
      buf({ id: 9, body: { message: "分析这份表", user_id: 42, has_attachment: true } }),
    );
    expect(msg?.hasAttachment).toBe(true);
  });

  it("parses a valid OSS attachment ref", () => {
    const att = {
      fileId: "abc",
      filename: "data.xlsx",
      ext: "xlsx",
      kind: "spreadsheet",
      storage: "oss",
      ref: "https://oss.leadingnews.cn/ibtai/lobster/attachments/2026/06/abc.xlsx",
      totalDataRows: 1234,
    };
    const msg = parseMessage(buf({ id: 5, message: "分析", user_id: 42, attachments: [att] }));
    expect(msg?.attachments).toHaveLength(1);
    expect(msg?.attachments?.[0].ref).toContain("abc.xlsx");
  });

  it("drops a malformed/stale attachment WITHOUT failing the whole message", () => {
    // Old inbox-format ref (storage:'inbox', non-url ref) must not drop the turn.
    const stale = {
      fileId: "x",
      filename: "f.xlsx",
      ext: "xlsx",
      kind: "spreadsheet",
      storage: "inbox",
      ref: "x.xlsx",
    };
    const msg = parseMessage(
      buf({ id: 5, message: "分析这份表", user_id: 42, attachments: [stale] }),
    );
    expect(msg).not.toBeNull();
    expect(msg?.message).toBe("分析这份表");
    expect(msg?.attachments).toBeUndefined();
  });

  it("keeps valid attachments and drops invalid ones in the same message", () => {
    const good = {
      fileId: "g",
      filename: "g.xlsx",
      ext: "xlsx",
      kind: "spreadsheet",
      storage: "oss",
      ref: "https://oss.leadingnews.cn/g.xlsx",
      totalDataRows: 10,
    };
    const bad = { fileId: "b", storage: "inbox" };
    const msg = parseMessage(buf({ id: 5, message: "m", user_id: 42, attachments: [good, bad] }));
    expect(msg?.attachments).toHaveLength(1);
    expect(msg?.attachments?.[0].fileId).toBe("g");
  });
});
