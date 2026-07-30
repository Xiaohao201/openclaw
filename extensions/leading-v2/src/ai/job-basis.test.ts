import { describe, expect, it } from "vitest";
import { collectJobErrors } from "./job-basis.js";

describe("collectJobErrors", () => {
  it("returns nothing when the task found no violations (rate 0)", () => {
    expect(
      collectJobErrors({
        job: { rate: 0, summary: "未发现违规内容" },
        tasks: [{ ruleTitle: "某规定", result: "不应出现在结果里" }],
      }),
    ).toBe("");
  });

  it("joins the summary with each violating task, prefixed by its rule title", () => {
    expect(
      collectJobErrors({
        job: { rate: 4.5, summary: "整体评估：存在多处未经核实的数据。" },
        tasks: [
          { ruleTitle: "互联网新闻信息服务管理规定", result: "第3段虚构营收。" },
          { result: "第7段引用来源不明。" },
        ],
      }),
    ).toBe(
      "整体评估：存在多处未经核实的数据。\n" +
        "《互联网新闻信息服务管理规定》：第3段虚构营收。\n" +
        "第7段引用来源不明。",
    );
  });

  it("reads searchMap instead of tasks for 事实审 jobs", () => {
    expect(
      collectJobErrors({
        job: { rate: 3, search: 1, summary: "事实审：部分表述失实。" },
        tasks: [{ result: "普通检测条目，不应被采用。" }],
        searchMap: {
          1: { insult: 1, problem: JSON.stringify({ reason: "第1段含侮辱性表述。" }) },
          2: { illegal: 1, result: "第2段与公开事实不符。" },
          3: { illegal: 0, result: "合规条目，应跳过。" },
        },
      }),
    ).toBe("事实审：部分表述失实。\n第1段含侮辱性表述。\n第2段与公开事实不符。");
  });

  it("skips an unparseable problem payload instead of throwing", () => {
    expect(
      collectJobErrors({
        job: { rate: 3, search: 1, summary: "事实审摘要。" },
        searchMap: { 1: { insult: 1, problem: "not json" } },
      }),
    ).toBe("事实审摘要。");
  });
});
