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

/** Return the most recent assistant message's text from a session message list. */
export function extractAssistantText(messages: unknown[]): string {
  if (!Array.isArray(messages)) {
    return "";
  }
  for (const msg of messages.toReversed()) {
    const m = msg as { role?: unknown; content?: unknown };
    if (m.role === "assistant") {
      const text = extractMessageText(m.content).trim();
      if (text) {
        return text;
      }
    }
  }
  return "";
}
