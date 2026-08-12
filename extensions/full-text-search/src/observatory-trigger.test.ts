import { describe, expect, it } from "vitest";
import { parseObservatorySearchIntent } from "./observatory-trigger.js";

describe("parseObservatorySearchIntent", () => {
  it.each([
    ["帮我使用观象台，搜索“今天吃饭了嘛？”", "今天吃饭了嘛？"],
    ["观象台：OpenClaw 最新消息", "OpenClaw 最新消息"],
    ["请通过观象台查询新能源汽车舆情", "新能源汽车舆情"],
    ['用观象台搜一下 "Qwen3.7-plus"', "Qwen3.7-plus"],
    ["观象台搜索关于“低空经济”的内容", "低空经济"],
    ["用观象台搜索苹果，并按“时间倒序”排列", "苹果，并按“时间倒序”排列"],
    ["不要介绍观象台；请用观象台搜索新能源汽车", "新能源汽车"],
  ])("extracts a full-text query from %s", (prompt, expected) => {
    expect(parseObservatorySearchIntent(prompt)).toEqual({ query: expected });
  });

  it.each([
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
