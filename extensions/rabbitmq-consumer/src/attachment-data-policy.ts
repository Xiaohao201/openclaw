/** Called with the extracted user task, never the attachment body or template. */
export function buildAttachmentDataPolicy(task: string): string {
  const restricted =
    /(?:不要|不用|别|禁止|请勿|无需|不必|不)(?:再)?(?:联网|搜索|检索|查询)|(?:仅|只)(?:依据|根据|基于|使用|用|分析)(?:附件|材料|原文)(?!的?(?:格式|模板|样式|结构))/u.test(
      task,
    );
  const newData =
    /(?:查询|检索|搜索|找出|查一下|搜一下).{0,40}(?:数据|信息|舆情|进展)|(?:打开|使用|用|通过|调用)观象台|(?:补充|更新|获取|拉取)(?:最新|本期|本周|本月|新)?数据/u.test(
      task,
    );
  if (!restricted && newData) {
    return (
      "附件按用户要求用作格式参考或已有证据；按用户指定的数据源检索新数据，保留明确时间范围。" +
      "不得把附件旧数据当作本期数据；分别标明附件与新查询的来源和统计口径。"
    );
  }
  return (
    "请【仅依据附件中的数据】进行分析与撰写，不要查询或编造系统内部舆情库的数据；" +
    "若附件数据不足以回答某一点，如实说明而非以内部数据补足。"
  );
}
