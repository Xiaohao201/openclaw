import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  type AliyunOssConfig,
  type OssUploadResult,
  resolveOssConfig,
  uploadFileToOss,
} from "../../infra/aliyun-oss.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import {
  assertRenderableSvg,
  CHART_DEFAULT_HEIGHT,
  CHART_DEFAULT_WIDTH,
  clampChartSide,
  parseChartOption,
  rasterizeSvgToPng,
  renderEChartsSvg,
} from "./chart-render.runtime.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNumberParam,
  readStringParam,
  ToolInputError,
} from "./common.js";

const log = createSubsystemLogger("chart-render-tool");

/** Subdirectory (inside the workspace) that holds rendered charts. */
const CHART_SUBDIR = "charts";

type ChartRenderToolDeps = {
  resolveConfig: () => AliyunOssConfig | null;
  uploadFile: (params: {
    config: AliyunOssConfig;
    localPath: string;
    displayName: string;
  }) => Promise<OssUploadResult>;
  renderSvg: typeof renderEChartsSvg;
  rasterize: typeof rasterizeSvgToPng;
};

type ChartRenderToolOptions = {
  /** Agent workspace root; rendered PNGs land in `<workspace>/charts`. */
  workspaceDir?: string;
  /** Trusted session key, used for audit logging only (never model args). */
  agentSessionKey?: string;
  /** Test seam; production callers omit this. */
  deps?: Partial<ChartRenderToolDeps>;
};

const defaultDeps: ChartRenderToolDeps = {
  resolveConfig: resolveOssConfig,
  uploadFile: uploadFileToOss,
  renderSvg: renderEChartsSvg,
  rasterize: rasterizeSvgToPng,
};

const ChartRenderToolSchema = Type.Object({
  option: Type.Optional(
    Type.String({
      description:
        'ECharts option as a JSON string, e.g. {"title":{"text":"…"},"xAxis":{"type":"category","data":[…]},"yAxis":{"type":"value"},"series":[{"type":"line","data":[…]}]}. Put the real numbers here — they are rendered exactly as given. Required unless `svg` is provided.',
    }),
  ),
  svg: Type.Optional(
    Type.String({
      description:
        "Self-contained SVG document to rasterize instead of an ECharts option. Use only for layouts ECharts cannot express; no scripts, event handlers, or external references.",
    }),
  ),
  width: Type.Optional(
    Type.Integer({ description: `Image width in pixels (default ${CHART_DEFAULT_WIDTH}).` }),
  ),
  height: Type.Optional(
    Type.Integer({ description: `Image height in pixels (default ${CHART_DEFAULT_HEIGHT}).` }),
  ),
  filename: Type.Optional(
    Type.String({
      description:
        "Download filename for the PNG (e.g. 发布时间趋势.png). Defaults to a timestamp.",
    }),
  ),
});

/** `chart-20260804-153012.png` — sortable, ASCII, collision-free enough per second. */
function defaultChartFilename(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `chart-${stamp}.png`;
}

