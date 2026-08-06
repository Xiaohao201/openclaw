import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

/**
 * Video discovery for fetched web pages.
 *
 * `web_fetch` runs Readability, which throws away `<video>`, player `<iframe>`s
 * and `og:video` meta — so a page's video is invisible to the agent even when it
 * carries the whole story. This module scans the *raw* HTML instead and ranks
 * the candidates so the agent can decide whether a clip is worth analyzing.
 *
 * Ranking is deliberately heuristic rather than model-driven: a page that
 * declares `og:video` has already told us which clip is the main one, and DOM
 * position rules out recommendation rails cheaply. When the top two candidates
 * are too close to call the result is marked `ambiguous` and the agent — which
 * already sees the candidate list — makes the call.
 */

const MAX_HTML_CHARS = 1_000_000;
const DEFAULT_MAX_CANDIDATES = 8;

/** Scores within this margin of the leader are treated as a tie. */
const AMBIGUOUS_MARGIN = 10;

export type VideoCandidateKind = "file" | "hls" | "platform" | "embed";

export type VideoCandidateSource =
  | "og"
  | "twitter"
  | "json-ld"
  | "video-tag"
  | "iframe"
  | "script"
  | "page-url";

export type VideoCandidate = {
  /** Direct media URL, or the platform watch page when only an embed is exposed. */
  url: string;
  kind: VideoCandidateKind;
  source: VideoCandidateSource;
  title?: string;
  durationSeconds?: number;
  poster?: string;
  /** Platform label (抖音/哔哩哔哩/…) when the URL belongs to a known video site. */
  platform?: string;
  score: number;
  /** Human-readable scoring trace; surfaced to the agent so its pick is informed. */
  reasons: string[];
};

export type VideoDetectionResult = {
  main?: VideoCandidate;
  others: VideoCandidate[];
  /** True when the runner-up scores within {@link AMBIGUOUS_MARGIN} of the leader. */
  ambiguous: boolean;
};

/** Hosts that only ever serve video watch pages — a bare URL is enough to route to yt-dlp. */
const PURE_VIDEO_HOSTS: ReadonlyArray<readonly [string, string]> = [
  ["douyin.com", "抖音"],
  ["iesdouyin.com", "抖音"],
  ["bilibili.com", "哔哩哔哩"],
  ["b23.tv", "哔哩哔哩"],
  ["kuaishou.com", "快手"],
  ["chenzhongtech.com", "快手"],
  ["v.qq.com", "腾讯视频"],
  ["youku.com", "优酷"],
  ["iqiyi.com", "爱奇艺"],
  ["ixigua.com", "西瓜视频"],
  ["youtube.com", "YouTube"],
  ["youtu.be", "YouTube"],
  ["tiktok.com", "TikTok"],
];

/**
 * Hosts that mix video with ordinary pages: the path has to look like a video
 * permalink before we treat the page URL itself as a clip.
 */
