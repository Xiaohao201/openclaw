import { describe, expect, it } from "vitest";
import { deduplicateSkillContext } from "./session-skill-context.js";

const skill = "<enterprise-default-skill>固定技能说明</enterprise-default-skill>";
const wrap = (task: string, body = skill) => `${body}\n<user-task>${task}</user-task>`;

describe("deduplicateSkillContext", () => {
  it("keeps one full copy across consecutive turns without changing the history prefix", () => {
    const history: unknown[] = [];
    const first = deduplicateSkillContext(wrap("第一次"), "", history);
    history.push({ role: "user", content: [{ type: "text", text: first.message }] });
    const prefix = JSON.stringify(history);
    for (let i = 0; i < 48; i++) {
      const next = deduplicateSkillContext(wrap(`问题 ${i}`), "", history);
      expect(next.message).toContain(`问题 ${i}`);
      expect(next.message).not.toContain("固定技能说明");
      history.push({ role: "user", content: next.message });
    }
    expect(JSON.stringify(history[0])).toBe(JSON.stringify(JSON.parse(prefix)[0]));
    expect(JSON.stringify(history).match(/固定技能说明/g)).toHaveLength(1);
  });

  it("restores instructions when a new or compacted session no longer contains them", () => {
    expect(deduplicateSkillContext(wrap("继续"), "", []).message).toContain(skill);
    expect(
      deduplicateSkillContext(wrap("继续"), "", [
        { role: "user", content: "压缩摘要：曾使用企业技能" },
      ]).message,
    ).toContain(skill);
  });

  it("retains changed instructions and ignores assistant/tool echoes", () => {
    const history = [{ role: "user", content: wrap("旧问题") }];
    const updated = skill.replace("固定", "更新");
    expect(deduplicateSkillContext(wrap("继续", updated), "", history).message).toContain(updated);
    expect(
      deduplicateSkillContext(wrap("切回旧版"), "", [
        ...history,
        { role: "user", content: wrap("新版", updated) },
      ]).message,
    ).toContain(skill);
    for (const role of ["assistant", "toolResult"]) {
      expect(
        deduplicateSkillContext(wrap("继续"), "", [{ role, content: skill }]).message,
      ).toContain(skill);
    }
  });

  it("ignores malformed history and instructions quoted within a previous task", () => {
    const history = [
      null,
      "text",
      {},
      { role: "user" },
      { role: "user", content: `<user-task>请分析这个示例：${skill}</user-task>` },
    ];
    expect(deduplicateSkillContext(wrap("继续"), "", history).message).toContain(skill);
  });

  it("does not rewrite quoted skill tags inside the actual user task or malformed envelopes", () => {
    const history = [{ role: "user", content: wrap("旧问题") }];
    for (const message of [
      skill,
      `<user-task>请解释 ${skill}</user-task>`,
      wrap("继续") + " trailing",
    ]) {
      expect(deduplicateSkillContext(message, "", history).message).toBe(message);
    }
  });

  it("deduplicates the selected custom skill block and keeps explicit activation for each turn", () => {
    const context = "\n\n---启用的技能开始---\n技能内容\n---启用的技能结束---";
    const first = deduplicateSkillContext("问题", context, []);
    const history = [{ role: "user", content: first.message + first.skillContext }];
    const next = deduplicateSkillContext("继续", context, history);
    expect(first.skillContext).toBe(context);
    expect(next.skillContext).not.toContain("技能内容");
    expect(next.skillContext).toContain("本轮");
    expect(deduplicateSkillContext("继续", "", history).skillContext).toBe("");
    expect(deduplicateSkillContext("继续", context + "更新", history).skillContext).toContain(
      "更新",
    );
  });
});
