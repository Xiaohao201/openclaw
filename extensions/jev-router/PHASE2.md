# Phase 2: controlled quality and task comparison

The authorized initial run is complete; see [results](./PHASE2-RESULTS.md).

This phase retains the existing plugin contract. It does not hard-filter live
OpenClaw tools or enable the plugin in the user's gateway configuration.

## Frozen inputs and request limits

- `eval/validation.json`: 64 newly authored bilingual synthetic cases, disjoint
  from the original 16 smoke prompts. Labels are author judgments, not independent
  human annotations. Do not claim this is a representative production sample.
- Freeze confidence at 0.8, retention probability at 0.2 and timeout at 2000 ms
  before evaluating; do not tune on these results and call the same set held out.
- `eval/tasks.json`: eight controlled tasks, each run once in each arm. Alternate
  arm order across tasks. Use one model in both arms: `qwen/qwen3.8-flash`, matching
  the user's configured model ID, through OpenRouter rather than the user's
  configured provider connection. This may have different provider latency.
- Live request ceiling for this phase: 64 routing decisions plus eight advisory
  decisions, and at most 64 chat-completion requests. No automatic retries.
- Each chat request allows at most 512 output tokens and waits at most 30 seconds.
  These bound requests, not an exact dollar charge. Report upstream `usage.cost`
  where supplied; missing billing remains unknown.
- Reserve result paths before external calls and save each completed item. Existing
  reports are never overwritten. Partial reports remain marked `complete: false`.

## What the task comparison measures

The baseline and advisory arms share tool definitions, system prompt, model,
fixtures and answer checks. The advisory arm invokes the actual plugin prompt
hook and includes its measured decision time and reported usage. Tool definitions
remain unchanged: this tests the implemented advice mode, not a hypothetical
future selector.

Read, fetch and memory-get calls resolve only exact predefined paths/URLs.
Search tools return controlled fixture data for a syntactically valid query;
query relevance is not scored. No model-generated command, filesystem path or
URL is executed. No real files, websites, stored memories or user transcripts
are sent. Tasks pass only when required tool types were called successfully and
the final text contains every specified evidence marker. This mechanical rubric
does not measure general answer quality or reject all possible contradictory text.

Report complete matched pairs, including failures; total latency includes JEV,
model calls and fixture execution. Count calls, input/output/cache tokens and
reported cost. Missing cost on any request makes that arm's total unknown.
Include unsuccessful model-call attempts in the count and keep their billing
unknown. Do not silently drop slow or failed arms.

This is a controlled tool-loop experiment, not a full OpenClaw Gateway benchmark.
It does not exercise channel delivery, sandbox approvals, real search, provider
auth behavior, or an actual production transcript. No generic SDK interface may
be justified by this experiment alone.

## Commands

Set `JEV_OPENROUTER_API_KEY` in the process environment using the existing
credential. Do not put it in a command argument or a report. From the repo root:

```sh
pnpm exec tsx extensions/jev-router/evaluate.ts --dataset extensions/jev-router/eval/validation.json --max-cases 64 --live --output jev-validation.json
pnpm exec tsx extensions/jev-router/benchmark.ts --dataset extensions/jev-router/eval/tasks.json --model qwen/qwen3.8-flash --max-tasks 8 --max-model-calls 64 --live --output jev-task-comparison.json
```

The earlier 16-request permission and this phase's separately approved run have
both been consumed. The commands above document how the experiment was run;
they are not permission to repeat paid calls. Offline tests need no live credentials.

## Decision rule

Stop before a generic selection API if the advisory arm has worse task success
or no credible cost/latency benefit. Eight pairs are an exploratory sample, not
statistical proof. A positive result still needs 300–500 independently labeled,
representative cases and actual OpenClaw run-level comparison with cache and
permission behavior intact.

References: [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling),
[usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting),
[Qwen3.8 Flash model](https://openrouter.ai/qwen/qwen3.8-flash).
