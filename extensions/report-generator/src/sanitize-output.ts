/**
 * Strip internal implementation details from assistant text before it reaches
 * the web customer. This is a hard backstop behind the workspace prompt rule
 * ("不暴露内部实现细节"): when the model slips and narrates a workspace path or
 * an internal identifier, we remove it rather than let it confuse the client.
 *
 * Conservative by design — only high-signal, near-zero-false-positive tokens
 * are removed (workspace paths, the pipeline's injected `[userId:…]` context,
 * per-user agent session keys). General prose is left untouched.
 */

/** Internal workspace directories that mark a path as a system artifact. */
const INTERNAL_DIRS = ["memory", "templates", "workspace", "sessions", "skills", "state"];

const DIR_ALT = INTERNAL_DIRS.join("|");

/**
 * Backtick-wrapped internal reference, optionally preceded by a Chinese lead-in
 * verb ("保存在 `memory/…md`"). Removing the lead-in too keeps the sentence from
 * collapsing into "保存在。". The span must look internal: contain a known dir or
 * a doc/data extension.
 */
const BACKTICKED_INTERNAL = new RegExp(
  "(?:已?保存(?:在|到|至)|存(?:放|储|档)(?:在|到|至)?|位于|路径(?:为|是)?[：:]?|文件(?:名|为)?[：:]?|详?见|参见)?\\s*" +
    "`[^`]*(?:(?:" +
    DIR_ALT +
    ")/|\\.(?:md|jsonl?|log|ya?ml|sql))[^`]*`",
  "g",
);

/**
 * Bare (un-backticked) path rooted at an internal directory. The lookbehind
 * keeps us from stripping a `/memory/` segment that lives inside a customer URL
 * (e.g. an article link "https://weibo.com/.../sessions/123") — we only match
 * when the internal dir starts at a real boundary, not mid-path.
 */
const BARE_INTERNAL_PATH = new RegExp("(?<![\\w/:.\\-])(?:" + DIR_ALT + ")/[\\w./\\-]+", "g");

/** The runtime root itself, e.g. "~/.openclaw/credentials" or ".openclaw/openclaw.json". */
const OPENCLAW_ROOT = /~?\/?\.openclaw\/[\w./-]+/g;

/** The chat pipeline injects these context prefixes; a confused model may echo them. */
const INJECTED_CONTEXT = /\[(?:userId|topicId|topicName|useSlaveTopic|allTopics)[^\]]*\]/g;

/** Per-user agent session keys / agent ids, e.g. `agent:rabbitmq-126:rabbitmq:126:…` or `rabbitmq-126`. */
const AGENT_SESSION_KEY = /\bagent:[\w.-]+(?::[\w.-]+)+/g;
const AGENT_ID = /\brabbitmq-\d+\b/g;

