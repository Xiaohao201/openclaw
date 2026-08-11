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
  query: "OpenClaw",
  dateAfter: "2026-08-01",
  dateBefore: "2026-08-11",
  platforms: ["微信", "微博"],
  sentiments: ["敏感"],
  count: 10,
});
```

Important defaults and limits:

- The date range defaults to the previous 30 days through today.
- `count` defaults to 5 and is capped at 20 to bound model context.
- Indexed full text is included by default and capped at 4,000 characters per result.
- `includeContent: false` returns metadata and snippets without the full-text field.
- `maxContentChars` can be set from 500 to 12,000 per tool call.
- `page` starts at 1.

The tool also supports `excludeQueries`, `original`, `order`, and
`reduceNoise`. The latter three pass through to the upstream search service.

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
