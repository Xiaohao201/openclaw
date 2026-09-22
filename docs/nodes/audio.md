---
summary: "How inbound audio/voice notes are downloaded, transcribed, and injected into replies"
read_when:
  - Changing audio transcription or media handling
title: "Audio and Voice Notes"
---

# Audio / Voice Notes (2026-01-17)

## What works

- **Media understanding (audio)**: If audio understanding is enabled (or auto‑detected), OpenClaw:
  1. Locates the first audio attachment (local path or URL) and downloads it if needed.
  2. Enforces `maxBytes` before sending to each model entry.
  3. Runs the first eligible model entry in order (provider or CLI).
  4. If it fails or skips (size/timeout), it tries the next entry.
  5. On success, it replaces `Body` with an `[Audio]` block and sets `{{Transcript}}`.
- **Command parsing**: When transcription succeeds, `CommandBody`/`RawBody` are set to the transcript so slash commands still work.
- **Verbose logging**: In `--verbose`, we log when transcription runs and when it replaces the body.

## Auto-detection (default)

If you **don’t configure models** and `tools.media.audio.enabled` is **not** set to `false`,
OpenClaw auto-detects in this order and stops at the first working option:

1. **Active reply provider** when it supports audio understanding, using its dedicated audio model when declared.
2. **Provider auth**
   - Configured `models.providers.*` entries that support audio are tried first.
   - Registered provider priority: Qwen → OpenAI → Groq → Deepgram → Google → Mistral.
3. **Local CLI** (if no authenticated provider is available)
   - `sherpa-onnx-offline` (requires `SHERPA_ONNX_MODEL_DIR` with encoder/decoder/joiner/tokens)

Installed `whisper` and `whisper-cli` binaries are no longer auto-launched. Existing
explicit CLI entries still work, but are not added as a fallback when a cloud ASR
request fails. Gemini CLI is not automatically selected for audio.

To disable auto-detection, set `tools.media.audio.enabled: false`.
To customize, set `tools.media.audio.models`.
Note: Binary detection is best-effort across macOS/Linux/Windows; ensure the CLI is on `PATH` (we expand `~`), or set an explicit CLI model with a full command path.

## Config examples

### Qwen ASR for audio attachments and video audio tracks

Set `DASHSCOPE_API_KEY` (or `QWEN_API_KEY`) in the gateway environment or its
`.env` file. Use a Standard API key for the same region and workspace as the endpoint.
OpenClaw does not read a standalone test script's `.env` file.

Merge this section into your existing config:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        timeoutSeconds: 300,
        models: [
          {
            provider: "qwen",
            model: "qwen-audio-3.0-asr-flash",
            baseUrl: "https://YOUR_WORKSPACE_ID.cn-beijing.maas.aliyuncs.com",
          },
        ],
      },
    },
  },
}
```

Replace the workspace placeholder with the workspace that owns the API key.
The provider sends the entire audio as a Base64 data URI to the native DashScope
ASR endpoint. It also accepts a full native endpoint URL and normalizes existing
Qwen chat endpoint URLs. Without an endpoint override it uses the China Standard
endpoint. The configured Qwen chat endpoint, if present, remains an inherited
default; an audio-specific `baseUrl` avoids changing chat or video routing.

This synchronous model accepts audio up to five minutes. Inline Base64 is limited
to 10 MB (including encoding overhead); oversized payloads fail before upload.
Audio is never silently truncated or split. Longer recordings require a suitable
file-transcription service or separately prepared complete segments. A timeout,
upstream error, or missing full transcript is a failed transcription, not silence.

`video_understand` still attempts whole-video understanding first. Its audio
fallback uses this same configuration and does not start a local Whisper process.

See the [Qwen ASR API reference](https://help.aliyun.com/zh/model-studio/fun-asr-flash-recorded-speech-recognition-http-api).

### Provider + CLI fallback (OpenAI + Whisper CLI)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
            timeoutSeconds: 45,
          },
        ],
      },
    },
  },
}
```

### Provider-only with scope gating

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        scope: {
          default: "allow",
          rules: [{ action: "deny", match: { chatType: "group" } }],
        },
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

