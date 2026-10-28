---
title: "Plugin Runtime Helpers"
sidebarTitle: "Runtime Helpers"
summary: "api.runtime -- the injected runtime helpers available to plugins"
read_when:
  - You need to call core helpers from a plugin (TTS, STT, image gen, web search, subagent)
  - You want to understand what api.runtime exposes
  - You are accessing config, agent, or media helpers from plugin code
---

# Plugin Runtime Helpers

Reference for the `api.runtime` object injected into every plugin during
registration. Use these helpers instead of importing host internals directly.

<Tip>
  **Looking for a walkthrough?** See [Channel Plugins](/plugins/sdk-channel-plugins)
  or [Provider Plugins](/plugins/sdk-provider-plugins) for step-by-step guides
  that show these helpers in context.
</Tip>

```typescript
register(api) {
  const runtime = api.runtime;
}
```

## Runtime namespaces

### `api.runtime.agent`

Agent identity, directories, and session management.

```typescript
// Resolve the agent's working directory
const agentDir = api.runtime.agent.resolveAgentDir(cfg);

// Resolve agent workspace
const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(cfg);

// Get agent identity
const identity = api.runtime.agent.resolveAgentIdentity(cfg);

// Get default thinking level
const thinking = api.runtime.agent.resolveThinkingDefault(cfg, provider, model);

// Get agent timeout
const timeoutMs = api.runtime.agent.resolveAgentTimeoutMs(cfg);

// Ensure workspace exists
await api.runtime.agent.ensureAgentWorkspace(cfg);

// Run an embedded agent turn
const agentDir = api.runtime.agent.resolveAgentDir(cfg);
const result = await api.runtime.agent.runEmbeddedAgent({
  sessionId: "my-plugin:task-1",
  runId: crypto.randomUUID(),
  sessionFile: path.join(agentDir, "sessions", "my-plugin-task-1.jsonl"),
  workspaceDir: api.runtime.agent.resolveAgentWorkspaceDir(cfg),
  prompt: "Summarize the latest changes",
  timeoutMs: api.runtime.agent.resolveAgentTimeoutMs(cfg),
});
```

`runEmbeddedAgent(...)` is the neutral helper for starting a normal OpenClaw
agent turn from plugin code. It uses the same provider/model resolution and
agent-harness selection as channel-triggered replies.

`runEmbeddedPiAgent(...)` remains as a compatibility alias.

**Session store helpers** are under `api.runtime.agent.session`:

```typescript
const storePath = api.runtime.agent.session.resolveStorePath(cfg);
const store = api.runtime.agent.session.loadSessionStore(cfg);
await api.runtime.agent.session.saveSessionStore(cfg, store);
const filePath = api.runtime.agent.session.resolveSessionFilePath(cfg, sessionId);
```

### `api.runtime.agent.defaults`

Default model and provider constants:

```typescript
const model = api.runtime.agent.defaults.model; // e.g. "anthropic/claude-sonnet-4-6"
const provider = api.runtime.agent.defaults.provider; // e.g. "anthropic"
```

### `api.runtime.subagent`

Launch and manage background subagent runs.

```typescript
// Start a subagent run
const { runId } = await api.runtime.subagent.run({
  sessionKey: "agent:main:subagent:search-helper",
  message: "Expand this query into focused follow-up searches.",
  provider: "openai", // optional override
  model: "gpt-4.1-mini", // optional override
  skillFilter: ["github"], // optional per-run skill allowlist
  toolsAllow: ["web_search", "web_fetch"], // optional narrowing tool allowlist
  systemPromptMode: "minimal", // optional compact system prompt
  bootstrapContextMode: "lightweight", // optional omission of workspace bootstrap files
  deliver: false,
});

// Wait for completion
const result = await api.runtime.subagent.waitForRun({ runId, timeoutMs: 30000 });
// A timeout with endedAt is a finished run that timed out, not an unfinished wait.
const finished = result.status !== "timeout" || result.endedAt !== undefined;

// Read session messages
const { messages } = await api.runtime.subagent.getSessionMessages({
  sessionKey: "agent:main:subagent:search-helper",
  limit: 10,
});

// Delete a session
await api.runtime.subagent.deleteSession({
  sessionKey: "agent:main:subagent:search-helper",
});
```