const MIXED_PLATFORM_HOSTS: ReadonlyArray<readonly [string, string, RegExp]> = [
  ["weibo.com", "微博", /^\/(tv\/show|\d+\/[A-Za-z0-9]+)/],
  ["weibo.cn", "微博", /^\/(tv\/show|\d+\/[A-Za-z0-9]+)/],
  ["xiaohongshu.com", "小红书", /^\/(explore|discovery\/item)\//],
  ["xhslink.com", "小红书", /\S/],
  ["x.com", "X", /\/status\/\d+/],
  ["twitter.com", "X", /\/status\/\d+/],
];

/** Containers whose videos are ads / recommendation rails rather than the story. */
const EXCLUDED_ANCESTOR_TAGS = new Set(["ASIDE", "NAV", "FOOTER", "HEADER"]);
const EXCLUDED_CONTAINER_RE =
  /(?:^|[-_\s])(?:ad|ads|adv|advert|advertis\w*|recommend\w*|relate\w*|sidebar|side-?bar|promo\w*|banner|rank\w*|hot-?list|footer|comment\w*|player-?list|playlist)(?:$|[-_\s\d])/i;
const ARTICLE_CONTAINER_RE =
  /(?:^|[-_\s])(?:article|content|post|detail|main|body|story|news|text)(?:$|[-_\s\d])/i;

const VIDEO_FILE_RE = /\.(?:mp4|m4v|mov|webm|ogv|avi|flv|mkv)(?:$|[?#])/i;
const HLS_RE = /\.(?:m3u8|mpd)(?:$|[?#])/i;
/**
 * Media URLs embedded in inline player bootstrap JSON. Backslashes are allowed
 * through because JSON string escaping renders every slash as `\/`.
 */
const SCRIPT_MEDIA_RE = /https?:(?:\\?\/){2}[^\s"'<>]+?\.(?:mp4|m3u8)(?:\?[^\s"'<>]*)?/gi;

type MinimalElement = {
  tagName?: string;
  parentElement?: MinimalElement | null;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): Iterable<MinimalElement>;
  textContent?: string | null;
};

type MinimalDocument = {
  querySelectorAll(selector: string): Iterable<MinimalElement>;
  querySelector(selector: string): MinimalElement | null;
};

let parseHtmlPromise: Promise<typeof import("linkedom").parseHTML> | undefined;

async function loadParseHtml(): Promise<typeof import("linkedom").parseHTML> {
  if (!parseHtmlPromise) {
    parseHtmlPromise = import("linkedom").then((mod) => mod.parseHTML);
  }
  try {
    return await parseHtmlPromise;
  } catch (error) {
    parseHtmlPromise = undefined;
    throw error;
  }
}

function hostMatches(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

/** Resolve the platform label for a URL, or undefined when it is not a known video site. */
export function resolveVideoPlatform(rawUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const hostname = normalizeLowercaseStringOrEmpty(parsed.hostname);
  for (const [suffix, label] of PURE_VIDEO_HOSTS) {
    if (hostMatches(hostname, suffix)) {
      return label;
    }
  }
  for (const [suffix, label, pathRe] of MIXED_PLATFORM_HOSTS) {
    if (hostMatches(hostname, suffix) && pathRe.test(parsed.pathname)) {
      return label;
    }
  }
  return undefined;
}

function classifyUrl(rawUrl: string): { kind: VideoCandidateKind; platform?: string } {
  const platform = resolveVideoPlatform(rawUrl);
  if (HLS_RE.test(rawUrl)) {
    return { kind: "hls", platform };
  }
  if (VIDEO_FILE_RE.test(rawUrl)) {
    return { kind: "file", platform };
  }
  if (platform) {
    return { kind: "platform", platform };
  }
  return { kind: "embed" };
}

function absolutize(raw: string | null | undefined, baseUrl: string): string | undefined {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:")) {
    return undefined;
  }
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return undefined;
    }
    return resolved.toString();
  } catch {
    return undefined;
  }
}

/** Normalized key for dedupe: same media reached via http/https or a stray hash is one candidate. */
function dedupeKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return `${parsed.host}${parsed.pathname}${parsed.search}`.toLowerCase();
  } catch {
    return normalizeLowercaseStringOrEmpty(url);
  }
}

/** Parse ISO-8601 durations (`PT2M14S`) as used by schema.org VideoObject. */
export function parseIsoDurationSeconds(raw: string | undefined): number | undefined {
  const value = normalizeOptionalString(raw);
  if (!value) {
    return undefined;
  }
  const match = /^P(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/i.exec(value);
  if (!match) {
    const numeric = Number.parseFloat(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
  }
  const [, days, hours, minutes, seconds] = match;
  const total =
    (Number.parseFloat(days ?? "0") || 0) * 86_400 +
    (Number.parseFloat(hours ?? "0") || 0) * 3_600 +
    (Number.parseFloat(minutes ?? "0") || 0) * 60 +
    (Number.parseFloat(seconds ?? "0") || 0);
  return total > 0 ? total : undefined;
}

function isExcludedContainer(element: MinimalElement): boolean {
  let node: MinimalElement | null | undefined = element.parentElement;
  let depth = 0;
  while (node && depth < 12) {
    const tag = node.tagName?.toUpperCase() ?? "";
    if (EXCLUDED_ANCESTOR_TAGS.has(tag)) {
      return true;
    }
    const marker = `${node.getAttribute("class") ?? ""} ${node.getAttribute("id") ?? ""}`;
    if (marker.trim() && EXCLUDED_CONTAINER_RE.test(marker)) {
      return true;
    }
    node = node.parentElement;
    depth += 1;
  }
  return false;
}

function isInArticleContainer(element: MinimalElement): boolean {
  let node: MinimalElement | null | undefined = element.parentElement;
  let depth = 0;
  while (node && depth < 12) {
    const tag = node.tagName?.toUpperCase() ?? "";
    if (tag === "ARTICLE" || tag === "MAIN") {
      return true;
    }
    const marker = `${node.getAttribute("class") ?? ""} ${node.getAttribute("id") ?? ""}`;
    if (marker.trim() && ARTICLE_CONTAINER_RE.test(marker)) {
      return true;
    }
    node = node.parentElement;
    depth += 1;
  }
  return false;
}

type CandidateDraft = Omit<VideoCandidate, "score" | "reasons"> & {
  score: number;
  reasons: string[];
};

class CandidateCollector {
  private readonly byKey = new Map<string, CandidateDraft>();
  /**
   * URLs ruled out by DOM position. Kept separately because the whole-document
   * script scan runs later and would otherwise resurrect a video we just
   * excluded for sitting in a recommendation rail.
   */
  private readonly excluded = new Set<string>();

  add(params: {
    url: string;
    source: VideoCandidateSource;
    score: number;
    reason: string;
    title?: string;
    durationSeconds?: number;
    poster?: string;
  }): void {
    const { kind, platform } = classifyUrl(params.url);
    const key = dedupeKey(params.url);
    if (this.excluded.has(key)) {
      return;
    }
    const existing = this.byKey.get(key);
    if (existing) {
      // Same media found through a second signal: keep the strongest score and
      // merge whatever metadata the new signal contributed.
      if (params.score > existing.score) {
        existing.score = params.score;
        existing.source = params.source;
      }
      existing.reasons.push(params.reason);
      existing.title ??= params.title;
      existing.durationSeconds ??= params.durationSeconds;
      existing.poster ??= params.poster;
      return;
    }
    this.byKey.set(key, {
      url: params.url,
      kind,
      source: params.source,
      platform,
      title: params.title,
      durationSeconds: params.durationSeconds,
      poster: params.poster,
      score: params.score,
      reasons: [params.reason],
    });
  }

  penalize(url: string, amount: number, reason: string): void {
    const existing = this.byKey.get(dedupeKey(url));
    if (!existing) {
      return;
    }
    existing.score -= amount;
    existing.reasons.push(reason);
  }

  /** Permanently rule out a URL — later signals for the same media are ignored. */
  exclude(url: string): void {
    const key = dedupeKey(url);
    this.excluded.add(key);
    this.byKey.delete(key);
  }

  values(): CandidateDraft[] {
    return [...this.byKey.values()];
  }
}

function collectMetaCandidates(params: {
  document: MinimalDocument;
  baseUrl: string;
  collector: CandidateCollector;
  pageTitle?: string;
}): void {
  const { document, baseUrl, collector } = params;
  for (const meta of document.querySelectorAll("meta")) {
    const property = normalizeLowercaseStringOrEmpty(
      meta.getAttribute("property") ?? meta.getAttribute("name") ?? "",
    );
    if (!property) {
      continue;
    }
    const content = absolutize(meta.getAttribute("content"), baseUrl);
    if (!content) {
      continue;
    }
    if (
      property === "og:video" ||
      property === "og:video:url" ||
      property === "og:video:secure_url"
    ) {
      collector.add({
        url: content,
        source: "og",
        score: 100,
        reason: `og:video 声明的主视频 (${property})`,
        title: params.pageTitle,
      });
      continue;
    }
    if (property === "twitter:player:stream") {
      collector.add({
        url: content,
        source: "twitter",
        score: 90,
        reason: "twitter:player:stream 声明的主视频",
        title: params.pageTitle,
      });
      continue;
    }
    if (property === "twitter:player") {
      collector.add({
        url: content,
        source: "twitter",
        score: 70,
        reason: "twitter:player 播放器地址",
        title: params.pageTitle,
      });
    }
  }
}

type JsonLdNode = Record<string, unknown>;

function walkJsonLd(node: unknown, visit: (value: JsonLdNode) => void, depth = 0): void {
  if (depth > 8 || !node) {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      walkJsonLd(item, visit, depth + 1);
    }
    return;
  }
  if (typeof node !== "object") {
    return;
  }
  const record = node as JsonLdNode;
  visit(record);
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      walkJsonLd(value, visit, depth + 1);
    }
  }
}

