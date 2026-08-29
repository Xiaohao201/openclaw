import { describe, expect, it } from "vitest";
import { renderLocalDebugPage } from "./local-debug-page.js";

describe("RabbitMQ local debug trace UI", () => {
  it("makes production extension-tool inheritance visible", () => {
    const html = renderLocalDebugPage("/debug/run", "/debug/skills");

    expect(html).toContain("本地会话隔离");
    expect(html).toContain("扩展能力对齐部署环境");
    expect(html).toContain("复用现有 MySQL 与 Milvus");
    expect(html).toContain("history_test");
    expect(html).toContain("MessageTest");
    expect(html).not.toContain("工具调用可能读写真实系统");
    expect(html).not.toContain("本地隔离模式");
  });

  it("renders a compact Xiuheng-style timeline with factual details on demand", () => {
    const html = renderLocalDebugPage("/debug/run", "/debug/skills");

    expect(html).toContain("row.className='trace-event'");
    expect(html).toContain("icon.className='trace-icon'");
    expect(html).toContain("const hasNarrative=narrative.length>0");
    expect(html).toContain("details.className='trace-event-detail'");
    expect(html).toContain("Array.isArray(item.narrative)?item.narrative:[]");
    expect(html).toContain("paragraph.textContent=line");
    expect(html).toContain("Array.isArray(data.trace)?data.trace:[]");
    expect(html).toContain("'工作过程'");
    expect(html).toContain("traceItems.length+' 个步骤'");
    expect(html).toContain("formatTraceLabel(item.summary,item.status)");
    expect(html).toContain("formatTraceDuration(item.durationMs)");
    expect(html).toContain("item.repeatCount>1?' · '+item.repeatCount+' 次':''");
    expect(html).not.toContain("trace-detail-label");
    expect(html).not.toContain("detail.label");
    expect(html).not.toContain("trace-scope");
    expect(html).not.toContain("OpenClaw 公开推理记录");
  });

  it("does not create empty expandable bodies for steps without factual detail", () => {
    const html = renderLocalDebugPage("/debug/run", "/debug/skills");

    expect(html).toContain("if(hasNarrative){");
    expect(html).toContain("row.classList.toggle('expandable',hasNarrative)");
    expect(html).not.toContain("paragraph.innerHTML");
    expect(html).not.toContain("content:'展开'");
    expect(html).not.toContain("content:'收起'");
  });

  it("keeps generated history ids inside a signed MySQL INT", () => {
    const html = renderLocalDebugPage("/debug/run", "/debug/skills");

    expect(html).toContain("const MAX_HISTORY_ID=2147483647");
    expect(html).toContain("crypto.getRandomValues");
    expect(html).toContain("function takeHistoryId()");
    expect(html).toContain("id:takeHistoryId()");
    expect(html).not.toContain("nextHistoryId=Date.now()");
  });
});
