// These platforms have no supported direct reporting workflow in this deployment.
const unavailableDomains = ["10jqka.com.cn", "xueqiu.com", "weixin.qq.com", "weixin.com"];
const unavailablePlatforms = new Set([
  "tonghuashun",
  "xueqiu",
  "wechat",
  "weixin",
  "同花顺",
  "雪球",
  "微信",
]);

export function isUnavailableComplaintLink(link: string): boolean {
  try {
    const host = new URL(link).hostname;
    return unavailableDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function isUnavailableComplaintPlatform(entry: unknown): boolean {
  const platform =
    typeof entry === "string"
      ? entry
      : entry && typeof entry === "object" && "platform" in entry
        ? entry.platform
        : undefined;
  return typeof platform === "string" && unavailablePlatforms.has(platform.toLowerCase());
}
