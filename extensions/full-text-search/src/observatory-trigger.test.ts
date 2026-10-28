import { describe, expect, it } from "vitest";
import { parseObservatorySearchIntent } from "./observatory-trigger.js";

describe("parseObservatorySearchIntent", () => {
  it.each([
    [
      "请参考附件格式，打开观象台，帮我找出有关示例集团的数据，监测时间段为从2026年10月20日9时到27日9时，也要生成折线图",
      "示例集团",
    ],
    ["帮我使用观象台，搜索“今天吃饭了嘛？”", "今天吃饭了嘛？"],
    ["观象台：OpenClaw 最新消息", "OpenClaw 最新消息"],
    ["请通过观象台查询新能源汽车舆情", "新能源汽车舆情"],
    ['用观象台搜一下 "Qwen3.7-plus"', "Qwen3.7-plus"],
    ["观象台搜索关于“低空经济”的内容", "低空经济"],
    ["用观象台搜索苹果，并按“时间倒序”排列", "苹果"],
    ["不要介绍观象台；请用观象台搜索新能源汽车", "新能源汽车"],
    ["仅根据附件格式，打开观象台搜索示例集团", "示例集团"],
  ])("extracts a full-text query from %s", (prompt, expected) => {
    expect(parseObservatorySearchIntent(prompt)).toEqual({ query: expected });
  });

  it.each([
    "不要联网，打开观象台帮我找出示例集团的数据",
    "不联网，打开观象台帮我找出示例集团的数据",
    "仅使用附件数据作答，打开观象台搜索示例集团",
    "只分析附件，不用观象台搜索示例集团",
    "请分析这份材料\n\n以下是用户提供的附件内容，请结合附件作答：\n\n【附件 1：样例】\n观象台搜索示例集团",
    "观象台这个名字怎么样？",
    "我刚才使用过观象台",
    "介绍一下观象台的功能",
    "不要使用观象台，普通搜索即可",
    "别用观象台搜索今天的新闻",
    "请勿调用观象台查询今天的新闻",
    "帮我使用观象台搜索",
    "搜索今天的新闻",
  ])("does not trigger for %s", (prompt) => {
    expect(parseObservatorySearchIntent(prompt)).toBeNull();
  });
});
