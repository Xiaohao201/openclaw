---
summary: "Debugging tools: watch mode, raw model streams, and tracing reasoning leakage"
read_when:
  - You need to inspect raw model output for reasoning leakage
  - You want to run the Gateway in watch mode while iterating
  - You need a repeatable debugging workflow
title: "Debugging"
---

# Debugging

This page covers debugging helpers for streaming output, especially when a
provider mixes reasoning into normal text.

## Runtime debug overrides

Use `/debug` in chat to set **runtime-only** config overrides (memory, not disk).
`/debug` is disabled by default; enable with `commands.debug: true`.
This is handy when you need to toggle obscure settings without editing `openclaw.json`.

Examples:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` clears all overrides and returns to the on-disk config.

## Session trace output

Use `/trace` when you want to see plugin-owned trace/debug lines in one session
without turning on full verbose mode.

Examples:

```text
/trace
/trace on
/trace off
```

Use `/trace` for plugin diagnostics such as Active Memory debug summaries.
Keep using `/verbose` for normal verbose status/tool output, and keep using
`/debug` for runtime-only config overrides.

## Gateway watch mode

For fast iteration, run the gateway under the file watcher:

```bash
pnpm gateway:watch
```

This maps to:

```bash
node scripts/watch-node.mjs gateway --force
```

The watcher restarts on build-relevant files under `src/`, extension source files,
extension `package.json` and `openclaw.plugin.json` metadata, `tsconfig.json`,
`package.json`, and `tsdown.config.ts`. Extension metadata changes restart the
gateway without forcing a `tsdown` rebuild; source and config changes still
rebuild `dist` first.

Add any gateway CLI flags after `gateway:watch` and they will be passed through on
each restart. Re-running the same watch command for the same repo/flag set now
replaces the older watcher instead of leaving duplicate watcher parents behind.

## Dev profile + dev gateway (--dev)

Use the dev profile to isolate state and spin up a safe, disposable setup for
debugging. There are **two** `--dev` flags:

- **Global `--dev` (profile):** isolates state under `~/.openclaw-dev` and
  defaults the gateway port to `19001` (derived ports shift with it).
- **`gateway --dev`: tells the Gateway to auto-create a default config +
  workspace** when missing (and skip BOOTSTRAP.md).

Recommended flow (dev profile + dev bootstrap):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

If you don’t have a global install yet, run the CLI via `pnpm openclaw ...`.

What this does:

1. **Profile isolation** (global `--dev`)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (browser/canvas shift accordingly)

2. **Dev bootstrap** (`gateway --dev`)
   - Writes a minimal config if missing (`gateway.mode=local`, bind loopback).
   - Sets `agent.workspace` to the dev workspace.
   - Sets `agent.skipBootstrap=true` (no BOOTSTRAP.md).
   - Seeds the workspace files if missing:
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - Default identity: **C3‑PO** (protocol droid).
   - Skips channel providers in dev mode (`OPENCLAW_SKIP_CHANNELS=1`).

Reset flow (fresh start):

```bash
pnpm gateway:dev:reset
```

Note: `--dev` is a **global** profile flag and gets eaten by some runners.
If you need to spell it out, use the env var form:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` wipes config, credentials, sessions, and the dev workspace (using
`trash`, not `rm`), then recreates the default dev setup.

### Inherit real configuration for RabbitMQ debugging

Use the dedicated launcher when the loopback RabbitMQ debug page must see the
same configured models and plugin tools as the real environment:

```bash
pnpm build
pnpm gateway:rabbitmq-debug
```

The launcher reads the normal config as a production baseline, overlays the dev
Gateway credentials and agent workspace, forces the RabbitMQ local-debug mode,
and runs the Gateway on loopback port `19001`. It keeps state and sessions under
the dev state directory. Channels, Gmail and internal hooks, and long-lived
plugin services are disabled so production consumers, schedulers, and
notification workers do not start.

Completed replies keep the high-level work-process panel compact. Framework-only
initialization, progress, synthetic thinking, and answer-assembly events are
omitted from the completed trace. A reply that did not use a tool therefore has
one natural OpenClaw public record instead of several generic pipeline steps;
when tools were used, only the actual operations count as work steps. Expand the
panel to see a continuous, muted narrative based on the sanitized request,
observable operations, outcome, and a bounded excerpt of the final response.
Each actual operation can also be expanded into a concise first-person account
of what OpenClaw did, why it did it, sanitized call context, and the outcome;
status and duration remain in the collapsed step header. This record is
generated from observable events, not hidden chain-of-thought. Raw tool
arguments, internal errors, credentials, and hidden model reasoning are never
included in the detail view.

Read-only `feed_list` and `milvus_search` steps include bounded observations from
their actual results instead of a generic completion sentence. Feed observations
can show the requested topic/page/size, total and returned counts, plus a preview
of the first item's title, platform, date, risk, emotion, and summary. Milvus
observations can show the match count and a capped excerpt of the highest-scoring
match. Links, collection names, search text, credentials, and raw errors remain
excluded.

The merged config exists only in a permission-restricted temporary directory and
is deleted when the launcher exits. Config values and secrets are never printed.
The local agent inherits the production `tools` policy, enabled extension
surface, MySQL connections, and Milvus connection, so the simulated RabbitMQ
turn sees the same data capabilities as the deployed channel. Development config
values still override their production counterparts when present. Local chat
history is the isolated `history_test` table (created from `history_messages` on
first use), while the RabbitMQ queue setting is forced to `MessageTest`. The
local session and agent workspace remain in the dev state directory; channels,
Gmail/internal hooks, Mercure delivery, and long-lived plugin services remain
disabled.

Optional path overrides:

- `OPENCLAW_REAL_CONFIG_PATH`: real config to inherit.
- `OPENCLAW_DEV_CONFIG_PATH`: dev overlay config.
- `OPENCLAW_DEV_STATE_DIR`: isolated state and sessions directory.

Tip: if a non‑dev gateway is already running (launchd/systemd), stop it first:

```bash
openclaw gateway stop
```

## Raw stream logging (OpenClaw)

OpenClaw can log the **raw assistant stream** before any filtering/formatting.
This is the best way to see whether reasoning is arriving as plain text deltas
(or as separate thinking blocks).

Enable it via CLI:

```bash
pnpm gateway:watch --raw-stream
```

Optional path override:

```bash
pnpm gateway:watch --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

Equivalent env vars:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Default file:

`~/.openclaw/logs/raw-stream.jsonl`

## Raw chunk logging (pi-mono)

To capture **raw OpenAI-compat chunks** before they are parsed into blocks,
pi-mono exposes a separate logger:

```bash
PI_RAW_STREAM=1
```

Optional path:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

Default file:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> Note: this is only emitted by processes using pi-mono’s
> `openai-completions` provider.

## Safety notes

- Raw stream logs can include full prompts, tool output, and user data.
- Keep logs local and delete them after debugging.
- If you share logs, scrub secrets and PII first.
