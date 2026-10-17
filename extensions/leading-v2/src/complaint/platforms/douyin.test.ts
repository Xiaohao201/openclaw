import { expect, it } from "vitest";
import { selectDouyinCategory } from "./douyin.js";
it("matches real option text without guessing from a narrative judgment", () => {
  expect(selectDouyinCategory("1. 不实信息", ["不实信息", "其他"])).toBe("不实信息");
  expect(selectDouyinCategory("不实信息", ["内容不实", "其他"])).toBe("内容不实");
  expect(selectDouyinCategory("不实信息", ["内容不实", "谣言"])).toBeUndefined();
  expect(selectDouyinCategory("该视频并非谣言", ["谣言"])).toBeUndefined();
  expect(selectDouyinCategory("其他", ["其他", "其他"])).toBeUndefined();
});
