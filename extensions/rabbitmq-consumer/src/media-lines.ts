/**
 * `MEDIA:<path-or-url>` is OpenClaw's channel-agnostic attachment directive:
 * channels that own an attachment surface (Telegram, WhatsApp, the OpenClaw web
 * UI) strip the line and deliver the file. This channel has no such surface —
 * the web client renders the stored reply as markdown and nothing else — so a
 * MEDIA: line reaches the customer as the literal text "MEDIA:https://…" and the
 * image is silently lost. That is exactly how a rendered chart went undelivered:
 * the model did its job, the directive just had no receiver here.
 *
 * Rewrite the directive into markdown the client already renders: an inline
 * `![](url)` for images, a download link for everything else.
 */

/** Extensions the browser renders inline via `<img>`. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

/** A whole line that is nothing but the directive; leading indent tolerated. */
const MEDIA_LINE = /^[ \t]*MEDIA:[ \t]*(\S.*?)[ \t]*$/i;

function fileExtension(url: string): string {
  const withoutQuery = url.split(/[?#]/, 1)[0] ?? "";
  const lastSegment = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  const dot = lastSegment.lastIndexOf(".");
  return dot > 0 ? lastSegment.slice(dot + 1).toLowerCase() : "";
}

/**
 * Human-readable label for the link/alt text. OSS object keys are commonly
 * opaque (`1785754614_5ff02a85.png`), so an unhelpful name is better dropped
 * than shown — an empty alt still renders the image.
 */
function displayName(url: string): string {
  const withoutQuery = url.split(/[?#]/, 1)[0] ?? "";
  const lastSegment = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  let decoded = lastSegment;
  try {
    decoded = decodeURIComponent(lastSegment);
  } catch {
    // Malformed percent-encoding: keep the raw segment.
  }
  const dot = decoded.lastIndexOf(".");
  const base = dot > 0 ? decoded.slice(0, dot) : decoded;
  // Opaque machine names (hex/timestamp soup) carry no meaning for the reader.
  return /^[\w-]*\d[\w-]*$/.test(base) && !/[一-龥]/.test(base) ? "" : base;
}

/**
 * Only http(s) targets survive. A local workspace path (`MEDIA:./chart.png`) is
 * unreachable from the customer's browser, so rendering it would produce a
 * broken image *and* leak an internal path; dropping the line is the honest
 * outcome.
 */
function toMarkdown(target: string): string | null {
  if (!/^https?:\/\//i.test(target)) {
    return null;
  }
  const url = target.trim();
  if (IMAGE_EXTENSIONS.has(fileExtension(url))) {
    return `![${displayName(url)}](${url})`;
  }
  const label = displayName(url) || "下载文件";
  return `[${label}](${url})`;
}

/** Does this text already render that URL, so a converted line would duplicate it? */
function alreadyRendered(text: string, url: string): boolean {
  return text.includes(`](${url})`);
}

/**
 * Convert `MEDIA:` directive lines into inline markdown.
 *
 * Skips fenced code blocks so a documented example (```MEDIA:...```) stays
 * literal. Lines whose URL the reply already renders as markdown are dropped
 * rather than duplicated — the model commonly pastes both the tool's markdown
 * and the directive.
 *
 * `documentText` lets a streaming caller run the duplicate check against the
 * whole reply so far instead of the current fragment: the `![](url)` and the
 * `MEDIA:url` routinely land in different flush windows, and without it the
 * live view would show the image twice while the reloaded one shows it once.
 */
export function mediaLinesToMarkdown(text: string, documentText?: string): string {
  if (typeof text !== "string" || !text || !/media:/i.test(text)) {
    return typeof text === "string" ? text : "";
  }
  const haystack = documentText ?? text;
  let inFence = false;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    const match = inFence ? null : MEDIA_LINE.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }
    const target = match[1] ?? "";
    const markdown = toMarkdown(target);
    if (markdown === null || alreadyRendered(haystack, target.trim())) {
      continue; // Drop the directive: unreachable target, or already shown.
    }
    out.push(markdown);
  }
  return out.join("\n");
}

/**
 * Length of a trailing partial MEDIA: line that a streaming flush must hold
 * back. The directive is only convertible once the whole line has arrived —
 * pushing "MEDIA:https" now and the rest later would strand the literal prefix
 * in the customer's view, which is precisely the observed failure.
 *
 * Returns 0 when the tail cannot become a MEDIA: line.
 */
export function pendingMediaLineLen(chunk: string): number {
  const lastLine = chunk.slice(chunk.lastIndexOf("\n") + 1);
  const leading = lastLine.length - lastLine.trimStart().length;
  const candidate = lastLine.slice(leading).toUpperCase();
  if (!candidate) {
    return 0;
  }
  // Either a complete directive still awaiting its newline, or a prefix of the
  // word itself ("M", "ME", … "MEDIA:") split across two flush windows.
  if (candidate.startsWith("MEDIA:") || "MEDIA:".startsWith(candidate)) {
    return lastLine.length;
  }
  return 0;
}