### Provider-only (Deepgram)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

### Provider-only (Mistral Voxtral)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "mistral", model: "voxtral-mini-latest" }],
      },
    },
  },
}
```

### Echo transcript to chat (opt-in)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        echoTranscript: true, // default is false
        echoFormat: '📝 "{transcript}"', // optional, supports {transcript}
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

## Notes & limits

- Provider auth follows the standard model auth order (auth profiles, env vars, `models.providers.*.apiKey`).
- Groq setup details: [Groq](/providers/groq).
- Deepgram picks up `DEEPGRAM_API_KEY` when `provider: "deepgram"` is used.
- Deepgram setup details: [Deepgram (audio transcription)](/providers/deepgram).
- Mistral setup details: [Mistral](/providers/mistral).
- Audio providers can override `baseUrl`, `headers`, and `providerOptions` via `tools.media.audio`.
- Default size cap is 20MB (`tools.media.audio.maxBytes`). Oversize audio is skipped for that model and the next entry is tried.
- Tiny/empty audio files below 1024 bytes are skipped before provider/CLI transcription.
- Default `maxChars` for audio is **unset** (full transcript). Set `tools.media.audio.maxChars` or per-entry `maxChars` to trim output.
- OpenAI auto default is `gpt-4o-mini-transcribe`; set `model: "gpt-4o-transcribe"` for higher accuracy.
- Use `tools.media.audio.attachments` to process multiple voice notes (`mode: "all"` + `maxAttachments`).
- Transcript is available to templates as `{{Transcript}}`.
- `tools.media.audio.echoTranscript` is off by default; enable it to send transcript confirmation back to the originating chat before agent processing.
- `tools.media.audio.echoFormat` customizes the echo text (placeholder: `{transcript}`).
- CLI stdout is capped (5MB); keep CLI output concise.

### Proxy environment support

Provider-based audio transcription honors standard outbound proxy env vars:

- `HTTPS_PROXY`
- `HTTP_PROXY`
- `https_proxy`
- `http_proxy`

If no proxy env vars are set, direct egress is used. If proxy config is malformed, OpenClaw logs a warning and falls back to direct fetch.

## Mention Detection in Groups

When `requireMention: true` is set for a group chat, OpenClaw now transcribes audio **before** checking for mentions. This allows voice notes to be processed even when they contain mentions.

**How it works:**

1. If a voice message has no text body and the group requires mentions, OpenClaw performs a "preflight" transcription.
2. The transcript is checked for mention patterns (e.g., `@BotName`, emoji triggers).
3. If a mention is found, the message proceeds through the full reply pipeline.
4. The transcript is used for mention detection so voice notes can pass the mention gate.

**Fallback behavior:**

- If transcription fails during preflight (timeout, API error, etc.), the message is processed based on text-only mention detection.
- This ensures that mixed messages (text + audio) are never incorrectly dropped.

**Opt-out per Telegram group/topic:**

- Set `channels.telegram.groups.<chatId>.disableAudioPreflight: true` to skip preflight transcript mention checks for that group.
- Set `channels.telegram.groups.<chatId>.topics.<threadId>.disableAudioPreflight` to override per-topic (`true` to skip, `false` to force-enable).
- Default is `false` (preflight enabled when mention-gated conditions match).

**Example:** A user sends a voice note saying "Hey @Claude, what's the weather?" in a Telegram group with `requireMention: true`. The voice note is transcribed, the mention is detected, and the agent replies.

## Gotchas

- Scope rules use first-match wins. `chatType` is normalized to `direct`, `group`, or `room`.
- Ensure your CLI exits 0 and prints plain text; JSON needs to be massaged via `jq -r .text`.
- For `parakeet-mlx`, if you pass `--output-dir`, OpenClaw reads `<output-dir>/<media-basename>.txt` when `--output-format` is `txt` (or omitted); non-`txt` output formats fall back to stdout parsing.
- Keep timeouts reasonable (`timeoutSeconds`, default 60s) to avoid blocking the reply queue.
- Preflight transcription only processes the **first** audio attachment for mention detection. Additional audio is processed during the main media understanding phase.