const FILENAME_ILLEGAL_CHARS = /[<>:"|?*]/g;

/** Drop control characters without a regex range (formatters mangle escaped ranges). */
function stripControlChars(value: string): string {
  return Array.from(value)
    .filter((char) => char.charCodeAt(0) >= 0x20)
    .join("");
}

/**
 * Keep the model-supplied name as the (often Chinese) download label while
 * stripping anything that could escape the charts directory. The extension is
 * forced to `.png` so the OSS content type and the chat `<img>` agree.
 */
export function sanitizeChartFilename(requested: string | undefined, now: Date): string {
  const raw = requested?.trim();
  if (!raw) {
    return defaultChartFilename(now);
  }
  const base = stripControlChars(
    raw.replace(/[/\\]/g, "_").replace(/\.\.+/g, ".").replace(FILENAME_ILLEGAL_CHARS, ""),
  ).trim();
  const withoutExtension = base.replace(/\.png$/i, "").trim();
  return withoutExtension ? `${withoutExtension}.png` : defaultChartFilename(now);
}

/**
 * chart_render — turn data into a PNG chart and hand back a link the user can
 * actually see. The model supplies an ECharts option (or raw SVG); the render
 * happens here, so the numbers on the chart are the numbers it passed in.
 *
 * When OSS is configured the PNG is uploaded and the tool returns a permanent
 * public URL plus ready-to-paste markdown — web users cannot reach workspace
 * paths, so an inline `![](url)` is the only delivery that reaches them.
 */
export function createChartRenderTool(opts?: ChartRenderToolOptions): AnyAgentTool {
  const deps: ChartRenderToolDeps = { ...defaultDeps, ...opts?.deps };

  return {
    label: "Render chart",
    name: "chart_render",
    description:
      "Render a data chart (line/bar/pie/scatter/…) to a PNG image and get a public image URL to embed in your reply. " +
      "Use this whenever the user asks for a chart, graph, trend picture, or any visualization of data you have — never describe a chart in prose instead, and never use image generation for data charts (it invents numbers). " +
      "Pass an ECharts option JSON built from the actual data. Reply with the returned markdown so the image shows inline.",
    parameters: ChartRenderToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const rawOption = readSnakeCaseParamRaw(params, "option");
      const svgInput = readStringParam(params, "svg");
      const width = clampChartSide(readNumberParam(params, "width"), CHART_DEFAULT_WIDTH);
      const height = clampChartSide(readNumberParam(params, "height"), CHART_DEFAULT_HEIGHT);

      const hasOption = rawOption !== undefined && rawOption !== null && rawOption !== "";
      if (!hasOption && !svgInput) {
        throw new ToolInputError("provide either option (ECharts option JSON) or svg");
      }

      let svg: string;
      if (hasOption) {
        svg = await deps.renderSvg({ option: parseChartOption(rawOption), width, height });
      } else {
        const rawSvg = svgInput as string;
        assertRenderableSvg(rawSvg);
        svg = rawSvg;
      }

      let png: Awaited<ReturnType<typeof rasterizeSvgToPng>>;
      try {
        png = await deps.rasterize(svg);
      } catch (err) {
        log.warn(`chart_render: rasterization failed: ${formatErrorMessage(err)}`);
        throw new ToolInputError(
          "Could not rasterize the chart. Check the option/svg and try again.",
        );
      }

      const now = new Date();
      const filename = sanitizeChartFilename(readStringParam(params, "filename"), now);
      const outputDir = path.join(
        opts?.workspaceDir ?? resolvePreferredOpenClawTmpDir(),
        CHART_SUBDIR,
      );
      await fs.mkdir(outputDir, { recursive: true });
      const filePath = path.join(outputDir, filename);
      await fs.writeFile(filePath, png.data);

      const altText = filename.replace(/\.png$/i, "");
      const ossConfig = deps.resolveConfig();
      if (!ossConfig) {
        return jsonResult({
          ok: true,
          path: filePath,
          filename,
          width: png.width,
          height: png.height,
          note: "Cloud storage is not configured, so there is no public URL. The PNG only exists on this host.",
        });
      }

      try {
        const uploaded = await deps.uploadFile({
          config: ossConfig,
          localPath: filePath,
          displayName: filename,
        });
        log.info(
          `chart_render: uploaded ${filename} (${uploaded.size} bytes, ${png.width}x${png.height}) ` +
            `for session=${opts?.agentSessionKey ?? "unknown"} -> ${uploaded.objectKey}`,
        );
        return jsonResult({
          ok: true,
          url: uploaded.url,
          markdown: `![${altText}](${uploaded.url})`,
          filename,
          width: png.width,
          height: png.height,
          note: "Paste the markdown into your reply so the chart shows inline. Never mention the local file path.",
        });
      } catch (err) {
        // Keep credentials/host details out of model-visible errors.
        log.warn(`chart_render: upload failed: ${formatErrorMessage(err)}`);
        throw new ToolInputError(
          "Could not upload the rendered chart right now. Please try again.",
        );
      }
    },
  };
}
