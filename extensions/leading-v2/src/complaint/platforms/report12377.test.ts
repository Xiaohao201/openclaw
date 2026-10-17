import { expect, it } from "vitest";
import { officialSubmission, receiptCode } from "./report12377.js";
it("accepts only an official POST endpoint and an explicit retrieval code", () => {
  expect(officialSubmission("https://www.12377.cn/rpapi/portal/report/add", "POST")).toBe(true);
  for (const url of [
    "https://12377.cn.attacker.test/rpapi/portal/report/add",
    "http://www.12377.cn/rpapi/portal/report/add",
    "https://user@www.12377.cn/rpapi/portal/report/add",
  ]) {
    expect(officialSubmission(url, "POST")).toBe(false);
  }
  expect(officialSubmission("https://www.12377.cn/rpapi/portal/report/add", "GET")).toBe(false);
  expect(receiptCode({ code: 1000, result: { retrievalCode: "fixture-code" } })).toBe(
    "fixture-code",
  );
  for (const payload of [
    null,
    { code: 0 },
    { code: 1000, result: { retrievalCode: "" } },
    { code: 1000, result: { retrievalCode: "secret\nvalue" } },
  ]) {
    expect(receiptCode(payload)).toBeUndefined();
  }
});
