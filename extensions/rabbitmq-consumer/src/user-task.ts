export type UserTask = {
  text: string;
  source: "message" | "enterprise-envelope" | "unresolved-envelope";
  excluded: ("enterprise-skill" | "attachment-content" | "video-content" | "unresolved-context")[];
};

// These delimiters are emitted by ai-assistant's attachment/video composers.
// Require the attachment flag and the numbered block, not arbitrary prose.
const ATTACHMENT_BOUNDARY =
  /(?:\r?\n\r?\n以下是用户提供的附件内容，请结合附件作答：|^请阅读并分析以下用户提供的附件内容：)\r?\n\r?\n【附件 \d+：/u;
const VIDEO_BOUNDARY =
  /(?:\r?\n\r?\n以下是用户提供的视频解析结果，请结合视频内容作答：|^请阅读并分析以下视频解析结果：)\r?\n\r?\n【视频附件 \d+：/u;

/** A classification view only: never replace the execution payload or transcript. */
export function extractUserTask(message: string, hasAttachment: boolean): UserTask {
  let text = message.trim();
  let source: UserTask["source"] = "message";
  const excluded: UserTask["excluded"] = [];
  if (text.startsWith("<enterprise-default-skill>")) {
    const skillEnd = text.indexOf("</enterprise-default-skill>");
    let rest =
      skillEnd < 0 ? "" : text.slice(skillEnd + "</enterprise-default-skill>".length).trimStart();
    const video = hasAttachment ? VIDEO_BOUNDARY.exec(rest) : null;
    if (video && rest.slice(0, video.index).endsWith("</user-task>")) {
      rest = rest.slice(0, video.index);
      excluded.push("video-content");
    }
    // Video results can follow the envelope. Inside the task, quoted tags must
    // survive; only a closing tag followed by end-of-input or the video wrapper counts.
    const envelope = /^<user-task>([\s\S]*)<\/user-task>\s*$/u.exec(rest);
    if (!envelope) {
      return { text: "", source: "unresolved-envelope", excluded: ["unresolved-context"] };
    }
    text = envelope[1].trim();
    source = "enterprise-envelope";
    excluded.push("enterprise-skill");
  }
  if (hasAttachment) {
    const attachment = ATTACHMENT_BOUNDARY.exec(text);
    const video = VIDEO_BOUNDARY.exec(text);
    const boundaries = [attachment?.index, video?.index].filter(
      (index): index is number => index !== undefined,
    );
    if (attachment) {
      excluded.push("attachment-content");
    }
    if (video && !excluded.includes("video-content")) {
      excluded.push("video-content");
    }
    if (boundaries.length) {
      text = text.slice(0, Math.min(...boundaries)).trim();
    }
  }
  // Fixed audit order, independent of where the producer placed each block.
  const order: UserTask["excluded"] = [
    "enterprise-skill",
    "attachment-content",
    "video-content",
    "unresolved-context",
  ];
  return { text, source, excluded: order.filter((kind) => excluded.includes(kind)) };
}
