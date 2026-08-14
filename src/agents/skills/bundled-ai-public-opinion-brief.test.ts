import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { loadSkillsFromDirSafe } from "./local-loader.js";

const skillDir = path.resolve("skills/ai-public-opinion-brief");

describe("bundled AI public-opinion brief skill", () => {
  it("is discoverable with the complete V2 brief specification", async () => {
    const bundledSkillsDir = resolveBundledSkillsDir();
    const { skills } = loadSkillsFromDirSafe({
      dir: bundledSkillsDir!,
      source: "openclaw-bundled",
    });

    const skill = skills.find((entry) => entry.name === "ai-public-opinion-brief");
    expect(skill).toBeDefined();
    expect(skill?.description).toContain("AI舆情速报");

    const content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    expect(content).toContain("references/ai-public-opinion-brief-v2.md");
    expect(content).toContain("默认检索公开网络信息");
    expect(content).toContain("不得编造");

    const reference = await fs.readFile(
      path.join(skillDir, "references/ai-public-opinion-brief-v2.md"),
      "utf8",
    );
    expect(reference).toContain("version: 2.0.0");
    expect(reference).toContain("# AI舆情速报 Skill V2.0");
    expect(reference).toContain("一、基本情况及热度");
    expect(reference).toContain("二、传播情况");
    expect(reference).toContain("三、工作情况");
    expect(reference).toContain("四、下一步工作");
    expect(reference).toContain("据反馈，（）。");
    expect(reference).toContain("第一优先级：事实不能编造");

    const metadata = await fs.readFile(path.join(skillDir, "agents/openai.yaml"), "utf8");
    expect(metadata).toContain('display_name: "舆情速报"');
    expect(metadata).toContain("$ai-public-opinion-brief");
  });
});
