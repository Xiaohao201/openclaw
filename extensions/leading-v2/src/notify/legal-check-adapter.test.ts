import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendConfig } from "../client/types.js";
import type { PendingTask } from "./types.js";

// Mock the HTTP client so the adapter can be driven with staged backend payloads.
const getJson = vi.fn();
vi.mock("../client/http-client.js", () => ({
  getJson: (...args: unknown[]) => getJson(...args),
}));

const { pollLegalCheck } = await import("./legal-check-adapter.js");

const config = {} as BackendConfig;
const task: PendingTask = {
  id: "legal_check:6070",
  kind: "legal_check",
  uid: "1749",
  backendId: "6070",
  sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_1",
  mercureTopic: "lobster/user/1749",
  delivery: {},
  title: "某条检测",
  createdAt: 0,
  attempts: 0,
  notified: false,
  expiresAt: 0,
};

beforeEach(() => getJson.mockReset());

describe("pollLegalCheck", () => {
  it("polls /ai/fetch-job with the job id in the pr workspace", async () => {
    getJson.mockResolvedValueOnce({ job: { status: "Running" } });
    await pollLegalCheck(task, "key", config);
    const [, path, params] = getJson.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(path).toBe("/ai/fetch-job");
    expect(params).toMatchObject({ id: "6070", workspace: "pr", all: 1 });
  });

  it("is not terminal while the task is still running", async () => {
    getJson.mockResolvedValueOnce({ job: { status: "Crawling" } });
    const res = await pollLegalCheck(task, "key", config);
    expect(res.terminal).toBe(false);
  });

  it("summarizes a completed check with the fresh title, flagged count, and FULL link", async () => {
    const fullLink = "https://www.msn.cn/zh-cn/entertainment/%E5%90%8D%E4%BA%BA/ar-AA26udhZ";
    getJson.mockResolvedValueOnce({
      job: { status: "Done", label: "锋菲恋再添新画面", link: fullLink },
      detail: { tableData: [{}, {}, {}] },
    });
    const res = await pollLegalCheck(task, "key", config);
    expect(res.terminal).toBe(true);
    expect(res.summary).toContain("「锋菲恋再添新画面」已完成");
    expect(res.summary).toContain("共发现 3 处");
    // The complete link is shown, sourced from job.link (not the captured title).
    expect(res.summary).toContain(fullLink);
    // Violations found → offer 一键举报 with two inline action buttons.
    expect(res.summary).toContain("是否需要对该内容一键举报");
    expect(res.summary).toContain("[🚨 一键举报](#lobster-report)");
    expect(res.summary).toContain("[暂不](#lobster-dismiss)");
  });

  it("omits the 一键举报 buttons when no violations were flagged", async () => {
    getJson.mockResolvedValueOnce({
      job: { status: "Done", label: "某合规内容", link: "https://a.com/ok" },
      detail: { tableData: [] },
    });
    const res = await pollLegalCheck(task, "key", config);
    expect(res.summary).toContain("已完成");
    expect(res.summary).not.toContain("一键举报");
    expect(res.summary).not.toContain("#lobster-report");
  });

  it("shows the full job.link even when the label is a truncated URL (the bug)", async () => {
    const fullLink =
      "https://www.msn.cn/zh-cn/entertainment/%E5%90%8D%E4%BA%BA/%E9%94%8B%E8%8F%B2%E6%81%8B/ar-AA26udhZ?ocid=TobArticle";
    getJson.mockResolvedValueOnce({
      // label is the 80-char-truncated URL the PHP backend stores at submit.
      job: {
        status: "Done",
        label: "https://www.msn.cn/zh-cn/entertainment/%E5%90%8D%E4%BA%BA/%E9%94%8B%E8%8F%B2%E6%",
        link: fullLink,
      },
      detail: { tableData: [] },
    });
    const res = await pollLegalCheck(task, "key", config);
    // The mangled URL label is NOT shown as a name…
    expect(res.summary).toContain("「该内容」");
    // …and the complete, untruncated link IS present.
    expect(res.summary).toContain(fullLink);
    expect(res.summary).not.toContain("%E6%」"); // no broken mid-encoding inside 「」
  });

  it("reports a Stop as terminal with the full link and a likely-cause hint", async () => {
    const fullLink = "https://www.msn.cn/zh-cn/a/ar-AA26udhZ?ocid=TobArticle";
    getJson.mockResolvedValueOnce({ job: { status: "Stop", link: fullLink } });
    const res = await pollLegalCheck(task, "key", config);
    expect(res.terminal).toBe(true);
    expect(res.summary).toContain("已停止");
    expect(res.summary).toContain(fullLink);
  });

  it("reports a Fail as terminal", async () => {
    getJson.mockResolvedValueOnce({ job: { status: "Fail" } });
    const res = await pollLegalCheck(task, "key", config);
    expect(res.terminal).toBe(true);
    expect(res.summary).toContain("失败");
  });

  it("throws when the backend returns an envelope error", async () => {
    getJson.mockResolvedValueOnce({ code: "danger", message: "boom" });
    await expect(pollLegalCheck(task, "key", config)).rejects.toThrow(/fetch-job failed/);
  });
});
