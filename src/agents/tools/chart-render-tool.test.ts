import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AliyunOssConfig } from "../../infra/aliyun-oss.js";
import { createChartRenderTool, sanitizeChartFilename } from "./chart-render-tool.js";

const TEST_CONFIG: AliyunOssConfig = {
  accessKeyId: "ak",
  accessKeySecret: "sk",
  bucket: "leadingnews",
  endpoint: "oss-cn-beijing.aliyuncs.com",
  customDomain: "https://oss.ibtai.com",
  pathPrefix: "ibtai/assistant-agent/outputs",
  maxFileSizeMb: 100,
  allowedExtensions: ["png"],
};

const OPTION_JSON = JSON.stringify({
  title: { text: "发布时间趋势" },
  xAxis: { type: "category", data: ["7/1", "7/25"] },
  yAxis: { type: "value" },
  series: [{ type: "line", data: [1, 11] }],
});

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("chart_render tool", () => {
  let workspaceDir: string;
  let uploads: Array<{ localPath: string; displayName: string }>;
  let rendered: Array<{ option: Record<string, unknown>; width: number; height: number }>;

  function makeTool(options?: { ossConfigured?: boolean }) {
    return createChartRenderTool({
      workspaceDir,
      agentSessionKey: "agent:rabbitmq-2059:rabbitmq:2059:session_x",
      deps: {
        resolveConfig: () => (options?.ossConfigured === false ? null : TEST_CONFIG),
        uploadFile: async ({ localPath, displayName }) => {
          uploads.push({ localPath, displayName });
          return {
            url: "https://oss.ibtai.com/ibtai/assistant-agent/outputs/2026/8/4/1_ab12cd34.png",
            objectKey: "ibtai/assistant-agent/outputs/2026/8/4/1_ab12cd34.png",
            size: 1234,
          };
        },
        renderSvg: async (request) => {
          rendered.push(request);
          return `<svg xmlns="http://www.w3.org/2000/svg" width="${request.width}" height="${request.height}"></svg>`;
        },
        rasterize: async () => ({ data: PNG_HEADER, width: 900, height: 500 }),
      },
    });
  }

  async function run(tool: ReturnType<typeof makeTool>, args: Record<string, unknown>) {
    const result = await tool.execute?.("call-1", args, undefined as never);
    return JSON.parse((result?.content?.[0] as { text: string }).text) as Record<string, unknown>;
  }

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "chart-render-ws-"));
    uploads = [];
    rendered = [];
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("renders an option, uploads the PNG and returns embeddable markdown", async () => {
    const payload = await run(makeTool(), { option: OPTION_JSON, filename: "发布时间趋势.png" });

    expect(rendered).toHaveLength(1);
    expect(rendered[0].width).toBe(900);
    expect(rendered[0].height).toBe(500);
    expect(rendered[0].option).toMatchObject({ title: { text: "发布时间趋势" } });

    expect(uploads).toHaveLength(1);
    expect(uploads[0].displayName).toBe("发布时间趋势.png");
    expect(payload.url).toBe(
      "https://oss.ibtai.com/ibtai/assistant-agent/outputs/2026/8/4/1_ab12cd34.png",
    );
    expect(payload.markdown).toBe(
      "![发布时间趋势](https://oss.ibtai.com/ibtai/assistant-agent/outputs/2026/8/4/1_ab12cd34.png)",
    );

    const written = await fs.readFile(path.join(workspaceDir, "charts", "发布时间趋势.png"));
    expect(written).toEqual(PNG_HEADER);
  });

  it("clamps requested dimensions", async () => {
    await run(makeTool(), { option: OPTION_JSON, width: 10, height: 99_999 });
    expect(rendered[0]).toMatchObject({ width: 200, height: 4000 });
  });

  it("accepts a raw svg instead of an option and skips the ECharts renderer", async () => {
    const payload = await run(makeTool(), {
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    });
    expect(rendered).toHaveLength(0);
    expect(payload.ok).toBe(true);
    expect(uploads).toHaveLength(1);
  });

  it("rejects unsafe svg and missing input", async () => {
    const tool = makeTool();
    await expect(run(tool, {})).rejects.toThrow(/option .* or svg/);
    await expect(run(tool, { svg: "<svg><script>x</script></svg>" })).rejects.toThrow(/script/);
    expect(uploads).toHaveLength(0);
  });

  it("falls back to a local path when cloud storage is not configured", async () => {
    const payload = await run(makeTool({ ossConfigured: false }), { option: OPTION_JSON });
    expect(payload.url).toBeUndefined();
    expect(String(payload.path)).toContain("charts");
    expect(uploads).toHaveLength(0);
  });

  it("sanitizes model-supplied filenames", () => {
    const now = new Date(2026, 7, 4, 15, 30, 12);
    expect(sanitizeChartFilename(undefined, now)).toBe("chart-20260804-153012.png");
    expect(sanitizeChartFilename("  ", now)).toBe("chart-20260804-153012.png");
    expect(sanitizeChartFilename("趋势图", now)).toBe("趋势图.png");
    expect(sanitizeChartFilename("趋势图.png", now)).toBe("趋势图.png");
    // Separators become underscores and dot runs collapse: nothing can traverse out.
    expect(sanitizeChartFilename("../../etc/passwd", now)).toBe("._._etc_passwd.png");
    expect(sanitizeChartFilename('a<b>c:"d|e?f*g.png', now)).toBe("abcdefg.png");
    expect(sanitizeChartFilename("7月/8月 数据.png", now)).toBe("7月_8月 数据.png");
  });
});
