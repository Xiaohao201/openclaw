import type { Citation } from "./types.js";

/**
 * Citation / footnote support for assistant answers (route B — prompt-driven).
 *
 * The model is instructed to (a) append an inline `[n]` marker after any
 * sentence that states an external fact, and (b) end its reply with a machine
 * block: a `CITATIONS_MARKER` line followed by a JSON array of the sources it
 * cited. The pipeline splits that block off the visible answer with
 * {@link splitCitations}, ships the structured `citations[]` to the frontend
 * (which renders `[n]` + a sources panel), and stores only the clean answer in
 * `history_messages.response`.
 *
 * The marker also gates the streaming pusher: once it appears in the token
 * stream, everything from it onward is withheld from the client so the raw JSON
 * block never flashes on screen (see StreamingMercurePusher).
 *
 * Route A (server-side URL capture from tool results, for authoritative
 * de-hallucination) can layer on later via the optional `allowedUrls` filter in
 * {@link splitCitations} — the model's self-reported URLs would then be kept
 * only when they were actually seen in a tool result.
 */

/**
 * Sentinel that separates the visible answer from the machine citations block.
 * Deliberately distinctive so it never collides with real prose, and so the
 * streaming pusher can truncate the stream at it.
 */
export const CITATIONS_MARKER = "<<<CITATIONS>>>";

/** Max sources kept per answer (defensive cap against a runaway list). */
const MAX_CITATIONS = 30;
/** Max characters kept per snippet (keep the payload small). */
const MAX_SNIPPET_LEN = 400;

/**
 * The per-turn directive telling the model when and how to cite. Injected into
 * the agent message (not the cached system prompt) alongside the other
 * per-turn directives. Written in Chinese to match the 观舆卫士 assistant voice.
 */
export function buildCitationDirective(): string {
  return (
    "[citations] 引用来源规范：当你的回答用到【外部事实】时，须在相关句子末尾紧跟角标 [1]、[2]……并在全文最末尾附上来源清单。" +
    "必须标注的 6 种情形：①具体数据/统计/研究结论；②时事新闻/政策法规/官方通告；③引述某人原话或独创观点；" +
    "④有争议/学界未定论的议题；⑤医疗/法律/金融/工程等专业建议；⑥用到联网搜索或检索(RAG)得到的网页/文档。" +
    "以下情形不要加角标：通用常识、纯逻辑或数学推演、对用户文本的翻译/改写/润色、纯创意创作。" +
    "角标序号从 1 递增，同一来源多次引用复用同一序号。url 必须是你在搜索/检索工具结果里真实见到的外部链接，" +
    "严禁编造链接或凭空引用。角标与来源块必须成对出现：只要正文里用了任何 [n] 角标，就【必须】输出来源块，" +
    "且每个角标序号都要能在来源清单里找到对应条目；反之，若你拿不出真实可访问的来源链接（例如结论来自内部数据库检索、" +
    "或搜索工具没有返回网页链接），则正文中【不要】使用任何 [n] 角标，直接正常行文。" +
    "若本轮没有用到任何外部来源，则完全不要输出下面的来源块。" +
    "输出格式：正常写完回答正文（含内联 [n] 角标）后，另起一行原样输出标记 " +
    CITATIONS_MARKER +
    " ，其后紧跟一个 JSON 数组（不要用代码块包裹、其后不要再有任何文字），每个元素形如 " +
    '{"id":1,"title":"来源标题","url":"https://...","snippet":"与被引句相关的原文摘要片段"} 。 '
  );
}

/** True when the text contains the citations block sentinel. */
export function hasCitationsMarker(text: string): boolean {
  return typeof text === "string" && text.includes(CITATIONS_MARKER);
}

/**
 * Split a finished assistant reply into its visible answer and structured
 * citations. Pure: never mutates input.
 *
 * - No marker → the whole text is the answer, `citations` is empty.
 * - Marker present → text before it is the answer (trailing whitespace
 *   trimmed); the JSON array after it is parsed, validated and normalized.
 *
 * @param allowedUrls optional Route-A allowlist: when provided, a citation is
 *   kept only if its URL (normalized) was actually observed in a tool result.
 */
