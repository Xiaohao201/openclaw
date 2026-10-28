---
title: "Full Text Search"
sidebarTitle: "Full Text Search"
summary: "Search indexed cross-platform posts and articles with rich filters"
read_when:
  - You need to search indexed social, news, forum, or web content
  - You need platform, sentiment, originality, or date filters
  - You want to understand when to use full_text_search instead of web_search or web_fetch
---

# Full Text Search

The bundled `full-text-search` plugin adds the `full_text_search` tool. It
searches an indexed cross-platform corpus and can return bounded full text plus
platform, author, sentiment, publication time, and engagement metadata.

It complements the existing web tools instead of replacing them:

| Goal                                                          | Tool               |
| ------------------------------------------------------------- | ------------------ |
| Discover pages on the open web                                | `web_search`       |
| Search indexed social posts, news, forums, and web content    | `full_text_search` |
| Fetch or verify the current contents of a specific result URL | `web_fetch`        |
| Aggregate or read an authorized internal monitoring project   | `feed_query`       |

Explicit requests to use “观象台” go directly to `full_text_search`; discovering
internal monitoring projects is not a prerequisite. For fresh or local social
events needing public discovery, this tool takes priority over `web_search`.
Respect requests limited to internal monitoring or supplied attachments.

Preserve the requested time window. “Latest” or “breaking” alone does not mean
“today.” Start with a small sample to check relevance, then keep one query and
filter scope for totals, trends, and examples. Each additional query should
resolve a concrete evidence gap. Use `web_search` for missing public or authority
evidence, and verify key claims with `web_fetch` or the browser; do not repeat
every search stage automatically.

The number of raw search results is not the number of relevant matches. Filter
same-name, old, and wrong-location results before deciding whether an event was
found.

## Enable the plugin

```json5
{
  plugins: {
    entries: {
      "full-text-search": {
        enabled: true,
        config: {
          // Optional trusted endpoint override.
          endpoint: "http://search-service:8004/api/v1/full_text_search",
          timeoutSeconds: 90,
          maxContentChars: 4000,
        },
      },
    },
  },
}
```

You can also override the endpoint with `FULL_TEXT_SEARCH_URL`. Plugin config
takes precedence over the environment variable.

If you use a tool allowlist, add `full_text_search` explicitly. It is not part
of `group:web` because it searches a separate indexed corpus rather than the
open web.

## Usage

```javascript
await full_text_search({
  query: ["Example Group debt", "Example Holdings debt"],
  dateAfter: "2026-10-20 09:00",
  dateBefore: "2026-10-27 09:00",
  endExclusive: true,
  platforms: ["weibo", "weixin"],
  hitFields: ["title", "content", "ocr", "asr"],
  order: "score",
  count: 5,
  includeContent: false,
});
```

This searches for either keyword group; spaces inside each group mean AND.
The adapter always sends the upstream `word` as an array. A single string such
as `"Example debt"` is one AND group. The deployed proxy does not expose URL
lookup, `word_distance`, or daily aggregation, even if another upstream API
documents those capabilities.

Important defaults and limits:

- Dates use Asia/Shanghai. The default is the previous 30 days through today.
- Dates accept `YYYY-MM-DD` or `YYYY-MM-DD HH:mm`. Date-only endpoints expand
  to `00:00` and `23:59`; the service includes the entire end minute.
- For a half-open window `[start, end)`, set `endExclusive: true` with a
  minute-precision end. The example sends an effective end of `08:59`, avoiding
  overlap with the next window starting at `09:00`.
- `count` defaults to 5 and is capped at 20. Billing is per returned work;
  use a small discovery sample or fetch a known small complete set once.
- Indexed full text is included by default and capped at 4,000 characters per result.
- `includeContent: false` returns metadata and snippets without the full-text field.
  This reduces model context, not upstream billing.
- `maxContentChars` can be set from 500 to 12,000 per tool call.
- `page` starts at 1.
- `merge` defaults to false. Keep it false for unmerged work counts; use true
  for representative reading only when the merged scope is appropriate.
