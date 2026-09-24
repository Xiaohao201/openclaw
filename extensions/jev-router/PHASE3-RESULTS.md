# Phase 3: actual filtering in Suheng debug

Date: 2026-09-24. See [the reproduction guide](./DEBUG-EXPERIMENT.md).

## Decision

Integration is feasible; a stable speed or quality benefit is **not demonstrated**.
Keep this opt-in experiment disabled by default. Do not expand the general tool
selection contract based on this smoke test.

Unlike Phase 2 advice, this experiment changes the actual schemas sent to the
configured `qwen/qwen3.8-flash` model, with prior conversation and tool results
included in JEV state. Real `read` calls and continuation ran through the
`pnpm suheng:debug` HTTP endpoint, not fixture tool emulation.

## Observations

- The host advertised 65 tools. A successful read decision reduced that request
  to one tool and from 96,733 to 17,341 bytes (82.1% smaller).
- Across eight JEV calls: one selected `read`, two selected no-tools, two timed
  out, and three abstained for low confidence. Only three requests were reduced.
- Decision latency ranged from 1,315 to 2,013 ms. Known JEV cost across six calls
  was $0.001828344; two timeout costs are unknown.
- There were four three-turn episodes, totaling 16 model calls and eight JEV calls.
  One earlier database ID validation failure made no model call.

The primary comparison uses the final isolated baseline and the first filter
episode. Both disabled background plugin services. All numbers below are
end-to-end HTTP milliseconds:

| Turn                                                |   Baseline |     Filter | Model calls, each arm |
| --------------------------------------------------- | ---------: | ---------: | --------------------: |
| Remember fixture path, includes lazy initialization |     68,196 |     82,685 |                     1 |
| Read the prior path and report its values           |     14,267 |     19,693 |                     2 |
| Calculate from the prior result                     |     13,719 |     11,795 |                     1 |
| Last two turns combined                             | **27,986** | **31,488** |                 **3** |

The last two turns were 3,502 ms (12.5%) slower with JEV. Main-model input tokens,
including cache reads, fell from 74,688 to 33,377; cache reads fell from 72,704 to
23,552. These are main-model figures, not total pipeline input or dollar savings.

Both primary arms actually read the correct fixture but reported an incorrect
verification code. Both calculated 22 correctly; the baseline also added unwanted
explanation despite the request for only a number. Thus this is not a comparison
of uniformly successful tasks. The repeated filter episode reported the file
values correctly, but overlapped a build and is excluded from speed conclusions.
The first baseline had background services enabled and is also excluded from the
primary comparison. No randomized crossover, p95 claim, or statistical quality
conclusion is justified by this single three-turn scenario.

Raw artifact names: `jev-debug-baseline-isolated.json`,
`jev-debug-baseline-isolated-metrics.jsonl`, `jev-debug-filter.json`,
`jev-debug-filter-repeat.json`, and `jev-debug-filter-metrics.jsonl`. They are
kept in the task's artifact directory, not committed to the repository.

## Next experiment

Select once per user turn and retain a stable shortlist within its tool loop.
Compare this with per-model-request selection, then test a smaller stable catalog
index. Preserve full LLM history and fail-open behavior. Add answer verification
and broader held-out paired tasks before changing confidence thresholds or
supporting additional tool classes.

## Verification

- 55 plugin tests and four existing debug configuration tests passed.
- New filter/proxy coverage: 90.9% lines and 87.34% branches.
- Scoped lint, formatting, and full build passed.
- Whole-repository type checking still reports the existing browser test error
  at `extensions/browser/src/browser-tool.test.ts:465`.
- Whole-repository lint also reports existing issues in report-generator,
  phone-reader, and rabbitmq-consumer. These files were not changed.
