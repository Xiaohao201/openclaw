import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { loadSkillsFromDirSafe } from "./local-loader.js";

const skillDir = path.resolve("skills/infringement-judgment");

describe("bundled infringement judgment skill", () => {
  it("is discoverable as the built-in infringement workflow", async () => {
    const bundledSkillsDir = resolveBundledSkillsDir();
    expect(bundledSkillsDir).toBe(path.resolve("skills"));

    const { skills } = loadSkillsFromDirSafe({
      dir: bundledSkillsDir!,
      source: "openclaw-bundled",
    });

    const skill = skills.find((entry) => entry.name === "infringement-judgment");
    expect(skill).toBeDefined();
    expect(skill?.description).toContain("侵权研判与投诉通知");

    const content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    expect(content).toContain("逐句判定，禁止整篇定性");
    expect(content).toContain("事实主张 / 意见评价 / 情绪宣泄");
    expect(content).toContain("投诉通知模板");
  });
});
