import { describe, expect, it, vi } from "vitest";
import { collectGallery, findGallery } from "./gallery.js";

const xml = (page: number, total = 3) =>
  `<hierarchy><node package="com.xingin.xhs" content-desc="图片,第${page}张,共 ${total}张,双指左划或右划即可查看更多内容" bounds="[0,200][1080,1400]"/></hierarchy>`;

describe("phone gallery", () => {
  it("uses accessible page numbers and actual image bounds", () => {
    expect(findGallery(xml(1), "com.xingin.xhs")).toEqual({
      page: 1,
      total: 3,
      bounds: { left: 0, top: 200, width: 1080, height: 1200 },
    });
    expect(findGallery(xml(1), "another.app")).toBeUndefined();
    expect(findGallery(xml(4), "com.xingin.xhs")).toBeUndefined();
    expect(findGallery(xml(1).replace("[1080,1400]", "[0,0]"), "com.xingin.xhs")).toBeUndefined();
  });
  it("captures each page once and stops at the last page", async () => {
    let page = 1;
    const swipe = vi.fn(async () => {
      page++;
    });
    const result = await collectGallery({
      initialXml: xml(1),
      packageName: "com.xingin.xhs",
      maxImages: 5,
      readUi: async () => xml(page),
      swipe,
      pause: async () => {},
      assertForeground: async () => {},
      capture: async () => ({ path: `page-${page}.png`, hash: String(page) }),
    });
    expect(result.images.map((i) => i.page)).toEqual([1, 2, 3]);
    expect(result.complete).toBe(true);
    expect(swipe).toHaveBeenCalledTimes(2);
  });
  it("reports partial capture when swiping fails, rather than repeating the same image", async () => {
    const result = await collectGallery({
      initialXml: xml(1),
      packageName: "com.xingin.xhs",
      maxImages: 5,
      readUi: async () => xml(1),
      swipe: async () => {},
      pause: async () => {},
      assertForeground: async () => {},
      capture: async () => ({ path: "one.png", hash: "one" }),
    });
    expect(result.images).toHaveLength(1);
    expect(result.stopReason).toBe("page_did_not_advance");
    expect(result.complete).toBe(false);
  });
  it("does not swipe unknown layouts and respects the image limit", async () => {
    const swipe = vi.fn(async () => {});
    const deps = {
      packageName: "com.xingin.xhs",
      maxImages: 1,
      readUi: async () => xml(2),
      swipe,
      pause: async () => {},
      assertForeground: async () => {},
      capture: async () => ({ path: "one.png", hash: "one" }),
    };
    expect((await collectGallery({ ...deps, initialXml: "<hierarchy/>" })).stopReason).toBe(
      "no_gallery",
    );
    expect((await collectGallery({ ...deps, initialXml: xml(1) })).stopReason).toBe("image_limit");
    expect(swipe).not.toHaveBeenCalled();
  });
  it("stops on duplicate pixels or a changed foreground", async () => {
    const deps = {
      initialXml: xml(1),
      packageName: "com.xingin.xhs",
      maxImages: 5,
      readUi: async () => xml(2),
      swipe: async () => {},
      pause: async () => {},
      assertForeground: async () => {},
      capture: async () => ({ path: "same.png", hash: "same" }),
    };
    const result = await collectGallery(deps);
    expect(result.stopReason).toBe("duplicate_image");
    expect(result.images).toHaveLength(1);
    const capture = vi.fn(deps.capture);
    const blocked = await collectGallery({
      ...deps,
      capture,
      assertForeground: async () => {
        throw new Error("changed");
      },
    });
    expect(blocked.stopReason).toBe("capture_failed");
    expect(capture).not.toHaveBeenCalled();
  });
});
