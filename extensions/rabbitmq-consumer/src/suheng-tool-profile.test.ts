import { describe, expect, it } from "vitest";
import { resolveSuhengToolsAllow } from "./suheng-tool-profile.js";

describe("resolveSuhengToolsAllow", () => {
  it("keeps ordinary monitoring turns on a compact evidence toolset", () => {
    const tools = resolveSuhengToolsAllow("查询今天有哪些高风险舆情");

    expect(tools).toEqual(tools.toSorted());
    expect(tools).toEqual(
      expect.arrayContaining(["feed_query", "full_text_search", "risk_judge", "web_search"]),
    );
    expect(tools).not.toContain("schedule_create");
    expect(tools).not.toContain("infringe_complaint_submit");
    expect(tools).not.toContain("video_generate");
  });

  it("adds report and artifact tools only for report creation", () => {
    const tools = resolveSuhengToolsAllow("生成本月舆情报告和可视化图表");

    expect(tools).toEqual(
      expect.arrayContaining([
        "chart_render",
        "file_share",
        "monthly_stats",
        "read",
        "sheet_report_create",
        "write",
      ]),
    );
    expect(tools).not.toContain("music_generate");
  });

  it("adds only the relevant transactional family for complaint work", () => {
    const tools = resolveSuhengToolsAllow("请研判这些链接并提交侵权投诉");

    expect(tools).toEqual(
      expect.arrayContaining([
        "infringe_complaint_submit",
        "infringe_profile_list",
        "letter_generate",
        "link_batch_create",
      ]),
    );
    expect(tools).not.toContain("schedule_create");
  });

  it("adds schedule controls only for scheduled-task intent", () => {
    const tools = resolveSuhengToolsAllow("每天九点创建舆情监测提醒");

    expect(tools).toEqual(
      expect.arrayContaining([
        "schedule_create",
        "schedule_delete",
        "schedule_list",
        "schedule_toggle",
      ]),
    );
    expect(tools).not.toContain("infringe_complaint_submit");
  });

  it("adds media tools without exposing unrelated transactional tools", () => {
    const tools = resolveSuhengToolsAllow("生成一段舆情科普短视频");

    expect(tools).toEqual(expect.arrayContaining(["video_generate", "video_understand"]));
    expect(tools).not.toContain("complaint_submit");
    expect(tools).not.toContain("schedule_create");
  });

  it("adds local inspection tools when the turn includes materialized attachments", () => {
    const tools = resolveSuhengToolsAllow("请分析一下", { hasAttachments: true });

    expect(tools).toEqual(expect.arrayContaining(["exec", "file_share", "process", "read"]));
  });

  it("adds only the permission-scoped history tool for collaboration diagnostics", () => {
    const tools = resolveSuhengToolsAllow("开始诊断", {
      builtinSkillName: "ai-collaboration-diagnostic",
    });

    expect(tools).toContain("collaboration_history_query");
    expect(tools).not.toContain("sessions_history");
    expect(tools).not.toContain("sessions_list");
  });

  it("does not narrow tools for custom or unknown skills", () => {
    expect(resolveSuhengToolsAllow("执行流程", { hasCustomSkills: true })).toBeUndefined();
    expect(
      resolveSuhengToolsAllow("执行流程", { builtinSkillName: "future-bundled-skill" }),
    ).toBeUndefined();
  });

  it.each([
    ["把这套流程保存为技能", ["skill_get", "skill_list", "skill_save"]],
    ["查看报告任务进度", ["job_list", "report_status"]],
    ["生成今天的每日风险提示", ["daily_risk_tips"]],
    ["批量重新研判这些舆情", ["feed_reanalyze"]],
    ["把报告发送到我的邮箱", ["file_share", "send_email"]],
  ])("adds the narrow capability for %s", (message, expected) => {
    expect(resolveSuhengToolsAllow(message)).toEqual(expect.arrayContaining(expected));
  });
});
