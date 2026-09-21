---
summary: "Read blocked web links using an Android phone connected to the Gateway host"
title: "Phone Reader"
---

# Phone Reader

The bundled `phone-reader` plugin adds the `phone_read` tool. When `web_fetch`
fails or returns a login/block page, the agent can open the link in a phone app
and read accessibility text and capture screenshots. The agent uses the `image`
tool to interpret those screenshots, or `read` with a vision-capable model when
the image tool is unavailable or fails. Tool selection is model-driven;
this plugin does not intercept every failed HTTP request. No skill is required.

## Requirements

- Windows, macOS, or Linux running the Gateway, with Android Platform Tools (`adb`).
- An Android phone connected to that host, with USB debugging enabled and the
  host authorized. Unlock the phone and sign into the target app manually.
- An agent allowed to use `phone_read`. The tool is unavailable in sandboxed sessions.
- Image recognition requires either the `image` tool with a working image model,
  or the `read` tool with a vision-capable conversation model. Capturing screenshots
  alone does not perform OCR. If both routes fail, the agent must report that
  image recognition failed.

iOS and phones attached to a different host are not supported by this plugin.
Run the Gateway on the computer connected to the phone. Check `adb devices -l`
before troubleshooting the agent. Multiple phones require an explicit `serial`.

## Configuration

Merge this entry into the existing configuration, preserving other plugins:

```json5
{
  plugins: {
    entries: {
      "phone-reader": {
        enabled: true,
        config: {
          adbPath: "adb", // Or the absolute path to adb/adb.exe on this host.
          serial: "YOUR_DEVICE_SERIAL", // Optional when exactly one device is connected.
        },
      },
    },
  },
}
```

If `plugins.allow` is configured, also add `phone-reader`. If tool policy uses an
allowlist, add `phone_read` (or the plugin ID) to that existing policy. Explicit
deny rules still apply. Enable this plugin only for agents allowed to read the
phone's logged-in content.

Xiaohongshu note URLs under `/explore/ID`, `/discovery/item/ID`, and
`/user/profile/USER/ID` use a plugin-owned deep-link adapter. The ID must contain
24 hexadecimal characters. Expand short links with web tools first. Links with
working web access should continue to use `web_fetch`.

Other Android apps can be mapped to exact hosts in `config.apps`:

```json5
apps: [{ host: "example.com", package: "com.example.app" }]
```

The configured app must support opening that HTTP(S) URL through an Android VIEW
intent and expose accessibility text. There is no universal app compatibility
guarantee. Custom ports, embedded credentials, and non-HTTP(S) input are rejected.

## Testing

From the source checkout, run a direct device smoke test:

```sh
node --import tsx extensions/phone-reader/smoke.ts "https://www.xiaohongshu.com/explore/0123456789abcdef01234567"
```

Replace the example with a real note. The smoke command accepts
`OPENCLAW_PHONE_ADB_PATH` and `OPENCLAW_PHONE_SERIAL`; the agent tool uses plugin
configuration instead.

Add `--images` to the smoke command to test screenshots and gallery swipes.
The direct smoke command returns file paths; it does not invoke an image model.

For the local Suheng Gateway, enable the plugin in the development configuration
(`~/.openclaw-dev/openclaw.json`) and preserve the production tool allowlist.
Run `pnpm build` after source changes, then `pnpm suheng:debug`. That command
reuses existing build artifacts when present. Start a new conversation and ask
the agent to read a real inaccessible note; verify that the trace includes
`phone_read`. The debug Gateway inherits the production agent and tool policy.

## Result and failure semantics

The text result is **current-screen accessibility text**. By default, the tool also
captures up to ten screenshots (`maxImages`: 1–10); use `captureImages: false`
for text only. Recognized image galleries are cropped using their actual UI
bounds and swiped only after confirming the target app owns the focused window.
Each next page must expose the expected page number. Unknown layouts produce
one current-screen screenshot without swiping.

`imageCapture.images` contains local paths for the `image` tool, saved in the
Gateway media directory under `browser`. Images are untrusted external content.
`imageCapture.complete` means all numbered gallery pages were captured from page
one; it does not guarantee that image text is legible or unclipped. The agent must
analyze the screenshots before describing their contents and disclose missing
pages. The stop reason distinguishes completion, the image limit, unknown
layouts, failed page advancement, duplicate pixels, and capture failure.

This does not provide video transcription or all comments.
`identityVerified: false` means the app does not
expose a verifiable target URL or note ID. Even a successful navigation can show
an error/login page; the agent must check relevance and disclose that limitation.
Page text is wrapped as untrusted external content.

The reader waits for two matching text samples in the expected foreground app.
It limits command time, total operation time, XML size, and output size; supports
cancellation; and serializes reads per phone across Gateway processes on one
host. Temporary UI dumps are removed after each sample. Other automation tools
do not share its lock and must not operate the phone concurrently.

Errors distinguish unsupported links, disconnected/unauthorized devices, a busy
device, a locked screen, unconfirmed navigation, invalid UI XML, and missing or
unstable text. These failures do not prove a note is deleted. No unlock, login,
like, favorite, comment, or share actions are performed.
