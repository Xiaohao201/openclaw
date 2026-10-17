import { localPlatforms } from "../complaint-local-contract.js";

function webUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.port
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}
export function contentIdentity(platform: string, value: string): string | undefined {
  const url = webUrl(value);
  if (!url) {
    return undefined;
  }
  const domains =
    platform === "tiantianfund"
      ? ["fund.eastmoney.com", "guba.eastmoney.com"]
      : localPlatforms[platform];
  if (!domains?.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    return undefined;
  }
  const path = url.pathname;
  switch (platform) {
    case "douyin":
      return (
        path.match(/^\/(?:video|note)\/(\d+)\/?$/)?.[1] ??
        (path === "/jingxuan" ? url.searchParams.get("modal_id")?.match(/^\d+$/)?.[0] : undefined)
      );
    case "xiaohongshu":
      return path.match(/^\/(?:explore|discovery\/item)\/([a-f0-9]{24})\/?$/i)?.[1]?.toLowerCase();
    case "sohu":
      return path.match(/^\/a\/(\d+_\d+)\/?$/)?.[1];
    case "tiantianfund":
      return path
        .match(/^\/(?:ba\/)?news,of([a-z0-9]+),(\d+)\.html$/i)
        ?.slice(1)
        .join(":");
    case "futu":
      return url.hostname === "q.futunn.com"
        ? path.match(/^\/(?:(?:hk|en|ja|th)\/)?feed\/(?:[^/?#]+-)?(\d+)\/?$/)?.[1]
        : undefined;
    case "sina":
      return (
        path.match(/\/doc-i([a-z0-9]+)\.shtml$/i)?.[1] ??
        path.match(/\/detail-i([a-z0-9]+)\.d\.html$/i)?.[1] ??
        (url.hostname === "super.sina.cn"
          ? path.match(/^\/shequn\/post\/detail_(\d+)\.html\/?$/)?.[1]
          : undefined)
      );
    case "yidianzixun":
      return path.match(/^\/article\/([A-Za-z0-9_-]+)\/?$/)?.[1];
    case "toutiao":
      return path.match(/^\/(?:article|video)\/(\d+)\/?$/)?.[1];
    case "weibo":
      return path.match(/^\/(\d+\/[A-Za-z0-9]+)\/?$/)?.[1];
    case "kuaishou":
      return path.match(/^\/(?:short-video|new-reco)\/([A-Za-z0-9_-]+)\/?$/)?.[1];
    case "bilibili":
      return path.match(/^\/(?:video|opus|read)\/([A-Za-z0-9]+)\/?$/)?.[1];
    case "zhihu":
      return (
        path.match(/^\/question\/\d+\/answer\/(\d+)\/?$/)?.[1] ??
        (url.hostname === "zhuanlan.zhihu.com" ? path.match(/^\/p\/(\d+)\/?$/)?.[1] : undefined)
      );
    case "baidu":
      return (
        url.searchParams.get("id")?.match(/^\d+$/)?.[0] ??
        path.match(/^\/video\/([A-Za-z0-9]+)\/?$/)?.[1]
      );
    case "netease":
      return path.match(/\/(?:article|v)\/([A-Za-z0-9]+)\.html$/)?.[1];
    case "tencent":
      return path.match(/\/(?:rain\/a|a)\/([A-Za-z0-9]+)(?:\.htm)?\/?$/)?.[1];
    case "eastmoney":
      return (
        path.match(/^\/a\/(\d+)\.html$/)?.[1] ??
        path.match(/^\/news,([A-Za-z0-9]+,\d+)\.html$/)?.[1]
      );
    default:
      return undefined;
  }
}

/** Validate report pages independently from click success, before any submission. */
export function matchesReportTarget(platform: string, report: string, target: string): boolean {
  const url = webUrl(report);
  const expected = contentIdentity(platform, target);
  if (!url || !expected) {
    return false;
  }
  const q = url.searchParams;
  if (platform === "sohu") {
    return (
      ["www.sohu.com", "m.sohu.com"].includes(url.hostname) &&
      url.pathname === "/feedback" &&
      contentIdentity(platform, q.get("articleUrl") ?? "") === expected &&
      (url.hostname === "m.sohu.com" || q.get("pageType") === "report")
    );
  }
  if (platform === "tiantianfund") {
    return (
      url.hostname === "help.eastmoney.com" &&
      url.pathname === "/report_center.html" &&
      q.get("reportType") === "3" &&
      q.get("systype") === "1" &&
      q.get("replyid") === "0" &&
      `${q.get("gubaCode")}:${q.get("id")}` === expected
    );
  }
  if (platform === "sina") {
    if (url.hostname === "news.sina.com.cn" && url.pathname === "/blank/report_news.shtml") {
      return q.get("docId") === expected;
    }
    return (
      url.hostname === "sinanews.sina.cn" &&
      url.pathname === "/activities/feedback.d.html" &&
      q.get("type") === "tiezi" &&
      q.get("dataid") === `tiezi:${expected}` &&
      q.get("docId") === `HB-1-discovery_hot_doc/hot_community-${expected}-tiezi` &&
      contentIdentity(platform, q.get("wapUrl") ?? "") === expected
    );
  }
  return contentIdentity(platform, report) === expected;
}
