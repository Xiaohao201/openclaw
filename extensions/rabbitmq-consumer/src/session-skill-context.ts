import { extractMessageText } from "./message-text.js";

/** Only remove copies from the new turn; never rewrite the cached history prefix. */
export function deduplicateSkillContext(
  message: string,
  skillContext: string,
  messages: readonly unknown[],
): { message: string; skillContext: string } {
  const userTexts = messages.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || !("role" in entry) || entry.role !== "user") {
      return [];
    }
    return "content" in entry ? [extractMessageText(entry.content)] : [];
  });

  // This envelope is supplied by the enterprise frontend. Do not interpret tags
  // inside the actual task (which may quote instructions for analysis).
  const taskStart = message.indexOf("<user-task>");
  if (taskStart >= 0 && message.trimEnd().endsWith("</user-task>")) {
    const prefix = message.slice(0, taskStart);
    const blocks = prefix.match(/<enterprise-default-skill>[\s\S]*?<\/enterprise-default-skill>/g);
    const previousBlock = userTexts.toReversed().flatMap((text) => {
      const start = text.indexOf("<user-task>");
      return start < 0
        ? []
        : (text
            .slice(0, start)
            .match(/<enterprise-default-skill>[\s\S]*?<\/enterprise-default-skill>/g) ?? []);
    })[0];
    if (blocks?.length === 1 && previousBlock === blocks[0]) {
      message =
        prefix.replace(
          blocks[0],
          "[enterprise-skill-reference] 本轮继续使用会话中已提供的同一份企业技能说明。",
        ) + message.slice(taskStart);
    }
  }

  // Compare the entire rendered selection, not individual substrings: changed
  // content, order or selection must be provided again. Empty means disabled.
  const previousSelection = userTexts.findLast(
    (text) => text.includes("---启用的技能开始---") && text.endsWith("---启用的技能结束---"),
  );
  if (skillContext && previousSelection?.endsWith(skillContext)) {
    skillContext =
      "\n\n[active-skill-reference] 本轮启用的自定义技能与会话中已提供的同一组说明一致，请继续遵循。";
  }
  return { message, skillContext };
}

export async function readActiveSkillHistory(sessionFile: string): Promise<unknown[]> {
  // Keep the Pi runtime off the ordinary chat cold path.
  const { readActiveSkillHistoryFromFile } = await import("./session-skill-context.runtime.js");
  return readActiveSkillHistoryFromFile(sessionFile);
}
