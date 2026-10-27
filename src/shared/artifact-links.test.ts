import { describe, expect, it } from "vitest";
import { artifactStreamPrefixLength, ArtifactLinks } from "./artifact-links.js";

const url =
  "https://oss.ibtai.com/ibtai/assistant-agent/outputs/2026/10/10/1791597127_56006919.html";
const wrong = url.replace("2026/10/10", "2026-10-10");
const result = (link = url) => ({ details: { ok: true, url: link, filename: "报告.html" } });

describe("ArtifactLinks", () => {
  it("releases ordinary prose while holding every possible URL prefix", () => {
    expect(artifactStreamPrefixLength("正文还在生成")).toBe(6);
    for (const prefix of [
      "h",
      "ht",
      "htt",
      "http",
      "https",
      "http:",
      "https:",
      "http:/",
      "https:/",
      "https://oss.",
    ]) {
      expect(artifactStreamPrefixLength(`正文\n下载：${prefix}`)).toBe(6);
    }
    expect(artifactStreamPrefixLength("正文[下载](")).toBe(2);
  });

  it("ignores malformed, failed and unsafe upload payloads", () => {
    const links = new ArtifactLinks("invalid domain");
    for (const value of [
      null,
      [],
      {},
      { details: { ok: false, url } },
      { details: { ok: true, url: "bad" } },
      { details: { ok: true, url: "javascript:alert(1)" } },
      { details: { ok: true, url: "https://user:password@example.com/out" } },
      { details: { ok: true, url: `${url}\n` } },
      { content: [{ type: "text", text: "bad json" }] },
      { content: [{ type: "text", text: "null" }] },
    ]) {
      links.observeToolEvent({ phase: "result", name: "file_share", result: value });
    }
    links.observeToolEvent(null);
    links.observeMessages([
      null,
      { role: "toolResult", toolName: "file_share", isError: true, ...result() },
    ]);
    expect(links.deliveryLinks()).toBe("");
    expect(links.sanitize(url)).toBe("（下载链接未核验）");
  });

  it("does not share evidence between sessions and escapes attachment labels", () => {
    const links = new ArtifactLinks();
    links.observeToolEvent({
      phase: "result",
      name: "file_share",
      result: { details: { ok: true, url, filename: "[报告]\n.html" } },
    });
    expect(links.deliveryLinks()).toContain("\\[报告\\] .html");
    expect(new ArtifactLinks().sanitize(url)).toBe("（下载链接未核验）");
    expect(links.sanitize(url.replace("https:", "http:"))).toBe(url);
    expect(links.sanitize(`![图表](${url})`)).toBe(`![图表](${url})`);
    expect(links.sanitize("[网站](https://example.com)")).toBe("[网站](https://example.com)");
  });
  it("repairs only uniquely identified uploads and preserves exact returned bytes", () => {
    const links = new ArtifactLinks();
    links.observeToolEvent({ phase: "result", name: "file_share", result: result() });
    expect(links.sanitize(`[下载](<${wrong} >)`)).toBe(`[下载](${url})`);
    expect(links.sanitize(wrong.replace("_", "\\_"))).toBe(url);
    expect(links.sanitize(url)).toBe(url);
    expect(links.sanitize(`${wrong}.`)).toBe(`${url}.`);
    expect(links.sanitize(`${url.replace("56006919", "missing")}.`)).toBe("（下载链接未核验）.");
    expect(links.deliveryLinks()).toContain(`[报告.html](${url})`);
  });

  it("blocks unknown and ambiguous artifact links, without rewriting external links", () => {
    const links = new ArtifactLinks();
    expect(links.sanitize(`[下载](${wrong})`)).toBe("下载（下载链接未核验）");
    expect(links.sanitize("https://example.com/2026-10-10/file.html")).toBe(
      "https://example.com/2026-10-10/file.html",
    );
    links.observeToolEvent({ phase: "result", name: "file_share", result: result() });
    links.observeToolEvent({
      phase: "result",
      name: "file_share",
      result: result(url.replace("/10/10/", "/10/9/")),
    });
    expect(links.sanitize(wrong)).toBe("（下载链接未核验）");
  });

  it("does not trust failed tools, other tools, or assistant history", () => {
    const links = new ArtifactLinks();
    links.observeToolEvent({ phase: "result", name: "exec", result: result() });
    links.observeToolEvent({
      phase: "result",
      name: "file_share",
      isError: true,
      result: result(),
    });
    links.observeToolEvent({ phase: "start", name: "file_share", result: result() });
    links.observeMessages([{ role: "assistant", content: url }]);
    expect(links.sanitize(url)).toBe("（下载链接未核验）");
    expect(links.deliveryLinks()).toBe("");
  });

  it("restores trusted session tool results without redelivering old files", () => {
    const links = new ArtifactLinks();
    links.observeMessages([
      {
        role: "toolResult",
        toolName: "file_share",
        content: [{ type: "text", text: JSON.stringify(result().details) }],
      },
    ]);
    expect(links.sanitize(wrong)).toBe(url);
    expect(links.deliveryLinks()).toBe("");
    const next = url.replace("56006919", "abcdef12");
    links.observeMessages(
      [{ role: "toolResult", toolName: "file_share", details: { ok: true, url: next } }],
      true,
    );
    expect(links.deliveryLinks()).toContain(`[下载文件](${next})`);
    expect(links.deliveryLinks()).not.toContain(url);
  });

  it("keeps signatures and supports configured storage locations and chart results", () => {
    const links = new ArtifactLinks("https://files.example.com", "exports");
    const signed = "https://files.example.com/exports/2026/1/2/chart.png?sig=a%2Fb&expires=42";
    links.observeToolEvent({
      phase: "result",
      name: "chart_render",
      result: {
        content: [
          { type: "text", text: JSON.stringify({ ok: true, url: signed, filename: "图表.png" }) },
        ],
      },
    });
    expect(links.sanitize(signed.replace("2026/1/2", "2026-01-02"))).toBe(signed);
    expect(links.deliveryLinks()).toContain(signed);
    expect(links.sanitize("https://files.example.com/exports/unknown.png")).toBe(
      "（下载链接未核验）",
    );
  });
});