function readJsonLdType(record: JsonLdNode): string[] {
  const raw = record["@type"];
  if (typeof raw === "string") {
    return [raw];
  }
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function titleSimilarity(a: string | undefined, b: string | undefined): number {
  const left = normalizeLowercaseStringOrEmpty(a ?? "");
  const right = normalizeLowercaseStringOrEmpty(b ?? "");
  if (!left || !right) {
    return 0;
  }
  if (left === right || left.includes(right) || right.includes(left)) {
    return 1;
  }
  return 0;
}

function collectJsonLdCandidates(params: {
  document: MinimalDocument;
  baseUrl: string;
  collector: CandidateCollector;
  pageTitle?: string;
}): void {
  const { document, baseUrl, collector } = params;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = normalizeOptionalString(script.textContent);
    if (!raw) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    walkJsonLd(parsed, (record) => {
      if (!readJsonLdType(record).some((type) => type.toLowerCase().endsWith("videoobject"))) {
        return;
      }
      const name = normalizeOptionalString(
        typeof record.name === "string" ? record.name : undefined,
      );
      const duration = parseIsoDurationSeconds(
        typeof record.duration === "string" ? record.duration : undefined,
      );
      const poster = absolutize(
        typeof record.thumbnailUrl === "string" ? record.thumbnailUrl : undefined,
        baseUrl,
      );
      const titleBonus = titleSimilarity(name, params.pageTitle) ? 15 : 0;
      const contentUrl = absolutize(
        typeof record.contentUrl === "string" ? record.contentUrl : undefined,
        baseUrl,
      );
      if (contentUrl) {
        collector.add({
          url: contentUrl,
          source: "json-ld",
          score: 80 + titleBonus,
          reason: titleBonus
            ? "JSON-LD VideoObject.contentUrl（标题与页面标题一致）"
            : "JSON-LD VideoObject.contentUrl",
          title: name,
          durationSeconds: duration,
          poster,
        });
      }
      const embedUrl = absolutize(
        typeof record.embedUrl === "string" ? record.embedUrl : undefined,
        baseUrl,
      );
      if (embedUrl) {
        collector.add({
          url: embedUrl,
          source: "json-ld",
          score: 60 + titleBonus,
          reason: "JSON-LD VideoObject.embedUrl",
          title: name,
          durationSeconds: duration,
          poster,
        });
      }
    });
  }
}