export function splitCitations(
  fullText: string,
  allowedUrls?: ReadonlySet<string>,
): { text: string; citations: Citation[] } {
  if (typeof fullText !== "string" || !fullText) {
    return { text: typeof fullText === "string" ? fullText : "", citations: [] };
  }
  const idx = fullText.indexOf(CITATIONS_MARKER);
  if (idx < 0) {
    return { text: fullText, citations: [] };
  }
  const text = fullText.slice(0, idx).replace(/\s+$/, "");
  const tail = fullText.slice(idx + CITATIONS_MARKER.length);
  const citations = parseCitations(tail, allowedUrls);
  return { text, citations };
}

/**
 * Remove "dangling" inline citation markers — `[n]` whose id has no matching
 * entry in `citations` — from a markdown answer. Covers the recurring model
 * failure of footnoting sentences but omitting (or botching) the sources
 * block: without this the user sees dead `[1][2]` markers that link nowhere.
 *
 * Skips fenced code blocks and inline code so array indexing like `arr[0]`
 * is never touched. Also eats spaces/tabs immediately before a removed marker
 * so "fact [1]." collapses to "fact." rather than "fact .".
 */
export function stripDanglingCitationMarkers(text: string, citations: readonly Citation[]): string {
  if (typeof text !== "string" || !text || !/\[\d{1,3}\]/.test(text)) {
    return text;
  }
  const valid = new Set(citations.map((c) => c.id));
  // Odd-indexed segments are the captured code spans (fenced or inline) —
  // passed through untouched; markers are only rewritten outside them.
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((seg, i) => {
      if (i % 2 === 1) {
        return seg;
      }
      return seg.replace(/[ \t]*\[(\d{1,3})\]/g, (m, n: string) => (valid.has(Number(n)) ? m : ""));
    })
    .join("");
}

/** Normalize a URL for dedupe/allowlist comparison (drop trailing slash). */
function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function parseCitations(tail: string, allowedUrls?: ReadonlySet<string>): Citation[] {
  const raw = extractJsonArray(tail);
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }

  const out: Citation[] = [];
  const seenUrls = new Set<string>();
  const seenIds = new Set<number>();
  let nextId = 1;
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    // External http(s) links only — never surface internal paths or junk.
    if (!/^https?:\/\/\S+$/i.test(url)) {
      continue;
    }
    const norm = normalizeUrl(url);
    if (allowedUrls && !allowedUrls.has(norm)) {
      continue;
    }
    if (seenUrls.has(norm)) {
      continue;
    }
    seenUrls.add(norm);

    // Keep the model's id when it is a positive integer and not already used
    // (so inline [n] markers still line up); otherwise assign the next free id.
    let id = typeof rec.id === "number" && Number.isInteger(rec.id) && rec.id > 0 ? rec.id : nextId;
    while (seenIds.has(id)) {
      id = nextId;
      nextId += 1;
    }
    seenIds.add(id);
    nextId = Math.max(nextId, id + 1);

    const title = typeof rec.title === "string" && rec.title.trim() ? rec.title.trim() : url;
    const snippet =
      typeof rec.snippet === "string" ? rec.snippet.trim().slice(0, MAX_SNIPPET_LEN) : "";

    out.push({ id, title, url, snippet });
    if (out.length >= MAX_CITATIONS) {
      break;
    }
  }
  return out;
}

/**
 * Pull the JSON array text out of the block tail. Tolerates the model wrapping
 * it in a ```json fence or adding stray prose — we take from the first `[` to
 * the last `]`.
 */
function extractJsonArray(tail: string): string | null {
  const start = tail.indexOf("[");
  const end = tail.lastIndexOf("]");
  if (start < 0 || end <= start) {
    return null;
  }
  return tail.slice(start, end + 1);
}
