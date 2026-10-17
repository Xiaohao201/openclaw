import { expect, it, vi } from "vitest";
import { submitPhone } from "./submit.js";
const link = "https://www.xiaohongshu.com/explore/0123456789abcdef01234567";
const fixture = () => ({
  open: vi.fn(),
  tap: vi.fn(),
  copiedLink: vi.fn().mockResolvedValue(link),
  openReport: vi.fn(),
  selectCategory: vi.fn(),
  fillReason: vi.fn(),
  texts: vi.fn().mockResolvedValueOnce(["举报", "提交"]).mockResolvedValue(["举报成功"]),
  checkSubmitReady: vi.fn(),
});
it("does not submit on target mismatch and never retries a lost submit response", async () => {
  const wrong = fixture();
  wrong.copiedLink.mockResolvedValue(link.replace("0123", "9999"));
  expect((await submitPhone(wrong, { link, category: "不实信息", reason: "fixture" })).state).toBe(
    "manual_required",
  );
  expect(wrong.tap).not.toHaveBeenCalledWith("提交");
  const lost = fixture();
  const log = vi.fn();
  lost.tap.mockImplementation(async (label: string) => {
    if (label === "提交") {
      throw new Error("response lost");
    }
  });
  expect(
    (await submitPhone(lost, { link, category: "不实信息", reason: "fixture" }, false, log)).state,
  ).toBe("unknown");
  expect(lost.tap.mock.calls.filter(([label]) => label === "提交")).toHaveLength(1);
  expect(log).toHaveBeenLastCalledWith({
    stage: "phone_submit",
    attempted: true,
    errorType: "Error",
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain("response lost");
});
it("confirms only a fresh receipt and supports preflight without submission", async () => {
  expect(
    (await submitPhone(fixture(), { link, category: "不实信息", reason: "fixture" })).state,
  ).toBe("done");
  const port = fixture();
  expect(
    (await submitPhone(port, { link, category: "不实信息", reason: "fixture" }, true)).state,
  ).toBe("not_submitted");
  expect(port.tap).not.toHaveBeenCalledWith("提交");
});