function collectVideoTagCandidates(params: {
  document: MinimalDocument;
  baseUrl: string;
  collector: CandidateCollector;
}): void {
  const { document, baseUrl, collector } = params;
  let order = 0;
  for (const element of document.querySelectorAll("video")) {
    const poster = absolutize(element.getAttribute("poster"), baseUrl);
    const urls: string[] = [];
    const direct = absolutize(element.getAttribute("src"), baseUrl);
    if (direct) {
      urls.push(direct);
    }
    for (const source of element.querySelectorAll("source")) {
      const sourceUrl = absolutize(source.getAttribute("src"), baseUrl);
      if (sourceUrl) {
        urls.push(sourceUrl);
      }
    }
    if (urls.length === 0) {
      continue;
    }
    const excluded = isExcludedContainer(element);
    const inArticle = isInArticleContainer(element);
    // autoplay+muted+loop with no controls is the signature of a decorative
    // background loop, not content anyone is meant to watch.
    const decorative =
      element.getAttribute("autoplay") !== null &&
      element.getAttribute("muted") !== null &&
      element.getAttribute("loop") !== null &&
      element.getAttribute("controls") === null;
    const positionBonus = Math.max(0, 5 - order);
    order += 1;

    for (const url of urls) {
      if (excluded) {
        collector.exclude(url);
        continue;
      }
      collector.add({
        url,
        source: "video-tag",
        score: (inArticle ? 50 : 30) + positionBonus,
        reason: inArticle ? "正文容器内的 <video>" : "页面内的 <video>",
        poster,
      });
      if (decorative) {
        collector.penalize(url, 50, "autoplay+muted+loop 且无控件，判为装饰性背景视频");
      }
    }
  }
}

function collectIframeCandidates(params: {
  document: MinimalDocument;
  baseUrl: string;
  collector: CandidateCollector;
}): void {
  const { document, baseUrl, collector } = params;
  for (const element of document.querySelectorAll("iframe")) {
    const url = absolutize(
      element.getAttribute("src") ?? element.getAttribute("data-src"),
      baseUrl,
    );
    if (!url) {
      continue;
    }
    const platform = resolveVideoPlatform(url);
    if (!platform && !VIDEO_FILE_RE.test(url) && !HLS_RE.test(url)) {
      continue;
    }
    if (isExcludedContainer(element)) {
      collector.exclude(url);
      continue;
    }
    collector.add({
      url,
      source: "iframe",
      score: isInArticleContainer(element) ? 45 : 35,
      reason: platform ? `正文内嵌 ${platform} 播放器` : "正文内嵌播放器 iframe",
    });
  }
}

