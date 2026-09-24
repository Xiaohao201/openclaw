# Phase 2 results

Run date: September 24, 2026. The separately authorized run used 72 JEV requests
(64 routing cases and eight task decisions) and 30 Qwen requests, below the
authorized ceilings of 72 and 64. No failed request was retried. The plugin
remains disabled by default; no gateway configuration or generic selection SDK
interface was changed.

## Decision

Continue to treat JEV as an experimental decision component. These observations
do not justify a generic selection interface or broad enablement of advisory
mode. The advisory arm completed one more controlled task but did not reduce
model calls, aggregate reported cost, or paired median latency. This is a small
authored experiment, not statistical evidence of production benefit or harm.

## Routing validation

The 64 newly authored cases used the frozen thresholds from [Phase 2](./PHASE2.md).

| Metric                                      | Result                                   |
| ------------------------------------------- | ---------------------------------------- |
| Route matched the authored label            | 57/64 (89.06%)                           |
| Selected-tool cases matched                 | 22/26                                    |
| Direct-answer cases matched                 | 13/16                                    |
| Expected abstentions matched                | 22/22                                    |
| Required-tool recall including fallbacks    | 100%                                     |
| Required-tool recall on non-abstained cases | 100%                                     |
| Fallbacks                                   | 29/64, including 22 expected abstentions |
| Candidate count reduction                   | 44.69%                                   |
| Decision p50 / p95                          | 795 / 1878 ms                            |

The seven mismatches were five low-confidence abstentions and two timeouts.
They preserved the original pool rather than dropping a required tool. Low
confidence affected email drafting, naming advice, comparing two files, a
memory-search/get sequence, and a memory-to-web sequence. Timeouts affected
poem generation and memory lookup.

Billing was reported on 62 cases, totaling USD 0.002654862. The two timeouts have
unknown billing; this is a known subtotal, not the full run cost. Thresholds and
labels were not changed after observing results.

## Controlled task comparison

Same requested model in both arms: `qwen/qwen3.8-flash` through OpenRouter. Fixed
synthetic tool data and the actual JEV advisory hook; no real tools were executed.

| Metric                                   | Baseline    | JEV advisory |
| ---------------------------------------- | ----------- | ------------ |
| Tasks passing the mechanical rubric      | 5/8         | 6/8          |
| Main-model calls, including failed tasks | 13          | 17           |
| JEV calls                                | 0           | 8            |
| Reported total cost (USD)                | 0.000813220 | 0.001166048  |

The median within-task latency difference across all eight pairs was +1710 ms
for advisory. Aggregate costs include failed tasks that stopped early, so the
difference must not be attributed solely to JEV overhead.

As a descriptive cross-check, the four tasks that passed in both arms used eight
main-model calls per arm. Their baseline/advisory reported costs were USD
0.000503860 / 0.000541588, and their paired median latency difference was +238.5 ms.
This success-conditioned subset is not an unbiased estimate of overall benefit.

| Task                     | Baseline                   | Advisory                   |
| ------------------------ | -------------------------- | -------------------------- |
| Read release code        | Pass                       | Pass                       |
| Fetch public passcode    | Pass                       | Pass                       |
| Search bulletin          | Tool-call/fixture mismatch | Tool-call/fixture mismatch |
| Search stored preference | Pass                       | Tool-call/fixture mismatch |
| Read stored passage      | Tool-call/fixture mismatch | Pass                       |
| Read file then fetch URL | Tool-call/fixture mismatch | Pass                       |
| Search then fetch        | Pass                       | Pass                       |
| Direct answer            | Pass                       | Pass                       |

`invalid_tool_call` groups invalid arguments, unavailable fixtures and unexpected
tool choices. This run deliberately did not store raw model arguments or text,
so its logs cannot further attribute these failures. They must not be presented
as observed failures of real OpenClaw tools. Before a larger task benchmark,
add sanitized failure categories and verify fixture coverage and equivalent
valid tool plans. Do not erase or reclassify this run to improve the score.

## Engineering checks and next boundary

- 48 offline tests passed, including the paired CLI with mocked HTTP.
- Runtime/index coverage: 98.34% lines, 93.06% branches.
- Scoped lint, formatting and `pnpm build` passed.
- Repository type checking still fails on the pre-existing unrelated
  `extensions/browser/src/browser-tool.test.ts:465` TS2353 error. No unrelated
  browser code was changed.

The next useful work is improving measurement fidelity and evaluating workflows
where a typed decision can actually remove a generative-model call. Keep the
existing permission boundary intact. A generic selector still requires larger
independently labeled data and a real OpenClaw run-level benefit comparison.
