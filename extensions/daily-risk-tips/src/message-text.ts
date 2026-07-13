/**
 * Extract plain text from subagent session messages. A message's `content` is a
 * string in simple sessions but an array of content blocks in tool-using ones;
 * this flattens either shape. Self-contained so the extension never cross-imports
 * another extension's internals.
 */

function blockText(block: unknown): string {
  if (typeof block === "string") {
    return block;
  }
  if (block && typeof block === "object") {
    const t = (block as { text?: unknown }).text;
    if (typeof t === "string") {
      return t;
    }
  }
  return "";
}

/** Flatten a single message's `content` (string | block[]) into text. */
export function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(blockText).join("");
  }
  return "";
}

/**
 * Return every non-empty assistant message's text, most recent first. In a
 * tool-using session the final assistant message may be a closing remark
 * rather than the answer, so callers should try each entry in order instead
 * of assuming the last one is the answer.
 */
export function collectAssistantTexts(messages: unknown[]): string[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  const texts: string[] = [];
  for (const msg of messages.toReversed()) {
    const m = msg as { role?: unknown; content?: unknown };
    if (m.role === "assistant") {
      const text = extractMessageText(m.content).trim();
      if (text) {
        texts.push(text);
      }
    }
  }
  return texts;
}
