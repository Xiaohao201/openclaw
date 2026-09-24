# JEV filtering in the Suheng debug runtime

This opt-in experiment tests **real tool-schema filtering**, unlike the earlier
advisory benchmark. It does not add a general Plugin SDK tool-selection contract
or enable the JEV plugin in production.

## Data flow

1. OpenClaw assembles the actual permitted tool catalog and model conversation.
2. A loopback proxy receives the Qwen OpenAI chat-completions request.
3. In filter mode, the proxy encodes user/assistant/tool history and the available
   catalog into the decision API's `state.user_request`. System and developer
   messages are excluded from the JEV copy. Descriptions in this copy are capped
   at 128 characters and marked when truncated. The complete serialized routing
   context must fit the existing 20,000-character limit, otherwise routing abstains.
4. JEV selects from the five existing read-only candidates actually present in
   this request. Requests needing other tools should abstain. Successful decisions
   reduce the advertised tool schemas, including removing schemas for no-tools.
5. Qwen receives the original conversation, with only the tool catalog changed.
   OpenClaw generates arguments, executes tools, and resumes the normal loop.
   Each subsequent model request includes the accumulated tool results in JEV state.

This changes tool visibility, **not execution authorization**. Existing OpenClaw
permissions remain authoritative. Unknown selections, low confidence, unsupported
contexts, and failures preserve the entire original tool pool. Forced tool-choice
requests bypass filtering. Original schemas and their order are retained.

## Running locally

Use an already configured `qwen` provider with `api: openai-completions`. These
experiments use the existing production model settings inherited by Suheng debug.
The new switches only modify its temporary configuration. No real user histories
should be used in this experiment.

In PowerShell, with a free debug port 19001:

```powershell
$env:OPENCLAW_JEV_DEBUG_MODE = 'baseline' # or 'filter'
$env:OPENCLAW_JEV_DEBUG_METRICS = 'C:/path/to/new-metrics.jsonl'
# Filter mode requires JEV_OPENROUTER_API_KEY already set securely in this shell.
pnpm suheng:debug
```

In another terminal, after the Gateway is ready:

```powershell
node --import tsx scripts/dev/jev-debug-bench.ts baseline C:/path/to/new-result.json
# Use filter as the label when the server is in filter mode.
```

The driver runs three synthetic turns: remember a fixture path, read its code and
count, then add five to the count using the prior result. It uses a unique session
and the `history_test` database table. The fixture's ground truth is
`JEV-LOCAL-7319`, `17`, then `22`; HTTP 200 alone does not establish correctness.
The output file is created exclusively and checkpointed after every turn.

The proxy accepts only requests with `[JEV_SYNTHETIC_BENCH]` in a user message,
uses an unguessable loopback route, refuses redirects, and caps each process at
16 forwarded model requests (and at most 16 JEV decisions). JEV has a two-second
timeout and no automatic retries. The Gateway can retry model requests, which
still count against this cap. The benchmark payload requests 512 output tokens,
but the current chat pipeline does not guarantee forwarding that limit; actual
generation settings remain the inherited model settings. This is not a token-cost
budget enforcement mechanism.

In experiment mode, background plugin services are disabled, while the HTTP debug
runner remains available. The proxy keeps the routing key out of the Gateway child
environment. Metrics contain counts, timings, decision enums, token usage, and
known costs, never credentials or conversation text. Upstream provider credentials
are forwarded only to the configured HTTPS provider.

Stop the debug process after the test and remove `OPENCLAW_JEV_DEBUG_MODE` and
`OPENCLAW_JEV_DEBUG_METRICS` from the shell for ordinary debug runs. Ordinary
`pnpm suheng:debug` behavior remains unchanged when these switches are absent.

## Interpretation

Measure end-to-end HTTP latency, model request count, successful tool use, final
answer correctness, token usage including cache reads, and JEV overhead. Exclude
first-turn lazy initialization from warm-turn speed comparisons. Do not run builds
or heavy checks during performance measurements. Changing tool schemas can reduce
prompt-cache reuse even when message content is preserved.

These three synthetic turns are an integration smoke test, not a statistically
powered quality or performance evaluation. Keep the experiment disabled by default.
Only consider a general tool-selection interface after broader paired evidence
shows a benefit without missed required tools or worse task completion.
