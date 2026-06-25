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

  it("summarizes a completed check with the flagged-paragraph count", async () => {
    getJson.mockResolvedValueOnce({
      job: { status: "Done" },
      detail: { tableData: [{}, {}, {}] },
    });
    const res = await pollLegalCheck(task, "key", config);
    expect(res.terminal).toBe(true);
    expect(res.summary).toContain("「某条检测」已完成");
    expect(res.summary).toContain("共发现 3 处");
  });

  it("reports a Stop as terminal with a likely-cause hint", async () => {
    getJson.mockResolvedValueOnce({ job: { status: "Stop" } });
    const res = await pollLegalCheck(task, "key", config);
    expect(res.terminal).toBe(true);
    expect(res.summary).toContain("已停止");
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
