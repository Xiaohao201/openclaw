import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { loadSkillsFromDirSafe } from "./local-loader.js";

const skillDir = path.resolve("skills/ai-public-opinion-brief");

describe("bundled AI public-opinion brief skill", () => {
  it("is discoverable with the complete V3.2 brief specification", async () => {
    const bundledSkillsDir = resolveBundledSkillsDir();
    const { skills } = loadSkillsFromDirSafe({
      dir: bundledSkillsDir!,
      source: "openclaw-bundled",
    });

    const skill = skills.find((entry) => entry.name === "ai-public-opinion-brief");
    expect(skill).toBeDefined();
    expect(skill?.description).toContain("AI舆情速报");

    const content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    expect(content).toContain("references/ai-public-opinion-brief-v3.2.md");
    expect(content).not.toContain("ai-public-opinion-brief-v2.md");
    expect(content).toContain("默认检索公开网络信息");
    expect(content).toContain("不得编造");
    expect(content).toContain("后台分析 → 锁定槽位 → 模板渲染");
    expect(content).toContain("references/leadership-approved-examples.md");
    expect(content).toContain("不得复用其中的事件事实");
    expect(content).toContain("突发或时效敏感事实必须执行双轨检索");

    await expect(
      fs.access(path.join(skillDir, "references/ai-public-opinion-brief-v2.md")),
    ).rejects.toThrow();

    const reference = await fs.readFile(
      path.join(skillDir, "references/ai-public-opinion-brief-v3.2.md"),
      "utf8",
    );
    expect(reference).toContain("version: 3.2.0");
    expect(reference).toContain("# AI舆情速报 Skill V3.2");
    expect(reference).toContain("阶段A：后台分析");
    expect(reference).toContain("阶段B：锁定槽位");
    expect(reference).toContain("阶段C：按领导审定模板渲染成稿");
    expect(reference).toContain("# 16. 模板A｜3部分简版");
    expect(reference).toContain("# 17. 模板B｜4部分完整版");
    for (let section = 0; section <= 62; section += 1) {
      expect(reference).toMatch(new RegExp(`^# ${section}\\. `, "m"));
    }
    expect(reference).toContain("一、基本情况及热度");
    expect(reference).toContain("二、传播情况");
    expect(reference).toContain("三、工作情况");
    expect(reference).toContain("四、下一步工作");
    expect(reference).toContain("后台分析不是正文素材");
    expect(reference).toContain("平台不是媒体，转载不是报道，自媒体不计入媒体");
    expect(reference).toContain("freshness=day");
    expect(reference).toContain("count=10");
    expect(reference).toContain("不限定时间的权威来源检索");
    expect(reference).toContain("按 URL 去重");
    expect(reference).toContain("最新结果优先");
    expect(reference).toContain("至少打开 2—3 条最新结果原文");
    expect(reference).toContain("“未检索到”不等于“未发生”");

    const examples = await fs.readFile(
      path.join(skillDir, "references/leadership-approved-examples.md"),
      "utf8",
    );
    expect(examples).toContain("case_count: 5");
    expect(examples).toContain("anonymized: true");
    expect(examples).toContain("案例不是事实库");
    expect(examples.match(/^【舆情(?:速报|续报)】/gm)).toHaveLength(5);
    const expectedExampleHeadings = [
      "## 案例一｜一般民生/经营风险，3 部分简版",
      "## 案例二｜线下维权/敏感现场，3 部分简版",
      "## 案例三｜重要会议/重大活动，3 部分简版",
      "## 案例四｜重要会议/重大活动，4 部分续报",
      "## 案例五｜劳动权益/职场舆情，4 部分完整版",
    ];
    for (const heading of expectedExampleHeadings) {
      expect(examples).toContain(heading);
    }
    const exampleBlocks = Array.from(
      examples.matchAll(/```text\n([\s\S]*?)\n```/g),
      (match) => match[1],
    );
    expect(exampleBlocks).toHaveLength(5);
    for (const [index, block] of exampleBlocks.entries()) {
      expect(block.match(/^[一二三四]、/gm)).toHaveLength(index < 3 ? 3 : 4);
    }
    expect(examples).not.toMatch(/weibo\.com|douyin\.com|toutiao\.com|iesdouyin\.com/);

    const metadata = await fs.readFile(path.join(skillDir, "agents/openai.yaml"), "utf8");
    expect(metadata).toContain('display_name: "舆情速报"');
    expect(metadata).toContain("$ai-public-opinion-brief");
  });
});
