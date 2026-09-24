# Business routing live results

Measured on September 24, 2026 using `pnpm suheng:debug`, the existing
`qwen3.8-flash` provider, and `typesafe/jev-1.13`. These are synthetic local
measurements, not production benchmarks.

## Repeated experiment

Each mode ran six three-turn sessions: remember a fixture path, read that file
using prior context, then answer from the result. Four independently started
batches ran in route/baseline/baseline/route order, three sessions per batch.
The first request of each batch was classified as cold in advance and excluded
from warm comparisons. All other requests, including fallbacks and extra tool
calls, remain in the results. No concurrent builds or test suites ran during timing.

| Warm metric                 |  Baseline |     Route | Change       |
| --------------------------- | --------: | --------: | ------------ |
| Total, 16 turns per mode    | 193.364 s | 184.664 s | 4.5% lower   |
| Mean per turn               |  12.085 s |  11.542 s | 4.5% lower   |
| Median per turn             |  11.781 s |  12.074 s | 2.5% higher  |
| Remember-path mean, 4 turns |  10.874 s |  12.626 s | 16.1% higher |
| Read mean, 6 turns          |  13.621 s |  15.716 s | 15.4% higher |
| Answer mean, 6 turns        |  11.357 s |   6.644 s | 41.5% lower  |

The two opposite-order batch comparisons reduced total warm latency by 2.4%
and 6.3%. An earlier two-session-per-mode experiment observed 14.4%; that larger
percentage did not recur. Do not combine these results into a general speedup claim.

## Decisions and retries

The 18 route turns produced exactly 18 JEV requests: five accepted `read`
decisions, six accepted `answer` decisions, and seven low-confidence fallbacks.
Six fallbacks were remember-path turns; one was a read turn. No JEV transport,
HTTP, contract, or timeout failure was recorded. Decision latency averaged
0.925 s, with a 0.909 s median and a 0.824–1.072 s range.

The client and local bridge do not retry. A failed or low-confidence decision
preserves the original model workflow. The decision promise is retained within
the user turn, including a fallback, so model tool continuations do not ask JEV
again. The upstream decision deadline is two seconds; the local bridge deadline
is 2.5 seconds. Provider-internal retries are not observable in these logs.

Across all 36 turns, the main model made 27 requests in route mode and 25 in
baseline mode. All completed with HTTP 200. One route turn read the fixture
twice, another three times; both had only one JEV decision. One baseline turn
called `process` with `action: list` after reading. These additional model/tool
steps remain included in latency and must not be described as JEV retries.

One baseline batch encountered a debug authentication timeout before submitting
any task or model request. Startup was allowed to finish before rerunning the
batch; this startup-only attempt is excluded from task timing.

## Limits and next steps

The prior experiment found correct tool results followed by incorrect model
answers in both modes. This repeated experiment intentionally measured latency
without investigating or repairing that issue. HTTP success is not task-quality
validation, and results were not filtered by answer correctness.

Only three fixed synthetic task types were repeated. Cache state, provider load,
model generation, and tool-loop length were not controlled. Reverse batch order
reduces but does not remove order effects. The sample does not establish a
production p95, statistical significance, or cost savings. Generation options
in the driver were not independently verified through the business pipeline.

Continue evaluating answer-only routing. Read routing and fallbacks do not yet
show an aggregate benefit. Keep this feature opt-in and defer a generic tool
selection interface until representative task-quality and latency evidence
supports it. Reproduce with `scripts/dev/jev-debug-bench.ts` and fresh output
paths; never include credentials or real conversations in reports.
