import { describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "../api.js";
import { detectReportRequest, extractInstruction } from "./report-trigger.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as PluginLogger;

describe("detectReportRequest", () => {
  describe("confident asks", () => {
    it.each([
      ["出个周报", "周报"],
      ["帮我生成一份日报", "日报"],
      ["月报", "月报"],
      ["写日报", "日报"],
      ["做周报", "周报"],
      ["出月报", "月报"],
      ["麻烦做份本周舆情", "周报"],
      ["今日舆情整理一下", "日报"],
    ])("treats %s as a %s request", (message, period) => {
      const result = detectReportRequest(message, logger);
      expect(result.verdict).toBe("confident");
      expect(result.isReportRequest).toBe(true);
      expect(result.period).toBe(period);
      expect(result.dateScope).not.toBeNull();
    });
  });

  describe("citations must not trigger", () => {
    it("ignores an outlet name in the ask itself", () => {
      const result = detectReportRequest("帮我分析下时代周报这篇文章的倾向性", logger);
      expect(result.verdict).toBe("none");
      expect(result.isReportRequest).toBe(false);
      expect(result.period).toBeNull();
    });

    it("ignores 每周质量报告 (a TV program, not a request)", () => {
      const result = detectReportRequest("央视每周质量报告曝光了这家企业，帮我看看影响面", logger);
      expect(result.verdict).toBe("none");
    });

    it("ignores a source list inside the message", () => {
      const result = detectReportRequest(
        "整理一下传播渠道：新京报、南方巡报、深圳新闻网等权威媒体报道",
        logger,
      );
      expect(result.isReportRequest).toBe(false);
    });

    it("ignores an unlisted outlet followed by an article reference", () => {
      const result = detectReportRequest("帮我分析湄洲日报这篇文章的倾向性", logger);
      expect(result.verdict).toBe("none");
      expect(result.isReportRequest).toBe(false);
      expect(result.period).toBeNull();
    });
  });

  describe("history_messages #4418 regression", () => {
    const message = [
      "关于“湄洲日报一文章标题审核问题”网络舆情专报",
      "一、舆情概况",
      ...Array.from(
        { length: 30 },
        (_, i) => `${i + 1}. 这里是用户粘贴的舆情专报模板正文和线下核实、处置情况。`,
      ),
      "四、风险研判及建议",
      "学习并写一篇",
    ].join("\n");

    it("keeps the pasted special-report template in normal chat", () => {
      const result = detectReportRequest(message, logger);
      expect(result.verdict).toBe("none");
      expect(result.isReportRequest).toBe(false);
      expect(result.period).toBeNull();
    });

    it("does not reinterpret a special-report template as a periodic report", () => {
      const result = detectReportRequest("请按照这份日报舆情专报模板写一篇", logger);
      expect(result.verdict).toBe("none");
      expect(result.isReportRequest).toBe(false);
    });

    it("still honors an explicit periodic-report request at the end of a long paste", () => {
      const explicitMessage = `${message}\n请据此生成一份日报`;
      const result = detectReportRequest(explicitMessage, logger);
      expect(result.verdict).toBe("confident");
      expect(result.isReportRequest).toBe(true);
      expect(result.period).toBe("日报");
    });
  });

  describe("history_messages #2001 regression", () => {
    // The real failure: the user asked the agent to write chapter 四 of a report
    // and pasted ~8.5k characters of source material. "时代周报" appeared at
    // offset 5556 of the paste, the old substring matcher fired, and the turn
    // was replaced by "周报报告已创建，正在生成中...".
    const message = [
      "请结合我下面对全国和深圳上月市场监管舆情的分析和8月市场监管领域舆情的时间属性，" +
        "撰写四、2026年8月深圳市市监舆情风险前瞻与应对建议二、2026年7月全国市监舆情焦点案例",
      "2026年7月，盛夏高温叠加暑期消费旺季，食品腐败风险与餐饮消费纠纷同步攀升。" +
        "本月央视《财经调查》《每周质量报告》多次直击产业暗角。",
      "（一）食品安全与质量风险",
      ...Array.from(
        { length: 40 },
        (_, i) => `${i + 1}.事件概述：媒体曝光相关企业存在违规行为，属地监管部门已立案调查。`,
      ),
      "➤新闻客户端 (15 起，9.7%)：时代周报、深圳新闻网等权威媒体报道，传播影响力大。",
      "本月舆情涉事主体可归纳为以下七类：（1）餐饮食品与生活服务类责任主体。",
      "预付式消费舆情已从“个体纠纷”演变为“系统性风险”，亟需建立跨部门、跨区域的预警联动机制。请",
    ].join("\n");

    it("does not enqueue a report", () => {
      const result = detectReportRequest(message, logger);
      expect(result.isReportRequest).toBe(false);
      expect(result.verdict).toBe("none");
    });

    it("scans only the instruction, not the pasted body", () => {
      const result = detectReportRequest(message, logger);
      expect(result.instruction).toContain("撰写四、2026年8月深圳市市监舆情风险前瞻");
      expect(result.instruction).not.toContain("时代周报");
      expect(result.instruction.length).toBeLessThan(400);
    });
  });

  describe("ambiguous cases go to the LLM arbiter", () => {
    it("flags a meta-question about reports instead of acting on it", () => {
      const result = detectReportRequest("月报的统计口径是不是变了？", logger);
      expect(result.verdict).toBe("ambiguous");
      expect(result.isReportRequest).toBe(false);
    });

    it("flags a keyword-free report ask (period hint + report noun + verb)", () => {
      const result = detectReportRequest("把上周的舆情整理成一份简报", logger);
      expect(result.verdict).toBe("ambiguous");
      expect(result.period).toBe("周报");
      expect(result.isReportRequest).toBe(false);
    });
  });

  describe("regex statefulness", () => {
    it("stays stable across repeated calls (no lastIndex carry-over)", () => {
      const first = detectReportRequest("出个周报", logger);
      const second = detectReportRequest("出个周报", logger);
      const third = detectReportRequest("出个周报", logger);
      expect([first.period, second.period, third.period]).toEqual(["周报", "周报", "周报"]);
      expect([first.verdict, second.verdict, third.verdict]).toEqual([
        "confident",
        "confident",
        "confident",
      ]);
    });
  });
});

describe("extractInstruction", () => {
  it("returns a short message unchanged", () => {
    expect(extractInstruction("  出个周报  ")).toBe("出个周报");
  });

  it("keeps only the head of a long paste", () => {
    const message = `帮我看看这份材料\n${"素材正文".repeat(200)}`;
    expect(extractInstruction(message)).toBe("帮我看看这份材料");
  });

  it("keeps a short closing ask alongside the head", () => {
    const message = `以下是本月素材\n${"素材正文".repeat(200)}\n请据此出一份周报`;
    const instruction = extractInstruction(message);
    expect(instruction).toContain("以下是本月素材");
    expect(instruction).toContain("请据此出一份周报");
  });

  it("keeps a template-learning ask at the end of a long paste", () => {
    const message = `关于某事件的网络舆情专报\n${"素材正文".repeat(200)}\n学习并写一篇`;
    const instruction = extractInstruction(message);
    expect(instruction).toContain("关于某事件的网络舆情专报");
    expect(instruction).toContain("学习并写一篇");
  });

  it("drops a long trailing body paragraph", () => {
    const message = `帮我看看\n${"素材正文".repeat(200)}\n${"结尾正文段落".repeat(30)}`;
    expect(extractInstruction(message)).toBe("帮我看看");
  });

  it("strips fenced code blocks before slicing", () => {
    const message = `统计一下\n\`\`\`\n${"周报".repeat(300)}\n\`\`\``;
    expect(extractInstruction(message)).not.toContain("周报");
  });
});
