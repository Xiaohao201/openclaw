import { describe, expect, it } from "vitest";
import { mediaLinesToMarkdown, pendingMediaLineLen } from "./media-lines.js";

const OSS_PNG =
  "https://oss.ibtai.com/ibtai/assistant-agent/outputs/2026/8/3/1785754614_5ff02a85.png";

describe("mediaLinesToMarkdown", () => {
  it("renders an image directive inline so the customer actually sees the chart", () => {
    // The exact shape of the undelivered reply (history_messages id 1955).
    expect(mediaLinesToMarkdown(`MEDIA:${OSS_PNG}`)).toBe(`![](${OSS_PNG})`);
  });

  it("keeps the surrounding answer intact", () => {
    const input = ["已生成发布时间趋势图。", "", `MEDIA:${OSS_PNG}`].join("\n");
    expect(mediaLinesToMarkdown(input)).toBe(
      ["已生成发布时间趋势图。", "", `![](${OSS_PNG})`].join("\n"),
    );
  });

  it("uses a meaningful filename as alt text but drops opaque machine names", () => {
    const named = "https://oss.ibtai.com/out/发布时间趋势.png";
    expect(mediaLinesToMarkdown(`MEDIA:${named}`)).toBe(`![发布时间趋势](${named})`);
    expect(mediaLinesToMarkdown(`MEDIA:${OSS_PNG}`)).toBe(`![](${OSS_PNG})`);
  });

  it("links non-image files instead of embedding them", () => {
    const doc = "https://oss.ibtai.com/out/舆情周报.docx";
    expect(mediaLinesToMarkdown(`MEDIA:${doc}`)).toBe(`[舆情周报](${doc})`);
  });

  it("drops local paths: the browser cannot reach them and they leak internals", () => {
    expect(mediaLinesToMarkdown("正文\nMEDIA:./charts/trend.png")).toBe("正文");
    expect(mediaLinesToMarkdown("正文\nMEDIA:/root/.openclaw/workspace/a.png")).toBe("正文");
  });

  it("does not duplicate an image the reply already renders as markdown", () => {
    const input = `![趋势图](${OSS_PNG})\n\nMEDIA:${OSS_PNG}`;
    expect(mediaLinesToMarkdown(input)).toBe(`![趋势图](${OSS_PNG})\n`);
  });

  it("leaves directives inside fenced code blocks literal", () => {
    const input = ["用法：", "```", `MEDIA:${OSS_PNG}`, "```"].join("\n");
    expect(mediaLinesToMarkdown(input)).toBe(input);
  });

  it("ignores prose that merely mentions the word", () => {
    const input = "social MEDIA: 微博与抖音的传播量";
    expect(mediaLinesToMarkdown(input)).toBe(input);
  });

  it("tolerates indentation and mixed case", () => {
    expect(mediaLinesToMarkdown(`  media:${OSS_PNG}  `)).toBe(`![](${OSS_PNG})`);
  });

  it("passes through text with no directive untouched", () => {
    expect(mediaLinesToMarkdown("普通回复，没有附件。")).toBe("普通回复，没有附件。");
    expect(mediaLinesToMarkdown("")).toBe("");
  });
});

describe("pendingMediaLineLen", () => {
  it("holds back a directive whose URL is still arriving", () => {
    // The observed truncation: the客户 saw "MEDIA:https" and never the rest.
    const chunk = "now convert to PNG:\nMEDIA:https";
    expect(pendingMediaLineLen(chunk)).toBe("MEDIA:https".length);
  });

  it("holds back a partial spelling of the word itself", () => {
    expect(pendingMediaLineLen("正文\nMED")).toBe(3);
    expect(pendingMediaLineLen("正文\nMEDIA:")).toBe(6);
  });

  it("releases the line once its newline arrives", () => {
    expect(pendingMediaLineLen(`MEDIA:${OSS_PNG}\n`)).toBe(0);
  });

  it("does not hold back ordinary prose", () => {
    expect(pendingMediaLineLen("正文\n目前监测到 12 条")).toBe(0);
    expect(pendingMediaLineLen("Monitoring shows")).toBe(0);
    expect(pendingMediaLineLen("")).toBe(0);
  });
});
