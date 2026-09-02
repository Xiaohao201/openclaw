import { describe, expect, it } from "vitest";
import {
  normalizeChineseProseQuotes,
  sanitizeInternalRefs,
  stripInternalRefs,
} from "./sanitize-output.js";

describe("normalizeChineseProseQuotes", () => {
  it("converts adjacent straight-quoted phrases to paired Chinese quotes", () => {
    expect(
      normalizeChineseProseQuotes(
        '弱势群体叙事自带燃点，"残疾夫妻""脑瘫女孩住桥洞两年""城管扣车致贷款用光"。',
      ),
    ).toBe("弱势群体叙事自带燃点，“残疾夫妻”“脑瘫女孩住桥洞两年”“城管扣车致贷款用光”。");
  });

  it("leaves code, JSON, HTML attributes, and Markdown link destinations unchanged", () => {
    const input = [
      '正文中的"重点人群"需要关注。',
      '`const label = "重点人群";`',
      "```json",
      '{"标题":"重点人群"}',
      "```",
      '<span title="重点人群">说明</span>',
      '[查看详情](https://example.com "重点人群")',
    ].join("\n");

    expect(normalizeChineseProseQuotes(input)).toBe(
      [
        "正文中的“重点人群”需要关注。",
        '`const label = "重点人群";`',
        "```json",
        '{"标题":"重点人群"}',
        "```",
        '<span title="重点人群">说明</span>',
        '[查看详情](https://example.com "重点人群")',
      ].join("\n"),
    );
  });

  it("keeps unmatched and escaped straight quotes untouched", () => {
    expect(normalizeChineseProseQuotes('未闭合"重点；转义\\"重点\\"。')).toBe(
      '未闭合"重点；转义\\"重点\\"。',
    );
  });

  it("handles nested link destinations, multi-backtick code, and tilde fences", () => {
    const input = [
      '链接[详情](https://example.com/a_(b) "标题")，正文"重点"。',
      '代码 ``const label = "重点";``，正文"结论"。',
      "~~~~md",
      '围栏中的"原样内容"',
      "~~~~",
    ].join("\r\n");

    expect(normalizeChineseProseQuotes(input)).toBe(
      [
        '链接[详情](https://example.com/a_(b) "标题")，正文“重点”。',
        '代码 ``const label = "重点";``，正文“结论”。',
        "~~~~md",
        '围栏中的"原样内容"',
        "~~~~",
      ].join("\r\n"),
    );
  });

  it("preserves structured lines and treats malformed markup as prose", () => {
    const input = [
      '{"标题":"重点"}',
      '["重点"]',
      '"标题": "重点"',
      'title: "重点"',
      'items: ["重点"]',
      '未闭合链接](https://example.com/a_(b "标题"',
      '<span title="重点"，正文"结论"',
    ].join("\n");

    expect(normalizeChineseProseQuotes(input)).toBe(
      [
        '{"标题":"重点"}',
        '["重点"]',
        '"标题": "重点"',
        'title: "重点"',
        'items: ["重点"]',
        "未闭合链接](https://example.com/a_(b “标题”",
        "<span title=“重点”，正文“结论”",
      ].join("\n"),
    );
    expect(normalizeChineseProseQuotes("没有英文双引号")).toBe("没有英文双引号");
    expect((normalizeChineseProseQuotes as (value: unknown) => string)(undefined)).toBe("");
  });
});