<Warning>
  Model overrides (`provider`/`model`) require operator opt-in via
  `plugins.entries.<id>.subagent.allowModelOverride: true` in config.
  Untrusted plugins can still run subagents, but override requests are rejected.
</Warning>

`skillFilter` limits the run's available skills to the named entries. OpenClaw
intersects this list with the target agent's configured skill filter, so a
plugin cannot use it to widen the agent's existing access.

`toolsAllow` similarly narrows the tools that already pass the target agent's
normal policy; it cannot grant a tool the agent does not have. An omitted or empty
list leaves the normal tool policy unchanged. Set `disableTools: true` for a
text-only run with no tools, even if `toolsAllow` is also provided. This optional
per-run flag does not change the parent session or the agent's configured tools.
Trusted in-process
plugins can use `systemPromptMode: "minimal"` and
`bootstrapContextMode: "lightweight"` for bounded classifier or domain-agent
runs that do not need the general OpenClaw guidance or workspace bootstrap files.

### `api.runtime.taskFlow`

Bind a Task Flow runtime to an existing OpenClaw session key or trusted tool
context, then create and manage Task Flows without passing an owner on every call.

```typescript
const taskFlow = api.runtime.taskFlow.fromToolContext(ctx);

const created = taskFlow.createManaged({
  controllerId: "my-plugin/review-batch",
  goal: "Review new pull requests",
});

const child = taskFlow.runTask({
  flowId: created.flowId,
  runtime: "acp",
  childSessionKey: "agent:main:subagent:reviewer",
  task: "Review PR #123",
  status: "running",
  startedAt: Date.now(),
});

const waiting = taskFlow.setWaiting({
  flowId: created.flowId,
  expectedRevision: created.revision,
  currentStep: "await-human-reply",
  waitJson: { kind: "reply", channel: "telegram" },
});
```

Use `bindSession({ sessionKey, requesterOrigin })` when you already have a
trusted OpenClaw session key from your own binding layer. Do not bind from raw
user input.

### `api.runtime.tts`

Text-to-speech synthesis.

```typescript
// Standard TTS
const clip = await api.runtime.tts.textToSpeech({
  text: "Hello from OpenClaw",
  cfg: api.config,
});

// Telephony-optimized TTS
const telephonyClip = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});

// List available voices
const voices = await api.runtime.tts.listVoices({
  provider: "elevenlabs",
  cfg: api.config,
});
```

Uses core `messages.tts` configuration and provider selection. Returns PCM audio
buffer + sample rate.

### `api.runtime.mediaUnderstanding`

Image, audio, and video analysis.

```typescript
// Describe an image
const image = await api.runtime.mediaUnderstanding.describeImageFile({
  filePath: "/tmp/inbound-photo.jpg",
  cfg: api.config,
  agentDir: "/tmp/agent",
});

// Transcribe audio
const { text } = await api.runtime.mediaUnderstanding.transcribeAudioFile({
  filePath: "/tmp/inbound-audio.ogg",
  cfg: api.config,
  mime: "audio/ogg", // optional, for when MIME cannot be inferred
});

// Describe a video
const video = await api.runtime.mediaUnderstanding.describeVideoFile({
  filePath: "/tmp/inbound-video.mp4",
  cfg: api.config,
});

// Generic file analysis
const result = await api.runtime.mediaUnderstanding.runFile({
  filePath: "/tmp/inbound-file.pdf",
  cfg: api.config,
});
```

Returns `{ text: undefined }` when no output is produced (e.g. skipped input).

