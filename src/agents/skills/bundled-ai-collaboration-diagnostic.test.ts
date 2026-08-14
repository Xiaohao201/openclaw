import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { loadSkillsFromDirSafe } from "./local-loader.js";

const skillDir = path.resolve("skills/ai-collaboration-diagnostic");

describe("bundled AI collaboration diagnostic skill", () => {
  it("is discoverable with the complete behavior-profile contract", async () => {
    const bundledSkillsDir = resolveBundledSkillsDir();
    const { skills } = loadSkillsFromDirSafe({
      dir: bundledSkillsDir!,
      source: "openclaw-bundled",
    });

    const skill = skills.find((entry) => entry.name === "ai-collaboration-diagnostic");
    expect(skill).toBeDefined();
    expect(skill?.description).toContain("AI协作力诊断");

    const content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    expect(content).toContain("特定时间段");
    expect(content).toContain("使用频度");
    expect(content).toContain("关系密切程度");
    expect(content).toContain("新的工作使用场景");
    expect(content).toContain("高价值提问");
    expect(content).toContain("夙衡赠言");
    expect(content).toContain("不得输出任何信息安全、保密");
    expect(content).toContain("只能依据可见对话记录");
    expect(content).toContain("sessions_list");
    expect(content).toContain("sessions_history");

    const metadata = await fs.readFile(path.join(skillDir, "agents/openai.yaml"), "utf8");
    expect(metadata).toContain('display_name: "AI协作力诊断"');
    expect(metadata).toContain("$ai-collaboration-diagnostic");
  });
});
