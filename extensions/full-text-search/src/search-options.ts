export const PLATFORM_CODES = [
  "app",
  "bbs",
  "douyin",
  "enews",
  "jingwai",
  "shipin",
  "toutiao",
  "web",
  "weibo",
  "weixin",
  "xiaohongshu",
] as const;
export const HIT_FIELDS = ["asr", "content", "nickname", "ocr", "poi", "title"] as const;
export const SEARCH_ORDERS = [
  "time_desc",
  "time_asc",
  "respond_desc",
  "like_desc",
  "comment_desc",
  "share_desc",
  "score",
  "similarity_desc",
  "fans_desc",
  "create_desc",
  "create_asc",
] as const;

const PLATFORM_ALIASES: Readonly<Record<string, string>> = {
  抖音: "douyin",
  微博: "weibo",
  微信: "weixin",
  头条: "toutiao",
  小红书: "xiaohongshu",
  网页: "web",
  网站: "web",
  客户端: "app",
  论坛: "bbs",
  数字报: "enews",
  境外: "jingwai",
  其他视频: "shipin",
};

export function normalizeStringArray(
  value: string[] | undefined,
  maximum: number,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`Expected at most ${maximum} string values.`);
  }
  const normalized = [...new Set(value.map((entry) => entry.trim()).filter(Boolean))].toSorted();
  return normalized.length ? normalized : undefined;
}

export function normalizeQuery(query: unknown): string[] {
  const values = typeof query === "string" ? [query] : query;
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 500)
  ) {
    throw new Error(
      "query is required: use a nonempty string or an array of keyword groups (max 500 characters each).",
    );
  }
  return normalizeStringArray(
    values.map((entry) => entry.trim().replace(/\s+/gu, " ")),
    20,
  )!;
}

export function normalizePlatforms(platforms?: string[]): string[] | undefined {
  return normalizeStringArray(
    platforms?.map((value) => {
      const trimmed = value.trim();
      const code = PLATFORM_ALIASES[trimmed] ?? trimmed.toLowerCase();
      if (!(PLATFORM_CODES as readonly string[]).includes(code)) {
        throw new Error("Unsupported platform; use a documented platform code.");
      }
      return code;
    }),
    20,
  );
}

export function normalizeHitFields(fields?: string[]): string[] | undefined {
  const values = normalizeStringArray(fields, 6);
  if (values?.some((field) => !(HIT_FIELDS as readonly string[]).includes(field))) {
    throw new Error("Unsupported hitFields value.");
  }
  return values;
}

function minuteValue(value: string, end: boolean): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/u.exec(value);
  if (!match) {
    throw new Error("Dates must use a valid YYYY-MM-DD or YYYY-MM-DD HH:mm value.");
  }
  const [, year, month, day, hour, minute] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() !== Number(month) - 1 ||
    parsed.getUTCDate() !== Number(day) ||
    (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59))
  ) {
    throw new Error("Dates must use a valid YYYY-MM-DD or YYYY-MM-DD HH:mm value.");
  }
  return hour === undefined ? `${value} ${end ? "23:59" : "00:00"}` : value;
}

export type SearchDateParams = { dateAfter?: string; dateBefore?: string; endExclusive?: boolean };

export function resolveDateRange(
  params: SearchDateParams,
  now = new Date(),
): { dateAfter: string; dateBefore: string } {
  // Interpret calendar defaults in the corpus timezone, independent of the gateway host.
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const today = shanghai.toISOString().slice(0, 10);
  shanghai.setUTCDate(shanghai.getUTCDate() - 30);
  const range = {
    dateAfter: params.dateAfter?.trim() || shanghai.toISOString().slice(0, 10),
    dateBefore: params.dateBefore?.trim() || today,
  };
  if (minuteValue(range.dateAfter, false) > minuteValue(range.dateBefore, true)) {
    throw new Error("dateAfter must not be later than dateBefore.");
  }
  return range;
}

export function resolveSearchWindow(params: SearchDateParams): {
  start: string;
  end: string;
  timeZone: "Asia/Shanghai";
  endInclusive: true;
} {
  const range = resolveDateRange(params);
  const start = minuteValue(range.dateAfter, false);
  let end = minuteValue(range.dateBefore, true);
  if (params.endExclusive) {
    if (!range.dateBefore.includes(" ")) {
      throw new Error("endExclusive requires dateBefore in YYYY-MM-DD HH:mm format.");
    }
    // The upstream includes the entire end minute. Subtract one minute for [start, end).
    end = new Date(Date.parse(`${end.replace(" ", "T")}:00Z`) - 60_000)
      .toISOString()
      .slice(0, 16)
      .replace("T", " ");
  }
  if (start > end) {
    throw new Error("The effective search window must not be empty.");
  }
  return { start, end, timeZone: "Asia/Shanghai", endInclusive: true };
}