<Info>
  `api.runtime.stt.transcribeAudioFile(...)` remains as a compatibility alias
  for `api.runtime.mediaUnderstanding.transcribeAudioFile(...)`.
</Info>

### `api.runtime.imageGeneration`

Image generation.

```typescript
const result = await api.runtime.imageGeneration.generate({
  prompt: "A robot painting a sunset",
  cfg: api.config,
});

const providers = api.runtime.imageGeneration.listProviders({ cfg: api.config });
```

### `api.runtime.webSearch`

Web search.

```typescript
const providers = api.runtime.webSearch.listProviders({ config: api.config });

const result = await api.runtime.webSearch.search({
  config: api.config,
  args: { query: "OpenClaw plugin SDK", count: 5 },
});
```

### `api.runtime.media`

Low-level media utilities.

```typescript
const webMedia = await api.runtime.media.loadWebMedia(url);
const mime = await api.runtime.media.detectMime(buffer);
const kind = api.runtime.media.mediaKindFromMime("image/jpeg"); // "image"
const isVoice = api.runtime.media.isVoiceCompatibleAudio(filePath);
const metadata = await api.runtime.media.getImageMetadata(filePath);
const resized = await api.runtime.media.resizeToJpeg(buffer, { maxWidth: 800 });
```

### `api.runtime.config`

Config load and write.

```typescript
const cfg = await api.runtime.config.loadConfig();
await api.runtime.config.writeConfigFile(cfg);
```

### `api.runtime.system`

System-level utilities.

```typescript
await api.runtime.system.enqueueSystemEvent(event);
api.runtime.system.requestHeartbeatNow();
const output = await api.runtime.system.runCommandWithTimeout(cmd, args, opts);
const hint = api.runtime.system.formatNativeDependencyHint(pkg);
```

### `api.runtime.events`

Event subscriptions.

```typescript
api.runtime.events.onAgentEvent((event) => {
  /* ... */
});
api.runtime.events.onSessionTranscriptUpdate((update) => {
  /* ... */
});
```

### `api.runtime.logging`

Logging.

```typescript
const verbose = api.runtime.logging.shouldLogVerbose();
const childLogger = api.runtime.logging.getChildLogger({ plugin: "my-plugin" }, { level: "debug" });
```

### `api.runtime.modelAuth`

Model and provider auth resolution.

```typescript
const auth = await api.runtime.modelAuth.getApiKeyForModel({ model, cfg });
const providerAuth = await api.runtime.modelAuth.resolveApiKeyForProvider({
  provider: "openai",
  cfg,
});
```

### `api.runtime.state`

State directory resolution.

```typescript
const stateDir = api.runtime.state.resolveStateDir();
```

### `api.runtime.tools`

Memory tool factories and CLI.

```typescript
const getTool = api.runtime.tools.createMemoryGetTool(/* ... */);
const searchTool = api.runtime.tools.createMemorySearchTool(/* ... */);
api.runtime.tools.registerMemoryCli(/* ... */);
```

### `api.runtime.channel`

Channel-specific runtime helpers (available when a channel plugin is loaded).

`api.runtime.channel.mentions` is the shared inbound mention-policy surface for
bundled channel plugins that use runtime injection:

```typescript
const mentionMatch = api.runtime.channel.mentions.matchesMentionWithExplicit(text, {
  mentionRegexes,
  mentionPatterns,
});

const decision = api.runtime.channel.mentions.resolveInboundMentionDecision({
  facts: {
    canDetectMention: true,
    wasMentioned: mentionMatch.matched,
    implicitMentionKinds: api.runtime.channel.mentions.implicitMentionKindWhen(
      "reply_to_bot",
      isReplyToBot,
    ),
  },
  policy: {
    isGroup,
    requireMention,
    allowTextCommands,
    hasControlCommand,
    commandAuthorized,
  },
});
```

