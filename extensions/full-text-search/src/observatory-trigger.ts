export type ObservatorySearchIntent = {
  query: string;
};

const NEGATION_BEFORE_INVOCATION_PATTERN =
  /(?:不要|不用|别|请勿|无需|不必|禁止|取消)(?:再)?\s*(?:使用|调用|通过|打开|用)?\s*$/u;

const SEARCH_VERB = String.raw`(?:搜索|查询|检索|搜(?:索|一下)?|查(?:询|一下)?)`;
const INVOCATION_PATTERNS = [
  new RegExp(
    String.raw`(?:帮我|请)?\s*(?:使用|调用|通过|打开|用)\s*观象台(?:来|帮我|进行)?\s*[,，:：]?\s*${SEARCH_VERB}\s*`,
    "gu",
  ),
  new RegExp(String.raw`观象台\s*${SEARCH_VERB}\s*`, "gu"),
  /观象台\s*[:：]\s*/gu,
];

function extractQuery(remainder: string): string | null {
  const normalized = remainder
    .trim()
    .replace(/^[,，:：]+/u, "")
    .trim()
    .replace(/^(?:关于|有关)\s*/u, "");
  const quoted = normalized.match(/^[“"「『]([^”"」』]+)[”"」』]/u)?.[1];
  const candidate = (quoted ?? normalized).trim().replace(/\s+/gu, " ");

  if (!candidate || candidate.length > 500) {
    return null;
  }
  return candidate;
}

/** Parse an explicit, non-negated natural-language invocation of “观象台”. */
export function parseObservatorySearchIntent(prompt: string): ObservatorySearchIntent | null {
  if (!prompt.includes("观象台")) {
    return null;
  }

  const matches = INVOCATION_PATTERNS.flatMap((pattern) => [...prompt.matchAll(pattern)]).toSorted(
    (left, right) => (left.index ?? 0) - (right.index ?? 0),
  );
  for (const match of matches) {
    const matchIndex = match.index ?? 0;
    const clausePrefix =
      prompt
        .slice(0, matchIndex)
        .split(/[；;。！？!?\n]/u)
        .at(-1) ?? "";
    if (NEGATION_BEFORE_INVOCATION_PATTERN.test(clausePrefix)) {
      continue;
    }
    const query = extractQuery(prompt.slice(matchIndex + match[0].length));
    if (query) {
      return { query };
    }
  }
  return null;
}
