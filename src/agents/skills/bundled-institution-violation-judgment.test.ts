import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { loadSkillsFromDirSafe } from "./local-loader.js";

const skillDir = path.resolve("skills/institution-violation-judgment");

describe("bundled institution violation judgment skill", () => {
  it("is discoverable and connects judgment to report and complaint actions", async () => {
    const bundledSkillsDir = resolveBundledSkillsDir();
    const { skills } = loadSkillsFromDirSafe({
      dir: bundledSkillsDir!,
      source: "openclaw-bundled",
    });

    const skill = skills.find((entry) => entry.name === "institution-violation-judgment");
    expect(skill).toBeDefined();
    expect(skill?.description).toContain("机构违规研判及举报");

    const content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    expect(content).toContain("建议立即举报");
    expect(content).toContain("建议补充证据后再举报");
    expect(content).toContain("建议暂不举报");
    expect(content).toContain("《网络信息内容生态治理规定》");
    expect(content).toContain("平台举报函");
    expect(content).toContain("300 字以内");
    expect(content).toContain("[举报](#lobster-report)");
    expect(content).toContain("[投诉](#lobster-complaint)");
    expect(content).toContain("[暂不处理](#lobster-dismiss)");
  });
});
