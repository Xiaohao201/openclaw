# Business routing PoC: preserve Lobster contracts

This opt-in **route** experiment classifies the next business direction before
the primary subagent run. It replaces neither the frontend protocol nor existing
explicit template/skill/attachment handling. It is separate from the earlier
per-model-request **filter** experiment. Production behavior stays unchanged.

## Existing boundaries

| Surface                 | Existing contract                                             | Role in this experiment                                 |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| Frontend request        | `template_id`, `builtin_skill_name`, `skill_ids`, attachments | Explicit selections bypass JEV                          |
| Deterministic inference | `inferBuiltinSkillName` and the resulting `skillFilter`       | Inferred first-party skills also bypass JEV             |
| Report branch           | Template resolution, attachment handling, `pendingReport`     | Keep the current host implementation                    |
| Model run               | Public `subagent.run` with `toolsAllow`, `disableTools`       | Narrow the existing policy without a new SDK contract   |
| Work timeline           | `step`, `report_step`, category/status                        | Still emitted from actual execution, not guessed by JEV |
| Result events           | `text`, `citations`, `done`, `report_*`, `error`              | Preserve frontend payloads                              |

The existing display categories must not become permission groups. For example,
`query` includes generic execution and refresh operations, and `memory` includes
both reading and writing. The experiment uses an explicit read-only policy.

## Decision contract, version 1

JEV receives one `choice` question, rather than a question per tool. Shared state:

```json
{
  "request": "[JEV_SYNTHETIC_BENCH] Read the file mentioned earlier",
  "history": [{ "role": "user", "content": "The path is fixture.txt" }],
  "allowMemory": false
}
```

The bridge returns `{version: 1, route, confidence, elapsedMs}`; failures return
`route: uncertain` with a closed reason code. The host validates the response
again and applies only decisions with confidence at least 0.8.

| Route                                                    | Current host action                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `answer`                                                 | Disable tools; let the LLM answer from the original context                |
| `clarify`                                                | Disable tools; ask the LLM to request missing information                  |
| `read`                                                   | Narrow to `read`                                                           |
| `search`                                                 | Narrow to `web_fetch`, `web_search`                                        |
| `memory`                                                 | Narrow to `memory_get`, `memory_search`, only when memory is enabled       |
| `query`, `check`, `report`, `write`, `think`, `schedule` | Record classification only; preserve the existing workflow and tool policy |
| `uncertain`, low confidence, failure                     | Preserve the original LLM run                                              |

For read/search/memory, the classifier must decide whether that family covers
the **whole remaining task**, including later steps. Mixed-family or complex
tasks retain the original workflow. This conservative policy still needs live
quality validation; the deterministic tests do not establish classifier accuracy.

Existing narrower run allowlists are intersected. An empty intersection uses
`disableTools: true`, because the existing API treats an empty `toolsAllow` as
unrestricted. Host agent-level permissions remain authoritative.

## Placement and context

Only the local debug runner wraps `subagent.run`. This occurs after the existing
chat pipeline resolves explicit branches and prepares the history snapshot.
History is obtained through the public `getSessionMessages` runtime API. The
original model message, system-prompt mode, and history are not rewritten.

There is at most **one routing request per user turn**, cached only in that
turn's wrapper. The narrowed tool set remains stable for its internal tool loop.
Within-turn continuation and completion remain the LLM's job. The next user turn
gets fresh history, including previous tool results; no cross-session cache exists.

System/developer history entries are excluded from the JEV copy. Over 100 history
messages or 20,000 serialized state characters causes fallback, not silent history
truncation. Only explicitly marked synthetic requests can route in this PoC.

## Reproduction

Build the updated Gateway once, then start it without running heavy checks during
timing measurements. Configure `JEV_OPENROUTER_API_KEY` securely in the shell.

```powershell
pnpm build
$env:OPENCLAW_JEV_DEBUG_MODE = 'route'
$env:OPENCLAW_JEV_DEBUG_METRICS = 'C:/path/to/new-route-metrics.jsonl'
pnpm suheng:debug
```

When ready, in another terminal:

```powershell
node --import tsx scripts/dev/jev-debug-bench.ts route C:/path/to/new-route-result.json
```

The launcher starts the existing loopback proxy and supplies its random private
`turn-decision` URL to the child. The routing key remains in the proxy process.
The bridge allows at most 16 turn decisions, independently of its 16 model-request
cap, with a two-second JEV timeout and no automatic routing retries. Budget is
reserved before awaiting a request, including concurrent callers. The host's
local request timeout is 2.5 seconds. Limits bound request counts, not token fees.

`turn_decision` metric records contain classification metadata only. In route mode,
model requests pass through unchanged: policy narrowing has already occurred at
`subagent.run`, so proxy tool counts describe the resulting model tool catalog.
Background plugin services stay disabled, and normal debug startup clears stale
turn-router endpoints. Stop the process and remove the experiment variables to
return to normal behavior.

## Validation status

Offline tests exercise branch precedence, history, one decision per turn, no-tools
versus uncertainty, policy intersection, failure fallback, loopback endpoint
validation, concurrent budget enforcement, and unchanged frontend event envelopes.
Live local measurements are recorded in [business routing results](./BUSINESS-ROUTING-RESULTS.md).
The repeated experiment observed a small aggregate latency reduction, driven by
answer-only turns; read turns did not consistently improve. This is not a
production-quality or general speedup claim. Phase 3 figures describe the older
filter implementation and must not be presented as results for this one.