function collectScriptCandidates(params: {
  html: string;
  baseUrl: string;
  collector: CandidateCollector;
}): void {
  const { html, baseUrl, collector } = params;
  let found = 0;
  for (const match of html.matchAll(SCRIPT_MEDIA_RE)) {
    if (found >= 6) {
      break;
    }
    // Player bootstrap JSON escapes slashes; undo that before resolving.
    const url = absolutize(match[0].replace(/\\\//g, "/"), baseUrl);
    if (!url) {
      continue;
    }
    found += 1;
    collector.add({
      url,
      source: "script",
      score: 20,
      reason: "页面脚本中的播放地址",
    });
  }
}

function readPageTitle(document: MinimalDocument): string | undefined {
  const ogTitle = document.querySelector('meta[property="og:title"]');
  const fromMeta = normalizeOptionalString(ogTitle?.getAttribute("content"));
  if (fromMeta) {
    return fromMeta;
  }
  return normalizeOptionalString(document.querySelector("title")?.textContent);
}

function finalize(drafts: CandidateDraft[], maxCandidates: number): VideoDetectionResult {
  const ranked = drafts
    .filter((draft) => draft.score > 0)
    .toSorted((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.url.localeCompare(right.url);
    })
    .slice(0, maxCandidates);
  if (ranked.length === 0) {
    return { others: [], ambiguous: false };
  }
  const [main, ...others] = ranked;
  const ambiguous = others.length > 0 && main.score - others[0].score <= AMBIGUOUS_MARGIN;
  return { main, others, ambiguous };
}

/**
 * Scan raw page HTML for video candidates and rank them.
 *
 * Returns an empty result (rather than throwing) when the HTML cannot be parsed —
 * video discovery is an enrichment of `web_fetch`, never a reason to fail it.
 */
export async function detectVideoCandidates(params: {
  html: string;
  url: string;
  maxCandidates?: number;
}): Promise<VideoDetectionResult> {
  const html = params.html?.slice(0, MAX_HTML_CHARS) ?? "";
  if (!html.trim()) {
    return { others: [], ambiguous: false };
  }
  const maxCandidates = Math.max(1, Math.floor(params.maxCandidates ?? DEFAULT_MAX_CANDIDATES));
  const collector = new CandidateCollector();

  try {
    const parseHTML = await loadParseHtml();
    const { document } = parseHTML(html) as unknown as { document: MinimalDocument };
    const pageTitle = readPageTitle(document);
    collectMetaCandidates({ document, baseUrl: params.url, collector, pageTitle });
    collectJsonLdCandidates({ document, baseUrl: params.url, collector, pageTitle });
    collectVideoTagCandidates({ document, baseUrl: params.url, collector });
    collectIframeCandidates({ document, baseUrl: params.url, collector });
  } catch {
    // Fall through to the script scan: a malformed page can still expose a
    // player URL in an inline bootstrap blob.
  }
  collectScriptCandidates({ html, baseUrl: params.url, collector });

  const drafts = collector.values();
  // A platform watch page is itself the video even when the markup hides the
  // player behind client-side rendering (抖音/B站 render nothing server-side).
  const pagePlatform = resolveVideoPlatform(params.url);
  if (pagePlatform && drafts.every((draft) => draft.score < 95)) {
    collector.add({
      url: params.url,
      source: "page-url",
      score: 95,
      reason: `页面本身是 ${pagePlatform} 视频页`,
    });
  }

  return finalize(collector.values(), maxCandidates);
}

/** Compact shape attached to `web_fetch` results — full candidates would bloat context. */
export type WebFetchVideoSummary = {
  count: number;
  main: {
    url: string;
    kind: VideoCandidateKind;
    platform?: string;
    title?: string;
    durationSeconds?: number;
    reasons: string[];
  };
  others: Array<{ url: string; kind: VideoCandidateKind; platform?: string; title?: string }>;
  ambiguous: boolean;
  hint: string;
};

export function summarizeVideoDetection(
  detection: VideoDetectionResult,
): WebFetchVideoSummary | undefined {
  if (!detection.main) {
    return undefined;
  }
  return {
    count: detection.others.length + 1,
    main: {
      url: detection.main.url,
      kind: detection.main.kind,
      platform: detection.main.platform,
      title: detection.main.title,
      durationSeconds: detection.main.durationSeconds,
      reasons: detection.main.reasons,
    },
    others: detection.others.map((candidate) => ({
      url: candidate.url,
      kind: candidate.kind,
      platform: candidate.platform,
      title: candidate.title,
    })),
    ambiguous: detection.ambiguous,
    hint: detection.ambiguous
      ? "检测到多个视频且主视频判定不确定，请结合正文自行挑选后调用 video_understand。"
      : "如需了解视频内容，调用 video_understand 并传入 main.url。",
  };
}
