import { describe, expect, it } from "vitest";
import { buildAttachmentDataPolicy } from "./attachment-data-policy.js";

describe("attachment data policy", () => {
  it("uses an attachment as a format reference when new data was requested", () => {
    expect(buildAttachmentDataPolicy("参考附件格式，打开观象台帮我找出示例集团的数据")).toContain(
      "按用户指定的数据源检索新数据",
    );
    expect(
      buildAttachmentDataPolicy("参考附件格式，打开观象台帮我找出示例集团的数据"),
    ).not.toContain("仅依据附件中的数据");
  });
  it("does not confuse a format-only constraint with a data-only constraint", () => {
    expect(buildAttachmentDataPolicy("仅根据附件格式，打开观象台查找新数据")).toContain(
      "按用户指定的数据源检索新数据",
    );
    expect(buildAttachmentDataPolicy("不联网，打开观象台查找新数据")).toContain(
      "仅依据附件中的数据",
    );
  });
  it.each([
    "仅依据附件中的数据写报告",
    "不要联网，只分析附件",
    "请基于附件生成舆情报告",
    "参考附件格式，但不要查询新数据",
  ])("keeps an attachment-only request scoped: %s", (task) => {
    expect(buildAttachmentDataPolicy(task)).toContain("仅依据附件中的数据");
  });
});
