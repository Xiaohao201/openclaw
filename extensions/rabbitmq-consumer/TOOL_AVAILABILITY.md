# Tool availability in interactive Suheng conversations

Interactive chat does not pass a message-derived `toolsAllow` list to the agent
runtime. The runtime builds the available catalog from registered tools and applies
the configured provider, agent, owner, group, sandbox and subagent policies on every
run. Removing the extra chat filter does not grant permission or register a missing
tool. Changes to runtime configuration or permissions still take effect.

The catalog must not shrink because a follow-up omits nouns from the original
request. A chart request followed by “make it clearer”, “retry”, or “continue” uses
the same discovery path. This also covers skills, documents, attachments and newly
registered plugin tools without another keyword list or per-session capability
cache. Restarts and transcript snapshots do not need capability-state migration.

Intent-specific instructions and selected skills can guide which tools to use;
they must not decide which authorized tools exist. Availability is not permission
to perform an external action: tool-level confirmation and account checks remain
mandatory. Scheduled or otherwise constrained jobs can retain their explicit
task-specific allowlists; this change only concerns interactive chat.

Tradeoff: ordinary turns can carry more tool schemas. In return, the catalog no
longer changes with wording, improving continuity and tool-prefix cache stability
when the underlying configuration stays unchanged. Future token optimization
should use runtime-supported tool discovery with an always-available way to obtain
needed tools, not silently discard capabilities based on one message.

Regression coverage lives in `src/chat-pipeline.test.ts`: multi-turn artifact
creation, revisions, retries and skill follow-ups must preserve the runtime tool
catalog. Core policy tests separately cover deny rules and account boundaries.

## Diagnosing missing tools

The Runtime field `channel_capabilities` describes messaging-channel features,
such as inline buttons. `none` does not mean tools are absent. Older transcripts
use the ambiguous field name `capabilities`; neither field is a tool allowlist.
The prompt uses the current tool catalog, including an explicitly empty catalog.

Gateway info logs prefixed with `tool-availability` record the plugin registry,
resolved plugin tools, registered tools, removals at each policy stage, and the
final model tool catalog. Correlate core events by `runId` and `sessionKey`;
plugin events carry `sessionKey`. Tool names are sorted only in diagnostics, not
reordered in the runtime. Arguments and schemas are not logged by this diagnostic.

- `plugins-disabled`, `plugin-registry-unavailable`, and `plugin-registry` locate
  plugin activation failures or disabled plugins.
- `plugin-factory-empty` and `optional-plugin-tool-policy` explain tools omitted
  during plugin tool resolution. Existing plugin error logs report factory errors
  and name conflicts.
- Policy events include the stage, removed tool names, and expanded allow/deny
  rules. Owner, provider, and run-specific filters are recorded separately.
- `model-tool-schemas` lists the final effective catalog, including client, MCP,
  and LSP tools. `model-tools-unsupported` indicates a model without tool support.

For browser incidents, first locate `browser` in these events. If available, the
assistant should query `browser` status/profiles and use the authorized browser.
Headless mode, login requirements, verification pages, or connection failures must
be established from real browser results. A failed HTTP fetch alone establishes
none of these. A conversation snapshot without tool schemas cannot establish which
tools were actually offered to the model.