const STRUCTURED_DATA_LINE = /^\s*(?:[{]|\[|"[^"]*"\s*:|[A-Za-z_$][\w$.-]*\s*:\s*(?:["{]|\[))/u;

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function findMarkdownDestinationEnd(line: string, start: number): number {
  let depth = 1;
  for (let cursor = start + 2; cursor < line.length; cursor += 1) {
    if (isEscaped(line, cursor)) {
      continue;
    }
    if (line[cursor] === "(") {
      depth += 1;
    } else if (line[cursor] === ")") {
      depth -= 1;
      if (depth === 0) {
        return cursor + 1;
      }
    }
  }
  return -1;
}

function normalizeProseLine(line: string): string {
  if (!line.includes('"') || STRUCTURED_DATA_LINE.test(line)) {
    return line;
  }

  const output: string[] = [];
  let pendingQuoteIndex: number | null = null;

  for (let cursor = 0; cursor < line.length; cursor += 1) {
    if (line[cursor] === "`") {
      let runLength = 1;
      while (line[cursor + runLength] === "`") {
        runLength += 1;
      }
      const marker = "`".repeat(runLength);
      const end = line.indexOf(marker, cursor + runLength);
      if (end >= 0) {
        output.push(line.slice(cursor, end + runLength));
        cursor = end + runLength - 1;
        continue;
      }
    }

    if (line[cursor] === "<" && /[A-Za-z/!?]/u.test(line[cursor + 1] ?? "")) {
      const end = line.indexOf(">", cursor + 1);
      if (end >= 0) {
        output.push(line.slice(cursor, end + 1));
        cursor = end;
        continue;
      }
    }

    if (line[cursor] === "]" && line[cursor + 1] === "(") {
      const end = findMarkdownDestinationEnd(line, cursor);
      if (end >= 0) {
        output.push(line.slice(cursor, end));
        cursor = end - 1;
        continue;
      }
    }

    if (line[cursor] !== '"' || isEscaped(line, cursor)) {
      output.push(line[cursor] ?? "");
      continue;
    }

    if (pendingQuoteIndex === null) {
      pendingQuoteIndex = output.length;
      output.push('"');
    } else {
      output[pendingQuoteIndex] = "“";
      output.push("”");
      pendingQuoteIndex = null;
    }
  }

  return output.join("");
}

/**
 * Use paired Chinese quotation marks in user-facing prose while preserving
 * Markdown code, structured data, HTML attributes, and link destinations.
 * Apply only to complete documents: quote pairs may span arbitrary stream chunks.
 */
export function normalizeChineseProseQuotes(text: string): string {
  if (typeof text !== "string" || !text.includes('"')) {
    return typeof text === "string" ? text : "";
  }

  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;

  return text
    .split(/(\r?\n)/u)
    .map((line) => {
      if (/^\r?\n$/u.test(line)) {
        return line;
      }

      const fence = line.match(/^\s*(`{3,}|~{3,})/u)?.[1];
      if (fence) {
        if (!inFence) {
          inFence = true;
          fenceChar = fence[0] ?? "";
          fenceLength = fence.length;
        } else if (fence[0] === fenceChar && fence.length >= fenceLength) {
          inFence = false;
          fenceChar = "";
          fenceLength = 0;
        }
        return line;
      }

      return inFence ? line : normalizeProseLine(line);
    })
    .join("");
}

/**
 * Tidy punctuation/whitespace left behind after a span is removed, so a stripped
 * clause doesn't leave "，。" or doubled spaces. Intentionally light — never
 * rewrites surviving content.
 */
function tidy(text: string): string {
  return (
    text
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+([，。、；：,.;:])/g, "$1")
      .replace(/，\s*。/g, "。")
      .replace(/，\s*，/g, "，")
      .replace(/(^|\n)[ \t]+/g, "$1")
      .replace(/[ \t]+(\n|$)/g, "$1")
      // Drop a line that became only punctuation after a whole-sentence removal.
      .replace(/(^|\n)[ \t]*[，。、；：,.;:]+[ \t]*(?=\n|$)/g, "$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Remove internal references WITHOUT touching whitespace. Pure: returns a new
 * string, never mutates.
 *
 * Use this on STREAMING fragments. The streaming flusher cuts the reply into
 * arbitrary chunks (every ~80ms); a chunk boundary routinely lands on the blank
 * line between two markdown blocks, or on the single space after a `###` ATX
 * marker. The whitespace-tidying `tidy()` ends in `.trim()` and strips line-edge
 * whitespace, so running it per chunk DELETES that boundary whitespace — the
 * frontend then concatenates the pieces with the blank line / heading space gone
 * (`---##`, `环节### 10`, `###1.`). Stripping refs alone is boundary-safe.
 */
export function stripInternalRefs(text: string): string {
  // Defensive: callers should pass a string, but a non-string (e.g. a raw
  // content-block array) must never crash the chat pipeline via `.replace`.
  if (typeof text !== "string" || !text) {
    return typeof text === "string" ? text : "";
  }
  return text
    .replace(BACKTICKED_INTERNAL, "")
    .replace(OPENCLAW_ROOT, "")
    .replace(BARE_INTERNAL_PATH, "")
    .replace(INJECTED_CONTEXT, "")
    .replace(AGENT_SESSION_KEY, "")
    .replace(AGENT_ID, "");
}

/**
 * Remove internal references AND tidy whitespace. Pure: returns a new string,
 * never mutates. Apply this to a WHOLE document (the final persisted response),
 * never to a streaming fragment — see {@link stripInternalRefs} for why tidying
 * a chunk corrupts markdown structure at the chunk boundary.
 */
export function sanitizeInternalRefs(text: string): string {
  if (typeof text !== "string" || !text) {
    return typeof text === "string" ? text : "";
  }
  return tidy(stripInternalRefs(text));
}
