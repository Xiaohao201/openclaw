import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendConfig } from "../client/types.js";
import type { PendingTask } from "./types.js";

// Mock the HTTP client so the adapter can be driven with staged backend payloads.
const getJson = vi.fn();
vi.mock("../client/http-client.js", () => ({
  getJson: (...args: unknown[]) => getJson(...args),
}));

const { pollLinkCheck } = await import("./link-check-adapter.js");

const config = {} as BackendConfig;
const task: PendingTask = {
  id: "link_check:42",
  kind: "link_check",
  uid: "1749",
  backendId: "42",
  sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_1",
  mercureTopic: "lobster/user/1749",
  delivery: {},
  title: "广本3条",
  createdAt: 0,
  attempts: 0,
  notified: false,
  expiresAt: 0,
};

beforeEach(() => getJson.mockReset());

describe("pollLinkCheck", () => {
  it("is not terminal while the task is still running", async () => {
    getJson.mockResolvedValueOnce({ job: { status: "Running" } });
    const res = await pollLinkCheck(task, "key", config);
    expect(res.terminal).toBe(false);
    expect(getJson).toHaveBeenCalledTimes(1); // no results fetch while running
  });

  it("treats Fail as a retry, not a terminal state", async () => {
    getJson.mockResolvedValueOnce({ job: { status: "Fail" } });
    const res = await pollLinkCheck(task, "key", config);
    expect(res.terminal).toBe(false);
    expect(getJson).toHaveBeenCalledTimes(1);
  });

  it("summarizes verdicts and lists 失效 links when done", async () => {
    getJson.mockResolvedValueOnce({ job: { status: "Done" } }).mockResolvedValueOnce({
      list: [
        { link: "https://a.com/1", offline: 1, memo: null, checked: 1 },
        { link: "https://a.com/2", offline: 0, memo: "", checked: 1 },
        { link: "https://a.com/3", offline: 0, memo: "验证码", checked: 1 },
      ],
    });
    const res = await pollLinkCheck(task, "key", config);
    expect(res.terminal).toBe(true);
    expect(getJson.mock.calls.map((c) => c[1])).toEqual([
      "/link/fetch-link-status-job/42",
      "/link/fetch-link-status-results/42",
    ]);
    expect(res.summary).toContain("「广本3条」已完成，共 3 条");
    expect(res.summary).toContain("失效 1");
    expect(res.summary).toContain("正常 1");
    expect(res.summary).toContain("无法判定 1");
    expect(res.summary).toContain("https://a.com/1（失效）");
  });

  it("reports a stopped task without fetching results", async () => {
    getJson.mockResolvedValueOnce({ job: { status: "Stop" } });
    const res = await pollLinkCheck(task, "key", config);
    expect(res.terminal).toBe(true);
    expect(res.summary).toContain("已停止");
    expect(getJson).toHaveBeenCalledTimes(1);
  });

  it("throws when the backend job call returns an envelope error", async () => {
    getJson.mockResolvedValueOnce({ code: "danger", message: "boom" });
    await expect(pollLinkCheck(task, "key", config)).rejects.toThrow(
      /fetch-link-status-job failed/,
    );
  });
});
