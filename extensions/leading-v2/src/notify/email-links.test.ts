import { describe, expect, it } from "vitest";
import { normalizeEmailDownloadLinks } from "./email-links.js";

const base = "oss.ibtai.com/ibtai/assistant-agent/outputs/";
describe("normalizeEmailDownloadLinks", () => {
  it.each(["http", "https"])("corrects %s dates without changing URL bytes elsewhere", (scheme) => {
    const input = `${scheme}://${base}2026-10-29/1793236261_27d0a59f.pdf?Signature=a%2Fb+Z&x=1#page=2`;
    const expected = input.replace("2026-10-29", "2026/10/29");
    expect(normalizeEmailDownloadLinks(input)).toBe(expected);
    expect(normalizeEmailDownloadLinks(expected)).toBe(expected);
  });
  it("preserves Markdown, escaped filenames, punctuation and multiple links", () => {
    const url = `https://${base}2026-10-29/a\\_b.pdf`;
    const input = `[${url}](${url})，<${url}>\n${url}.`;
    expect(normalizeEmailDownloadLinks(input)).toBe(input.replaceAll("2026-10-29", "2026/10/29"));
  });
  it.each([
    "plain text",
    "",
    `https://${base}2026/10/29/a.pdf`,
    `https://${base}2026-2-03/a.pdf`,
    `https://${base}2026-02-30/a.pdf`,
    `https://${base}2025-02-29/a.pdf`,
    `https://${base}2026-13-01/a.pdf`,
    `https://${base}2026-00-01/a.pdf`,
    `https://${base}2026-10-00/a.pdf`,
    `https://${base}2026-10-29`,
    "https://example.com/ibtai/assistant-agent/outputs/2026-10-29/a.pdf",
    "https://oss.ibtai.com.evil.test/ibtai/assistant-agent/outputs/2026-10-29/a.pdf",
    "https://oss.ibtai.com@evil.test/ibtai/assistant-agent/outputs/2026-10-29/a.pdf",
    "https://oss.ibtai.com/ibtai-other/assistant-agent/outputs/2026-10-29/a.pdf",
    "https://oss.ibtai.com/ibtai/reports/2026-10-29/a.pdf",
    `https://example.com/?next=https://${base}2026-10-29/a.pdf`,
    `https://${base}2026/10/29/a.pdf?next=https://${base}2026-10-29/b.pdf`,
    `ftp://${base}2026-10-29/a.pdf`,
  ])("leaves unrelated or malformed content unchanged: %s", (input) => {
    expect(normalizeEmailDownloadLinks(input)).toBe(input);
  });
  it("accepts leap days", () => {
    expect(normalizeEmailDownloadLinks(`https://${base}2024-02-29/a.pdf`)).toBe(
      `https://${base}2024/02/29/a.pdf`,
    );
  });
});
