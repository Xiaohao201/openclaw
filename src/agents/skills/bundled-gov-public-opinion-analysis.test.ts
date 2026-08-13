import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { loadSkillsFromDirSafe } from "./local-loader.js";

const skillDir = path.resolve("skills/gov-public-opinion-analysis-agent");

describe("bundled government public-opinion analysis skill", () => {
  it("is discoverable with its complete V2 reference", async () => {
    const bundledSkillsDir = resolveBundledSkillsDir();
    expect(bundledSkillsDir).toBe(path.resolve("skills"));

    const { skills } = loadSkillsFromDirSafe({
      dir: bundledSkillsDir!,
      source: "openclaw-bundled",
    });

    const skill = skills.find((entry) => entry.name === "gov-public-opinion-analysis-agent");
    expect(skill).toBeDefined();
    expect(skill?.description).toContain("政务舆情分析报告");

    const content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    expect(content).toContain("references/government-public-opinion-analysis-v2.md");
    expect(content).toContain("必须检索公开网络信息");

    const reference = await fs.readFile(
      path.join(skillDir, "references/government-public-opinion-analysis-v2.md"),
      "utf8",
    );
    expect(reference).toContain("version: 2.0.0");
    expect(reference).toContain("# 政务舆情分析报告 Agent SKILL V2.0");
    expect(reference).toContain("# 12. 生成前强制内部检查清单");
  });
});
