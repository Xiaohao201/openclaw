import { expect, it } from "vitest";
import { parsePhoneNodes, selectPhoneNode } from "./ui.js";
it("rejects entities, foreign windows, disabled ancestors and duplicate controls", () => {
  expect(() => parsePhoneNodes("<!DOCTYPE x><node/>")).toThrow();
  const node =
    '<node package="com.xingin.xhs" text="提交" bounds="[10,10][100,100]" enabled="true"/>';
  expect(selectPhoneNode(parsePhoneNodes(`<hierarchy>${node}</hierarchy>`), "提交")?.text).toBe(
    "提交",
  );
  expect(() =>
    selectPhoneNode(parsePhoneNodes(`<hierarchy>${node}${node}</hierarchy>`), "提交"),
  ).toThrow();
  expect(() =>
    selectPhoneNode(
      parsePhoneNodes(`<hierarchy><node enabled="false">${node}</node></hierarchy>`),
      "提交",
    ),
  ).toThrow();
  expect(parsePhoneNodes(node.replace("com.xingin.xhs", "other.app"))).toEqual([]);
});