Available mention helpers:

- `buildMentionRegexes`
- `matchesMentionPatterns`
- `matchesMentionWithExplicit`
- `implicitMentionKindWhen`
- `resolveInboundMentionDecision`

`api.runtime.channel.mentions` intentionally does not expose the older
`resolveMentionGating*` compatibility helpers. Prefer the normalized
`{ facts, policy }` path.

## Storing runtime references

Use `createPluginRuntimeStore` to store the runtime reference for use outside
the `register` callback:

```typescript
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const store = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "my-plugin",
  errorMessage: "my-plugin runtime not initialized",
});

// In your entry point
export default defineChannelPluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  description: "Example",
  plugin: myPlugin,
  setRuntime: store.setRuntime,
});

// In other files
export function getRuntime() {
  return store.getRuntime(); // throws if not initialized
}

export function tryGetRuntime() {
  return store.tryGetRuntime(); // returns null if not initialized
}
```

Prefer `pluginId` for the runtime-store identity. The lower-level `key` form is
for uncommon cases where one plugin intentionally needs more than one runtime
slot.

## Other top-level `api` fields

Beyond `api.runtime`, the API object also provides:

| Field                    | Type                      | Description                                                                                 |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------------------------- |
| `api.id`                 | `string`                  | Plugin id                                                                                   |
| `api.name`               | `string`                  | Plugin display name                                                                         |
| `api.config`             | `OpenClawConfig`          | Current config snapshot (active in-memory runtime snapshot when available)                  |
| `api.pluginConfig`       | `Record<string, unknown>` | Plugin-specific config from `plugins.entries.<id>.config`                                   |
| `api.logger`             | `PluginLogger`            | Scoped logger (`debug`, `info`, `warn`, `error`)                                            |
| `api.registrationMode`   | `PluginRegistrationMode`  | Current load mode; `"setup-runtime"` is the lightweight pre-full-entry startup/setup window |
| `api.resolvePath(input)` | `(string) => string`      | Resolve a path relative to the plugin root                                                  |

## File delivery

`openclaw/plugin-sdk/file-delivery-runtime` provides the version 1
`uploadFileForDelivery({ version: 1, data, displayName })` contract. It uploads
authorized artifact bytes through the host's existing OSS file delivery configuration,
enforces the configured extension and size limits, and returns
`{ version: 1, url, objectKey, size }`. The URL uses the configured public storage domain.
Configuration and credentials remain host-owned; plugins must validate the source
bytes and obtain authorization for storage. Imports are lazy and do not load storage
configuration during plugin discovery. Upload failures throw and must not cause a
caller to repeat the external action that produced the artifact.

## Related

- [SDK Overview](/plugins/sdk-overview) -- subpath reference
- [SDK Entry Points](/plugins/sdk-entrypoints) -- `definePluginEntry` options
- [Plugin Internals](/plugins/architecture) -- capability model and registry

## Shared MySQL pools

`openclaw/plugin-sdk/mysql-pool` exposes the additive v1 `acquireMysqlPool(config)` contract.
Pass `host`, `port`, `user`, `password`, and `database`. Equal configurations share one
physical mysql2 pool within the same Node.js process, including across bundled plugins.
Different credentials or databases, worker threads with separate JavaScript globals,
and separate processes use independent pools.

The returned handle supports mysql2 promise-pool operations. `query` and `execute`
borrow and release connections automatically. Explicit `getConnection()` callers must
release the connection in `finally`, especially when using transactions. Each owner
must call its handle's `end()` during shutdown; this releases that owner's reference.
The last owner drains pending operations and closes the physical pool. A closed handle
cannot issue further queries. Change pool settings by restarting the service.