- `save_filter` is always 0; searches do not save upstream filter settings.

Use canonical platform codes: `app`, `bbs`, `douyin`, `enews`, `jingwai`,
`shipin`, `toutiao`, `web`, `weibo`, `weixin`, and `xiaohongshu`. Chinese aliases
are normalized before the request; unknown values fail validation.

`hitFields` supports `asr`, `content`, `nickname`, `ocr`, `poi`, and `title`.
Omitting it searches all fields; restricting it changes the statistical scope.
`original` categories are 0=repost, 1=original, 2=comment. `reduceNoise` selects
0=all, 1=normal (upstream default), 2=noise, or 3=recommended; it is not a
strength setting. `excludeQueries` excludes keyword groups.

Choose `order: "score"` for relevance, `time_desc` for latest developments,
or `respond_desc`/`share_desc` for reach. Do not run every ordering by default.
`similarity_desc` requires `merge: true`.

## Reuse results and preserve count scope

The result includes the request filters in `queryScope` and the effective
minute window in `effectiveDateRange`.

- `totalStatus: "reported"` means a usable count was reported, not that each
  match has been verified relevant. At 5,000 or above it becomes
  `"possibly_capped"`; a missing count is `total: null`, never zero.
- `platformCounts` contains all-platform facets, even when a platform filter
  is selected. Do not substitute their sum or `all` for the filtered `total`.
- `totalMerged` is separate from `total` and pagination limits. It is null when
  merging is off or the upstream merged count is missing.
- `coverage: "complete"` requires an unmerged first page containing every
  reported result, without rejected or truncated-away records. Otherwise
  coverage is `"partial"`, or `"unknown"` when total is unavailable.
- Calculate trends and distributions from complete records when the required
  fields exist. Partial samples cannot establish population statistics.
  Missing engagement metrics are null, not zero.

If a trend requires per-day queries because the complete set is unavailable,
keep identical filters and nonoverlapping date buckets. `count: 1` still
retrieves a billed work; it is not an aggregation operation. State gaps or
capped counts rather than presenting an exact trend without evidence.

For `feed_query`, reuse the confirmed authorized project. Use `topics` only
when project resolution is needed, request all required `groupBy` dimensions
together in `stats`, and use `search` for representative evidence. A search
matching at most 100 records reads all of them regardless of `limit`; larger
sets return a sample. Reuse its total and complete records rather than issuing
redundant count or per-day calls. Internal and public-corpus totals describe
different populations.

## Throttling and cancellation

Within one gateway process, requests to the same endpoint are serialized with
a conservative three-second gap after completion. Throttling (HTTP 429 or the
proxy's known rate-limit response) and HTTP 502/503/504 receive at most one
automatic retry, waiting at least five seconds and respecting `Retry-After`.
A wait exceeding 60 seconds skips that retry; the endpoint cooldown remains
in effect. This is local scheduling, not a service-wide rate-limit guarantee.

Exhausted throttling returns `status: "error"`, `errorCode: "RATE_LIMITED"`,
and `retryable: false`. Do not immediately resubmit it or interpret it as no
matches. Cancellation stops queued work and propagates to the active request.

## Security and result verification

Search results are external, untrusted content and are wrapped with OpenClaw's
web-search content markers before they reach the model. Response bodies and
per-result content are bounded, and only HTTP(S) result URLs without embedded
credentials are returned.

The bundled service URL currently uses plain HTTP. Search terms and filters are
therefore not encrypted in transit unless you configure an HTTPS endpoint or a
trusted TLS-terminating proxy. Do not send secrets or private data as queries.

Indexed content can be stale or differ from the live page. For claims that need
current verification, pass the returned URL to `web_fetch`; use the browser for
JS-heavy or authenticated pages.

## See also

- [Web Search](/tools/web)
- [Web Fetch](/tools/web-fetch)
- [Web Browser](/tools/browser)
