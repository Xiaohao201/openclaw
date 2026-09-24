# JEV Router PoC

An opt-in decision plugin for read-only tool shortlists. It uses OpenRouter's
Decisions API (`typesafe/jev-1.13`), not its chat-completions API.

## Scope

- **Shadow** (default): evaluate the current prompt and log decision metadata;
  leave model input and tool availability unchanged. The hook is awaited, so
  even shadow mode adds decision latency up to the configured timeout.
- **Advisory**: add a current-turn suggestion for a selected shortlist. The
  generation model still chooses tools and generates arguments.
- **Evaluation**: run labeled synthetic cases against the live API or replay
  captured API bodies without calling the API.

This plugin never executes tools, replaces the main model, enforces tool
permissions, or adds a generic tool-selection SDK interface. It does not claim
cost savings. Such an interface is deferred until measured task-level benefit.

The current hook does not expose runtime-authorized tool descriptors. Configure
only read-only tool names that make sense for your deployment. The shortlist is
not proof that a tool is available or authorized. Existing OpenClaw policies
remain authoritative. `no_tools` never becomes an empty `toolsAllow` value.

## Enable deliberately

Make `JEV_OPENROUTER_API_KEY` available in the gateway process environment.
There is no API-key config field and no automatic reading of `.env` files.
The destination is fixed to `https://openrouter.ai/api/alpha/decisions`;
redirects are rejected. Enabling this feature sends the current prompt to
OpenRouter; history and system prompts are not sent. Prompts may themselves
contain sensitive text: use synthetic or appropriately sanitized requests for
the PoC. Logging contains only status, candidates, reason/confidence and latency.

Merge this entry into your existing plugin configuration, and include
`jev-router` in `plugins.allow` if you use an allowlist:

```json
{
  "plugins": {
    "entries": {
      "jev-router": {
        "enabled": true,
        "config": {
          "enabled": true,
          "mode": "shadow",
          "candidates": ["read", "web_fetch", "web_search"],
          "timeoutMs": 2000,
          "minConfidence": 0.8,
          "retainProbability": 0.2,
          "maxConcurrent": 2
        }
      }
    }
  }
}
```

For an external checkout, load/install this plugin directory using OpenClaw's
normal plugin workflow. Do not copy its source into core. The package needs its
declared `zod` runtime dependency and an OpenClaw host with the declared SDK
compatibility. Plugin discovery itself makes no network calls.

`enabled` defaults to false and `candidates` defaults to empty. Either prevents
hook registration. Existing hook policy (`allowPromptInjection`) can also block
the prompt hook; do not weaken it just to enable this experiment.

The accepted catalog is `memory_get`, `memory_search`, `read`, `web_fetch`, and
`web_search`. Candidate input is unique and stably sorted. Thresholds are
experimental, not calibrated quality guarantees. Large/empty prompts, missing
keys, invalid output, low confidence, unsupported tasks, timeouts and upstream
failures preserve the original pool. Three consecutive transport/contract
failures open a 30-second circuit. Active requests are bounded; no retries are
performed. The HTTP client accepts cancellation, but the prompt hook does not
expose a run AbortSignal; hook requests therefore rely on their deadline.

## Evaluate quality

From the repository root (Node 22+ and installed workspace dependencies):

```sh
pnpm exec tsx extensions/jev-router/evaluate.ts --dataset extensions/jev-router/eval/seed.json --live --output jev-live-report.json
```

Live mode makes at most one request per case and requires the API key above.
The default budget is 20 cases; larger labeled datasets require an explicit
`--max-cases N` (up to 500). The default timeout is 2000 ms, configurable with
`--timeout-ms N` from 100 through 10000. Output uses exclusive creation and will
not overwrite an existing report. The included 16 bilingual synthetic cases
are a smoke set, not independent evidence of production quality.

For an offline run, use `--responses responses.json` instead of `--live`.
The replay file must contain exactly the dataset IDs, each mapped to
`{ "body": <raw Decisions API response>, "elapsedMs": <recorded latency> }`.
Replay input must be sanitized. A replay report is labeled `source: replay` and
must not be represented as a live benchmark.

Metrics distinguish route accuracy, fallback rate, fallback-inclusive required
tool recall, recall on non-abstained decisions, candidate reduction, and decision
p50/p95 latency. Missing denominators produce `null`, not a perfect score.
Reports contain case IDs and decisions, not prompts. Retaining all tools can
produce perfect recall and zero reduction; it does not demonstrate benefit.
Candidate reduction is not a token-cost or latency-savings measurement.

Before broader integration, label 300–500 representative cases, split by session
into calibration and held-out sets, and compare complete tasks with and without
JEV. Measure task success, actual model/tool calls, cache behavior, billed usage,
and total p95 latency. Expand to a generic selection interface only after a
repeatable benefit with no meaningful task-quality regression.

## Validate and roll back

For the next-stage frozen validation set and paired task experiment, see
[Phase 2](./PHASE2.md). The scripts record upstream usage when available and
reserve output files before external calls. Reports checkpoint completed items
and distinguish partial from complete runs.

For actual schema filtering with prior conversation and tool results in the
Suheng debug runtime, see [the local debug experiment](./DEBUG-EXPERIMENT.md).
This separate opt-in proxy is limited to synthetic read-only tasks; ordinary
plugin shadow/advisory behavior remains unchanged.

For one business-direction decision per user turn while reusing Lobster's existing
branches and event protocol, see [business routing](./BUSINESS-ROUTING.md).

```sh
pnpm test extensions/jev-router
```

Tests cover selection, invalid responses, timeout/cancellation, deterministic
request assembly, metadata-only shadow behavior and evaluation arithmetic.
Disable the plugin entry or set its `config.enabled` to false to return to the
original behavior. No migration or transcript rewrite is required.

API references: [TypeSafe introduction](https://docs.typesafe.ai/introduction),
[OpenRouter JEV guide](https://openrouter.ai/blog/tutorials/how-to-use-jev/).
