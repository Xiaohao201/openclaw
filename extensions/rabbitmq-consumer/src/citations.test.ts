import { describe, expect, it } from "vitest";
import {
  buildCitationDirective,
  CITATIONS_MARKER,
  hasCitationsMarker,
  splitCitations,
} from "./citations.js";

describe("splitCitations", () => {
  it("returns the whole text with no citations when the marker is absent", () => {
    const text = "深圳今天天气不错，水在标准大气压下沸点是 100℃。";
    expect(splitCitations(text)).toEqual({ text, citations: [] });
  });

  it("splits the visible answer from the JSON block and parses sources", () => {
    const full =
      "深圳市交通运输局发布了针对柴油货车的限行管制政策[1]。\n\n" +
      `${CITATIONS_MARKER}\n` +
      '[{"id":1,"title":"深圳市交通运输局通告","url":"https://sz.gov.cn/x","snippet":"自2026年起限行..."}]';
    const { text, citations } = splitCitations(full);
    expect(text).toBe("深圳市交通运输局发布了针对柴油货车的限行管制政策[1]。");
    expect(citations).toEqual([
      {
        id: 1,
        title: "深圳市交通运输局通告",
        url: "https://sz.gov.cn/x",
        snippet: "自2026年起限行...",
      },
    ]);
  });

  it("tolerates a ```json code fence around the array", () => {
    const full =
      `答案[1]。\n${CITATIONS_MARKER}\n` +
      '```json\n[{"id":1,"title":"T","url":"https://a.com","snippet":"s"}]\n```';
    const { citations } = splitCitations(full);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.url).toBe("https://a.com");
  });

  it("drops entries without a valid http(s) url", () => {
    const full =
      `答案。\n${CITATIONS_MARKER}\n` +
      '[{"id":1,"title":"good","url":"https://a.com","snippet":""},' +
      '{"id":2,"title":"bad path","url":"memory/x.md","snippet":""},' +
      '{"id":3,"title":"no url","snippet":""}]';
    const { citations } = splitCitations(full);
    expect(citations.map((c) => c.url)).toEqual(["https://a.com"]);
  });

  it("dedupes by url (ignoring a trailing slash) and keeps the first", () => {
    const full =
      `答案。\n${CITATIONS_MARKER}\n` +
      '[{"id":1,"title":"first","url":"https://a.com/","snippet":"one"},' +
      '{"id":2,"title":"dup","url":"https://a.com","snippet":"two"}]';
    const { citations } = splitCitations(full);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.title).toBe("first");
  });

  it("assigns a sequential id when the model omits or dups ids", () => {
    const full =
      `答案。\n${CITATIONS_MARKER}\n` +
      '[{"title":"a","url":"https://a.com","snippet":""},' +
      '{"id":1,"title":"b","url":"https://b.com","snippet":""}]';
    const { citations } = splitCitations(full);
    // first has no id → 1; second wants 1 but it is taken → next free id.
    expect(citations.map((c) => c.id)).toEqual([1, 2]);
  });

  it("applies the Route-A allowlist when provided", () => {
    const full =
      `答案。\n${CITATIONS_MARKER}\n` +
      '[{"id":1,"title":"seen","url":"https://a.com","snippet":""},' +
      '{"id":2,"title":"hallucinated","url":"https://evil.com","snippet":""}]';
    const { citations } = splitCitations(full, new Set(["https://a.com"]));
    expect(citations.map((c) => c.url)).toEqual(["https://a.com"]);
  });

  it("returns no citations when the block is malformed", () => {
    const full = `答案[1]。\n${CITATIONS_MARKER}\nnot json at all`;
    const { text, citations } = splitCitations(full);
    expect(text).toBe("答案[1]。");
    expect(citations).toEqual([]);
  });
});

describe("hasCitationsMarker", () => {
  it("detects the sentinel", () => {
    expect(hasCitationsMarker(`x ${CITATIONS_MARKER} y`)).toBe(true);
    expect(hasCitationsMarker("no marker here")).toBe(false);
  });
});

describe("buildCitationDirective", () => {
  it("includes the sentinel and the citing rules", () => {
    const d = buildCitationDirective();
    expect(d).toContain(CITATIONS_MARKER);
    expect(d).toContain("外部事实");
    expect(d).toContain("政策法规");
    expect(d).toContain("https://");
  });
});
