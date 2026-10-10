const DEFAULT_DOMAIN = "https://oss.ibtai.com";
const DEFAULT_PREFIX = "ibtai/assistant-agent/outputs";
const UNVERIFIED = "（下载链接未核验）";
const URL_PATTERN = /https?:\/\/[^\s<>"'`()[\]，。；！？]+/gi;

type LinkResolution =
  | { kind: "unrelated" }
  | { kind: "unverified" }
  | { kind: "verified"; url: string };

/** Release ordinary prose promptly, but hold a potentially incomplete link. */
export function artifactStreamPrefixLength(text: string): number {
  const start = text.lastIndexOf("\n") + 1;
  const line = text.slice(start);
  const candidate = line.search(/https?:\/\/|\[|!/i);
  let end = candidate < 0 ? line.length : candidate;
  for (const prefix of [
    "h",
    "ht",
    "htt",
    "http",
    "https",
    "http:",
    "https:",
    "http:/",
    "https:/",
  ]) {
    if (line.toLowerCase().endsWith(prefix)) {
      end = Math.min(end, line.length - prefix.length);
    }
  }
  return start + end;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function payload(value: unknown): Record<string, unknown> | undefined {
  const obj = record(value);
  if (!obj) {
    return undefined;
  }
  const details = record(obj.details);
  if (details) {
    return details;
  }
  if (Array.isArray(obj.content)) {
    for (const block of obj.content) {
      const item = record(block);
      if (item?.type === "text" && typeof item.text === "string") {
        try {
          const parsed = record(JSON.parse(item.text));
          if (parsed) {
            return parsed;
          }
        } catch {
          // Non-JSON tool output is not upload evidence.
        }
      }
    }
  }
  return undefined;
}

function parseUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

/** Per-session evidence, never shared across users or inferred from assistant prose. */
export class ArtifactLinks {
  private readonly locations = new Set<string>();
  private readonly trusted = new Set<string>();
  private readonly deliveries = new Map<string, string>();

  constructor(domain = DEFAULT_DOMAIN, prefix = DEFAULT_PREFIX) {
    this.locations.add(`${DEFAULT_DOMAIN}/${DEFAULT_PREFIX}/`);
    const base = parseUrl(`${domain.replace(/\/+$/, "")}/${prefix.replace(/^\/+|\/+$/g, "")}/`);
    if (base) {
      this.locations.add(base.href);
    }
  }

  observeToolEvent(value: unknown): void {
    const event = record(value);
    if (event?.phase === "result" && !event.isError) {
      this.observe(event.name, event.result, true);
    }
  }

  observeMessages(messages: unknown[], deliverNew = false): void {
    for (const value of messages) {
      const message = record(value);
      if (message?.role === "toolResult" && !message.isError) {
        const data = payload(message);
        const shouldDeliver =
          deliverNew && typeof data?.url === "string" && !this.trusted.has(data.url);
        this.observe(message.toolName, message, shouldDeliver);
      }
    }
  }

  private observe(name: unknown, result: unknown, deliver: boolean): void {
    if (name !== "file_share" && name !== "chart_render") {
      return;
    }
    const data = payload(result);
    if (data?.ok !== true || typeof data.url !== "string") {
      return;
    }
    const url = parseUrl(data.url);
    // These tools return opaque object keys. Reject markdown/control characters
    // rather than changing the authoritative URL to make it renderable.
    if (!url || /[\s<>"'`()[\]\\]/.test(data.url)) {
      return;
    }
    this.trusted.add(data.url);
    this.locations.add(new URL(".", url).href);
    if (deliver) {
      const filename = typeof data.filename === "string" ? data.filename : "下载文件";
      const label = filename.replace(/[\r\n<>]/g, " ").replace(/[\\[\]`*_!]/g, "\\$&");
      this.deliveries.set(data.url, label);
    }
  }

  resolve(value: string): LinkResolution {
    if (this.trusted.has(value)) {
      return { kind: "verified", url: value };
    }
    const cleaned = value.replace(/\\_/g, "_");
    const url = parseUrl(cleaned);
    if (
      !url ||
      ![...this.locations].some((location) => {
        const base = new URL(location);
        return url.host === base.host && url.pathname.startsWith(base.pathname);
      })
    ) {
      return { kind: "unrelated" };
    }
    const basename = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    const candidates = [...this.trusted].filter((link) => {
      const known = new URL(link);
      return (
        known.host === url.host &&
        known.pathname.slice(known.pathname.lastIndexOf("/") + 1) === basename
      );
    });
    return candidates.length === 1
      ? { kind: "verified", url: candidates[0] }
      : { kind: "unverified" };
  }

  sanitize(text: string): string {
    // Handle whole Markdown links first so an unknown target becomes plain text,
    // not an empty clickable href. Also validate URL-shaped display labels.
    const markdown = text.replace(
      /!?\[([^\]\n]*)\]\(\s*<?(https?:\/\/[^\s<>]+?)\s*>?\s*\)/gi,
      (whole, label: string, target: string) => {
        const resolved = this.resolve(target);
        if (resolved.kind === "unrelated") {
          return whole;
        }
        const safeLabel = this.sanitizeUrls(label);
        if (resolved.kind === "unverified") {
          return `${safeLabel}${UNVERIFIED}`;
        }
        return `${whole.startsWith("!") ? "!" : ""}[${safeLabel}](${resolved.url})`;
      },
    );
    return this.sanitizeUrls(markdown);
  }

  private sanitizeUrls(text: string): string {
    return text.replace(URL_PATTERN, (url) => {
      const resolved = this.resolve(url);
      if (resolved.kind === "verified") {
        return resolved.url;
      }
      if (resolved.kind === "unrelated") {
        return url;
      }
      const punctuation = url.match(/[.,;:!?]+$/)?.[0] ?? "";
      if (punctuation) {
        const withoutPunctuation = this.resolve(url.slice(0, -punctuation.length));
        if (withoutPunctuation.kind === "verified") {
          return withoutPunctuation.url + punctuation;
        }
      }
      return UNVERIFIED + punctuation;
    });
  }

  /** Server-generated delivery links remain available even if the model omits them. */
  deliveryLinks(): string {
    if (!this.deliveries.size) {
      return "";
    }
    return `\n\n可下载文件：\n${[...this.deliveries].map(([url, label]) => `- [${label}](${url})`).join("\n")}`;
  }
}
