import { describe, expect, it } from "vitest";
import { parseLegacyReferences, resourceIndex, validateSkillResources } from "./skill-resources.js";

describe("skill resource contract", () => {
  it("keeps nested Unicode paths and sorts deterministically", () => {
    const resources = [
      { path: "references/项目.json", mediaType: "application/json", content: "{}" },
      { path: "assets/template.md", mediaType: "text/markdown", content: "# Report" },
    ];
    expect(validateSkillResources(resources)).toEqual(
      validateSkillResources(resources.toReversed()),
    );
    expect(validateSkillResources(resources)[1].path).toBe("references/项目.json");
  });
  it.each([
    "../escape.md",
    "/absolute.md",
    "C:/file.md",
    "a\\file.md",
    "a/../file.md",
    "SKILL.md",
    "a//file.md",
    "CON.md",
    "a./file.md",
    "notes.md/child.md",
  ])("rejects unsafe path %s", (path) => {
    expect(() =>
      validateSkillResources([{ path, mediaType: "text/markdown", content: "x" }]),
    ).toThrow();
  });
  it("rejects invalid content, type mismatches and case-insensitive collisions", () => {
    expect(() =>
      validateSkillResources([{ path: "a.json", mediaType: "application/json", content: "bad" }]),
    ).toThrow();
    expect(() =>
      validateSkillResources([{ path: "a.md", mediaType: "application/json", content: "{}" }]),
    ).toThrow();
    expect(() =>
      validateSkillResources([
        { path: "a.md", mediaType: "text/markdown", content: "x".repeat(1_048_577) },
      ]),
    ).toThrow();
    expect(() =>
      validateSkillResources(
        ["a.md", "A.md"].map((path) => ({ path, mediaType: "text/markdown", content: "x" })),
      ),
    ).toThrow();
  });
  it("preserves legacy text, URLs and unrecognized JSON without fetching", () => {
    expect(parseLegacyReferences("旧版参考说明")).toEqual({
      raw: "旧版参考说明",
      files: [],
      urls: [],
    });
    expect(parseLegacyReferences('["references/a.md","https://example.com/doc"]')).toEqual({
      raw: '["references/a.md","https://example.com/doc"]',
      files: ["references/a.md"],
      urls: ["https://example.com/doc"],
    });
    expect(parseLegacyReferences('{"unexpected":true}').raw).toBe('{"unexpected":true}');
    expect(parseLegacyReferences("a.md\nb.md").files).toEqual(["a.md", "b.md"]);
    expect(parseLegacyReferences(null)).toEqual({ raw: "", files: [], urls: [] });
  });
  it("provides a stable attachment index and explicitly identifies missing legacy files", () => {
    expect(resourceIndex([], null, [])).toBe("");
    const resources = validateSkillResources([
      { path: "references/a.md", mediaType: "text/markdown", content: "A" },
    ]);
    const text = resourceIndex(
      resources,
      '["references/a.md","old.txt","missing.md",{"url":"https://example.com"}]',
      ["old.txt"],
    );
    expect(text).toContain("[references/a.md](references/a.md)");
    expect(text).toContain("[old.txt](old.txt)");
    expect(text).toContain("Missing legacy attachment: missing.md");
    expect(text).toContain("https://example.com");
    expect(parseLegacyReferences('[{"url":"https://example.com"},null,{},7]').urls).toEqual([
      "https://example.com",
    ]);
  });
  it("bounds collection size and rejects invalid resource shapes", () => {
    for (const input of [
      null,
      {},
      [null],
      [[]],
      [{ path: 4 }],
      [{ path: "a.exe", mediaType: "text/plain", content: "x" }],
    ]) {
      expect(() => validateSkillResources(input)).toThrow();
    }
    expect(() =>
      validateSkillResources(
        Array.from({ length: 65 }, (_, i) => ({
          path: `${i}.md`,
          mediaType: "text/markdown",
          content: "x",
        })),
      ),
    ).toThrow();
    expect(() =>
      validateSkillResources(
        Array.from({ length: 5 }, (_, i) => ({
          path: `${i}.md`,
          mediaType: "text/markdown",
          content: "x".repeat(1_048_576),
        })),
      ),
    ).toThrow();
  });
});
