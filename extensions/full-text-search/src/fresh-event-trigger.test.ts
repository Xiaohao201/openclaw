import { describe, expect, it } from "vitest";
import { parseFullTextPriorityIntent } from "./fresh-event-trigger.js";

const NOW = new Date("2026-08-21T06:30:00.000Z");

describe("parseFullTextPriorityIntent", () => {
  it.each([
    ["今天深圳某餐厅发生食品安全事件，查一下", "fresh-event", "today"],
    ["刚刚发布的某地官方通报，帮我核实", "fresh-event", "today"],
    ["突发：南山区发生事故，写舆情速报", "fresh-event", "today"],
    ["深圳赛百味维修人员穿鞋踩踏出餐区，撰写该事件舆情速报", "local-social-event", "recent"],
    ["广州某商场发生消费纠纷，请做舆情研判", "local-social-event", "recent"],
  ] as const)("routes %s to full-text search first", (prompt, reason, dateScope) => {
    expect(parseFullTextPriorityIntent(prompt, NOW)).toMatchObject({ reason, dateScope });
  });

  it("extracts only the public event terms from an injected chat prompt", () => {
    expect(
      parseFullTextPriorityIntent(
        "[auto-selected-skill] 请使用 $ai-public-opinion-brief 完成任务。 " +
          "[userId:1749][topicId:88]深圳赛百味维修人员穿鞋踩踏出餐区，撰写该事件舆情速报",
        NOW,
      ),
    ).toEqual({
      reason: "local-social-event",
      dateScope: "recent",
      query: "深圳赛百味维修人员穿鞋踩踏出餐区",
    });
  });

  it("removes duplicated report-writing instructions from the original event wording", () => {
    expect(
      parseFullTextPriorityIntent("深圳赛百味维修人员穿鞋踩踏出餐区，写撰写该事件舆情速报", NOW),
    ).toMatchObject({ query: "深圳赛百味维修人员穿鞋踩踏出餐区" });
  });

  it.each([
    "今天天气怎么样",
    "我刚刚写完代码",
    "这是一个突发奇想",
    "介绍一下什么是本地社会事件",
    "不要联网，只根据附件写一份深圳食品安全报告",
    "深圳有哪些赛百味门店",
    "",
  ])("does not auto-route %s", (prompt) => {
    expect(parseFullTextPriorityIntent(prompt, NOW)).toBeNull();
  });

  it("rejects an oversized extracted query", () => {
    expect(
      parseFullTextPriorityIntent(`今天深圳发生食品安全事件，查一下${"新".repeat(600)}`, NOW),
    ).toBeNull();
  });
});
