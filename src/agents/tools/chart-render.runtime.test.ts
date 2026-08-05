import { describe, expect, it } from "vitest";
import {
  assertRenderableSvg,
  CHART_FONT_FAMILY,
  clampChartSide,
  normalizeFontFamilies,
  parseChartOption,
  rasterizeSvgToPng,
  renderEChartsSvg,
  withChartDefaults,
} from "./chart-render.runtime.js";

describe("chart render runtime", () => {
  it("clamps sizes into the renderable range", () => {
    expect(clampChartSide(undefined, 900)).toBe(900);
    expect(clampChartSide(Number.NaN, 500)).toBe(500);
    expect(clampChartSide(10, 900)).toBe(200);
    expect(clampChartSide(99_999, 900)).toBe(4000);
    expect(clampChartSide(640.4, 900)).toBe(640);
  });

  it("accepts the option as JSON string or object", () => {
    expect(parseChartOption('{"series":[]}')).toEqual({ series: [] });
    const asObject = { series: [] };
    expect(parseChartOption(asObject)).toEqual(asObject);
  });

  it("rejects option input that is not an option object", () => {
    expect(() => parseChartOption("not json")).toThrow(/valid JSON/);
    expect(() => parseChartOption("   ")).toThrow(/must not be empty/);
    expect(() => parseChartOption("[1,2]")).toThrow(/option object/);
    expect(() => parseChartOption(42)).toThrow(/option object/);
  });

  it("applies CJK font, opaque background and no animation without mutating input", () => {
    const option = { title: { text: "趋势" }, textStyle: { fontSize: 18 } };
    const withDefaults = withChartDefaults(option);
    expect(withDefaults.backgroundColor).toBe("#ffffff");
    expect(withDefaults.animation).toBe(false);
    expect(withDefaults.textStyle).toEqual({ fontFamily: CHART_FONT_FAMILY, fontSize: 18 });
    expect(option).toEqual({ title: { text: "趋势" }, textStyle: { fontSize: 18 } });
  });

  it("lets the caller override the defaults it cares about", () => {
    expect(withChartDefaults({ backgroundColor: "#000" }).backgroundColor).toBe("#000");
    expect(
      (
        withChartDefaults({ textStyle: { fontFamily: "Serif" } }).textStyle as {
          fontFamily: string;
        }
      ).fontFamily,
    ).toBe("Serif");
  });

  it("rejects svg that would fetch or execute something", () => {
    expect(() => assertRenderableSvg("")).toThrow(/must not be empty/);
    expect(() => assertRenderableSvg("<div>hi</div>")).toThrow(/<svg> document/);
    expect(() => assertRenderableSvg("<svg><script>alert(1)</script></svg>")).toThrow(/script/);
    expect(() => assertRenderableSvg("<svg><foreignObject/></svg>")).toThrow(/foreignObject/);
    expect(() => assertRenderableSvg('<svg><rect onload="x()"/></svg>')).toThrow(/event handlers/);
    expect(() => assertRenderableSvg('<svg><image href="https://x/y.png"/></svg>')).toThrow(
      /external references/,
    );
    expect(() => assertRenderableSvg('<svg><image xlink:href="//x/y.png"/></svg>')).toThrow(
      /external references/,
    );
  });

  it("accepts a self-contained svg with inline data references", () => {
    expect(() =>
      assertRenderableSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
      ),
    ).not.toThrow();
  });

  it("renders an ECharts option to an SVG string at the requested size", async () => {
    const svg = await renderEChartsSvg({
      option: {
        title: { text: "发布时间趋势" },
        xAxis: { type: "category", data: ["7/1", "7/25"] },
        yAxis: { type: "value" },
        series: [{ type: "line", data: [1, 11] }],
      },
      width: 640,
      height: 320,
    });
    expect(svg).toContain("<svg");
    expect(svg).toContain('width="640"');
    expect(svg).toContain('height="320"');
    // Chinese title survives into the document, and the font stack is applied.
    expect(svg).toContain("发布时间趋势");
    expect(svg).toContain("Microsoft YaHei");
  });

  it("rewrites double-quoted font families that would corrupt the svg", async () => {
    expect(normalizeFontFamilies({ textStyle: { fontFamily: '"Arial",sans-serif' } })).toEqual({
      textStyle: { fontFamily: "'Arial',sans-serif" },
    });
    expect(normalizeFontFamilies({ series: [{ label: { fontFamily: '"Noto Sans"' } }] })).toEqual({
      series: [{ label: { fontFamily: "'Noto Sans'" } }],
    });

    // End to end: a model-supplied double-quoted family still rasterizes.
    const svg = await renderEChartsSvg({
      option: {
        textStyle: { fontFamily: '"Microsoft YaHei", sans-serif' },
        title: { text: "字体" },
        xAxis: { type: "category", data: ["甲"] },
        yAxis: {},
        series: [{ type: "bar", data: [2] }],
      },
      width: 300,
      height: 200,
    });
    expect(svg).not.toContain('font-family:"');
    await expect(rasterizeSvgToPng(svg)).resolves.toMatchObject({ width: 300, height: 200 });
  });

  it("rasterizes an SVG to PNG bytes of the same size", async () => {
    const svg = await renderEChartsSvg({
      option: {
        xAxis: { type: "category", data: ["a"] },
        yAxis: {},
        series: [{ type: "bar", data: [1] }],
      },
      width: 400,
      height: 240,
    });
    const png = await rasterizeSvgToPng(svg);
    expect(png.width).toBe(400);
    expect(png.height).toBe(240);
    expect(png.data.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });
});
