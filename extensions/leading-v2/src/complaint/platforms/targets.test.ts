import { expect, it } from "vitest";
import { contentIdentity, matchesReportTarget } from "./targets.js";

it.each([
  ["douyin", "https://www.douyin.com/jingxuan?modal_id=123", "123"],
  ["sohu", "https://m.sohu.com/a/123_456", "123_456"],
  ["tiantianfund", "https://guba.eastmoney.com/news,of000001,123.html", "000001:123"],
  ["sina", "https://news.sina.com.cn/c/doc-imtest123.shtml", "mtest123"],
  [
    "xiaohongshu",
    "https://www.xiaohongshu.com/explore/0123456789abcdef01234567",
    "0123456789abcdef01234567",
  ],
  ["weibo", "https://weibo.com/123456/Abc123", "123456/Abc123"],
])("extracts %s target identity", (platform, url, identity) => {
  expect(contentIdentity(platform, url)).toBe(identity);
  expect(
    contentIdentity(platform, url.replace("https://", "https://attacker.test/")),
  ).toBeUndefined();
});
it("rejects unrelated report targets and reply reports", () => {
  const article = "https://m.sohu.com/a/123_456";
  expect(
    matchesReportTarget(
      "sohu",
      `https://www.sohu.com/feedback?articleUrl=${encodeURIComponent(article)}&pageType=report`,
      article,
    ),
  ).toBe(true);
  expect(
    matchesReportTarget(
      "sohu",
      "https://www.sohu.com/feedback?articleUrl=https://m.sohu.com/a/999_456",
      article,
    ),
  ).toBe(false);
  const post = "https://fund.eastmoney.com/ba/news,of000001,123.html";
  const report =
    "https://help.eastmoney.com/report_center.html?reportType=3&systype=1&replyid=0&gubaCode=000001&id=123";
  expect(matchesReportTarget("tiantianfund", report, post)).toBe(true);
  expect(matchesReportTarget("tiantianfund", report.replace("replyid=0", "replyid=1"), post)).toBe(
    false,
  );
});
