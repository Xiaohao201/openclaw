/** Read only the request segment, never instructions quoted in an uploaded report. */
export function extractSearchTask(prompt: string): string {
  const attachment = prompt.search(
    /(?:以下是用户提供的(?:附件内容|视频解析结果)，请结合[^\n]*：|^请阅读并分析以下用户提供的附件内容：)/u,
  );
  let task = attachment < 0 ? prompt : prompt.slice(0, attachment);
  const userMarker = /\[userId:[^\]]+\]/u.exec(task);
  if (userMarker) {
    task = task.slice(userMarker.index + userMarker[0].length);
  }
  return task
    .replace(/<enterprise-default-skill>[\s\S]*?<\/enterprise-default-skill>/gu, " ")
    .replace(/<\/?user-task>/gu, " ")
    .replace(/\[(?:userId|topicId|historyId|auto-selected-skill|builtin-skill)[^\]]*\]/gu, " ")
    .trim();
}

export function forbidsExternalSearch(task: string): boolean {
  return (
    /(?:不要|不用|别|请勿|无需|不必|禁止|不)(?:再)?(?:联网|上网|搜索|检索)/u.test(task) ||
    /(?:只|仅)(?:依据|根据|基于|使用|用|分析)(?:用户提供的)?(?:附件|材料|原文)(?:中的数据|数据)?(?:进行分析|分析|作答|写|$|[，。])/u.test(
      task,
    )
  );
}