| Environment variable         | Default                             | Meaning                                                                                  |
| ---------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `MYSQL_CONNECTION_LIMIT`     | `10`                                | Maximum physical connections per shared pool                                             |
| `MYSQL_MIN_IDLE_CONNECTIONS` | `2` (capped by the default maximum) | Idle connections to maintain when capacity permits; `0` disables prewarming              |
| `MYSQL_IDLE_TIMEOUT_MS`      | `60000`                             | Idle age before excess connections are reclaimed                                         |
| `MYSQL_QUEUE_LIMIT`          | `100`                               | Maximum queued acquisitions; further requests fail instead of growing an unbounded queue |

Values must be positive integers, except the idle minimum which may be zero. An
explicit minimum above the maximum is rejected. Maintenance checks at most once per
second (more often for shorter idle timeouts), preserves busy connections, and gives
user queries priority over prewarming. Outages may prevent reaching the idle minimum;
failed prewarming backs off for 10 seconds. The queue limit does not set a query timeout.

For deployment credentials use `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`,
`MYSQL_PASSWORD`, and `MYSQL_DATABASE`. The account must have the read/write permissions
required by the enabled plugins. Connection limits do not replace MySQL server-wide
`max_connections`, which also includes other applications and processes.

## Externally managed service handoff

Services can opt into the additive `handoff.version: 1` contract on
`api.registerService`. When `ctx.lifecycleMode` is `"externally-managed"`,
`start(ctx)` must initialize in standby without accepting work. `isReady(ctx)`
reports dependency readiness, including while paused. The host calls
`resume(ctx)` only after the external manager grants ownership.

`pause(ctx, timeoutMs)` must stop new deliveries and wait for accepted work,
including response publication and broker acknowledgments. It must not abort
accepted work on timeout. A rejected pause can be followed by `resume(ctx)` to
restore the existing process. Keep connections open until `stop(ctx)`; do not
close a queue channel while it still owns unsettled deliveries. `resume` must
be safe after partial pause failure and must not create duplicate consumers.

Legacy services continue to work outside managed mode. Managed startup fails
readiness for services without this contract rather than silently assuming
their background work can be interrupted. Tool-only services with no independent
ingress may implement no-op pause/resume; the host still drains their agent turns.

Execution backends can use `handoff: { version: 2, drainPhase: "execution", ... }`
with the same `pause`, `resume`, and `isReady` methods. Check
`ctx.handoffVersion === 2` during managed startup and reject older hosts. V1
services and v2 services with `drainPhase: "ingress"` drain first. The host then
waits for accepted agent work, closes command admission, and drains execution
services. On recovery, execution services resume before ingress. A busy direct
entry point can postpone the idle boundary and cause the upgrade to time out;
the host restores the old worker rather than aborting its tasks.

`openclaw/plugin-sdk/service-runtime` provides `createServiceWorkTracker(id,
initiallyAccepting?)`. Its `run` and `stream` helpers hold leases until the
underlying operation finishes. `pause(timeoutMs)` closes admission and waits for
all leases without cancelling them. `resume()` reopens admission. Stream leases
drain the producer even if the consumer stops reading, so producer cleanup and
persistence remain part of the drain. Use this only for finite operations;
infinite subscriptions need their own explicit unsubscribe-and-settle protocol.

Managed lazy modules must expose the handoff factory selected by
`handoffExportName`, plus start and stop exports. The host resolves and validates
the execution v2 contract before calling start, and passes the service context
to the factory. Missing capabilities are errors in managed mode; ordinary
unmanaged modules remain compatible.

The bundled ACP adapter requires a successful availability probe. With acpx
0.5.3, a persistent session that has been ensured but has not completed a turn
may still own a cached client without a public non-destructive disposal API.
The adapter refuses handoff in that case and lets the manager resume the old
worker; it does not delete persistent sessions or kill untracked processes.
Browser handoff drains operations but does not preserve the in-memory state of
Chrome instances owned and stopped by the old worker. Pairing notification
handoff waits for sending and state persistence; crash recovery between a
remote send and local persistence can still produce duplicate notifications.
