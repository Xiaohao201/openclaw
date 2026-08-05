import { ToolInputError } from "./common.js";

/**
 * Deterministic chart rendering for the `chart_render` tool: an ECharts option
 * (or a raw SVG document) is turned into a PNG without a browser — ECharts has
 * a server-side SVG renderer, and sharp rasterizes the result. Numbers come
 * from the model's data, never from a diffusion model that would invent them.
 */

export const CHART_DEFAULT_WIDTH = 900;
export const CHART_DEFAULT_HEIGHT = 500;
const MIN_CHART_SIDE = 200;
const MAX_CHART_SIDE = 4000;

/** Raw SVG accepted from the model; large enough for a dense chart, small enough to stay cheap. */
const MAX_SVG_LENGTH = 2_000_000;

const MAX_RASTER_PIXELS = MAX_CHART_SIDE * MAX_CHART_SIDE;

/**
 * CJK-safe stack: the SVG carries no font files, so every label is resolved
 * against host fonts at rasterization time. Without a CJK family first, Chinese
 * axis/title text renders as tofu boxes on hosts whose default sans has no CJK
 * coverage.
 *
 * Single quotes are load-bearing: ECharts emits the family into `style="…"`, so
 * a double-quoted family name closes the attribute and the SVG stops parsing.
 */
export const CHART_FONT_FAMILY =
  "'Microsoft YaHei','PingFang SC','Hiragino Sans GB','Noto Sans CJK SC','Source Han Sans SC','WenQuanYi Micro Hei',Arial,sans-serif";

type SharpModule = typeof import("sharp");

export function clampChartSide(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(MAX_CHART_SIDE, Math.max(MIN_CHART_SIDE, Math.round(value)));
}

/**
 * Accept the option either as a JSON string (what the schema advertises) or as
 * an already-decoded object (what some providers send anyway).
 */
export function parseChartOption(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new ToolInputError("option must not be empty");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(trimmed);
    } catch {
      throw new ToolInputError("option must be valid JSON (an ECharts option object)");
    }
    return parseChartOption(decoded);
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  throw new ToolInputError("option must be an ECharts option object (or its JSON string)");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Defaults the model should not have to remember: opaque white background (a
 * transparent chart is unreadable on a dark chat bubble), animation off (an SSR
 * render would otherwise capture frame zero), and the CJK font stack.
 */
export function withChartDefaults(option: Record<string, unknown>): Record<string, unknown> {
  return {
    backgroundColor: "#ffffff",
    ...option,
    animation: false,
    textStyle: {
      fontFamily: CHART_FONT_FAMILY,
      ...asRecord(option.textStyle),
    },
  };
}

/**
 * ECharts writes every `fontFamily` verbatim into a `style="…"` attribute, so a
 * model-supplied family with double quotes (the usual CSS habit) corrupts the
 * SVG document. Rewrite them to single quotes anywhere in the option tree.
 */
export function normalizeFontFamilies(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeFontFamilies);
  }
  const record = asRecord(value);
  if (!record) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => {
      if (key === "fontFamily" && typeof entry === "string") {
        return [key, entry.replaceAll('"', "'")];
      }
      return [key, normalizeFontFamilies(entry)];
    }),
  );
}

/** Markup that would make rasterization fetch or execute something. */
const UNSAFE_SVG_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /<\s*script\b/i, reason: "<script> is not allowed in svg" },
  { pattern: /<\s*foreignObject\b/i, reason: "<foreignObject> is not allowed in svg" },
  { pattern: /\son[a-z]+\s*=/i, reason: "inline event handlers are not allowed in svg" },
  {
    pattern: /(?:xlink:)?href\s*=\s*["']?\s*(?:https?:|\/\/|file:)/i,
    reason: "external references are not allowed in svg (inline the content instead)",
  },
];

/**
 * Model-authored SVG is untrusted input to a native rasterizer. We only accept
 * self-contained documents: no scripts, no event handlers, no remote fetches.
 */
export function assertRenderableSvg(svg: string): void {
  const trimmed = svg.trim();
  if (!trimmed) {
    throw new ToolInputError("svg must not be empty");
  }
  if (trimmed.length > MAX_SVG_LENGTH) {
    throw new ToolInputError(`svg is too large (max ${MAX_SVG_LENGTH} characters)`);
  }
  if (!/<\s*svg\b/i.test(trimmed)) {
    throw new ToolInputError("svg must be an <svg> document");
  }
  for (const { pattern, reason } of UNSAFE_SVG_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new ToolInputError(reason);
    }
  }
}

export type ChartSvgRequest = {
  option: Record<string, unknown>;
  width: number;
  height: number;
};

/** Render an ECharts option to an SVG string via the server-side renderer (no browser). */
export async function renderEChartsSvg(request: ChartSvgRequest): Promise<string> {
  const echarts = await import("echarts");
  const chart = echarts.init(null, null, {
    renderer: "svg",
    ssr: true,
    width: request.width,
    height: request.height,
  });
  try {
    chart.setOption(
      normalizeFontFamilies(withChartDefaults(request.option)) as Record<string, unknown>,
    );
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

export type RasterizedPng = {
  data: Buffer;
  width: number;
  height: number;
};

/** Rasterize an SVG document to PNG bytes. */
export async function rasterizeSvgToPng(svg: string): Promise<RasterizedPng> {
  const mod = (await import("sharp")) as unknown as { default?: SharpModule };
  const sharp = mod.default ?? (mod as unknown as SharpModule);
  const { data, info } = await sharp(Buffer.from(svg, "utf8"), {
    limitInputPixels: MAX_RASTER_PIXELS,
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