describe("sanitizeInternalRefs", () => {
  it("removes a backticked workspace path together with its lead-in verb", () => {
    const input = "处置方案已整理完成，保存在 `memory/2026-06-09-深圳农行车贷投诉处置方案.md`。";
    const out = sanitizeInternalRefs(input);
    expect(out).toBe("处置方案已整理完成。");
    expect(out).not.toContain("memory/");
    expect(out).not.toContain("`");
  });

  it("handles other lead-in verbs (位于 / 路径)", () => {
    expect(sanitizeInternalRefs("报告位于 `templates/weekly.md`，请查收。")).toBe("报告，请查收。");
    expect(sanitizeInternalRefs("路径为 `workspace/state/run.json`")).toBe("");
  });

  it("strips a bare (un-backticked) internal path", () => {
    const out = sanitizeInternalRefs("已写入 memory/2026-06-09.md 完成");
    expect(out).not.toContain("memory/");
    expect(out).toContain("已写入");
    expect(out).toContain("完成");
  });

  it("strips the runtime root path", () => {
    expect(sanitizeInternalRefs("凭证在 ~/.openclaw/credentials/web.json 里")).not.toContain(
      ".openclaw",
    );
  });

  it("removes the injected pipeline context prefixes", () => {
    const input = '[userId:126] [topicId:42 topicName:"农行"] 您好';
    const out = sanitizeInternalRefs(input);
    expect(out).toBe("您好");
  });

  it("removes per-user agent session keys and ids", () => {
    expect(sanitizeInternalRefs("run agent:rabbitmq-126:rabbitmq:126:abc done")).toBe("run done");
    expect(sanitizeInternalRefs("由 rabbitmq-962 处理")).toBe("由 处理");
  });

  it("does NOT mangle a legitimate customer article URL", () => {
    const url = "详情见 https://weibo.com/u/123/sessions/456 报道";
    expect(sanitizeInternalRefs(url)).toBe(url);
  });

  it("does NOT mangle an OSS file delivery link (file_share output)", () => {
    // The file_share tool's whole purpose is putting this URL in the reply;
    // sanitization must never strip or truncate it.
    const reply =
      "文件已生成，点击下载：\n" +
      "https://oss.ibtai.com/ibtai/assistant-agent/outputs/2026/6/12/1781234567_a3f8c21e.docx\n" +
      "（链接长期有效）";
    expect(sanitizeInternalRefs(reply)).toBe(reply);
  });

  it("leaves ordinary prose untouched", () => {
    const prose = "本周舆情整体平稳，负面提及 12 条，建议持续关注。";
    expect(sanitizeInternalRefs(prose)).toBe(prose);
  });

  it("is a no-op on empty input", () => {
    expect(sanitizeInternalRefs("")).toBe("");
  });

  it("never throws on non-string input (defensive)", () => {
    // A raw content-block array used to crash the pipeline via .replace.
    expect(() => sanitizeInternalRefs([{ text: "x" }] as never)).not.toThrow();
    expect(sanitizeInternalRefs([{ text: "x" }] as never)).toBe("");
    expect(sanitizeInternalRefs(null as never)).toBe("");
    expect(sanitizeInternalRefs(undefined as never)).toBe("");
  });

  it("collapses whitespace and dangling punctuation left by removals", () => {
    const out = sanitizeInternalRefs("结论：A。\n\n\n保存在 `memory/x.md`。\n\n下一步：B。");
    expect(out).not.toContain("memory");
    expect(out).not.toMatch(/\n{3,}/);
    expect(out).toContain("结论：A。");
    expect(out).toContain("下一步：B。");
    // The sentence that was nothing but a path leaves no dangling "。" line.
    expect(out).not.toMatch(/(^|\n)。(\n|$)/);
  });
});

describe("stripInternalRefs", () => {
  it("strips internal refs but PRESERVES surrounding whitespace (no trim/tidy)", () => {
    // This is the streaming-safe variant: it must never touch boundary whitespace.
    expect(stripInternalRefs("\n\n### ")).toBe("\n\n### ");
    expect(stripInternalRefs("环节\n\n")).toBe("环节\n\n");
    expect(stripInternalRefs("  leading and trailing  ")).toBe("  leading and trailing  ");
    expect(stripInternalRefs("a\n\n\n\nb")).toBe("a\n\n\n\nb"); // 4 newlines NOT collapsed
  });

  it("still removes internal paths / injected context / session keys", () => {
    expect(stripInternalRefs("见 `memory/x.md` 完成")).not.toContain("memory");
    expect(stripInternalRefs("ctx [userId:42] 你好")).not.toContain("userId");
    expect(stripInternalRefs("run agent:rabbitmq-1:rabbitmq:1:abc done")).not.toContain("agent:");
  });

  it("is whitespace-boundary-safe across an adversarially split block boundary", () => {
    // The exact failure mode: a flush boundary on the blank line / heading space.
    // Stripping each fragment then rejoining must equal the original document.
    const doc = "环节\n\n### 10. 港大深圳医院";
    const a = stripInternalRefs("环节\n\n") + stripInternalRefs("### 10. 港大深圳医院");
    const b = stripInternalRefs("环节\n\n### ") + stripInternalRefs("10. 港大深圳医院");
    expect(a).toBe(doc);
    expect(b).toBe(doc);
  });

  it("returns empty string for non-string input without throwing", () => {
    expect(() => stripInternalRefs([{ text: "x" }] as never)).not.toThrow();
    expect(stripInternalRefs(null as never)).toBe("");
    expect(stripInternalRefs(undefined as never)).toBe("");
  });
});
